package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const (
	claimStaleAfter = 2 * time.Minute
	watchdogGrace   = 10 * time.Minute // the watchdog gives up this long after the deadline
	beatStaleAfter  = 5 * time.Second
)

var errNoPending = errors.New("nothing pending")

func (h *host) readPending() (*pendingFile, error) {
	var pf pendingFile
	ok, err := readJSON(h.path("pending.json"), &pf)
	if err != nil || !ok {
		return nil, err
	}
	return &pf, nil
}

// claimPending renames pending.json to a claim file. Only one process can win the rename, so the
// watchdog and a user's Keep / Revert never both act on the same change.
func (h *host) claimPending() (string, *pendingFile, error) {
	claim := h.path(fmt.Sprintf("pending.claim-%d-%d.json", os.Getpid(), time.Now().UnixNano()))
	if err := renameRetry(h.path("pending.json"), claim); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil, errNoPending
		}
		return "", nil, err
	}
	now := time.Now()
	_ = os.Chtimes(claim, now, now) // the claim's age is how others tell it is still being worked on
	var pf pendingFile
	if ok, err := readJSON(claim, &pf); err != nil || !ok {
		os.Remove(claim)
		return "", nil, errNoPending
	}
	return claim, &pf, nil
}

// unclaim puts a claim back as pending.json; deadline non-nil moves the deadline (e.g. to now, to retry).
func (h *host) unclaim(claim string, deadline *time.Time) {
	if deadline != nil {
		var pf pendingFile
		if ok, _ := readJSON(claim, &pf); ok {
			pf.Deadline = deadline.UnixMilli()
			if err := writeJSONAtomic(h.path("pending.json"), &pf); err == nil {
				os.Remove(claim)
				return
			}
		}
	}
	_ = renameRetry(claim, h.path("pending.json"))
}

// claimActive reports whether a fresh claim file exists (someone is acting on the change right now).
func (h *host) claimActive() bool {
	m, _ := filepath.Glob(h.path("pending.claim-*.json"))
	for _, f := range m {
		if fi, err := os.Stat(f); err == nil && time.Since(fi.ModTime()) < claimStaleAfter {
			return true
		}
	}
	return false
}

// recoverStaleClaims turns claim files left by a crashed process back into a pending change that is due now.
func (h *host) recoverStaleClaims() {
	m, _ := filepath.Glob(h.path("pending.claim-*.json"))
	for _, f := range m {
		fi, err := os.Stat(f)
		if err != nil || time.Since(fi.ModTime()) < claimStaleAfter {
			continue
		}
		if fileExists(h.path("pending.json")) {
			os.Remove(f)
			continue
		}
		now := h.now()
		h.unclaim(f, &now)
	}
}

func (h *host) confirm() (any, *hostError) {
	claim, pf, err := h.claimPending()
	if errors.Is(err, errNoPending) {
		return nil, herr("no_pending", "Nothing is waiting for Keep.", nil)
	}
	if err != nil {
		return nil, herr("internal", "Could not claim pending.json: "+err.Error(), nil)
	}
	os.Remove(claim)
	if !fileExists(h.path("pending.json")) {
		h.disarmFailsafe()
	}
	h.audit(AuditEntry{Action: "keep", Adapter: pf.Adapter, Index: pf.Index, From: &pf.Snapshot, To: &pf.Applied,
		Profile: pf.Profile, Source: pf.Source, Context: pf.Context, Result: "ok"})
	return map[string]any{"kept": true}, nil
}

func (h *host) revert() (Adapter, *hostError) {
	claim, pf, err := h.claimPending()
	if errors.Is(err, errNoPending) {
		return Adapter{}, herr("no_pending", "Nothing is waiting to be reverted.", nil)
	}
	if err != nil {
		return Adapter{}, herr("internal", "Could not claim pending.json: "+err.Error(), nil)
	}
	ad, e := h.revertClaimed(claim, pf, "revert", pf.Source)
	if e != nil {
		_ = h.spawnWatchdog() // the change is back in pending.json, due now; make sure someone retries
	}
	return ad, e
}

