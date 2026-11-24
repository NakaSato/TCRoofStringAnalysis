package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

const wifiWarning = "A static IP applies to this adapter, not only to this network."

type host struct {
	sys  system
	dir  string
	user string

	now   func() time.Time
	sleep func(time.Duration)

	// Swappable so tests never spawn processes or touch the registry.
	spawnWatchdog func() error
	setFailsafe   func() error
	clearFailsafe func() error

	verifyTimeout time.Duration // how long to wait for the stored config to match
	verifyEvery   time.Duration
	retryEvery    time.Duration // watchdog retry after a failed rollback
	maxRetries    int
}

func newHost(dir string, sys system) *host {
	return &host{
		sys: sys, dir: dir, user: currentUser(),
		now: time.Now, sleep: time.Sleep,
		spawnWatchdog: spawnWatchdogProcess, setFailsafe: setRunOnce, clearFailsafe: clearRunOnce,
		verifyTimeout: 5 * time.Second, verifyEvery: 500 * time.Millisecond,
		retryEvery: 5 * time.Second, maxRetries: 10,
	}
}

// writeConfig runs the netsh plan for c on the adapter and verifies the stored config.
// netsh's exit code and (localized) text are not trusted; only the re-read config counts.
func (h *host) writeConfig(index int, guid string, c Config) (string, *hostError) {
	var log strings.Builder
	timedOut := false
	for _, args := range planConfig(index, c) {
		out, err := h.sys.netsh(args)
		fmt.Fprintf(&log, "netsh %s\n%s", strings.Join(args, " "), strings.TrimSpace(out))
		if err != nil {
			fmt.Fprintf(&log, " [%v]", err)
			if errors.Is(err, errTimeout) {
				timedOut = true
			}
		}
		log.WriteString("\n")
	}
	deadline := h.now().Add(h.verifyTimeout)
	var got Config
	var rerr error
	for {
		got, rerr = h.sys.readConfig(guid)
		if rerr == nil && configEqual(got, c) {
			return log.String(), nil
		}
		if !h.now().Before(deadline) {
			break
		}
		h.sleep(h.verifyEvery)
	}
	if rerr != nil {
		fmt.Fprintf(&log, "re-read failed: %v\n", rerr)
	} else {
		fmt.Fprintf(&log, "stored config after write: %s\n", describeConfig(got))
	}
	fmt.Fprintf(&log, "wanted: %s\n", describeConfig(c))
	if timedOut {
		return log.String(), herr("timeout", "netsh did not finish within 30 seconds and the setting did not change.", log.String())
	}
	return log.String(), herr("write_failed", "Windows did not accept the new setting.", log.String())
}

func describeConfig(c Config) string {
	if c.DHCP {
		if len(c.DNS) > 0 {
			return "DHCP, DNS " + strings.Join(c.DNS, ", ")
		}
		return "DHCP"
	}
	s := strings.Join(c.Addrs, ", ")
	if s == "" {
		s = "static, no address"
	}
	if c.Gateway != "" {
		s += " via " + c.Gateway
	}
	if len(c.DNS) > 0 {
		s += ", DNS " + strings.Join(c.DNS, ", ")
	}
	return s
}

type applyResult struct {
	Adapter  Adapter  `json:"adapter"`
	Pending  *Pending `json:"pending"`
	Test     *Test    `json:"test"`
	Warnings []string `json:"warnings"`
}

