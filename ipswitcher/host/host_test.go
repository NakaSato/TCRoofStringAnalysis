package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type testHost struct {
	*host
	t      *testing.T
	fake   *fakeSystem
	clock  time.Time
	spawns int
	armed  int
}

func newTestHost(t *testing.T) *testHost {
	dir := t.TempDir()
	t.Setenv("IPSWITCHER_DATA_DIR", dir)
	th := &testHost{t: t, fake: newFakeSystem(dir), clock: time.Date(2026, 11, 24, 10, 0, 0, 0, time.Local)}
	h := newHost(dir, th.fake)
	h.user = `PC\tech`
	h.now = func() time.Time { return th.clock }
	h.sleep = func(d time.Duration) { th.clock = th.clock.Add(d) }
	h.spawnWatchdog = func() error { th.spawns++; return nil }
	h.setFailsafe = func() error { th.armed++; return nil }
	h.clearFailsafe = func() error { th.armed--; return nil }
	th.host = h
	return th
}

type reply struct {
	ID    string          `json:"id"`
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data"`
	Error *struct {
		Code    string          `json:"code"`
		Message string          `json:"message"`
		Detail  json.RawMessage `json:"detail"`
	} `json:"error"`
}

func (th *testHost) call(cmd string, args any) reply {
	th.t.Helper()
	req := map[string]any{"id": "r1", "v": 1, "cmd": cmd}
	if args != nil {
		req["args"] = args
	}
	b, _ := json.Marshal(req)
	var r reply
	if err := json.Unmarshal(th.handle(b), &r); err != nil {
		th.t.Fatal(err)
	}
	if r.ID != "r1" {
		th.t.Fatalf("reply id %q", r.ID)
	}
	return r
}

func (th *testHost) mustOK(cmd string, args any, out any) {
	th.t.Helper()
	r := th.call(cmd, args)
	if !r.OK {
		th.t.Fatalf("%s failed: %s %s %s", cmd, r.Error.Code, r.Error.Message, r.Error.Detail)
	}
	if out != nil {
		if err := json.Unmarshal(r.Data, out); err != nil {
			th.t.Fatal(err)
		}
	}
}

func (th *testHost) mustErr(cmd string, args any, code string) reply {
	th.t.Helper()
	r := th.call(cmd, args)
	if r.OK || r.Error.Code != code {
		th.t.Fatalf("%s: want error %s, got ok=%v %+v data=%s", cmd, code, r.OK, r.Error, r.Data)
	}
	return r
}

func (th *testHost) config(index int) Config {
	th.t.Helper()
	st, _ := th.fake.load()
	for _, a := range st.Adapters {
		if a.Index == index {
			return a.Config
		}
	}
	th.t.Fatalf("no adapter %d", index)
	return Config{}
}

func (th *testHost) pendingExists() bool { return fileExists(th.path("pending.json")) }

func (th *testHost) auditActions() []string {
	var out []string
	for _, l := range th.readAudit(500) {
		var e AuditEntry
		json.Unmarshal(l, &e)
		out = append(out, e.Action+":"+e.Result)
	}
	return out
}

var staticLAN = map[string]any{"index": 12, "mode": "static", "ip": "10.100.35.1", "prefix": 24,
	"gateway": "10.100.35.254", "dns": []string{"8.8.8.8", "1.1.1.1"}, "rollbackSec": 30,
	"testHost": "10.100.35.254", "profile": "TC LAN · 10.100.35.1", "source": "site",
	"context": map[string]string{"plantId": "P1", "plantName": "Plant 1", "equipmentId": "INV-1"}}

// ---------------- framing ----------------

func frame(b []byte) []byte {
	var hdr [4]byte
	binary.LittleEndian.PutUint32(hdr[:], uint32(len(b)))
	return append(hdr[:], b...)
}

func readReplies(t *testing.T, b []byte) []reply {
	t.Helper()
	var out []reply
	r := bytes.NewReader(b)
	for {
		var hdr [4]byte
		if _, err := r.Read(hdr[:]); err != nil {
			return out
		}
		buf := make([]byte, binary.LittleEndian.Uint32(hdr[:]))
		if _, err := r.Read(buf); err != nil {
			t.Fatal(err)
		}
		var rp reply
		if err := json.Unmarshal(buf, &rp); err != nil {
			t.Fatalf("%v: %s", err, buf)
		}
		out = append(out, rp)
	}
}

