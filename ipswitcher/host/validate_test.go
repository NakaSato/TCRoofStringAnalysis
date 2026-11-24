package main

import (
	"reflect"
	"strings"
	"testing"
)

func ip(n int) *int { return &n }

func TestParseDotted(t *testing.T) {
	good := []string{"0.0.0.0", "10.0.0.1", "255.255.255.255", "192.168.100.200"}
	bad := []string{"", "1.2.3", "1.2.3.4.5", "01.2.3.4", "1.02.3.4", "1.2.3.004", "256.1.1.1", "1.2.3.-1",
		"1.2.3.4 ", " 1.2.3.4", "1..3.4", "a.b.c.d", "::1", "::ffff:1.2.3.4", "1.2.3.4/24", "0x1.2.3.4", "+1.2.3.4"}
	for _, s := range good {
		if _, ok := parseDotted(s); !ok {
			t.Errorf("parseDotted(%q) rejected", s)
		}
	}
	for _, s := range bad {
		if _, ok := parseDotted(s); ok {
			t.Errorf("parseDotted(%q) accepted", s)
		}
	}
}

func TestValidateApply(t *testing.T) {
	static := func(ipS string, prefix int) applyArgs {
		return applyArgs{Index: ip(12), Mode: "static", IP: ipS, Prefix: &prefix}
	}
	with := func(a applyArgs, f func(*applyArgs)) applyArgs { f(&a); return a }
	cases := []struct {
		name  string
		args  applyArgs
		field string // "" = valid
		msg   string // substring of the message
	}{
		{"basic", static("10.100.35.1", 24), "", ""},
		{"leading zero", static("10.100.035.1", 24), "ip", "not an IPv4"},
		{"zero addr", static("0.0.0.0", 8), "ip", "0.0.0.0"},
		{"loopback", static("127.0.0.5", 8), "ip", "loopback"},
		{"link local", static("169.254.3.4", 16), "ip", "link-local"},
		{"multicast", static("224.0.0.1", 24), "ip", "multicast"},
		{"class E", static("240.1.1.1", 24), "ip", "multicast"},
		{"broadcast all", static("255.255.255.255", 24), "ip", "multicast"},
		{"network /24", static("10.100.35.0", 24), "ip", "network address of 10.100.35.0/24"},
		{"broadcast /24", static("10.100.35.255", 24), "ip", "broadcast address"},
		{"network /30", static("10.0.0.4", 30), "ip", "network address"},
		{"broadcast /30", static("10.0.0.7", 30), "ip", "broadcast"},
		{"host /30", static("10.0.0.5", 30), "", ""},
		{"/31 low", static("10.0.0.4", 31), "", ""},
		{"/31 high", static("10.0.0.5", 31), "", ""},
		{"/32 x.0", static("10.0.0.0", 32), "", ""},
		{"/32 x.255", static("10.0.0.255", 32), "", ""},
		{"prefix 7", static("10.0.0.1", 7), "prefix", "8–32"},
		{"prefix 33", static("10.0.0.1", 33), "prefix", "8–32"},
		{"prefix missing", applyArgs{Index: ip(1), Mode: "static", IP: "10.0.0.1"}, "prefix", "prefix"},
		{"ip missing", applyArgs{Index: ip(1), Mode: "static", Prefix: ip(24)}, "ip", "Enter"},
		{"gw ok", with(static("10.100.35.1", 24), func(a *applyArgs) { a.Gateway = "10.100.35.254" }), "", ""},
		{"gw outside", with(static("10.100.35.1", 24), func(a *applyArgs) { a.Gateway = "10.100.36.1" }), "gateway", "inside 10.100.35.0/24"},
		{"gw equals ip", with(static("10.100.35.1", 24), func(a *applyArgs) { a.Gateway = "10.100.35.1" }), "gateway", "same as the IP"},
		{"gw invalid", with(static("10.100.35.1", 24), func(a *applyArgs) { a.Gateway = "10.100.35.01" }), "gateway", "not an IPv4"},
		{"gw /31 peer", with(static("10.0.0.4", 31), func(a *applyArgs) { a.Gateway = "10.0.0.5" }), "", ""},
		{"gw /32", with(static("10.0.0.4", 32), func(a *applyArgs) { a.Gateway = "10.0.0.5" }), "gateway", "inside 10.0.0.4/32"},
		{"dns 2", with(static("10.0.0.1", 24), func(a *applyArgs) { a.DNS = []string{"8.8.8.8", "1.1.1.1"} }), "", ""},
		{"dns 3", with(static("10.0.0.1", 24), func(a *applyArgs) { a.DNS = []string{"8.8.8.8", "1.1.1.1", "9.9.9.9"} }), "dns", "At most 2"},
		{"dns loopback", with(static("10.0.0.1", 24), func(a *applyArgs) { a.DNS = []string{"127.0.0.1"} }), "dns", "loopback"},
		{"dns empty string", with(static("10.0.0.1", 24), func(a *applyArgs) { a.DNS = []string{""} }), "dns", "not an IPv4"},
		{"dns outside subnet ok", with(static("10.0.0.1", 24), func(a *applyArgs) { a.DNS = []string{"8.8.8.8"} }), "", ""},
		{"dhcp", applyArgs{Index: ip(1), Mode: "dhcp"}, "", ""},
		{"dhcp prefix 0 ok", applyArgs{Index: ip(1), Mode: "dhcp", Prefix: ip(0)}, "", ""},
		{"dhcp with ip", applyArgs{Index: ip(1), Mode: "dhcp", IP: "10.0.0.1"}, "ip", "empty for DHCP"},
		{"dhcp with prefix", applyArgs{Index: ip(1), Mode: "dhcp", Prefix: ip(24)}, "prefix", "empty for DHCP"},
		{"dhcp with gw", applyArgs{Index: ip(1), Mode: "dhcp", Gateway: "10.0.0.1"}, "gateway", "empty for DHCP"},
		{"dhcp with dns", applyArgs{Index: ip(1), Mode: "dhcp", DNS: []string{"8.8.8.8"}}, "dns", "empty for DHCP"},
		{"no mode", applyArgs{Index: ip(1)}, "mode", ""},
		{"bad mode", applyArgs{Index: ip(1), Mode: "auto"}, "mode", ""},
		{"no index", applyArgs{Mode: "dhcp"}, "index", ""},
		{"rollback 301", applyArgs{Index: ip(1), Mode: "dhcp", RollbackSec: ip(301)}, "rollbackSec", ""},
		{"rollback -1", applyArgs{Index: ip(1), Mode: "dhcp", RollbackSec: ip(-1)}, "rollbackSec", ""},
		{"rollback 0", applyArgs{Index: ip(1), Mode: "dhcp", RollbackSec: ip(0)}, "", ""},
		{"source bad", applyArgs{Index: ip(1), Mode: "dhcp", Source: "x"}, "source", ""},
		{"ack bad", applyArgs{Index: ip(1), Mode: "dhcp", Ack: []string{"all"}}, "ack", ""},
		{"testHost loopback ok", applyArgs{Index: ip(1), Mode: "dhcp", TestHost: "127.0.0.1"}, "", ""},
		{"testHost zero", applyArgs{Index: ip(1), Mode: "dhcp", TestHost: "0.0.0.0"}, "testHost", ""},
		{"testHost multicast", applyArgs{Index: ip(1), Mode: "dhcp", TestHost: "239.1.1.1"}, "testHost", ""},
		{"testHost name", applyArgs{Index: ip(1), Mode: "dhcp", TestHost: "router.local"}, "testHost", ""},
	}
	for _, c := range cases {
		_, errs := validateApply(c.args)
		if c.field == "" {
			if len(errs) > 0 {
				t.Errorf("%s: unexpected errors %v", c.name, errs)
			}
			continue
		}
		found := false
		for _, e := range errs {
			if e.Field == c.field && strings.Contains(e.Message, c.msg) {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: want error on %s containing %q, got %v", c.name, c.field, c.msg, errs)
		}
	}
}

func TestValidateApplyTarget(t *testing.T) {
	p, errs := validateApply(applyArgs{Index: ip(12), Mode: "static", IP: "10.100.35.1", Prefix: ip(24),
		Gateway: "10.100.35.254", DNS: []string{"8.8.8.8", "8.8.8.8"}, RollbackSec: ip(60), Source: "site", Ack: []string{"internet"}})
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	want := Config{Addrs: []string{"10.100.35.1/24"}, Gateway: "10.100.35.254", DNS: []string{"8.8.8.8"}}
	if !reflect.DeepEqual(p.target, want) || p.rollbackSec != 60 || p.source != "site" || !p.ack["internet"] || p.index != 12 {
		t.Fatalf("plan = %+v", p)
	}
	p, _ = validateApply(applyArgs{Index: ip(3), Mode: "dhcp"})
	if !p.target.DHCP || p.rollbackSec != 30 || p.source != "popup" {
		t.Fatalf("dhcp defaults = %+v", p)
	}
}

func TestGuardrails(t *testing.T) {
	inv := []Adapter{
		{Index: 1, GUID: "A", Name: "Ethernet", Status: "Up", IsInternet: true, IPs: []string{"192.168.1.5/24"}},
		{Index: 2, GUID: "B", Name: "USB", Status: "Up", IPs: []string{"10.0.0.0/8"}},
		{Index: 3, GUID: "C", Name: "Off", Status: "Disconnected", IPs: []string{"172.16.0.5/24"}},
		{Index: 4, GUID: "D", Name: "Target", Status: "Up"},
	}
	codes := func(g []map[string]string) []string {
		var out []string
		for _, x := range g {
			out = append(out, x["code"])
		}
		return out
	}
	plan := func(ipS string, prefix int) applyPlan {
		p, errs := validateApply(applyArgs{Index: ip(4), Mode: "static", IP: ipS, Prefix: &prefix})
		if len(errs) > 0 {
			t.Fatal(errs)
		}
		return p
	}
	if g := guardrails(plan("192.168.1.50", 24), inv[3], inv); !reflect.DeepEqual(codes(g), []string{"overlap"}) {
		t.Errorf("same subnet: %v", g)
	}
	// Their /8 contains our IP although our /24 doesn't contain theirs.
	if g := guardrails(plan("10.20.30.40", 24), inv[3], inv); !reflect.DeepEqual(codes(g), []string{"overlap"}) {
		t.Errorf("contained: %v", g)
	}
	if g := guardrails(plan("172.16.0.9", 24), inv[3], inv); len(g) != 0 {
		t.Errorf("disconnected adapters don't count: %v", g)
	}
	if g := guardrails(plan("192.168.1.50", 24), inv[0], inv); !reflect.DeepEqual(codes(g), []string{"internet"}) {
		t.Errorf("internet adapter (its own subnet doesn't overlap itself): %v", g)
	}
}