func (h *host) apply(a applyArgs) (any, *hostError) {
	p, ferrs := validateApply(a)
	if len(ferrs) > 0 {
		return nil, herr("invalid", ferrs[0].Message, ferrs)
	}
	ok, err := h.sys.canWrite()
	if err != nil {
		return nil, sysError(err)
	}
	if !ok {
		return nil, herr("no_permission",
			"This Windows account can't change IP settings. Add it to the Network Configuration Operators group.", nil)
	}
	inv, err := h.inventory(true)
	if err != nil {
		return nil, sysError(err)
	}
	ad, found := findAdapter(inv, "", p.index)
	if !found || ad.Index != p.index {
		return nil, herr("no_adapter", fmt.Sprintf("No adapter with index %d. Refresh the adapter list.", p.index), nil)
	}
	var notAcked []map[string]string
	for _, g := range guardrails(p, ad, inv) {
		if !p.ack[g["code"]] {
			notAcked = append(notAcked, g)
		}
	}
	if len(notAcked) > 0 {
		return nil, herr("needs_confirm", "Confirm the warnings to continue.", notAcked)
	}
	warnings := []string{}
	if ad.IsWifi && !p.target.DHCP {
		warnings = append(warnings, wifiWarning)
	}

	existing, err := h.readPending()
	if err != nil {
		return nil, herr("internal", "Could not read pending.json: "+err.Error(), nil)
	}
	if existing != nil && existing.GUID != ad.GUID {
		return nil, herr("busy", fmt.Sprintf("A change on %s is waiting for Keep or Revert.", existing.Adapter), existing.Pending)
	}

	before := ad.Config
	snapshot := before
	prevStatic := h.staticFor(ad.GUID)
	claimPath := ""
	if existing != nil {
		// Same adapter: take the pending change over, keeping its original snapshot.
		cp, claimed, err := h.claimPending()
		if err != nil {
			return nil, herr("busy", "A rollback is in progress. Try again in a few seconds.", nil)
		}
		claimPath, snapshot, prevStatic = cp, claimed.Snapshot, claimed.PrevStatic
	}
	restoreClaim := func() {
		if claimPath != "" {
			h.unclaim(claimPath, nil)
		}
	}

	var pf *pendingFile
	if p.rollbackSec > 0 {
		pf = &pendingFile{
			Pending: Pending{
				Index: ad.Index, GUID: ad.GUID, Adapter: ad.Name,
				Deadline: h.now().Add(time.Duration(p.rollbackSec) * time.Second).UnixMilli(),
				Snapshot: snapshot, Applied: p.target, Profile: a.Profile, Source: p.source,
			},
			Context: a.Context, PrevStatic: prevStatic,
		}
		// The rollback must be armed before netsh touches anything.
		if err := writeJSONAtomic(h.path("pending.json"), pf); err != nil {
			restoreClaim()
			return nil, herr("internal", "Could not save the rollback point: "+err.Error(), nil)
		}
		if err := h.spawnWatchdog(); err != nil {
			if claimPath != "" {
				restoreClaim()
			} else {
				os.Remove(h.path("pending.json"))
			}
			return nil, herr("internal", "Could not start the rollback timer: "+err.Error(), nil)
		}
		h.armFailsafe()
	}

	out, werr := h.writeConfig(ad.Index, ad.GUID, p.target)
	if werr != nil {
		// Put the adapter back the way it was before this write.
		if _, rerr := h.writeConfig(ad.Index, ad.GUID, before); rerr != nil {
			werr.Detail = fmt.Sprint(werr.Detail) + "\nrestore of the previous setting also failed:\n" + fmt.Sprint(rerr.Detail)
		}
		if claimPath != "" {
			restoreClaim()
		} else if pf != nil {
			os.Remove(h.path("pending.json"))
			h.disarmFailsafe()
		}
		h.audit(AuditEntry{Action: "apply", Adapter: ad.Name, Index: ad.Index, From: &before, To: &p.target,
			Profile: a.Profile, Source: p.source, Context: a.Context, Result: "error", Detail: fmt.Sprint(werr.Detail)})
		return nil, werr
	}
	_ = out
	if claimPath != "" {
		os.Remove(claimPath)
		if pf == nil {
			h.disarmFailsafe() // rollbackSec 0: the change is kept at once
		}
	}

	var test *Test
	if p.testHost.IsValid() {
		t := h.pingTest(p.testHost)
		test = &t
	}

	if p.target.DHCP {
		h.setStatic(ad.GUID, nil)
	} else {
		h.setStatic(ad.GUID, &Static{GUID: ad.GUID, Index: ad.Index, Adapter: ad.Name, Profile: a.Profile,
			Since: h.now().UnixMilli(), Config: p.target})
	}
	h.audit(AuditEntry{Action: "apply", Adapter: ad.Name, Index: ad.Index, From: &before, To: &p.target,
		Profile: a.Profile, Source: p.source, Context: a.Context, Result: "ok", Test: test})

	fresh := h.freshAdapter(ad, p.target)
	res := applyResult{Adapter: fresh, Test: test, Warnings: warnings}
	if pf != nil {
		res.Pending = &pf.Pending
	}
	return res, nil
}

// freshAdapter re-reads the adapter after a write; if that fails, the old record with the new config.
func (h *host) freshAdapter(old Adapter, cfg Config) Adapter {
	if list, err := h.inventory(true); err == nil {
		if a, ok := findAdapter(list, old.GUID, old.Index); ok {
			return a
		}
	}
	old.Config = cfg
	return old
}