func TestFraming(t *testing.T) {
	th := newTestHost(t)
	var in bytes.Buffer
	in.Write(frame([]byte(`{"id":"a","v":1,"cmd":"health"}`)))
	in.Write(frame(bytes.Repeat([]byte("x"), maxRequest+1))) // oversized: drained
	in.Write(frame([]byte(`{"id":"b","v":1,"cmd":"nope"}`)))
	in.Write(frame([]byte(`{"id":"c","v":1,"cmd":"health","extra":1}`)))
	in.Write(frame([]byte(`{"id":"d","v":1,"cmd":"listAdapters","args":{"showAll":true,"x":1}}`)))
	in.Write(frame([]byte(`{"id":"e","v":1,"cmd":"listAdapters","args":{"showAll":"yes"}}`)))
	in.Write(frame([]byte(`{"id":"f","v":2,"cmd":"health"}`)))
	in.Write(frame([]byte(`{"id":"g","v":1,"cmd":"pending"}`)))
	in.Write(frame([]byte(`not json`)))
	in.Write(frame([]byte(`{"id":"h","v":1,"cmd":"health"} {}`)))
	in.Write([]byte{1, 0}) // truncated header at EOF: clean exit
	var out bytes.Buffer
	if err := th.serve(&in, &out); err != nil {
		t.Fatal(err)
	}
	rs := readReplies(t, out.Bytes())
	want := []struct{ id, code string }{
		{"a", ""}, {"", "too_large"}, {"b", "unknown_cmd"}, {"c", "bad_request"}, {"d", "bad_request"},
		{"e", "bad_request"}, {"f", "protocol"}, {"g", ""}, {"", "bad_request"}, {"h", "bad_request"},
	}
	if len(rs) != len(want) {
		t.Fatalf("got %d replies, want %d", len(rs), len(want))
	}
	for i, w := range want {
		code := ""
		if rs[i].Error != nil {
			code = rs[i].Error.Code
		}
		if rs[i].ID != w.id || code != w.code || rs[i].OK != (w.code == "") {
			t.Errorf("reply %d = id %q code %q ok %v, want %q %q", i, rs[i].ID, code, rs[i].OK, w.id, w.code)
		}
	}
	var health map[string]any
	json.Unmarshal(rs[0].Data, &health)
	if health["hostVersion"] != version || health["protocol"] != float64(1) || health["user"] != `PC\tech` || health["canWrite"] != true {
		t.Errorf("health = %v", health)
	}
	if string(rs[7].Data) != "null" {
		t.Errorf("pending with nothing pending = %s", rs[7].Data)
	}
}

// ---------------- end to end against the fake system ----------------

func TestListAdapters(t *testing.T) {
	th := newTestHost(t)
	var list []Adapter
	th.mustOK("listAdapters", nil, &list)
	if len(list) != 3 {
		t.Fatalf("physical adapters = %d", len(list))
	}
	var inet []string
	for _, a := range list {
		if a.IsInternet {
			inet = append(inet, a.Name)
		}
	}
	if len(inet) != 1 || inet[0] != "Wi-Fi" {
		t.Errorf("internet = %v", inet)
	}
	th.mustOK("listAdapters", map[string]any{"showAll": true}, &list)
	if len(list) != 4 {
		t.Fatalf("all adapters = %d", len(list))
	}
	r := th.call("listAdapters", nil)
	if !strings.Contains(string(r.Data), "อีเทอร์เน็ต 2") || !strings.Contains(string(r.Data), `"ips":[]`) {
		t.Errorf("raw = %s", r.Data)
	}
}

