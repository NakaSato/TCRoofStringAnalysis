//go:build darwin

package main

// macOS: the adapters are the Mac's network services (System Settings → Network), read and set
// with networksetup / ifconfig / netstat / ipconfig. The helper's change plan is the same netsh
// argument lists as on Windows (planConfig); netsh() translates each one to networksetup.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"os/user"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// newPlatformSystem: the fake when IPSWITCHER_FAKE=1, else the real Mac.
func newPlatformSystem(dir string) system {
	if fakeEnabled() {
		return newFakeSystem(dir)
	}
	return macSystem{}
}

type macSystem struct{}

// GUIDs on the Mac are the network service names, prefixed so they can't clash with Windows ones.
const macGUIDPrefix = "mac:"

func runCmd(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return string(out), errTimeout
	}
	return string(out), err
}

type macService struct {
	name, port, device string
	disabled           bool
}

var serviceLine = regexp.MustCompile(`^\((\d+|\*)\)\s+(.+)$`)
var portLine = regexp.MustCompile(`^\(Hardware Port: (.*), Device: (.*)\)$`)

// parseServiceOrder parses `networksetup -listnetworkserviceorder`.
func parseServiceOrder(out string) []macService {
	var list []macService
	var cur *macService
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if m := serviceLine.FindStringSubmatch(line); m != nil {
			list = append(list, macService{name: m[2], disabled: m[1] == "*"})
			cur = &list[len(list)-1]
			continue
		}
		if m := portLine.FindStringSubmatch(line); m != nil && cur != nil {
			cur.port, cur.device = m[1], m[2]
		}
	}
	return list
}

// parseGetInfo parses `networksetup -getinfo <service>` into a Config (DNS filled separately).
func parseGetInfo(out string) Config {
	c := Config{DHCP: !strings.Contains(out, "Manual Configuration")}
	var ip, mask string
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), ":")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch strings.TrimSpace(k) {
		case "IP address":
			ip = v
		case "Subnet mask":
			mask = v
		case "Router":
			if _, ok := parseDotted(v); ok {
				c.Gateway = v
			}
		}
	}
	if c.DHCP {
		c.Gateway = ""
		return c
	}
	if a, ok := parseDotted(ip); ok {
		if p, okm := maskToPrefix(mask); okm {
			c.Addrs = []string{fmt.Sprintf("%s/%d", a, p)}
		}
	}
	return c
}

// parseDNS parses `networksetup -getdnsservers <service>` (static DNS only).
func parseDNS(out string) []string {
	var dns []string
	for _, l := range strings.Split(out, "\n") {
		l = strings.TrimSpace(l)
		if _, ok := parseDotted(l); ok {
			dns = append(dns, l)
		}
	}
	return dns
}

// parseIfconfig returns (active, IPv4 addrs as ip/prefix, mac) from `ifconfig <dev>`.
func parseIfconfig(out string) (bool, []string, string) {
	active := false
	var ips []string
	mac := ""
	for _, l := range strings.Split(out, "\n") {
		f := strings.Fields(l)
		if len(f) == 0 {
			continue
		}
		switch f[0] {
		case "status:":
			active = len(f) > 1 && f[1] == "active"
		case "ether":
			if len(f) > 1 {
				mac = strings.ToUpper(strings.ReplaceAll(f[1], ":", "-"))
			}
		case "inet":
			if len(f) >= 4 && f[2] == "netmask" {
				m, err := strconv.ParseUint(strings.TrimPrefix(f[3], "0x"), 16, 32)
				if err == nil {
					ip, _ := parseDotted(f[1])
					if ip.IsValid() {
						ips = append(ips, fmt.Sprintf("%s/%d", ip, popcount(uint32(m))))
					}
				}
			}
		}
	}
	// Interfaces without media status (e.g. iPhone USB, bridges) count as up when they have an address.
	if !strings.Contains(out, "status:") && len(ips) > 0 {
		active = true
	}
	return active, ips, mac
}

func popcount(v uint32) int {
	n := 0
	for v != 0 {
		n += int(v & 1)
		v >>= 1
	}
	return n
}

// parseDefaultRoutes returns device → (gateway, order) from `netstat -rn -f inet` (first = preferred).
func parseDefaultRoutes(out string) map[string][2]string {
	res := map[string][2]string{}
	order := 0
	for _, l := range strings.Split(out, "\n") {
		f := strings.Fields(l)
		if len(f) >= 4 && f[0] == "default" {
			if _, ok := parseDotted(f[1]); !ok {
				continue
			}
			dev := f[len(f)-1]
			if _, seen := res[dev]; !seen {
				res[dev] = [2]string{f[1], strconv.Itoa(order)}
				order++
			}
		}
	}
	return res
}

func (macSystem) services() ([]macService, error) {
	out, err := runCmd("networksetup", "-listnetworkserviceorder")
	if err != nil {
		return nil, fmt.Errorf("networksetup: %v: %s", err, strings.TrimSpace(out))
	}
	return parseServiceOrder(out), nil
}

