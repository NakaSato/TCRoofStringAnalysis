# IP Switcher: extension ↔ native host contract (protocol 1)

Phase 1 of `specs/ip-switcher-design-spec.md` (Rev B). This file is the single contract between
`ipswitcher/extension/` and `ipswitcher/host/`. Change it first, then both sides.

## Names

| Item | Value |
|---|---|
| Native host name | `com.tcroof.ipswitcher` |
| Host binary | `ipswitch-host.exe` (Go, `GOOS=windows GOARCH=amd64`) |
| Data folder | `%LOCALAPPDATA%\IPSwitcher\` (override: env `IPSWITCHER_DATA_DIR`) |
| Dev extension ID | `gojmikegpclikdmngdgonghdcdemicib` (fixed by `key` in manifest.json) |
| Protocol version | `1` |

## Transport

Chrome Native Messaging: 32-bit little-endian length prefix + UTF-8 JSON. Request ≤ 16 KB
(bigger → error `too_large`), reply ≤ 1 MB.

The extension uses one-shot `chrome.runtime.sendNativeMessage` for **every** command. The host is
stateless between calls: all state is on disk (`pending.json`, `statics.json`). The rollback timer
is a separate detached watchdog process (`ipswitch-host.exe --watchdog`), so it survives the
browser closing (spec §12 step 5). This replaces the spec's long-lived `connectNative` port.

Request: `{"id": "<string>", "v": 1, "cmd": "<cmd>", "args": {…}}` (args may be omitted).
Unknown top-level fields, unknown `args` fields or wrong types → error `bad_request`.

Reply: `{"id": "<same>", "ok": true, "data": …}` or
`{"id": "<same>", "ok": false, "error": {"code": "…", "message": "<plain English>", "detail": …}}`.

## Types

`Config` (what an adapter is configured to; also the snapshot):

```json
{"dhcp": false, "addrs": ["10.100.35.1/24"], "gateway": "10.100.35.254", "dns": ["8.8.8.8"]}
```
- `dhcp: true` → address from DHCP; `addrs` empty, `gateway` "".
- `dns` = **static** DNS servers only (empty = DNS from DHCP, or none for a static adapter). Max 2.

`Adapter`:

```json
{
  "index": 12, "guid": "{…}", "name": "Ethernet", "description": "Realtek USB GbE",
  "status": "Up" | "Disconnected" | "Disabled" | "…",
  "mac": "AA-BB-…", "isWifi": false, "isInternet": true,
  "dhcp": true, "ips": ["10.0.0.23/24"], "gateway": "10.0.0.1", "dns": ["10.0.0.1"],
  "config": Config
}
```
`ips` / `gateway` / `dns` are live (what Windows uses now); `config` is the stored setting.
`isInternet` = the Up adapter whose default route has the lowest route metric + interface metric.

`Pending`:

```json
{"index": 12, "guid": "{…}", "adapter": "Ethernet", "deadline": 1764000000000,
 "snapshot": Config, "applied": Config, "profile": "TC LAN · 10.100.35.1", "source": "popup"}