func TestApplyRevertRestoresSnapshot(t *testing.T) {
	th := newTestHost(t)
	before := th.config(12)
	var res struct {
		Adapter  Adapter  `json:"adapter"`
		Pending  *Pending `json:"pending"`
		Test     *Test    `json:"test"`
		Warnings []string `json:"warnings"`
	}
	th.mustOK("apply", staticLAN, &res)
	want := Config{Addrs: []string{"10.100.35.1/24"}, Gateway: "10.100.35.254", DNS: []string{"8.8.8.8", "1.1.1.1"}}
	if got := th.config(12); !configEqual(got, want) {
		t.Fatalf("applied = %+v", got)
	}
	if res.Pending == nil || !configEqual(res.Pending.Snapshot, before) || res.Pending.Deadline != th.clock.Add(30*time.Second).UnixMilli() {
		t.Fatalf("pending = %+v", res.Pending)
	}
	if res.Test == nil || !res.Test.OK || res.Test.Tries != 1 || res.Test.Host != "10.100.35.254" {
		t.Errorf("test = %+v", res.Test)
	}
	if !configEqual(res.Adapter.Config, want) || len(res.Warnings) != 0 {
		t.Errorf("adapter = %+v warnings %v", res.Adapter, res.Warnings)
	}
	if !th.pendingExists() || th.spawns != 1 || th.armed != 1 {
		t.Fatalf("pending file %v spawns %d armed %d", th.pendingExists(), th.spawns, th.armed)
	}
	var p Pending
	th.mustOK("pending", nil, &p)
	if p.GUID != res.Adapter.GUID || p.Source != "site" || p.Profile != "TC LAN · 10.100.35.1" {
		t.Errorf("pending cmd = %+v", p)
	}
	var status struct {
		Pending *Pending `json:"pending"`
		Statics []Static `json:"statics"`
	}
	th.mustOK("status", nil, &status)
	if status.Pending == nil || len(status.Statics) != 1 {
		t.Errorf("status = %+v", status)
	}

	var rv struct {
		Adapter Adapter `json:"adapter"`
	}
	th.mustOK("revert", nil, &rv)
	if got := th.config(12); !configEqual(got, before) {
		t.Fatalf("after revert = %+v, want %+v", got, before)
	}
	if !configEqual(rv.Adapter.Config, before) || th.pendingExists() || th.armed != 0 {
		t.Errorf("revert reply %+v pending %v armed %d", rv.Adapter.Config, th.pendingExists(), th.armed)
	}
	th.mustOK("status", nil, &status)
	if status.Pending != nil || len(status.Statics) != 0 {
		t.Errorf("status after revert = %+v", status)
	}
	th.mustErr("revert", nil, "no_pending")
	th.mustErr("confirm", nil, "no_pending")
	if got := th.auditActions(); strings.Join(got, ",") != "revert:ok,apply:ok" {
		t.Errorf("audit = %v", got)
	}
	var log []AuditEntry
	th.mustOK("log", map[string]any{"limit": 1}, &log)
	if len(log) != 1 || log[0].Action != "revert" || log[0].User != `PC\tech` || log[0].Context == nil || log[0].Context.PlantID != "P1" {
		t.Errorf("log = %+v", log)
	}
}

func TestApplyConfirmThenDHCP(t *testing.T) {
	th := newTestHost(t)
	th.mustOK("apply", staticLAN, nil)
	var kept map[string]bool
	th.mustOK("confirm", nil, &kept)
	if !kept["kept"] || th.pendingExists() || th.armed != 0 {
		t.Fatalf("confirm: %v pending %v armed %d", kept, th.pendingExists(), th.armed)
	}
	var status struct {
		Pending *Pending `json:"pending"`
		Statics []Static `json:"statics"`
	}
	th.mustOK("status", nil, &status)
	if status.Pending != nil || len(status.Statics) != 1 || status.Statics[0].Index != 12 ||
		status.Statics[0].Profile != "TC LAN · 10.100.35.1" || status.Statics[0].Since != th.clock.UnixMilli() {
		t.Fatalf("statics = %+v", status)
	}
	// Back to DHCP, kept at once.
	var res struct {
		Pending *Pending `json:"pending"`
	}
	th.mustOK("apply", map[string]any{"index": 12, "mode": "dhcp", "rollbackSec": 0}, &res)
	if res.Pending != nil || th.pendingExists() {
		t.Fatalf("rollbackSec 0 left a pending change")
	}
	if got := th.config(12); !configEqual(got, Config{DHCP: true}) {
		t.Fatalf("dhcp = %+v", got)
	}
	th.mustOK("status", nil, &status)
	if len(status.Statics) != 0 {
		t.Errorf("statics after dhcp = %+v", status.Statics)
	}
	// "DHCP is already enabled" from netsh is fine: the re-read config matches.
	th.mustOK("apply", map[string]any{"index": 12, "mode": "dhcp", "rollbackSec": 0}, nil)
}

