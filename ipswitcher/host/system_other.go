//go:build !windows

package main

import (
	"errors"
	"net/netip"
	"os"
	"os/exec"
	"syscall"
	"time"
)

var errWindowsOnly = errors.New("Windows only")

// unsupportedSystem is the real system on anything but Windows: every call fails.
type unsupportedSystem struct{}

func (unsupportedSystem) listAdapters(bool) ([]Adapter, error) { return nil, errWindowsOnly }
func (unsupportedSystem) readConfig(string) (Config, error)    { return Config{}, errWindowsOnly }
func (unsupportedSystem) netsh([]string) (string, error)       { return "", errWindowsOnly }
func (unsupportedSystem) canWrite() (bool, error)              { return false, errWindowsOnly }
func (unsupportedSystem) ping(netip.Addr, time.Duration) (bool, int, error) {
	return false, 0, errWindowsOnly
}

// newPlatformSystem: the fake when IPSWITCHER_FAKE=1 (dev on a Mac), else "Windows only".
func newPlatformSystem(dir string) system {
	if fakeEnabled() {
		return newFakeSystem(dir)
	}
	return unsupportedSystem{}
}

// spawnWatchdogProcess starts `<exe> --watchdog` in its own session (used by the fake smoke run).
func spawnWatchdogProcess() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, "--watchdog")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// The RunOnce fail-safe exists only on Windows.
func setRunOnce() error   { return nil }
func clearRunOnce() error { return nil }
