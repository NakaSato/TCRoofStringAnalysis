package main

import (
	"encoding/json"
	"fmt"
	"net/netip"
	"strconv"
	"strings"
)

func prefixToMask(prefix int) string { return fromU32(maskBits(prefix)).String() }

// maskToPrefix converts a dotted mask to a prefix length; only contiguous masks are accepted.
func maskToPrefix(mask string) (int, bool) {
	a, ok := parseDotted(mask)
	if !ok {
		return 0, false
	}
	v := u32(a)
	n := 0
	for n < 32 && v&(1<<(31-n)) != 0 {
		n++
	}
	if maskBits(n) != v {
		return 0, false
	}
	return n, true
}

func splitCIDR(cidr string) (string, int, bool) {
	pf, err := netip.ParsePrefix(cidr)
	if err != nil || !pf.Addr().Is4() {
		return "", 0, false
	}
	return pf.Addr().String(), pf.Bits(), true
}

// planConfig returns the netsh argument lists (without "netsh") that set interface index to c.
func planConfig(index int, c Config) [][]string {
	name := "name=" + strconv.Itoa(index)
	var plan [][]string
	if c.DHCP {
		plan = append(plan, []string{"interface", "ipv4", "set", "address", name, "source=dhcp"})
	} else {
		first := true
		for _, cidr := range c.Addrs {
			ip, prefix, ok := splitCIDR(cidr)
			if !ok {
				continue
			}
			mask := prefixToMask(prefix)
			if first {
				gw := c.Gateway
				if gw == "" {
					gw = "none"
				}
				plan = append(plan, []string{"interface", "ipv4", "set", "address", name, "source=static",
					"address=" + ip, "mask=" + mask, "gateway=" + gw})
				first = false
			} else {
				plan = append(plan, []string{"interface", "ipv4", "add", "address", name, "address=" + ip, "mask=" + mask})
			}
		}
	}
	switch {
	case len(c.DNS) == 0 && c.DHCP:
		plan = append(plan, []string{"interface", "ipv4", "set", "dnsservers", name, "source=dhcp"})
	case len(c.DNS) == 0:
		plan = append(plan, []string{"interface", "ipv4", "set", "dnsservers", name, "source=static",
			"address=none", "register=primary", "validate=no"})
	default:
		plan = append(plan, []string{"interface", "ipv4", "set", "dnsservers", name, "source=static",
			"address=" + c.DNS[0], "register=primary", "validate=no"})
		for i, d := range c.DNS[1:] {
			plan = append(plan, []string{"interface", "ipv4", "add", "dnsservers", name,
				"address=" + d, "index=" + strconv.Itoa(i+2), "validate=no"})
		}
	}
	return plan
}

// configEqual compares stored configs: addresses as a set, DNS in order; DHCP ignores addrs/gateway.
func configEqual(a, b Config) bool {
	if a.DHCP != b.DHCP {
		return false
	}
	if len(a.DNS) != len(b.DNS) {
		return false
	}
	for i := range a.DNS {
		if a.DNS[i] != b.DNS[i] {
			return false
		}
	}
	if a.DHCP {
		return true
	}
	if a.Gateway != b.Gateway || len(a.Addrs) != len(b.Addrs) {
		return false
	}
	seen := map[string]int{}
	for _, x := range a.Addrs {
		seen[x]++
	}
	for _, x := range b.Addrs {
		if seen[x] == 0 {
			return false
		}
		seen[x]--
	}
	return true
}

func cleanAddrList(xs []string) []string {
	var out []string
	for _, x := range xs {
		x = strings.TrimSpace(x)
		if x == "" || x == "0.0.0.0" {
			continue
		}
		out = append(out, x)
	}
	return out
}

// configFromReg builds the stored config from the Tcpip\Parameters\Interfaces\<guid> values.
// enableDHCP: 1 = DHCP, 0 = static, -1 = value missing (treated as static).
func configFromReg(enableDHCP int, ips, masks, gws []string, nameServer string) Config {
	var c Config
	if enableDHCP == 1 {
		c.DHCP = true
	} else {
		for i, ip := range ips {
			ip = strings.TrimSpace(ip)
			if ip == "" || ip == "0.0.0.0" || i >= len(masks) {
				continue
			}
			if _, ok := parseDotted(ip); !ok {
				continue
			}
			prefix, ok := maskToPrefix(strings.TrimSpace(masks[i]))
			if !ok || prefix == 0 {
				continue
			}
			c.Addrs = append(c.Addrs, fmt.Sprintf("%s/%d", ip, prefix))
		}
		if g := cleanAddrList(gws); len(g) > 0 {
			c.Gateway = g[0]
		}
	}
	c.DNS = cleanAddrList(strings.FieldsFunc(nameServer, func(r rune) bool { return r == ',' || r == ' ' || r == ';' }))
	return c
}

type regValue struct {
	Type  string
	Value string   // raw text after the type
	Multi []string // REG_MULTI_SZ split on literal \0
}