func TestStaticsReconcile(t *testing.T) {
	th := newTestHost(t)
	th.mustOK("apply", map[string]any{"index": 12, "mode": "static", "ip": "10.1.1.1", "prefix": 24, "rollbackSec": 0}, nil)
	st, _ := th.loadStatics()
	if len(st) != 1 {
		t.Fatal(st)
	}
	// Someone changes the adapter outside IP Switcher.
	th.fake.netsh([]string{"interface", "ipv4", "set", "address", "name=12", "source=dhcp"})
	th.mustOK("listAdapters", nil, nil)
	if st, _ := th.loadStatics(); len(st) != 0 {
		t.Errorf("stale static kept: %+v", st)
	}
}

func TestNeedsConfirmInternet(t *testing.T) {
	th := newTestHost(t)
	args := map[string]any{"index": 7, "mode": "static", "ip": "10.100.35.1", "prefix": 24}
	r := th.mustErr("apply", args, "needs_confirm")
	var det []map[string]string
	json.Unmarshal(r.Error.Detail, &det)
	if len(det) != 1 || det[0]["code"] != "internet" {
		t.Fatalf("detail = %s", r.Error.Detail)
	}
	if got := th.config(7); !got.DHCP || th.pendingExists() || th.spawns != 0 {
		t.Fatalf("needs_confirm changed something: %+v", got)
	}
	args["ack"] = []string{"internet"}
	var res struct {
		Warnings []string `json:"warnings"`
		Adapter  Adapter  `json:"adapter"`
	}
	th.mustOK("apply", args, &res)
	if len(res.Warnings) != 1 || res.Warnings[0] != wifiWarning {
		t.Errorf("warnings = %v", res.Warnings)
	}
	if res.Adapter.Config.DHCP {
		t.Errorf("not applied: %+v", res.Adapter)
	}
}

func TestNeedsConfirmOverlap(t *testing.T) {
	th := newTestHost(t)
	args := map[string]any{"index": 12, "mode": "static", "ip": "192.168.1.50", "prefix": 24}
	r := th.mustErr("apply", args, "needs_confirm")
	if !strings.Contains(string(r.Error.Detail), `"overlap"`) || !strings.Contains(string(r.Error.Detail), "Wi-Fi") {
		t.Fatalf("detail = %s", r.Error.Detail)
	}
	args["ack"] = []string{"overlap"}
	th.mustOK("apply", args, nil)
}

func TestSecondApplyKeepsOriginalSnapshot(t *testing.T) {
	th := newTestHost(t)
	original := th.config(12)
	th.mustOK("apply", staticLAN, nil)
	th.clock = th.clock.Add(20 * time.Second)
	var res struct {
		Pending *Pending `json:"pending"`
	}
	th.mustOK("apply", map[string]any{"index": 12, "mode": "static", "ip": "192.168.0.10", "prefix": 24, "rollbackSec": 60}, &res)
	if res.Pending == nil || !configEqual(res.Pending.Snapshot, original) {
		t.Fatalf("snapshot = %+v, want original %+v", res.Pending, original)
	}
	if res.Pending.Deadline != th.clock.Add(60*time.Second).UnixMilli() {
		t.Errorf("deadline not restarted")
	}
	if m, _ := filepath.Glob(th.path("pending.claim-*")); len(m) != 0 {
		t.Errorf("claim files left: %v", m)
	}
	th.mustOK("revert", nil, nil)
	if got := th.config(12); !configEqual(got, original) {
		t.Fatalf("revert went to %+v, want %+v", got, original)
	}
}

func TestBusyOnAnotherAdapter(t *testing.T) {
	th := newTestHost(t)
	th.mustOK("apply", staticLAN, nil)
	before := th.config(15)
	th.mustErr("apply", map[string]any{"index": 15, "mode": "static", "ip": "10.9.9.9", "prefix": 24}, "busy")
	if got := th.config(15); !configEqual(got, before) {
		t.Errorf("busy changed adapter 15")
	}
}

