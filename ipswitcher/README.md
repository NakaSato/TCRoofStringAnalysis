# IP Switcher (phase 1)

Switch a Windows 10/11 laptop's IPv4 address between saved profiles from the browser toolbar, with
automatic undo. Design: the internal design spec (Rev B, not in this repo). Contract between the two parts:
[`PROTOCOL.md`](PROTOCOL.md).

| Part | Folder | What it is |
|---|---|---|
| Extension | `extension/` | Chrome / Edge MV3: popup, options page, badge. Plain JS, no build step |
| Helper (native host) | `host/` | `ipswitch-host.exe` (Go, standard library only): reads adapters, runs `netsh`, rollback watchdog, ping, audit log |
| Installer | `installer/` | Per-user (HKCU) install for Chrome and Edge. No admin |

Preloaded profiles: **Automatic (DHCP)**, **Growatt Ecosystem · 192.168.10.x** (laptop
192.168.10.250/24, no gateway) and **Huawei SmartLogger · 192.168.0.10** (laptop 192.168.0.250/24, ping
and web page 192.168.0.10). Installs from before this remove the old "TC LAN · 10.100.35.1 / .2"
profiles once (those are plant P2-055's meter IPs) if they were never edited.

## Plant profiles from the O&M register

```bash
uv run --with openpyxl python ipswitcher/tools/om_network_to_profiles.py "data/OM-Asset & Network.xlsx"
```

Writes `data/ipswitcher-profiles.json` (gitignored: site IPs): the two profiles above plus one per
plant: laptop `<router subnet>.250/24`, gateway and test ping = the plant's Teltonika router, device
IPs (router, ShineMaster, PQM, meters) in the note. Import it in ⚙ Settings → Import; importing a newer
file updates the same profiles (stable IDs per plant code). The popup's search box finds a plant by code
(`P2-055`, `p2055`), name or IP; Enter opens the first match.

## Requirements on the laptop

- Windows 10 or 11, Chrome or Edge 116+.
- The Windows account must be allowed to change network settings without "Run as administrator":
  a member of **Network Configuration Operators** (an admin adds it once:
  `net localgroup "Network Configuration Operators" <user> /add`, then sign out and in).
  Otherwise the popup says "This Windows account can't change network settings" and changes nothing.

## Build (on any OS with Go ≥ 1.23)

```bash
ipswitcher/build.sh        # runs the Go tests, cross-builds the .exe → ipswitcher/dist/IPSwitcher-<version>.zip
```

## Install (per laptop, once, internet not needed after this)

1. Copy `IPSwitcher-<version>` (from the zip) to the laptop.
2. Run `helper\install.cmd`. It copies the helper to `%LOCALAPPDATA%\IPSwitcher\` and registers it
   for Chrome and Edge. It needs no admin. Not code-signed yet, so SmartScreen may warn ("More info → Run anyway").
3. Chrome: `chrome://extensions` (Edge: `edge://extensions`) → **Developer mode** → **Load unpacked** →
   pick the `extension` folder. The ID must be `gojmikegpclikdmngdgonghdcdemicib` (fixed by the `key`
   in `manifest.json`; the private key is `secrets/ipswitcher-extension-key.pem`, gitignored).
4. Pin **IP Switcher** to the toolbar.

`install.cmd` also puts an **IP Switcher** icon on the desktop and in the Start menu. It opens the
same screen in its own window with its own taskbar button, like a desktop app (Chrome's `--app`
window; Chrome if installed, else Edge; `-Browser edge` to choose, `-NoShortcut` to skip). The ⧉
button in the toolbar popup opens the same window.

## Publish the extension (instead of Load unpacked)

`build.sh` also writes `dist/ipswitcher-extension-store-<version>.zip`: the extension without the dev
`key` (stores assign their own ID).

1. **Chrome Web Store** (recommended, also serves Edge): register at the Chrome Web Store Developer
   Dashboard (one-time US$5 fee), **New item** → upload the store zip. Listing: description,
   at least one 1280×800 screenshot, the 128 px icon (`extension/icons/icon-128.png`). Privacy tab:
   single purpose "switch this PC's IPv4 address between saved profiles"; justify `nativeMessaging`
   (talks to the local IP Switcher helper), `storage` (saved profiles), `alarms` (badge refresh);
   no user data collected. Visibility **Unlisted** (only people with the link can install).
   Review usually takes a few days; `nativeMessaging` can make it longer.
2. Note the store's extension ID, then on each laptop: `install.cmd -ExtensionId <storeId>`
   (or `<storeId>,gojmikegpclikdmngdgonghdcdemicib` to keep the unpacked dev copy working too).
3. **Edge:** open the Chrome Web Store link in Edge and click **Allow extensions from other stores**:
   same ID, no second listing. (A separate Edge Add-ons listing is free via Microsoft Partner Center
   but gets a different ID, which then goes in `-ExtensionId` too.)
4. Updates: raise `version` in `extension/manifest.json`, rebuild, upload the new store zip; browsers
   update on their own. The helper `.exe` does not update through the store: ship the new zip and
   run `install.cmd` again.

Uninstall: `helper\uninstall.cmd` (keeps `audit.log`; `-All` removes it too).

## Use

Click the toolbar icon → pick the adapter (e.g. Ethernet) → type the plant code in the search box (e.g. `P2-055`) → Enter → Apply.
The helper saves the current settings, applies the profile, pings the test host and starts a 30 s
window: press **Keep**, or it puts the old settings back by itself (also if the browser is closed).
**Automatic (DHCP)** switches back. Badge: amber `!` = waiting for Keep, blue `S` = an adapter is on a
static profile, amber = static for more than 4 h.

## How the undo works (differs from the spec's long-lived port)

Every command is a one-shot native message; the helper keeps no state in memory. Before it writes,
it saves `pending.json` and starts a detached `ipswitch-host.exe --watchdog` that reverts at the
deadline. A HKCU `RunOnce` entry (`--revert-due`) covers a reboot or sign-out inside the window, and
every helper start reverts an overdue change. Keep / Revert / watchdog "claim" the file by renaming it,
so only one of them acts. Audit: `%LOCALAPPDATA%\IPSwitcher\audit.log` (JSON lines, 1 MB × 5).

## Verified so far

Built and unit-tested on macOS only (Go tests against a fake system that applies the same `netsh`
argument lists; extension JS syntax + Node tests of validation). **Not yet run on Windows.** Before
field use, run spec §17 T1–T9 on Windows 10 and 11 with a non-admin account in Chrome and Edge. The
ones most likely to need a fix:

- T1 the PowerShell adapter read (Thai names, `-Physical` filter, USB adapters).
- T2/T3 `netsh` writes + registry verify as a Network Configuration Operators member.
- T5 the watchdog surviving the browser closing (Chrome may run hosts in a job object; the helper asks
  for `CREATE_BREAKAWAY_FROM_JOB` and falls back to without it; RunOnce + start-up check are the backstop).
- The ping via `IcmpSendEcho`.

## macOS

The helper also runs on a Mac: the adapters are the Mac's network services (System Settings →
Network), read and set with `networksetup`; administrator accounts need no password. Install (builds
from source, needs Go; per user, registers Chrome and Edge):

```bash
ipswitcher/installer/install-mac.sh                     # real mode
IPSWITCHER_FAKE=1 ipswitcher/installer/install-mac.sh   # demo: pretend adapters, changes nothing
```

Not on macOS: a second IP on one adapter, and the reboot fail-safe (the next helper start reverts an
overdue change instead). Verified on macOS: reading the services, static ↔ DHCP, no-gateway, the
watchdog auto undo.

## Next phases (spec §16)

2 TC Roof *Connect to device* (`externally_connectable`, confirm window, device Network fields cached
offline: the PWA today caches no `/api` data, so that has to be built first) · 3 Thai UI, extra IP,
signed installer · 4 Firefox.