```
`deadline` = Unix ms. `snapshot` = the config before the first change of this window.

`Static` (an adapter left static by a profile): `{"guid", "index", "adapter", "profile", "since": <unix ms>, "config": Config}`

`Test` (ping result): `{"host": "10.100.35.254", "ok": true, "rttMs": 2, "tries": 1}`

## Commands

| cmd | args | data |
|---|---|---|
| `health` | — | `{"hostVersion": "0.1.0", "protocol": 1, "user": "PC\\tech", "canWrite": true}` |
| `listAdapters` | `{"showAll"?: bool}` | `[Adapter]` (physical only unless `showAll`) |
| `apply` | see below | `{"adapter": Adapter, "pending": Pending \| null, "test": Test \| null, "warnings": [string]}` |
| `confirm` | — | `{"kept": true}`; error `no_pending` if nothing pending |
| `revert` | — | `{"adapter": Adapter}`; error `no_pending` |
| `pending` | — | `Pending` or `null` |
| `status` | — | `{"pending": Pending \| null, "statics": [Static]}` (fast: no PowerShell) |
| `ping` | `{"host": "10.100.35.254", "once"?: bool}` | `Test` (up to 2 tries; `once`: 1 try, for the ping console) |
| `log` | `{"limit"?: 1..500, default 100}` | `[AuditEntry]`, newest first |

`apply` args:

```json
{
  "index": 12,
  "mode": "static" | "dhcp",
  "ip": "10.100.35.1", "prefix": 24, "gateway": "10.100.35.254", "dns": ["8.8.8.8"],
  "rollbackSec": 30,
  "testHost": "10.100.35.254",
  "profile": "TC LAN · 10.100.35.1",
  "source": "popup" | "site",
  "context": {"plantId": "", "plantName": "", "equipmentId": ""},
  "ack": ["internet", "overlap"]
}
```
- `mode: "dhcp"`: `ip`, `prefix`, `gateway`, `dns` must be absent or empty.
- `prefix`: integer 8–32 (the extension converts `255.255.255.0` → 24).
- `rollbackSec`: 0–300, default 30. `0` = keep at once, no pending window.
- `testHost`, `gateway`, `dns`, `profile`, `context`, `ack` optional. `source` default `popup`.
- Second `apply` while a change is pending: same adapter → keeps the **original** snapshot and
  restarts the deadline; another adapter → error `busy`.

Before writing, the host returns error `needs_confirm` (nothing changed) with
`detail: [{"code": "internet" | "overlap", "message": "…"}]` for each guardrail not in `ack`:
- `internet`: the target adapter is `isInternet`.
- `overlap`: another Up adapter has an address in the new subnet (or its subnet contains the new IP).

Wi-Fi adds the warning string "A static IP applies to this adapter, not only to this network." to
`warnings` (no ack needed).

## Validation (host enforces; extension repeats for instant feedback) — spec §10.3

| Field | Reject when |
|---|---|
| `ip` | not dotted IPv4 (no leading zeros), 0.0.0.0, 127.0.0.0/8, 169.254.0.0/16, ≥ 224.0.0.0 |
| `ip` vs subnet | equals the network or broadcast address when prefix ≤ 30 |
| `prefix` | not an integer 8–32 |
| `gateway` | invalid as `ip`, outside the subnet, or equal to `ip` |
| `dns` | any invalid (same rules as `ip`, no subnet check), or more than 2 |
| `testHost` | not dotted IPv4, 0.0.0.0 or ≥ 224.0.0.0 |
| `index` | not in the current adapter inventory (`showAll: true`) → error `no_adapter` |

Field errors: error `invalid`, `detail: [{"field": "gateway", "message": "Gateway must be inside 10.100.35.0/24"}]`.

## Error codes

`bad_request`, `too_large`, `unknown_cmd`, `protocol`, `invalid`, `no_adapter`, `needs_confirm`,
`busy`, `no_pending`, `no_permission` (canWrite false: nothing written), `write_failed`
(netsh ran but the re-read config doesn't match: the host already rolled back; `detail` has the
netsh output), `timeout`, `internal`.

Errors raised by the browser (extension side, from `chrome.runtime.lastError`):
`host_missing` ("Specified native messaging host not found."), `host_forbidden`
("Access to the specified native messaging host is forbidden."), `host_crashed` (anything else).

## Audit entry (`audit.log`, one JSON object per line, rotate 1 MB × 5)

```json
{"time": "2026-11-24T10:00:00+07:00", "user": "PC\\tech", "action": "apply" | "keep" | "revert" | "rollback" | "rollback_failed",
 "adapter": "Ethernet", "index": 12, "from": Config, "to": Config, "profile": "…", "source": "popup" | "site" | "watchdog",
 "context": {…} | null, "result": "ok" | "error", "detail": "…", "test": Test | null}
```