func TestErrors(t *testing.T) {
	th := newTestHost(t)
	r := th.mustErr("apply", map[string]any{"index": 12, "mode": "static", "ip": "10.0.0.0", "prefix": 24}, "invalid")
	if !strings.Contains(string(r.Error.Detail), `"field":"ip"`) {
		t.Errorf("detail = %s", r.Error.Detail)
	}
	th.mustErr("apply", map[string]any{"index": 99, "mode": "dhcp"}, "no_adapter")
	th.mustErr("apply", map[string]any{"index": 12, "mode": "dhcp", "bogus": 1}, "bad_request")
	th.mustErr("apply", map[string]any{"index": "12", "mode": "dhcp"}, "bad_request")
	th.mustErr("apply", map[string]any{"index": 12, "mode": "dhcp", "context": map[string]any{"x": 1}}, "bad_request")
	th.mustErr("apply", nil, "bad_request")
	th.mustErr("ping", map[string]any{"host": "224.0.0.1"}, "invalid")
	th.mustErr("log", map[string]any{"limit": 0}, "invalid")
	var tst Test
	th.mustOK("ping", map[string]any{"host": "192.168.1.1"}, &tst)
	if !tst.OK || tst.Tries != 1 {
		t.Errorf("ping = %+v", tst)
	}
	th.mustOK("ping", map[string]any{"host": "8.8.8.8"}, &tst)
	if tst.OK || tst.Tries != 2 {
		t.Errorf("ping unreachable = %+v", tst)
	}
	th.mustOK("ping", map[string]any{"host": "8.8.8.8", "once": true}, &tst)
	if tst.OK || tst.Tries != 1 {
		t.Errorf("ping once unreachable = %+v", tst)
	}

	no := false
	st, _ := th.fake.load()
	st.CanWrite = &no
	th.fake.save(st)
	th.mustErr("apply", map[string]any{"index": 12, "mode": "dhcp"}, "no_permission")
}

func TestWriteFailedRollsBack(t *testing.T) {
	th := newTestHost(t)
	before := th.config(12)
	st, _ := th.fake.load()
	st.FailWrites = true
	th.fake.save(st)
	r := th.mustErr("apply", staticLAN, "write_failed")
	if !strings.Contains(string(r.Error.Detail), "netsh interface ipv4 set address") {
		t.Errorf("detail = %s", r.Error.Detail)
	}
	if th.pendingExists() || th.armed != 0 {
		t.Errorf("pending left after write_failed")
	}
	if got := th.config(12); !configEqual(got, before) {
		t.Errorf("config = %+v", got)
	}
	if got := th.auditActions(); len(got) != 1 || got[0] != "apply:error" {
		t.Errorf("audit = %v", got)
	}
}

func TestWatchdogRevertsOverdue(t *testing.T) {
	th := newTestHost(t)
	original := th.config(12)
	th.mustOK("apply", map[string]any{"index": 12, "mode": "static", "ip": "10.100.35.1", "prefix": 24, "rollbackSec": 5}, nil)
	start := th.clock
	th.watchdog() // sleeps on the fake clock until the deadline, then reverts and returns
	if got := th.config(12); !configEqual(got, original) {
		t.Fatalf("watchdog left %+v", got)
	}
	if th.pendingExists() || th.clock.Sub(start) < 5*time.Second || th.clock.Sub(start) > 7*time.Second {
		t.Errorf("pending %v, slept %v", th.pendingExists(), th.clock.Sub(start))
	}
	log := th.readAudit(1)
	var e AuditEntry
	json.Unmarshal(log[0], &e)
	if e.Action != "rollback" || e.Source != "watchdog" || e.Result != "ok" {
		t.Errorf("audit = %+v", e)
	}
	// A user Revert after the watchdog acted finds nothing to do.
	th.mustErr("revert", nil, "no_pending")
}

