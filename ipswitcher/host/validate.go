package main

import (
	"fmt"
	"net/netip"
	"strconv"
	"strings"
)

type fieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// applyArgs is the apply command's args. Pointers mark fields whose absence matters.
type applyArgs struct {
	Index       *int     `json:"index"`
	Mode        string   `json:"mode"`
	IP          string   `json:"ip"`
	Prefix      *int     `json:"prefix"`
	Gateway     string   `json:"gateway"`
	DNS         []string `json:"dns"`
	RollbackSec *int     `json:"rollbackSec"`
	TestHost    string   `json:"testHost"`
	Profile     string   `json:"profile"`
	Source      string   `json:"source"`
	Context     *Context `json:"context"`
	Ack         []string `json:"ack"`
}

// applyPlan is a validated apply request.
type applyPlan struct {
	index       int
	target      Config
	ip          netip.Addr // static only
	prefix      int        // static only
	testHost    netip.Addr // invalid = none
	rollbackSec int
	source      string
	ack         map[string]bool
}

// parseDotted parses a strict dotted-quad IPv4 address: four decimal parts 0–255, no leading zeros.
func parseDotted(s string) (netip.Addr, bool) {
	parts := strings.Split(s, ".")
	if len(parts) != 4 {
		return netip.Addr{}, false
	}
	var b [4]byte
	for i, p := range parts {
		if p == "" || len(p) > 3 || (len(p) > 1 && p[0] == '0') {
			return netip.Addr{}, false
		}
		for _, c := range p {
			if c < '0' || c > '9' {
				return netip.Addr{}, false
			}
		}
		n, err := strconv.Atoi(p)
		if err != nil || n > 255 {
			return netip.Addr{}, false
		}
		b[i] = byte(n)
	}
	return netip.AddrFrom4(b), true
}

func u32(a netip.Addr) uint32 {
	b := a.As4()
	return uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
}

func fromU32(v uint32) netip.Addr {
	return netip.AddrFrom4([4]byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)})
}

func maskBits(prefix int) uint32 {
	if prefix <= 0 {
		return 0
	}
	return ^uint32(0) << (32 - prefix)
}

func sameSubnet(a, b netip.Addr, prefix int) bool {
	m := maskBits(prefix)
	return u32(a)&m == u32(b)&m
}

func networkOf(a netip.Addr, prefix int) netip.Addr { return fromU32(u32(a) & maskBits(prefix)) }

// unicastProblem returns why s can't be a host / gateway / DNS address ("" = fine).
func unicastProblem(s string) (netip.Addr, string) {
	a, ok := parseDotted(s)
	if !ok {
		return a, fmt.Sprintf("%q is not an IPv4 address like 192.168.1.10", s)
	}
	b := a.As4()
	switch {
	case u32(a) == 0:
		return a, "0.0.0.0 is not a usable address"
	case b[0] == 127:
		return a, s + " is a loopback address (127.x.x.x)"
	case b[0] == 169 && b[1] == 254:
		return a, s + " is a link-local address (169.254.x.x)"
	case b[0] >= 224:
		return a, s + " is a multicast or reserved address (224.0.0.0 and above)"
	}
	return a, ""
}

// testHostProblem: dotted IPv4, not 0.0.0.0, below 224.0.0.0.
func testHostProblem(s string) (netip.Addr, string) {
	a, ok := parseDotted(s)
	if !ok {
		return a, fmt.Sprintf("%q is not an IPv4 address like 192.168.1.10", s)
	}
	if u32(a) == 0 {
		return a, "0.0.0.0 can't be pinged"
	}
	if a.As4()[0] >= 224 {
		return a, s + " is a multicast or reserved address (224.0.0.0 and above)"
	}
	return a, ""
}

