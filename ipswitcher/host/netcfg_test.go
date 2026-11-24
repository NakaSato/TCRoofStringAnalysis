package main

import (
	"reflect"
	"strings"
	"testing"
)

func join(plan [][]string) []string {
	var out []string
	for _, a := range plan {
		out = append(out, strings.Join(a, " "))
	}
	return out
}

func TestPlanConfig(t *testing.T) {
	cases := []struct {
		name string
		c    Config
		want []string
	}{
		{"static gw 2 dns", Config{Addrs: []string{"10.100.35.1/24"}, Gateway: "10.100.35.254", DNS: []string{"8.8.8.8", "1.1.1.1"}}, []string{
			"interface ipv4 set address name=12 source=static address=10.100.35.1 mask=255.255.255.0 gateway=10.100.35.254",
			"interface ipv4 set dnsservers name=12 source=static address=8.8.8.8 register=primary validate=no",
			"interface ipv4 add dnsservers name=12 address=1.1.1.1 index=2 validate=no",
		}},
		{"static bare", Config{Addrs: []string{"192.168.1.100/30"}}, []string{
			"interface ipv4 set address name=12 source=static address=192.168.1.100 mask=255.255.255.252 gateway=none",
			"interface ipv4 set dnsservers name=12 source=static address=none register=primary validate=no",
		}},
		{"dhcp", Config{DHCP: true}, []string{
			"interface ipv4 set address name=12 source=dhcp",
			"interface ipv4 set dnsservers name=12 source=dhcp",
		}},
		{"dhcp static dns", Config{DHCP: true, DNS: []string{"8.8.8.8"}}, []string{
			"interface ipv4 set address name=12 source=dhcp",
			"interface ipv4 set dnsservers name=12 source=static address=8.8.8.8 register=primary validate=no",
		}},
		{"snapshot 2 addrs", Config{Addrs: []string{"10.0.0.5/8", "192.168.0.5/16"}, Gateway: "10.0.0.1", DNS: []string{"10.0.0.1"}}, []string{
			"interface ipv4 set address name=12 source=static address=10.0.0.5 mask=255.0.0.0 gateway=10.0.0.1",
			"interface ipv4 add address name=12 address=192.168.0.5 mask=255.255.0.0",
			"interface ipv4 set dnsservers name=12 source=static address=10.0.0.1 register=primary validate=no",
		}},
	}
	for _, c := range cases {
		if got := join(planConfig(12, c.c)); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s:\n got %q\nwant %q", c.name, got, c.want)
		}
	}
}

func TestMasks(t *testing.T) {
	for p := 0; p <= 32; p++ {
		got, ok := maskToPrefix(prefixToMask(p))
		if !ok || got != p {
			t.Errorf("prefix %d → %s → %d %v", p, prefixToMask(p), got, ok)
		}
	}
	for _, m := range []string{"255.0.255.0", "255.255.255.1", "0.255.255.255", "255.255.255", "255.255.255.00"} {
		if _, ok := maskToPrefix(m); ok {
			t.Errorf("mask %q accepted", m)
		}
	}
}

const regStatic = "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\{1D4F0A11-0000-4000-8000-000000000012}\r\n" +
	"    EnableDHCP    REG_DWORD    0x0\r\n" +
	"    Domain    REG_SZ    \r\n" +
	"    NameServer    REG_SZ    8.8.8.8,1.1.1.1\r\n" +
	"    DhcpIPAddress    REG_SZ    192.168.1.23\r\n" +
	"    IPAddress    REG_MULTI_SZ    10.100.35.1\\0192.168.5.9\r\n" +
	"    SubnetMask    REG_MULTI_SZ    255.255.255.0\\0255.255.0.0\r\n" +
	"    DefaultGateway    REG_MULTI_SZ    10.100.35.254\r\n" +
	"    DefaultGatewayMetric    REG_MULTI_SZ    0\r\n" +
	"    RegistrationEnabled    REG_DWORD    0x1\r\n\r\n"

const regDHCP = "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\...\\{X}\r\n" +
	"    EnableDHCP    REG_DWORD    0x1\r\n" +
	"    NameServer    REG_SZ    \r\n" +
	"    IPAddress    REG_MULTI_SZ    10.100.35.1\r\n" + // stale static values stay in the registry
	"    SubnetMask    REG_MULTI_SZ    255.255.255.0\r\n" +
	"    DefaultGateway    REG_MULTI_SZ    \r\n" +
	"    DhcpIPAddress    REG_SZ    192.168.1.23\r\n\r\n"