func TestClaimPreventsDoubleRevert(t *testing.T) {
	th := newTestHost(t)
	th.mustOK("apply", map[string]any{"index": 12, "mode": "static", "ip": "10.100.35.1", "prefix": 24, "rollbackSec": 5}, nil)
	applied := th.config(12)
	th.clock = th.clock.Add(10 * time.Second)
	// The user's Revert wins the claim first (e.g. it is mid-way through netsh).
	claim, pf, err := th.claimPending()
	if err != nil {
		t.Fatal(err)
	}
	acted, e := th.revertIfDue() // what the watchdog does at the deadline
	if acted || e != nil {
		t.Fatalf("watchdog acted on a claimed change: %v %v", acted, e)
	}
	if got := th.config(12); !configEqual(got, applied) {
		t.Fatalf("watchdog touched the adapter")
	}
	if _, e := th.revertClaimed(claim, pf, "revert", "popup"); e != nil {
		t.Fatal(e)
	}
	if got := th.auditActions(); strings.Join(got, ",") != "revert:ok,apply:ok" {
		t.Errorf("audit = %v (want exactly one revert)", got)
	}
	th.watchdog() // nothing pending, no claim: returns at once
}

func TestWatchdogFollowsMovedDeadline(t *testing.T) {
	th := newTestHost(t)
	th.mustOK("apply", map[string]any{"index": 12, "mode": "static", "ip": "10.100.35.1", "prefix": 24, "rollbackSec": 5}, nil)
	pf, _ := th.readPending()
	pf.Deadline = th.clock.Add(100 * time.Second).UnixMilli()
	writeJSONAtomic(th.path("pending.json"), pf)
	start := th.clock
	th.watchdog()
	if d := th.clock.Sub(start); d < 100*time.Second {
		t.Errorf("reverted after %v, before the moved deadline", d)
	}
}

func TestWatchdogRetriesFailedRollback(t *testing.T) {
	th := newTestHost(t)
	th.mustOK("apply", map[string]any{"index": 12, "mode": "static", "ip": "10.100.35.1", "prefix": 24, "rollbackSec": 5}, nil)
	st, _ := th.fake.load()
	st.FailWrites = true
	th.fake.save(st)
	th.watchdog()
	if !th.pendingExists() {
		t.Fatal("a failed rollback must stay pending for the next try")
	}
	n := 0
	for _, a := range th.auditActions() {
		if a == "rollback_failed:error" {
			n++
		}
	}
	if n != th.maxRetries {
		t.Errorf("rollback_failed entries = %d, want %d", n, th.maxRetries)
	}
	// The next helper start (writes work again) reverts it.
	st.FailWrites = false
	th.fake.save(st)
	th.startup()
	if th.pendingExists() || !th.config(12).DHCP {
		t.Errorf("startup did not revert the overdue change")
	}
}

func TestStartupRevertsOverdueAndRespawns(t *testing.T) {
	th := newTestHost(t)
	th.mustOK("apply", map[string]any{"index": 12, "mode": "static", "ip": "10.100.35.1", "prefix": 24, "rollbackSec": 30}, nil)
	th.spawns = 0
	th.startup() // not overdue, no watchdog heartbeat → spawn one
	if th.spawns != 1 || !th.pendingExists() {
		t.Fatalf("spawns %d pending %v", th.spawns, th.pendingExists())
	}
	th.clock = th.clock.Add(time.Minute) // e.g. the PC slept through the deadline
	th.startup()
	if th.pendingExists() || !th.config(12).DHCP {
		t.Errorf("overdue change not reverted at startup")
	}
}

func TestAuditRotation(t *testing.T) {
	th := newTestHost(t)
	big := strings.Repeat("x", 100*1024)
	for i := 0; i < 60; i++ {
		th.audit(AuditEntry{Action: "apply", Detail: big, Index: i})
	}
	if fileExists(th.path("audit.log.5")) || !fileExists(th.path("audit.log.4")) {
		t.Errorf("rotation files wrong")
	}
	fi, _ := os.Stat(th.path("audit.log"))
	if fi.Size() > auditMaxBytes {
		t.Errorf("audit.log = %d bytes", fi.Size())
	}
	got := th.readAudit(500)
	var first, last AuditEntry
	json.Unmarshal(got[0], &first)
	json.Unmarshal(got[len(got)-1], &last)
	if first.Index != 59 || last.Index >= first.Index || len(got) > 50 {
		t.Errorf("newest first: first %d last %d n %d", first.Index, last.Index, len(got))
	}
}