// revertClaimed restores the snapshot of a claimed change. On failure the change goes back to
// pending.json with deadline = now, so it is retried.
func (h *host) revertClaimed(claim string, pf *pendingFile, action, source string) (Adapter, *hostError) {
	fail := func(e *hostError) (Adapter, *hostError) {
		now := h.now()
		if fileExists(h.path("pending.json")) {
			os.Remove(claim) // a newer change took over; it has its own snapshot
		} else {
			h.unclaim(claim, &now)
		}
		act := action
		if action == "rollback" {
			act = "rollback_failed"
		}
		h.audit(AuditEntry{Action: act, Adapter: pf.Adapter, Index: pf.Index, From: &pf.Applied, To: &pf.Snapshot,
			Profile: pf.Profile, Source: source, Context: pf.Context, Result: "error", Detail: fmt.Sprint(e.Detail)})
		return Adapter{}, e
	}
	inv, err := h.inventory(true)
	if err != nil {
		e := sysError(err)
		if e.Detail == nil {
			e.Detail = err.Error()
		}
		return fail(e)
	}
	ad, ok := findAdapter(inv, pf.GUID, pf.Index)
	if !ok {
		return fail(herr("no_adapter", fmt.Sprintf("%s is not connected, so it can't be reverted yet.", pf.Adapter),
			"adapter "+pf.GUID+" not in the inventory"))
	}
	from := ad.Config
	if _, e := h.writeConfig(ad.Index, ad.GUID, pf.Snapshot); e != nil {
		return fail(e)
	}
	if !pf.Snapshot.DHCP && pf.PrevStatic != nil && configEqual(pf.PrevStatic.Config, pf.Snapshot) {
		h.setStatic(ad.GUID, pf.PrevStatic)
	} else {
		h.setStatic(ad.GUID, nil)
	}
	os.Remove(claim)
	if !fileExists(h.path("pending.json")) {
		h.disarmFailsafe()
	}
	h.audit(AuditEntry{Action: action, Adapter: ad.Name, Index: ad.Index, From: &from, To: &pf.Snapshot,
		Profile: pf.Profile, Source: source, Context: pf.Context, Result: "ok"})
	return h.freshAdapter(ad, pf.Snapshot), nil
}

// revertIfDue reverts the pending change if its deadline has passed. Returns whether it acted.
func (h *host) revertIfDue() (bool, *hostError) {
	pf, err := h.readPending()
	if err != nil || pf == nil || h.now().Before(pf.deadline()) {
		return false, nil
	}
	claim, claimed, err := h.claimPending()
	if err != nil {
		return false, nil // someone else got it
	}
	if h.now().Before(claimed.deadline()) {
		h.unclaim(claim, nil) // the deadline moved after we looked
		return false, nil
	}
	_, e := h.revertClaimed(claim, claimed, "rollback", "watchdog")
	return true, e
}

// startup runs at the start of every native-messaging run: revert an overdue change (killed
// watchdog, sleep, reboot) and restart the watchdog if one is pending without a live watchdog.
func (h *host) startup() {
	h.recoverStaleClaims()
	_, _ = h.revertIfDue()
	if pf, _ := h.readPending(); pf != nil {
		fi, err := os.Stat(h.path("watchdog.beat"))
		if err != nil || time.Since(fi.ModTime()) > beatStaleAfter {
			_ = h.spawnWatchdog()
		}
	} else if !h.claimActive() {
		h.disarmFailsafe()
	}
}

func (h *host) beat() {
	p := h.path("watchdog.beat")
	now := time.Now()
	if err := os.Chtimes(p, now, now); err != nil {
		_ = os.WriteFile(p, []byte(fmt.Sprint(os.Getpid())), 0o600)
	}
}

// watchdog waits for the pending deadline and reverts. It re-reads pending.json every tick (a
// second apply moves the deadline) and exits when nothing is pending.
func (h *host) watchdog() {
	failures := 0
	for {
		h.beat()
		pf, err := h.readPending()
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			// A half-written file can't happen (atomic rename); treat as transient.
			h.sleep(time.Second)
			continue
		}
		if pf == nil {
			if h.claimActive() {
				h.sleep(time.Second) // a Keep / Revert / apply is in progress; it may put the file back
				continue
			}
			return
		}
		now := h.now()
		if now.After(pf.deadline().Add(watchdogGrace)) {
			h.audit(AuditEntry{Action: "rollback_failed", Adapter: pf.Adapter, Index: pf.Index, From: &pf.Applied,
				To: &pf.Snapshot, Profile: pf.Profile, Source: "watchdog", Context: pf.Context, Result: "error",
				Detail: "watchdog gave up 10 minutes after the deadline; the next helper start will retry"})
			return
		}
		if !now.Before(pf.deadline()) {
			acted, e := h.revertIfDue()
			if acted && e == nil {
				return
			}
			if e != nil {
				failures++
				if failures >= h.maxRetries {
					return
				}
				h.sleep(h.retryEvery)
			} else if !acted {
				h.sleep(200 * time.Millisecond)
			}
			continue
		}
		wait := pf.deadline().Sub(now)
		if wait > time.Second {
			wait = time.Second
		}
		h.sleep(wait)
	}
}

// armFailsafe sets the RunOnce entry (revert at next sign-in) and remembers it did.
func (h *host) armFailsafe() {
	if err := h.setFailsafe(); err == nil {
		_ = os.WriteFile(h.path("runonce.set"), nil, 0o600)
	}
}

// disarmFailsafe removes the RunOnce entry, only if this helper set it (saves a reg.exe run per call).
func (h *host) disarmFailsafe() {
	if !fileExists(h.path("runonce.set")) {
		return
	}
	_ = h.clearFailsafe()
	os.Remove(h.path("runonce.set"))
}