func TestRegQueryParse(t *testing.T) {
	vals := parseRegQuery(regStatic)
	if v := vals["Domain"]; v.Type != "REG_SZ" || v.Value != "" {
		t.Errorf("empty REG_SZ = %+v", v)
	}
	if v := vals["IPAddress"]; !reflect.DeepEqual(v.Multi, []string{"10.100.35.1", "192.168.5.9"}) {
		t.Errorf("multi = %+v", v)
	}
	got := configFromRegQuery(regStatic)
	want := Config{Addrs: []string{"10.100.35.1/24", "192.168.5.9/16"}, Gateway: "10.100.35.254", DNS: []string{"8.8.8.8", "1.1.1.1"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("static = %+v", got)
	}
	got = configFromRegQuery(regDHCP)
	if !reflect.DeepEqual(got, Config{DHCP: true}) {
		t.Errorf("dhcp = %+v", got)
	}
	// Space-separated NameServer and a 0.0.0.0 placeholder address.
	got = configFromReg(0, []string{"0.0.0.0", "10.0.0.2"}, []string{"0.0.0.0", "255.255.255.0"}, []string{"", "10.0.0.1"}, "8.8.8.8 8.8.4.4")
	want = Config{Addrs: []string{"10.0.0.2/24"}, Gateway: "10.0.0.1", DNS: []string{"8.8.8.8", "8.8.4.4"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("mixed = %+v", got)
	}
}

func TestParsePSInventory(t *testing.T) {
	// PowerShell quirks: @($null) → [null], a single value may arrive as a bare string.
	out := []byte("\xef\xbb\xbf" + `[{"index":12,"guid":"{abc}","name":"อีเทอร์เน็ต","description":"Realtek","status":"Up","mac":"AA-BB","isWifi":false,` +
		`"ifMetric":25,"ipDhcp":"Disabled","ips":["10.100.35.1/24"],"gateway":"10.100.35.254","routeMetric":0,"dns":[null],` +
		`"regDhcp":0,"regIp":"10.100.35.1","regMask":["255.255.255.0"],"regGw":[null],"regNs":""},` +
		`{"index":7,"guid":"{def}","name":"Wi-Fi","description":"Intel","status":"Disconnected","mac":"CC","isWifi":true,` +
		`"ifMetric":35,"ipDhcp":"Enabled","ips":[],"gateway":"0.0.0.0","routeMetric":5,"dns":["",""],` +
		`"regDhcp":1,"regIp":[null],"regMask":[null],"regGw":[null],"regNs":"8.8.8.8"}]`)
	list, err := parsePSInventory(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 2 {
		t.Fatalf("len = %d", len(list))
	}
	a := list[0]
	if a.Name != "อีเทอร์เน็ต" || a.GUID != "{ABC}" || a.DHCP || a.Gateway != "10.100.35.254" || len(a.DNS) != 0 ||
		!reflect.DeepEqual(a.Config, Config{Addrs: []string{"10.100.35.1/24"}}) {
		t.Errorf("a = %+v", a)
	}
	b := list[1]
	if !b.DHCP || b.Gateway != "" || b.RouteMetric != -1 || !reflect.DeepEqual(b.Config, Config{DHCP: true, DNS: []string{"8.8.8.8"}}) {
		t.Errorf("b = %+v", b)
	}
	markInternet(list)
	if !list[0].IsInternet || list[1].IsInternet {
		t.Errorf("isInternet = %v %v", list[0].IsInternet, list[1].IsInternet)
	}
	// Single object (not wrapped) and empty output.
	if l, err := parsePSInventory([]byte(`{"index":1,"guid":"{x}","status":"Up"}`)); err != nil || len(l) != 1 {
		t.Errorf("single = %v %v", l, err)
	}
	if l, err := parsePSInventory([]byte("\r\n")); err != nil || len(l) != 0 {
		t.Errorf("empty = %v %v", l, err)
	}
}

func TestMarkInternet(t *testing.T) {
	l := []Adapter{
		{Status: "Up", Gateway: "10.0.0.1", RouteMetric: 0, IfMetric: 35},
		{Status: "Up", Gateway: "192.168.1.1", RouteMetric: 0, IfMetric: 25},
		{Status: "Disconnected", Gateway: "172.16.0.1", RouteMetric: 0, IfMetric: 1},
		{Status: "Up", RouteMetric: -1, IfMetric: 0},
	}
	markInternet(l)
	if l[0].IsInternet || !l[1].IsInternet || l[2].IsInternet || l[3].IsInternet {
		t.Errorf("%+v", l)
	}
}

func TestConfigEqual(t *testing.T) {
	a := Config{Addrs: []string{"1.1.1.1/24", "2.2.2.2/24"}, Gateway: "1.1.1.254", DNS: []string{"8.8.8.8", "1.1.1.1"}}
	b := Config{Addrs: []string{"2.2.2.2/24", "1.1.1.1/24"}, Gateway: "1.1.1.254", DNS: []string{"8.8.8.8", "1.1.1.1"}}
	if !configEqual(a, b) {
		t.Error("address order should not matter")
	}
	b.DNS = []string{"1.1.1.1", "8.8.8.8"}
	if configEqual(a, b) {
		t.Error("DNS order matters")
	}
	if !configEqual(Config{DHCP: true}, Config{DHCP: true, Addrs: []string{"x"}, Gateway: "y"}) {
		t.Error("DHCP ignores addrs/gateway")
	}
	if configEqual(Config{DHCP: true}, Config{DHCP: true, DNS: []string{"8.8.8.8"}}) {
		t.Error("DHCP compares static DNS")
	}
}
