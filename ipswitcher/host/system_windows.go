//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

const (
	createNoWindow         = 0x08000000
	createBreakawayFromJob = 0x01000000
	detachedProcess        = 0x00000008
	createNewProcessGroup  = 0x00000200

	childTimeout = 30 * time.Second
	regIfaces    = `HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\`
	runOnceKey   = `HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce`
	runOnceValue = "IPSwitcherRevert"
)

type windowsSystem struct{}

func newPlatformSystem(string) system { return windowsSystem{} }

func sys32(name string) string {
	if root := os.Getenv("SystemRoot"); root != "" {
		p := filepath.Join(root, "System32", name)
		if fileExists(p) {
			return p
		}
	}
	return name
}

// run starts a hidden child (no console window flashes) with a 30 s timeout.
func run(name string, args ...string) (stdout, stderr []byte, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), childTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	var o, e bytes.Buffer
	cmd.Stdout, cmd.Stderr = &o, &e
	err = cmd.Run()
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		err = fmt.Errorf("%s: %w", filepath.Base(name), errTimeout)
	}
	return o.Bytes(), e.Bytes(), err
}

// powershell runs a script via -EncodedCommand (base64 of UTF-16LE), so no quoting reaches a shell.
func powershell(script string) ([]byte, error) {
	u := utf16.Encode([]rune(script))
	b := make([]byte, len(u)*2)
	for i, c := range u {
		binary.LittleEndian.PutUint16(b[i*2:], c)
	}
	exe := sys32(`WindowsPowerShell\v1.0\powershell.exe`)
	if exe == `WindowsPowerShell\v1.0\powershell.exe` {
		exe = "powershell.exe"
	}
	out, errOut, err := run(exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
		"-EncodedCommand", base64.StdEncoding.EncodeToString(b))
	if err != nil {
		return out, fmt.Errorf("powershell: %w: %s", err, strings.TrimSpace(string(errOut)))
	}
	return out, nil
}

// inventoryScript emits one JSON record per adapter that has IPv4 (see psAdapter).
const inventoryScript = `
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$showAll = __SHOWALL__
if ($showAll) { $ads = @(Get-NetAdapter) } else { $ads = @(Get-NetAdapter -Physical) }
$out = @()
foreach ($a in $ads) {
  if ($null -eq $a) { continue }
  $ipif = @(Get-NetIPInterface -InterfaceIndex $a.ifIndex -AddressFamily IPv4)
  if ($ipif.Count -eq 0 -or $null -eq $ipif[0]) { continue }
  $addrs = @(Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 | ForEach-Object { [string]$_.IPAddress + '/' + [string]$_.PrefixLength })
  $routes = @(Get-NetRoute -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -PolicyStore ActiveStore | Sort-Object -Property RouteMetric)
  $gw = ''
  $rm = -1
  if ($routes.Count -gt 0 -and $null -ne $routes[0]) { $gw = [string]$routes[0].NextHop; $rm = [int]$routes[0].RouteMetric }
  $dns = @()
  $dnsObj = @(Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4)
  foreach ($d in $dnsObj) { if ($null -ne $d -and $null -ne $d.ServerAddresses) { $dns += @($d.ServerAddresses) } }
  $guid = [string]$a.InterfaceGuid
  $r = Get-ItemProperty -LiteralPath ('HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\' + $guid)
  $regDhcp = -1
  $regIp = @()
  $regMask = @()
  $regGw = @()
  $regNs = ''
  if ($null -ne $r) {
    if ($null -ne $r.EnableDHCP) { $regDhcp = [int]$r.EnableDHCP }
    if ($null -ne $r.IPAddress) { $regIp = @($r.IPAddress) }
    if ($null -ne $r.SubnetMask) { $regMask = @($r.SubnetMask) }
    if ($null -ne $r.DefaultGateway) { $regGw = @($r.DefaultGateway) }
    if ($null -ne $r.NameServer) { $regNs = [string]$r.NameServer }
  }
  $wifi = ($a.NdisPhysicalMedium -eq 9) -or ([string]$a.PhysicalMediaType -like '*802.11*')
  $out += [pscustomobject]@{
    index = [int]$a.ifIndex
    guid = $guid
    name = [string]$a.Name
    description = [string]$a.InterfaceDescription
    status = [string]$a.Status
    mac = [string]$a.MacAddress
    isWifi = [bool]$wifi
    ifMetric = [int]$ipif[0].InterfaceMetric
    ipDhcp = [string]$ipif[0].Dhcp
    ips = $addrs
    gateway = $gw
    routeMetric = $rm
    dns = $dns
    regDhcp = $regDhcp
    regIp = $regIp
    regMask = $regMask
    regGw = $regGw
    regNs = $regNs
  }
}
ConvertTo-Json -InputObject @($out) -Depth 5 -Compress
`

func (windowsSystem) listAdapters(showAll bool) ([]Adapter, error) {
	flag := "$false"
	if showAll {
		flag = "$true"
	}
	out, err := powershell(strings.Replace(inventoryScript, "__SHOWALL__", flag, 1))
	if err != nil {
		return nil, err
	}
	list, err := parsePSInventory(out)
	if err != nil {
		return nil, fmt.Errorf("adapter list: %w", err)
	}
	return list, nil
}

// readConfig reads the stored setting straight from the registry (fast; used to verify writes).
func (windowsSystem) readConfig(guid string) (Config, error) {
	out, errOut, err := run(sys32("reg.exe"), "query", regIfaces+guid)
	if err != nil {
		return Config{}, fmt.Errorf("reg query: %w: %s", err, strings.TrimSpace(string(errOut)))
	}
	return configFromRegQuery(string(out)), nil
}

// netsh runs netsh.exe with an argument list. Its exit code and localized text are not trusted.
func (windowsSystem) netsh(args []string) (string, error) {
	out, errOut, err := run(sys32("netsh.exe"), args...)
	text := strings.ToValidUTF8(strings.TrimSpace(string(out)+"\n"+string(errOut)), "?")
	return text, err
}

const canWriteScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$nco = $p.IsInRole([Security.Principal.SecurityIdentifier]'S-1-5-32-556')
$adm = $p.IsInRole([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
if ($nco -or $adm) { 'true' } else { 'false' }
`

// canWrite: member of Network Configuration Operators, or an elevated admin (UAC-filtered = false).
func (windowsSystem) canWrite() (bool, error) {
	out, err := powershell(canWriteScript)
	if err != nil {
		return false, err
	}
	switch strings.TrimSpace(strings.TrimPrefix(string(out), "\xef\xbb\xbf")) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	}
	return false, fmt.Errorf("canWrite: unexpected output %q", string(out))
}

var (
	iphlpapi            = syscall.NewLazyDLL("iphlpapi.dll")
	procIcmpCreateFile  = iphlpapi.NewProc("IcmpCreateFile")
	procIcmpSendEcho    = iphlpapi.NewProc("IcmpSendEcho")
	procIcmpCloseHandle = iphlpapi.NewProc("IcmpCloseHandle")
)

// ping sends one ICMP echo with IcmpSendEcho (works without admin; no ping.exe text to parse).
func (windowsSystem) ping(addr netip.Addr, timeout time.Duration) (bool, int, error) {
	if err := iphlpapi.Load(); err != nil {
		return false, 0, err
	}
	h, _, callErr := procIcmpCreateFile.Call()
	if h == 0 || h == ^uintptr(0) {
		return false, 0, fmt.Errorf("IcmpCreateFile: %v", callErr)
	}
	defer procIcmpCloseHandle.Call(h)

	a4 := addr.As4()
	dest := binary.LittleEndian.Uint32(a4[:]) // IPAddr: the 4 bytes in memory (network) order
	data := []byte("ipswitcher-ping!")
	reply := make([]byte, 256+len(data)) // ICMP_ECHO_REPLY (40 B on x64) + data + 8 + room for an ICMP error
	ms := uint32(timeout / time.Millisecond)
	n, _, _ := procIcmpSendEcho.Call(h, uintptr(dest),
		uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)), 0,
		uintptr(unsafe.Pointer(&reply[0])), uintptr(len(reply)), uintptr(ms))
	if n == 0 {
		return false, 0, nil // no reply within the timeout (or unreachable)
	}
	status := binary.LittleEndian.Uint32(reply[4:8])
	rtt := binary.LittleEndian.Uint32(reply[8:12])
	if status != 0 {
		return false, 0, nil
	}
	return true, int(rtt), nil
}

