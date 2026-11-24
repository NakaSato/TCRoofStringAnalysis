// Command ipswitch-host is the IP Switcher native messaging host (protocol: ipswitcher/PROTOCOL.md).
//
//	ipswitch-host                       native messaging on stdin/stdout (Chrome passes
//	ipswitch-host chrome-extension://…  the origin and --parent-window=N; both ignored)
//	ipswitch-host --watchdog            wait for the pending deadline and revert
//	ipswitch-host --revert-due          revert now if overdue, else become the watchdog
//	ipswitch-host --version
package main

import (
	"fmt"
	"os"
)

var version = "0.1.0"

func main() {
	mode := ""
	for _, a := range os.Args[1:] {
		switch a {
		case "--watchdog", "--revert-due", "--version":
			mode = a
		}
	}
	if mode == "--version" {
		fmt.Println(version)
		return
	}

	// Native messaging owns stdout: keep the real one for frames and send any stray print to stderr.
	out := os.Stdout
	os.Stdout = os.Stderr

	dir, err := dataDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "ipswitch-host: data folder:", err)
		os.Exit(1)
	}
	h := newHost(dir, newPlatformSystem(dir))

	switch mode {
	case "--watchdog":
		h.watchdog()
	case "--revert-due":
		h.recoverStaleClaims()
		if pf, _ := h.readPending(); pf == nil {
			h.disarmFailsafe()
			return
		}
		if acted, e := h.revertIfDue(); acted && e == nil {
			return
		}
		h.watchdog()
	default:
		h.startup()
		if err := h.serve(os.Stdin, out); err != nil {
			fmt.Fprintln(os.Stderr, "ipswitch-host:", err)
			os.Exit(1)
		}
	}
}
