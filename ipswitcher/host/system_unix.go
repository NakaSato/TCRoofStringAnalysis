//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

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
