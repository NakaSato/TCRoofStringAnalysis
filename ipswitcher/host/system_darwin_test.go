//go:build darwin

package main

import (
	"reflect"
	"testing"
)

func TestMacParsers(t *testing.T) {
	svcs := parseServiceOrder(`An asterisk (*) denotes that a network service is disabled.
(1) USB 10/100/1000 LAN
(Hardware Port: USB 10/100/1000 LAN, Device: en5)

(*) Thunderbolt Bridge
(Hardware Port: Thunderbolt Bridge, Device: bridge0)

(3) Wi-Fi
(Hardware Port: Wi-Fi, Device: en0)
`)
	want := []macService{{"USB 10/100/1000 LAN", "USB 10/100/1000 LAN", "en5", false}, {"Thunderbolt Bridge", "Thunderbolt Bridge", "bridge0", true}, {"Wi-Fi", "Wi-Fi", "en0", false}}
	if !reflect.DeepEqual(svcs, want) {
		t.Fatalf("services = %+v", svcs)
	}

	c := parseGetInfo("Manual Configuration\nIP address: 10.1.4.250\nSubnet mask: 255.255.255.0\nRouter: 10.1.4.254\n")
	if !reflect.DeepEqual(c, Config{Addrs: []string{"10.1.4.250/24"}, Gateway: "10.1.4.254"}) {
		t.Fatalf("manual = %+v", c)
	}
	c = parseGetInfo("Manual Configuration\nIP address: 192.168.0.250\nSubnet mask: 255.255.255.0\nRouter: (null)\n")
	if c.Gateway != "" || c.DHCP || c.Addrs[0] != "192.168.0.250/24" {
		t.Fatalf("no router = %+v", c)
	}
	c = parseGetInfo("DHCP Configuration\nIP address: 10.50.30.25\nSubnet mask: 255.255.255.0\nRouter: 10.50.30.254\n")
	if !c.DHCP || len(c.Addrs) != 0 || c.Gateway != "" {
		t.Fatalf("dhcp = %+v", c)
	}

	if d := parseDNS("There aren't any DNS Servers set on Wi-Fi.\n"); len(d) != 0 {
		t.Fatalf("no dns = %v", d)
	}
	if d := parseDNS("8.8.8.8\n1.1.1.1\n"); !reflect.DeepEqual(d, []string{"8.8.8.8", "1.1.1.1"}) {
		t.Fatalf("dns = %v", d)
	}

	up, ips, mac := parseIfconfig("en0: flags=8863<UP>\n\tether 74:a6:cd:d9:24:e4\n\tinet 10.50.30.25 netmask 0xffffff00 broadcast 10.50.30.255\n\tstatus: active\n")
	if !up || !reflect.DeepEqual(ips, []string{"10.50.30.25/24"}) || mac != "74-A6-CD-D9-24-E4" {
		t.Fatalf("ifconfig = %v %v %v", up, ips, mac)
	}
	if up, _, _ := parseIfconfig("en3: flags=8822\n\tether ca:a7:2e:91:dc:b0\n\tstatus: inactive\n"); up {
		t.Fatal("inactive reported up")
	}

	r := parseDefaultRoutes("Destination Gateway Flags Netif Expire\ndefault 10.50.30.254 UGScg en0\ndefault 192.168.1.1 UGScIg en5\ndefault link#20 UCSIg bridge0\n")
	if r["en0"] != [2]string{"10.50.30.254", "0"} || r["en5"] != [2]string{"192.168.1.1", "1"} || len(r) != 2 {
		t.Fatalf("routes = %v", r)
	}
}