// spawnWatchdogProcess starts `<exe> --watchdog` detached from Chrome (and its job object if allowed).
func spawnWatchdogProcess() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	start := func(flags uint32) error {
		cmd := exec.Command(exe, "--watchdog")
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: flags}
		// Stdin/Stdout/Stderr nil → NUL: nothing inherited from the native-messaging pipes.
		if err := cmd.Start(); err != nil {
			return err
		}
		return cmd.Process.Release()
	}
	base := uint32(detachedProcess | createNewProcessGroup)
	if err := start(base | createBreakawayFromJob); err != nil {
		// Chrome may run the host in a job object that forbids breakaway.
		return start(base)
	}
	return nil
}

// setRunOnce registers `"<exe>" --revert-due` to run at the next sign-in while a change is pending.
func setRunOnce() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	_, errOut, err := run(sys32("reg.exe"), "add", runOnceKey, "/v", runOnceValue, "/t", "REG_SZ",
		"/d", `"`+exe+`" --revert-due`, "/f")
	if err != nil {
		return fmt.Errorf("reg add RunOnce: %w: %s", err, strings.TrimSpace(string(errOut)))
	}
	return nil
}

func clearRunOnce() error {
	_, _, err := run(sys32("reg.exe"), "delete", runOnceKey, "/v", runOnceValue, "/f")
	return err // fails harmlessly when the value isn't there
}
