package main

import (
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// fakeAdapter is one adapter of the fake system (state in <dataDir>/fake.json).
type fakeAdapter struct {
	Index       int    `json:"index"`
	GUID        string `json:"guid"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Status      string `json:"status"`
	MAC         string `json:"mac"`
	IsWifi      bool   `json:"isWifi"`
	Physical    bool   `json:"physical"`
	IfMetric    int    `json:"ifMetric"`
	Config      Config `json:"config"`
	// What the DHCP server on this link would hand out (empty = no DHCP server answering).
	Lease Config `json:"lease"`
}

type fakeState struct {
	Adapters   []fakeAdapter `json:"adapters"`
	FailWrites bool          `json:"failWrites"` // netsh "succeeds" but changes nothing
	CanWrite   *bool         `json:"canWrite,omitempty"`
}

// fakeSystem simulates Windows for tests and for a Mac smoke run (IPSWITCHER_FAKE=1).
// Its netsh parses the exact argument lists planConfig produces.
type fakeSystem struct {
	mu    sync.Mutex
	path  string
	calls [][]string
}

func newFakeSystem(dir string) *fakeSystem {
	f := &fakeSystem{path: filepath.Join(dir, "fake.json")}
	if !fileExists(f.path) {
		_ = writeJSONAtomic(f.path, seedFakeState())
	}
	return f
}

func seedFakeState() fakeState {
	return fakeState{Adapters: []fakeAdapter{
		{Index: 12, GUID: "{1D4F0A11-0000-4000-8000-000000000012}", Name: "Ethernet", Description: "Realtek USB GbE Family Controller",
			Status: "Disconnected", MAC: "00-E0-4C-68-01-12", Physical: true, IfMetric: 25, Config: Config{DHCP: true}},
		{Index: 7, GUID: "{1D4F0A11-0000-4000-8000-000000000007}", Name: "Wi-Fi", Description: "Intel(R) Wi-Fi 6 AX201 160MHz",
			Status: "Up", MAC: "A4-C3-F0-11-22-07", IsWifi: true, Physical: true, IfMetric: 35, Config: Config{DHCP: true},
			Lease: Config{Addrs: []string{"192.168.1.23/24"}, Gateway: "192.168.1.1", DNS: []string{"192.168.1.1"}}},
		{Index: 15, GUID: "{1D4F0A11-0000-4000-8000-000000000015}", Name: "อีเทอร์เน็ต 2", Description: "ASIX AX88179 USB 3.0 to Gigabit Ethernet Adapter",
			Status: "Up", MAC: "00-0E-C6-AA-BB-15", Physical: true, IfMetric: 25, Config: Config{DHCP: true},
			Lease: Config{Addrs: []string{"10.0.0.23/24"}}},
		{Index: 30, GUID: "{1D4F0A11-0000-4000-8000-000000000030}", Name: "vEthernet (WSL)", Description: "Hyper-V Virtual Ethernet Adapter",
			Status: "Up", MAC: "00-15-5D-00-00-30", IfMetric: 5000, Config: Config{Addrs: []string{"172.20.0.1/20"}}},
	}}
}

func (f *fakeSystem) load() (fakeState, error) {
	var st fakeState
	ok, err := readJSON(f.path, &st)
	if err != nil {
		return st, err
	}
	if !ok {
		st = seedFakeState()
	}
	return st, nil
}

func (f *fakeSystem) save(st fakeState) error { return writeJSONAtomic(f.path, st) }

// live returns the addresses Windows would use now.
func (a fakeAdapter) live() (ips []string, gw string, dns []string) {
	if a.Status != "Up" {
		return nil, "", nil
	}
	if a.Config.DHCP {
		ips, gw, dns = a.Lease.Addrs, a.Lease.Gateway, a.Lease.DNS
		if len(ips) == 0 {
			ips = []string{"169.254.12.34/16"} // APIPA: no DHCP server
		}
	} else {
		ips, gw = a.Config.Addrs, a.Config.Gateway
	}
	if len(a.Config.DNS) > 0 {
		dns = a.Config.DNS
	}
	return ips, gw, dns
}

func (f *fakeSystem) listAdapters(showAll bool) ([]Adapter, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	st, err := f.load()
	if err != nil {
		return nil, err
	}
	var out []Adapter
	for _, a := range st.Adapters {
		if !showAll && !a.Physical {
			continue
		}
		ips, gw, dns := a.live()
		rm := -1
		if gw != "" {
			rm = 0
		}
		out = append(out, Adapter{Index: a.Index, GUID: a.GUID, Name: a.Name, Description: a.Description,
			Status: a.Status, MAC: a.MAC, IsWifi: a.IsWifi, DHCP: a.Config.DHCP,
			IPs: append([]string(nil), ips...), Gateway: gw, DNS: append([]string(nil), dns...),
			Config: cloneConfig(a.Config), IfMetric: a.IfMetric, RouteMetric: rm})
	}
	return out, nil
}

func cloneConfig(c Config) Config {
	c.Addrs = append([]string(nil), c.Addrs...)
	c.DNS = append([]string(nil), c.DNS...)
	return c
}

func (f *fakeSystem) readConfig(guid string) (Config, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	st, err := f.load()
	if err != nil {
		return Config{}, err
	}
	for _, a := range st.Adapters {
		if a.GUID == guid {
			return cloneConfig(a.Config), nil
		}
	}
	return Config{}, fmt.Errorf("no adapter %s", guid)
}

func (f *fakeSystem) canWrite() (bool, error) {
	st, err := f.load()
	if err != nil {
		return false, err
	}
	if st.CanWrite != nil {
		return *st.CanWrite, nil
	}
	return true, nil
}

func (f *fakeSystem) ping(addr netip.Addr, _ time.Duration) (bool, int, error) {
	st, err := f.load()
	if err != nil {
		return false, 0, err
	}
	for _, a := range st.Adapters {
		ips, _, _ := a.live()
		for _, cidr := range append(append([]string(nil), ips...), a.Config.Addrs...) {
			if pf, err := netip.ParsePrefix(cidr); err == nil && pf.Masked().Contains(addr) {
				return true, 1, nil
			}
		}
	}
	return false, 0, nil
}

// netsh applies one `netsh interface ipv4 …` argument list to the fake state.
func (f *fakeSystem) netsh(args []string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, append([]string(nil), args...))
	if len(args) < 5 || args[0] != "interface" || args[1] != "ipv4" {
		return "The syntax supplied for this command is not valid.", errors.New("exit status 1")
	}
	verb, obj := args[2], args[3]
	kv := map[string]string{}
	for _, a := range args[4:] {
		k, v, ok := strings.Cut(a, "=")
		if !ok {
			return "The syntax supplied for this command is not valid.", errors.New("exit status 1")
		}
		kv[k] = v
	}
	allowed := map[string][]string{
		"set address":    {"name", "source", "address", "mask", "gateway"},
		"add address":    {"name", "address", "mask"},
		"set dnsservers": {"name", "source", "address", "register", "validate"},
		"add dnsservers": {"name", "address", "index", "validate"},
	}[verb+" "+obj]
	if allowed == nil {
		return "The following command was not found: " + strings.Join(args, " "), errors.New("exit status 1")
	}
	for k := range kv {
		found := false
		for _, a := range allowed {
			found = found || a == k
		}
		if !found {
			return "The parameter is incorrect.", errors.New("exit status 1")
		}
	}
	st, err := f.load()
	if err != nil {
		return "", err
	}
	idx, err := strconv.Atoi(kv["name"])
	if err != nil {
		return "The filename, directory name, or volume label syntax is incorrect.", errors.New("exit status 1")
	}
	ai := -1
	for i, a := range st.Adapters {
		if a.Index == idx {
			ai = i
		}
	}
	if ai < 0 {
		return "The filename, directory name, or volume label syntax is incorrect.", errors.New("exit status 1")
	}
	if st.FailWrites {
		return "Ok.", nil // netsh claims success, nothing changes: verify must catch it
	}
	c := &st.Adapters[ai].Config
	cidr := func() (string, error) {
		ip, ok := parseDotted(kv["address"])
		prefix, okm := maskToPrefix(kv["mask"])
		if !ok || !okm {
			return "", errors.New("bad address or mask")
		}
		return fmt.Sprintf("%s/%d", ip, prefix), nil
	}
	switch verb + " " + obj {
	case "set address":
		switch kv["source"] {
		case "dhcp":
			if c.DHCP {
				return "DHCP is already enabled on this interface.", errors.New("exit status 1")
			}
			c.DHCP, c.Addrs, c.Gateway = true, nil, ""
		case "static":
			a, err := cidr()
			if err != nil {
				return "The parameter is incorrect.", errors.New("exit status 1")
			}
			gw := kv["gateway"]
			if gw == "none" {
				gw = ""
			}
			c.DHCP, c.Addrs, c.Gateway = false, []string{a}, gw
		default:
			return "The parameter is incorrect.", errors.New("exit status 1")
		}
	case "add address":
		a, err := cidr()
		if err != nil {
			return "The parameter is incorrect.", errors.New("exit status 1")
		}
		for _, x := range c.Addrs {
			if x == a {
				return "The object already exists.", errors.New("exit status 1")
			}
		}
		c.Addrs = append(c.Addrs, a)
	case "set dnsservers":
		switch {
		case kv["source"] == "dhcp":
			c.DNS = nil
		case kv["source"] == "static" && kv["address"] == "none":
			c.DNS = nil
		case kv["source"] == "static":
			if _, ok := parseDotted(kv["address"]); !ok {
				return "The parameter is incorrect.", errors.New("exit status 1")
			}
			c.DNS = []string{kv["address"]}
		default:
			return "The parameter is incorrect.", errors.New("exit status 1")
		}
	case "add dnsservers":
		if _, ok := parseDotted(kv["address"]); !ok {
			return "The parameter is incorrect.", errors.New("exit status 1")
		}
		for _, x := range c.DNS {
			if x == kv["address"] {
				return "The object already exists.", errors.New("exit status 1")
			}
		}
		pos, _ := strconv.Atoi(kv["index"])
		if pos < 1 || pos > len(c.DNS)+1 {
			pos = len(c.DNS) + 1
		}
		c.DNS = append(c.DNS[:pos-1], append([]string{kv["address"]}, c.DNS[pos-1:]...)...)
	}
	if err := f.save(st); err != nil {
		return "", err
	}
	return "Ok.", nil
}

// fakeEnabled reports whether IPSWITCHER_FAKE=1 selects the fake system.
func fakeEnabled() bool { return os.Getenv("IPSWITCHER_FAKE") == "1" }