func (m macSystem) listAdapters(showAll bool) ([]Adapter, error) {
	svcs, err := m.services()
	if err != nil {
		return nil, err
	}
	routes, _ := runCmd("netstat", "-rn", "-f", "inet")
	defaults := parseDefaultRoutes(routes)
	var list []Adapter
	for _, s := range svcs {
		physical := s.device != "" && !strings.HasPrefix(s.device, "bridge") && !strings.HasPrefix(s.device, "utun")
		if !showAll && !physical {
			continue
		}
		a := Adapter{GUID: macGUIDPrefix + s.name, Name: s.name, Description: s.port, RouteMetric: -1}
		if s.device != "" {
			a.Description = fmt.Sprintf("%s (%s)", s.port, s.device)
		}
		a.IsWifi = s.port == "Wi-Fi" || s.port == "AirPort"
		ifc, ierr := net.InterfaceByName(s.device)
		switch {
		case s.disabled:
			a.Status = "Disabled"
		case s.device == "" || ierr != nil:
			a.Status = "NotPresent"
		default:
			a.Index = ifc.Index
			out, _ := runCmd("ifconfig", s.device)
			active, ips, mac := parseIfconfig(out)
			a.IPs, a.MAC = ips, mac
			a.Status = "Disconnected"
			if active {
				a.Status = "Up"
			}
		}
		if a.Index == 0 {
			// Not present: a stable negative index from the service order so the UI can still select it.
			a.Index = -(len(list) + 1)
		}
		info, _ := runCmd("networksetup", "-getinfo", s.name)
		a.Config = parseGetInfo(info)
		dns, _ := runCmd("networksetup", "-getdnsservers", s.name)
		a.Config.DNS = parseDNS(dns)
		a.DHCP = a.Config.DHCP
		if r, ok := defaults[s.device]; ok && a.Status == "Up" {
			a.Gateway = r[0]
			a.RouteMetric, _ = strconv.Atoi(r[1])
		}
		a.DNS = a.Config.DNS
		if len(a.DNS) == 0 && a.Status == "Up" && s.device != "" {
			if out, err := runCmd("ipconfig", "getoption", s.device, "domain_name_server"); err == nil {
				if _, ok := parseDotted(strings.TrimSpace(out)); ok {
					a.DNS = []string{strings.TrimSpace(out)}
				}
			}
		}
		list = append(list, a)
	}
	return list, nil
}

func (m macSystem) readConfig(guid string) (Config, error) {
	name := strings.TrimPrefix(guid, macGUIDPrefix)
	out, err := runCmd("networksetup", "-getinfo", name)
	if err != nil || strings.Contains(out, "is not a recognized network service") {
		return Config{}, fmt.Errorf("networksetup -getinfo %q: %v %s", name, err, strings.TrimSpace(out))
	}
	c := parseGetInfo(out)
	dns, _ := runCmd("networksetup", "-getdnsservers", name)
	c.DNS = parseDNS(dns)
	return c, nil
}

// netsh translates one `interface ipv4 …` argument list from planConfig into networksetup.
func (m macSystem) netsh(args []string) (string, error) {
	if len(args) < 5 || args[0] != "interface" || args[1] != "ipv4" {
		return "", errors.New("unsupported command")
	}
	kv := map[string]string{}
	for _, a := range args[4:] {
		k, v, ok := strings.Cut(a, "=")
		if !ok {
			return "", fmt.Errorf("bad argument %q", a)
		}
		kv[k] = v
	}
	idx, err := strconv.Atoi(kv["name"])
	if err != nil {
		return "", fmt.Errorf("bad interface index %q", kv["name"])
	}
	list, err := m.listAdapters(true)
	if err != nil {
		return "", err
	}
	svc := ""
	for _, a := range list {
		if a.Index == idx {
			svc = strings.TrimPrefix(a.GUID, macGUIDPrefix)
		}
	}
	if svc == "" {
		return "", fmt.Errorf("no network service with index %d", idx)
	}
	set := func(a ...string) (string, error) {
		out, err := runCmd("networksetup", a...)
		// networksetup often exits 0 even on failure; verify (readConfig) decides.
		if err == nil && strings.Contains(out, "Error") {
			err = errors.New(strings.TrimSpace(out))
		}
		return out, err
	}
	switch args[2] + " " + args[3] {
	case "set address":
		if kv["source"] == "dhcp" {
			return set("-setdhcp", svc)
		}
		gw := kv["gateway"]
		if gw == "" || gw == "none" {
			// No gateway: networksetup needs a router argument; macOS accepts an empty one.
			return set("-setmanual", svc, kv["address"], kv["mask"], "")
		}
		return set("-setmanual", svc, kv["address"], kv["mask"], gw)
	case "add address":
		return "", errors.New("a second IP on one adapter is not supported on macOS")
	case "set dnsservers":
		if kv["source"] == "dhcp" || kv["address"] == "none" {
			return set("-setdnsservers", svc, "Empty")
		}
		return set("-setdnsservers", svc, kv["address"])
	case "add dnsservers":
		cur, _ := runCmd("networksetup", "-getdnsservers", svc)
		return set(append(append([]string{"-setdnsservers", svc}, parseDNS(cur)...), kv["address"])...)
	}
	return "", fmt.Errorf("unsupported command %q", strings.Join(args, " "))
}

// canWrite: macOS lets administrators change network settings.
func (macSystem) canWrite() (bool, error) {
	u, err := user.Current()
	if err != nil {
		return false, err
	}
	gids, err := u.GroupIds()
	if err != nil {
		return false, err
	}
	if os.Geteuid() == 0 {
		return true, nil
	}
	for _, g := range gids {
		if grp, err := user.LookupGroupId(g); err == nil && grp.Name == "admin" {
			return true, nil
		}
	}
	return false, nil
}

var pingTime = regexp.MustCompile(`time=([\d.]+) ms`)

func (macSystem) ping(addr netip.Addr, timeout time.Duration) (bool, int, error) {
	ms := int(timeout.Milliseconds())
	if ms < 1 {
		ms = 1000
	}
	out, err := runCmd("ping", "-n", "-c", "1", "-W", strconv.Itoa(ms), addr.String())
	if m := pingTime.FindStringSubmatch(out); m != nil {
		f, _ := strconv.ParseFloat(m[1], 64)
		return true, int(f + 0.5), nil
	}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return false, 0, nil // no reply
		}
		return false, 0, err
	}
	return false, 0, nil
}