// validateApply checks apply args against PROTOCOL.md "Validation". Pure: no system access.
func validateApply(a applyArgs) (applyPlan, []fieldError) {
	var errs []fieldError
	add := func(f, m string) { errs = append(errs, fieldError{Field: f, Message: m}) }
	p := applyPlan{rollbackSec: 30, source: "popup", ack: map[string]bool{}}

	if a.Index == nil {
		add("index", "Choose an adapter")
	} else {
		p.index = *a.Index
	}

	switch a.Source {
	case "":
	case "popup", "site":
		p.source = a.Source
	default:
		add("source", `Source must be "popup" or "site"`)
	}

	if a.RollbackSec != nil {
		if *a.RollbackSec < 0 || *a.RollbackSec > 300 {
			add("rollbackSec", "Confirm window must be 0–300 seconds")
		} else {
			p.rollbackSec = *a.RollbackSec
		}
	}

	for _, k := range a.Ack {
		if k != "internet" && k != "overlap" {
			add("ack", fmt.Sprintf("Unknown confirmation %q", k))
			continue
		}
		p.ack[k] = true
	}

	if a.TestHost != "" {
		if h, msg := testHostProblem(a.TestHost); msg != "" {
			add("testHost", "Test host: "+msg)
		} else {
			p.testHost = h
		}
	}

	switch a.Mode {
	case "dhcp":
		if a.IP != "" {
			add("ip", "Leave the IP address empty for DHCP")
		}
		if a.Prefix != nil && *a.Prefix != 0 {
			add("prefix", "Leave the prefix empty for DHCP")
		}
		if a.Gateway != "" {
			add("gateway", "Leave the gateway empty for DHCP")
		}
		if len(a.DNS) > 0 {
			add("dns", "Leave DNS empty for DHCP")
		}
		p.target = Config{DHCP: true}
	case "static":
		ipOK, prefixOK := false, false
		if a.IP == "" {
			add("ip", "Enter an IP address")
		} else if ip, msg := unicastProblem(a.IP); msg != "" {
			add("ip", "IP address: "+msg)
		} else {
			p.ip, ipOK = ip, true
		}
		if a.Prefix == nil {
			add("prefix", "Enter a prefix length (8–32)")
		} else if *a.Prefix < 8 || *a.Prefix > 32 {
			add("prefix", "Prefix length must be 8–32")
		} else {
			p.prefix, prefixOK = *a.Prefix, true
		}
		if ipOK && prefixOK && p.prefix <= 30 {
			m := maskBits(p.prefix)
			v := u32(p.ip)
			subnet := fmt.Sprintf("%s/%d", networkOf(p.ip, p.prefix), p.prefix)
			if v&^m == 0 {
				add("ip", fmt.Sprintf("%s is the network address of %s", a.IP, subnet))
			} else if v&^m == ^m {
				add("ip", fmt.Sprintf("%s is the broadcast address of %s", a.IP, subnet))
			}
		}
		gw := ""
		if a.Gateway != "" {
			if g, msg := unicastProblem(a.Gateway); msg != "" {
				add("gateway", "Gateway: "+msg)
			} else if ipOK && prefixOK {
				subnet := fmt.Sprintf("%s/%d", networkOf(p.ip, p.prefix), p.prefix)
				if g == p.ip {
					add("gateway", "Gateway can't be the same as the IP address")
				} else if !sameSubnet(g, p.ip, p.prefix) {
					add("gateway", "Gateway must be inside "+subnet)
				} else {
					gw = a.Gateway
				}
			}
		}
		var dns []string
		if len(a.DNS) > 2 {
			add("dns", "At most 2 DNS servers")
		} else {
			for _, d := range a.DNS {
				if _, msg := unicastProblem(d); msg != "" {
					add("dns", "DNS: "+msg)
					continue
				}
				dup := false
				for _, e := range dns {
					dup = dup || e == d
				}
				if !dup {
					dns = append(dns, d)
				}
			}
		}
		if ipOK && prefixOK {
			p.target = Config{Addrs: []string{fmt.Sprintf("%s/%d", p.ip, p.prefix)}, Gateway: gw, DNS: dns}
		}
	case "":
		add("mode", "Choose static or DHCP")
	default:
		add("mode", `Mode must be "static" or "dhcp"`)
	}
	return p, errs
}

// guardrails returns the needs_confirm items for a validated plan (ack not applied).
func guardrails(p applyPlan, target Adapter, inv []Adapter) []map[string]string {
	var out []map[string]string
	if target.IsInternet {
		out = append(out, map[string]string{"code": "internet", "message": fmt.Sprintf(
			"%s is this PC's internet connection. Changing it may cut the internet until you switch back.", target.Name)})
	}
	if !p.target.DHCP && p.ip.IsValid() {
		for _, o := range inv {
			if o.GUID == target.GUID || o.Status != "Up" {
				continue
			}
			for _, cidr := range o.IPs {
				pf, err := netip.ParsePrefix(cidr)
				if err != nil || !pf.Addr().Is4() {
					continue
				}
				if sameSubnet(pf.Addr(), p.ip, p.prefix) || sameSubnet(pf.Addr(), p.ip, pf.Bits()) {
					out = append(out, map[string]string{"code": "overlap", "message": fmt.Sprintf(
						"%s (%s) is already on this subnet. Two adapters on one subnet can send traffic the wrong way.", o.Name, cidr)})
					break
				}
			}
		}
	}
	return out
}