// parseRegQuery parses `reg query <key>` output (value lines are 4-space indented "name    TYPE    value").
func parseRegQuery(out string) map[string]regValue {
	vals := map[string]regValue{}
	for _, line := range strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n") {
		if !strings.HasPrefix(line, "    ") {
			continue
		}
		parts := strings.SplitN(strings.TrimLeft(line, " "), "    ", 3)
		if len(parts) < 2 || !strings.HasPrefix(parts[1], "REG_") {
			continue
		}
		v := regValue{Type: strings.TrimSpace(parts[1])}
		if len(parts) == 3 {
			v.Value = strings.TrimRight(parts[2], " \t")
		}
		if v.Type == "REG_MULTI_SZ" && v.Value != "" {
			v.Multi = strings.Split(v.Value, `\0`)
		}
		vals[parts[0]] = v
	}
	return vals
}

func regDWORD(v regValue, ok bool) int {
	if !ok || v.Type != "REG_DWORD" {
		return -1
	}
	n, err := strconv.ParseUint(strings.TrimPrefix(strings.ToLower(v.Value), "0x"), 16, 32)
	if err != nil {
		return -1
	}
	return int(n)
}

func regStrings(v regValue, ok bool) []string {
	if !ok {
		return nil
	}
	if v.Type == "REG_MULTI_SZ" {
		return v.Multi
	}
	if v.Value == "" {
		return nil
	}
	return []string{v.Value}
}

// configFromRegQuery turns `reg query` output into a Config.
func configFromRegQuery(out string) Config {
	vals := parseRegQuery(out)
	d, ok := vals["EnableDHCP"]
	ips, okIP := vals["IPAddress"]
	masks, okM := vals["SubnetMask"]
	gws, okG := vals["DefaultGateway"]
	ns := vals["NameServer"]
	return configFromReg(regDWORD(d, ok), regStrings(ips, okIP), regStrings(masks, okM), regStrings(gws, okG), ns.Value)
}

// strList decodes PowerShell output that may be null, a bare string, or an array with nulls.
type strList []string

func (s *strList) UnmarshalJSON(b []byte) error {
	var raw any
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	*s = nil
	var walk func(v any)
	walk = func(v any) {
		switch x := v.(type) {
		case string:
			*s = append(*s, x)
		case float64:
			*s = append(*s, strconv.FormatFloat(x, 'f', -1, 64))
		case []any:
			for _, e := range x {
				walk(e)
			}
		}
	}
	walk(raw)
	return nil
}

// psAdapter is one record of the PowerShell inventory script.
type psAdapter struct {
	Index       int     `json:"index"`
	GUID        string  `json:"guid"`
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Status      string  `json:"status"`
	MAC         string  `json:"mac"`
	IsWifi      bool    `json:"isWifi"`
	IfMetric    int     `json:"ifMetric"`
	IPDhcp      string  `json:"ipDhcp"`
	IPs         strList `json:"ips"`
	Gateway     string  `json:"gateway"`
	RouteMetric int     `json:"routeMetric"`
	DNS         strList `json:"dns"`
	RegDhcp     int     `json:"regDhcp"`
	RegIP       strList `json:"regIp"`
	RegMask     strList `json:"regMask"`
	RegGw       strList `json:"regGw"`
	RegNs       string  `json:"regNs"`
}

// parsePSInventory converts the inventory script's JSON (array, single object or empty) to adapters.
func parsePSInventory(out []byte) ([]Adapter, error) {
	s := strings.TrimSpace(strings.TrimPrefix(string(out), "\xef\xbb\xbf"))
	if s == "" || s == "null" {
		return []Adapter{}, nil
	}
	var recs []psAdapter
	if strings.HasPrefix(s, "{") {
		var one psAdapter
		if err := json.Unmarshal([]byte(s), &one); err != nil {
			return nil, err
		}
		recs = []psAdapter{one}
	} else if err := json.Unmarshal([]byte(s), &recs); err != nil {
		return nil, err
	}
	list := make([]Adapter, 0, len(recs))
	for _, r := range recs {
		if r.GUID == "" {
			continue
		}
		cfg := configFromReg(r.RegDhcp, r.RegIP, r.RegMask, r.RegGw, r.RegNs)
		var ips []string
		for _, x := range cleanAddrList(r.IPs) {
			if strings.HasPrefix(x, "0.0.0.0/") {
				continue
			}
			ips = append(ips, x)
		}
		gw := strings.TrimSpace(r.Gateway)
		if gw == "0.0.0.0" {
			gw = ""
		}
		rm := r.RouteMetric
		if gw == "" {
			rm = -1
		}
		dhcp := cfg.DHCP
		switch strings.ToLower(r.IPDhcp) {
		case "enabled":
			dhcp = true
		case "disabled":
			dhcp = false
		}
		list = append(list, Adapter{
			Index: r.Index, GUID: strings.ToUpper(r.GUID), Name: r.Name, Description: r.Description,
			Status: r.Status, MAC: r.MAC, IsWifi: r.IsWifi, DHCP: dhcp, IPs: ips, Gateway: gw,
			DNS: cleanAddrList(r.DNS), Config: cfg, IfMetric: r.IfMetric, RouteMetric: rm,
		})
	}
	return list, nil
}

// markInternet sets isInternet on the Up adapter whose default route has the lowest route + interface metric.
func markInternet(list []Adapter) {
	best := -1
	for i := range list {
		list[i].IsInternet = false
		a := list[i]
		if a.Status != "Up" || a.Gateway == "" || a.RouteMetric < 0 {
			continue
		}
		if best < 0 || a.RouteMetric+a.IfMetric < list[best].RouteMetric+list[best].IfMetric {
			best = i
		}
	}
	if best >= 0 {
		list[best].IsInternet = true
	}
}
