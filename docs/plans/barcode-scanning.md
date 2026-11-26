# Plan & Spec: Barcode & QR scanning (external scanner, phone and iPad camera)

Status: **Steps 1–3 of §12 built** (2026-11-26: resolver, keyboard scanner, camera and photo, ScanField in Tools and the Site Register, Settings → Scanning). Steps 4–7 (field hints per model, labels, batch mode, the device matrix test) wait for the FEDR pages · Created 2026-11-26 · Owner: Chanthawat
Related: PMBOK *Field Equipment Defect & Replacement Management* (FEDR), WBS 1.6.1 (red tags + QR) and DR-06 / DR-07 / DR-09; [`measuring-tools.md`](measuring-tools.md) (QR labels on instruments, "Later" list); [`om-asset-network.md`](om-asset-network.md) (site device serials); [`claims.md`](claims.md) (SN out / SN in)

One scanning layer for the whole app. It reads **1D barcodes and 2D codes (QR, DataMatrix)** from three sources:

1. an **external barcode reader** (USB or Bluetooth, in keyboard / HID mode) on a PC, Mac, iPad or Android phone,
2. the **camera of a phone or iPad**, live, inside the app (browser and installed PWA),
3. a **photo** taken with the camera or picked from the gallery, as a fallback,

plus **manual entry** when nothing can read the label.

The first users are the Defects / Spares / Failed units pages (FEDR). The same layer serves Measuring Tools (instrument QR) and the site device register.

---

## 1. Why

- Serial numbers decide everything downstream: the device register after a swap, the claim with Growatt, stock per part, and the red tag on a failed unit. Typing a 16-character SN on a roof is slow and error-prone (O ↔ 0, I ↔ 1, 8 ↔ B).
- The store needs speed. Receiving a box of 20 routers, or counting a bin, must be scan, beep, scan, beep, not 20 dialogs.
- Crews carry phones and iPads, not scanners. The store and the office desk can have a scanner. Both must work, with the same result.

## 2. Scope

**In (v1)**
- A global **Scan** button in the top bar plus a keyboard-scanner listener. It resolves any app code (red tag, spare, bin, instrument, device, defect) and opens the right record.
- A **ScanField** in forms: an input that accepts typing, a keyboard scanner and a camera button. It is used for device SN, new SN on replacement, spare SN on stock moves, red tag no. and instrument tag.
- **Batch scan mode** for the store: receive, issue, transfer and cycle count. Each scan adds a row with a beep. Duplicates are flagged. A list is confirmed at the end.
- **App labels**: QR codes the app generates for red tags, spare bins / locations, serialised spares and instruments, with a print sheet (PDF) and a CSV for a label printer.
- **Parsing of manufacturer labels**: pick the serial out of the multi-field labels found on inverters, routers, meters and modules (§6.3), with confirmation by a person.
- Every saved value records **how it was entered** (`hid` | `camera` | `photo` | `manual`), so data quality can be measured.

**Out (later)**
- An offline queue (scan with no network, sync later). v1 decodes offline but needs the network to resolve and save, the same as the rest of the app.
- Reading serials with OCR from labels that have no barcode. Later, perhaps on-device text recognition.
- RFID / NFC tags.
- Scanners in serial (SPP) mode or a vendor SDK. Browsers on iOS have no Web Serial or Web Bluetooth, so only **HID keyboard mode** is supported.
- Driving a label printer directly from the browser. v1 gives a PDF sheet and a CSV.

## 3. Constraints from the project rules

| Rule | What it means here |
|---|---|
| Never invent numbers (CLAUDE.md rule 3) | A scanned value is shown as read. The app never "corrects" a serial on its own. Normalisation (§6.2) is limited to trimming and case, and the original raw value is kept. When a label has several fields, a person confirms which one is the SN. |
| Plant scoping | Resolving a code on a plant the engineer is not assigned to answers **404, without revealing the plant**, the same as `/tools` check-outs. |
| Live data in memory, SQL for records | Camera frames never leave the device. Only the decoded text is sent, and only when the user saves something. No frames or photos are stored unless the user takes an evidence photo on purpose (`defect_photos`). |
| One REST client | Types in `api/types/scan.ts`, methods in `api/client.ts`. |
| Page state in the URL | Batch mode, its kind and location go in the query string (`useUrlState`). The scanned list lives in memory and `sessionStorage` until it is confirmed. |
| GCP ฿1,000/month | Decoding runs in the browser (WASM). The backend only does a cheap lookup. There is no paid scanning SDK. |
| Bun, no new test framework | Pure parsing and keymap modules get `bun test` unit tests (built into Bun). Components are checked with `bun run lint && bun run build` as usual. |

## 4. Input source 1: external barcode reader (HID / keyboard wedge)

### 4.1 Supported hardware
- **2D imager scanners** (they read QR and DataMatrix; 1D laser scanners cannot read QR), in **HID keyboard mode**:
  - USB for desks
  - Bluetooth HID for iPad, phones and laptops
- Configuration required on the scanner:
  - **Suffix = Enter (CR)**, which is the factory default on most models
  - **no prefix**, or the configured prefix of §4.4
  - AIM symbology ID **off**
  - keyboard country = **US**
- iPad / iPhone: pair in Bluetooth settings as a keyboard. While a hardware keyboard is connected, iOS hides the on-screen keyboard. Most scanners have a quick "toggle keyboard" scan or button; the quick guide covers this.

### 4.2 How the app tells a scanner from a person
A scanner "types" a whole code in a burst and then presses Enter. The listener (`useHidScanner`) watches `keydown` on `window`:

| Rule | Default (configurable in Settings → Scanning, per device in `localStorage`) |
|---|---|
| Gap between keys in a burst | ≤ 35 ms (scanners: 2–15 ms; people: > 80 ms) |
| Minimum length | 4 characters |
| End of code | `Enter`, or `Tab`, or no key for 80 ms after a burst |
| Start of code (optional) | the configured prefix character(s), see §4.4 |

Behaviour:
- **Focus in a ScanField:** the burst goes into that field, Enter submits the field, and the global handler does nothing.
- **Focus in a normal text field** (note, description): the listener **does not** take the burst, so the code is typed as text. Exception: a burst with the configured prefix is always taken as a scan.
- **Nothing focused, or focus on a button or the page:** the burst goes to the **global resolver**, which opens the record (§7.1). The Enter is consumed so it does not click a focused button.
- In batch mode (§7.3), every burst goes into the batch list.

### 4.3 Thai keyboard layout (important)
A HID scanner sends **key positions**, not characters. When the OS input source is **Thai (Kedmanee)**, the code `RT-0103` arrives as Thai characters (e.g. `R` → `พ`, `T` → `ะ`), and digits can become Thai characters too. This happens on Windows, macOS and iPadOS.

Fix, in `lib/scan/keymap.ts`:
- Build the scanned string from **`KeyboardEvent.code`** (the physical key: `KeyR`, `Digit0`, `Minus`, …) plus `shiftKey`, mapped through a fixed **US layout table**, not from `event.key`. The result is the same whatever the active layout is.
- Keep `event.key` as a fallback only when `code` is empty (some Bluetooth stacks send `Unidentified`). In that case, apply a Thai-Kedmanee → US reverse table.
- Unit-test both tables against every printable ASCII character.

The quick guide still says "switch the keyboard to English for best results", but the app must not depend on it.

### 4.4 Optional prefix
For desks where people also type a lot, the scanner can be programmed to send a prefix, e.g. `F13` / `§` / `~`, set in Settings → Scanning. A burst that starts with the prefix is always a scan, even inside a normal text field. The prefix is removed before parsing. The default is none.

### 4.5 Limits
- Codes with control characters: GS1 DataMatrix and Code 128 use **GS (ASCII 29)** as a field separator. Most scanners in keyboard mode drop it or send it as `Ctrl+]`. The listener maps `Ctrl+]` to `\x1d`. If a scanner drops GS, the GS1 parser (§6.3) falls back to fixed-length AIs.
- Some scanners translate Code 128 FNC1 to nothing. This is handled the same way.

## 5. Input sources 2 and 3: camera (live) and photo

### 5.1 Decoder
- Use the **`BarcodeDetector` Web API** when the browser has it and it supports the formats needed (Chrome on Android, Chrome on desktop with platform support).
- Otherwise use the **`barcode-detector` ponyfill** (same API, ZXing-C++ compiled to WASM), which covers **Safari on iPhone / iPad**, where `BarcodeDetector` is not available.
- Lazy-load it with dynamic `import()` only when a camera scan opens, so the main bundle does not grow.
- **Self-host the WASM file.** The package's default fetches it from a public CDN. Configure it to load from the app's own origin (see the package docs for the current option name), so it works with the installed PWA, behind strict networks and offline after the first load. Add `*.wasm` to the Workbox `globPatterns`, or add a runtime cache rule in `vite.config.ts`.
- Formats enabled, per context:
  - global scan: `qr_code`, `data_matrix`, `code_128`, `code_39`
  - device SN fields: those four + `ean_13`, `ean_8`, `upc_a`, `itf`, `pdf417`

  Fewer formats means faster and fewer false reads.

### 5.2 Live camera scanner (`CameraScanner` in `ScanDialog`)
- `getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })`. Fall back to 1280×720 if refused.
- `<video playsinline muted autoplay>`: `playsinline` is required on iOS, or the video goes fullscreen.
- Decode loop:
  - use `requestVideoFrameCallback` where available, else `requestAnimationFrame`
  - throttle to about **10 decodes per second**
  - decode a **crop of the centre box** (about 70% width × 40% height for 1D, a square for 2D, switched by a toggle) drawn to an `OffscreenCanvas` / canvas
  - fall back to the full frame every 5th attempt
- On a read: draw the detected outline, beep and vibrate (§8), then:
  - **single mode:** pause and show the value with **Use** / **Scan again**
  - **batch mode:** add it to the list and keep running, ignoring the same value for 1.5 s
- Controls:
  - **torch**, shown only if `track.getCapabilities().torch` is true (most Android phones; on iOS, support depends on the version, so feature-detect and never assume)
  - **zoom** slider if `capabilities.zoom` exists (helps with small DataMatrix labels on routers)
  - **switch camera** if more than one rear camera is listed
  - a **tap to focus** hint (focus control is not available on iOS Safari; the hint tells the user to move closer or further)
- Stop every track when the dialog closes, the page is hidden (`visibilitychange`) or the route changes. The camera LED must go off.

### 5.3 Permissions and HTTPS
- The camera needs a secure context. Production on Firebase Hosting is HTTPS, and `localhost` works for development.
- **Testing on a real iPad or phone in development** needs HTTPS on the LAN. Run `vite --host` with `@vitejs/plugin-basic-ssl` (dev only), or use a mkcert certificate. Documented in `frontend/CLAUDE.md`.
- `firebase.json` headers: `Permissions-Policy: camera=(self)`. If a CSP is added later, it must allow `wasm-unsafe-eval` for the decoder.
- Permission states and UI:
  - **prompt:** a short explanation ("The camera is used only to read the code. Nothing is recorded.") before the browser prompt
  - **denied:** show how to re-enable it (iOS: Settings → Safari → Camera, or the site's settings for the installed app; Android: site settings), plus the **Photo** and **Type it** fallbacks
- iOS installed PWA: the camera works in standalone mode, but iOS may ask for permission again in later sessions. This is expected; the explanation screen says so.

### 5.4 Photo fallback (`PhotoScan`)
- `<input type="file" accept="image/*" capture="environment">` opens the native camera (or the gallery). The picture is decoded in the browser with the same decoder, at full resolution, trying rotations of 0/90/180/270°.
- Useful when the live scan cannot focus (very small DataMatrix, a curved label, glare). The photo is **not uploaded** unless the user also attaches it as evidence.

### 5.5 Manual entry
Always available. The field shows a monospace font with the hint "Check O/0 and I/1". Values entered by hand are saved with `input_method = manual`.

## 6. What the codes contain

### 6.1 App labels (QR generated by TC Roof)
- Payload = a **URL** on the app's host, so that the phone's **own camera app** also opens the right record: `https://<app-host>/s/<kind>/<code>`.

| kind | code | Example | Opens |
|---|---|---|---|
| `rt` | red tag no. | `/s/rt/RT-0103` | failed unit |
| `sp` | spare unit SN (serialised) or part id | `/s/sp/P-ROUTER-RUT` | spare part / unit |
| `loc` | stock location / bin | `/s/loc/STORE-A-03` | location stock, batch mode |
| `tool` | instrument asset tag | `/s/tool/MT-INS-02` | `/tools?tool=<id>` |
| `dev` | site device id | `/s/dev/<id>` | plant Documents card, device row |
| `df` | defect no. | `/s/df/DF-2026-0042` | defect |

- The in-app scanner accepts the full URL, the path alone, or `kind:code` (e.g. `rt:RT-0103`, for 1D labels that cannot hold a URL).
- No secrets or personal data go in the payload, only identifiers. Access is still checked when the record is resolved.
- QR settings: error correction **Q** (labels get dirty), a quiet zone of ≥ 4 modules, a printed size of **≥ 15 mm** for phone cameras at a 10–20 cm distance, and the human-readable code printed under the QR.
- Red tags can be **pre-printed in batches** (blank tags RT-0001…RT-0500). Scanning a blank tag on a new failed unit binds it (§7.2), so crews don't need a printer on site.

### 6.2 Normalisation (`lib/scan/parse.ts`)
1. Remove control characters except GS (`\x1d`), and trim spaces.
2. Remove common label prefixes: `S/N`, `SN:`, `SN`, `Serial No.`, `P/N` (the last is marked as part number, not serial).
3. Uppercase for serial comparison. The **raw value is saved too** (`raw_scan`).
4. Never change O ↔ 0 or I ↔ 1 automatically. If a typed serial is not found but a variant with those swaps is in the register, show "Did you mean …?" for the person to choose.

### 6.3 Manufacturer labels
- **GS1** (DataMatrix or GS1-128, starts with `]d2` / `]C1` or AI pattern `(01)…(21)…`): parse the Application Identifiers. **AI 21** = serial, 01 = GTIN, 10 = batch, 11/17 = dates.
- **Multi-field text** (common on routers and inverters: the SN, IMEI, MAC, model and P/N in one QR, separated by `;` `,` `|` or newlines, or `key:value`): split into fields and pre-select the one labelled SN / Serial. If no label is present, list every field for the person to pick, and remember the choice per **category + model** (`scan_field_hints`, admin-editable), so the next scan of the same model picks it automatically.
- **IMEI / ICCID** (routers, SIMs): recognised by length and check digit (Luhn); offered as "IMEI" or "SIM ICCID", never as the device SN.
- **Plain 1D (Code 128 / 39)**: taken as the serial after normalisation.

Per-category expectations (warnings only, never blocking, because models vary):

| Category | Expected | Check |
|---|---|---|
| inverter, datalogger | Growatt SN, alphanumeric, uppercase | Length within the range of SNs already in the registry for that model (computed from the registry, not assumed) |
| router_4g | SN digits (Site Register has 145 known), IMEI separate | Not equal to the IMEI; IMEI passes Luhn |
| revenue_meter | CEWE SN like the register (`WP` + digits) | Pattern taken from the existing register values |
| pv_module, optimizer | Manufacturer SN, often Code 128 or QR | Not already installed at another position |

## 7. Where scanning is used

### 7.1 Global scan (top bar + keyboard scanner)
- A top-bar **Scan** button (icon `ScanLine`) opens `ScanDialog` with Camera | Photo | Type tabs. On a desktop with no camera, the dialog opens on Type with "or scan with your barcode reader".
- Resolve: `GET /scan/resolve?code=` → `{ kind, id, label, plant_id?, path }`, or `{ kind: "unknown", candidates[] }` for a raw manufacturer serial matched against inverters, site devices, spare units, failed units and instruments. One match navigates there; several show a pick list; none offers **New defect with this SN** or **Receive as spare**.
- The route `/s/:kind/:code` (opened by the phone's camera app or a pasted link) calls the same resolver and redirects. If the user is not signed in, it goes through the login page and comes back.

### 7.2 ScanField in forms

| Form | Field | Extra rule on scan |
|---|---|---|
| New defect | Device SN | Looks up the register; when found, fills category, plant, position and model |
| Replacement | **New SN** | Must differ from the old SN; warns if the SN is already installed elsewhere or is a failed unit; if it is a spare in stock, the stock movement (`issue`) is prefilled from the user's van |
| Replacement | Old SN | Must match the device being replaced, or ask "Register says X, label says Y: update the register?" (no silent overwrite) |
| Failed unit | Red tag | A blank pre-printed tag binds; a tag already in use is refused (409) |
| Stock movement | Spare SN / part | Serialised parts need an SN; non-serialised parts need a part code + quantity |
| Instrument check-out | Asset tag | Opens the instrument and its check-out dialog (measuring-tools guard still applies) |

### 7.3 Batch mode (store and vans)
`/spares/scan?mode=receive|issue|transfer|count&loc=<id>`
1. Scan or choose the **location** (bin / van).
2. Scan items one after another, by keyboard scanner or camera in continuous mode. Each scan adds a row: part, SN, qty 1 (merged for non-serialised parts), and a status: ✓ new · ⚠ duplicate in this list · ⚠ already in another location · ✕ unknown.
3. Rows can be edited (qty, remove), and the list survives a reload (`sessionStorage`).
4. **Confirm** posts one `POST /stock/movements/batch`, which applies all or nothing (409 with the failing rows).
5. **Count** mode compares the scanned list with the computed stock of the location and shows missing / extra / match. The adjustment movements are created only after confirmation, by an admin or the store keeper (FEDR D-02).

## 8. Feedback

| Event | Sound | Vibration | Visual |
|---|---|---|---|
| Read OK | short high beep | 50 ms (Android) | green flash on the box, value toast |
| Duplicate / warning | two low beeps | 50-50-50 ms | amber row |
| Error / unknown / refused | long low beep | 200 ms | red row, message |

- Sound uses Web Audio, unlocked on the first user tap (iOS needs a gesture). It is on by default, with a mute toggle remembered per device.
- `navigator.vibrate` is not supported on iOS. The visual flash is always shown, so nothing depends on sound or vibration.

## 9. Backend

```
GET  /scan/resolve?code=               → { kind, id, label, plant_id?, path } | { kind:"unknown", candidates[] }
                                          (scoped: unassigned plant → 404 not revealed; rate-limited 60/min/user)
GET  /scan/labels?kind=tool|dev|rt&ids=|plant_id=|site_code=|batch=  → label data {kind, key, code, path, title, lines}
POST /scan/labels/redtags {count ≤ 500} (admin) → reserves the next RT-xxxx numbers as one batch
GET  /scan/labels/redtags              (admin) → batches (first, last, count, bound, reserved_by / _at)
POST /stock/movements/batch            → all-or-nothing; rows carry input_method + raw_scan
GET  /scan/field-hints                 PUT /scan/field-hints (first: anyone; change: admin)   DELETE /scan/field-hints/{id} (admin)
                                          (category + model → which field is the SN)
GET  /scan/resolve?code=&suggest=true  → also did_you_mean[] (O/0, I/1 spellings that match; typed codes only)
```

- New columns, wherever a scanned value is saved (`replacements.old_sn/new_sn`, `failed_units.red_tag_no`, `stock_movements.serial_no`, `defects.serial_no`, `instrument_checkouts`):
  - `<field>_input` (`hid | camera | photo | manual`)
  - `<field>_raw` (the raw scan, ≤ 512 chars)
- The resolver lookup order:
  1. app code (`kind:code`, URL)
  2. red tag
  3. instrument asset tag
  4. spare unit SN
  5. failed unit SN
  6. inverter SN (registry)
  7. site device SN / IMEI / SIM
  8. defect no.

  Matching is exact on normalised values first, then case-insensitive. **No fuzzy matching on the server**: for the O/0 suggestion of §6.2 the server only looks up the swapped spellings exactly (a bounded set, `suggest=true`); the UI offers them and the person chooses.
- Every resolve that leads to a change is already audited by that action. Resolves alone are not stored, to keep SQL small.

## 10. Frontend files

```
src/lib/scan/keymap.ts          KeyboardEvent.code → US ASCII table; Thai-Kedmanee → US reverse table
src/lib/scan/hidScanner.ts      useHidScanner(): burst detection, prefix, suffix, focus rules, Ctrl+] → GS
src/lib/scan/decoder.ts         getDetector(formats): native BarcodeDetector or lazy ponyfill (self-hosted WASM)
src/lib/scan/camera.ts          openCamera(), capabilities (torch / zoom), stopAll(); visibility + route cleanup
src/lib/scan/parse.ts           normalise(), parseAppCode(), parseGs1(), splitFields(), isImei(), isIccid()
src/lib/scan/feedback.ts        beep / vibrate / flash, mute setting
src/lib/scan/*.test.ts          bun test: keymap, parse, GS1, IMEI / ICCID, burst detection (synthetic events)
src/api/types/scan.ts           ResolveResult, LabelData, BatchMovement, FieldHint
src/components/scan/ScanDialog.tsx     Camera | Photo | Type tabs, permission states
src/components/scan/CameraScanner.tsx  video, overlay box, torch / zoom / switch, continuous mode
src/components/scan/ScanField.tsx      input + camera button + HID capture, shows source badge (Scanned / Camera / Typed)
src/components/scan/FieldPicker.tsx    multi-field label → pick the SN (remember per model)
src/components/scan/ScanButton.tsx     top bar button + global listener mount
src/pages/ScanRedirectPage.tsx         /s/:kind/:code
src/pages/spares/BatchScanPage.tsx     /spares/scan
src/pages/settings/ScanningSettings.tsx  timings, prefix, sound; "Test your scanner" box
src/pages/labels/LabelSheet.tsx        A4 sheet / CSV (QR via `qrcode` package, lazy)
```

Dependencies to add with `bun add`:
- `barcode-detector` (ponyfill, lazy)
- `qrcode` (label generation, lazy)
- `@vitejs/plugin-basic-ssl`, dev only

No other scanning SDK.

**Settings → Scanning → "Test your scanner":** a box where a scan shows the decoded string, the timing between keys, whether the suffix arrived, and a warning if Thai characters were received. This is used when setting up each new scanner or iPad.

## 11. Device and browser matrix (acceptance)

| Device | Browser / mode | Keyboard scanner | Camera live | Photo |
|---|---|---|---|---|
| iPhone (iOS current − 1) | Safari, installed PWA | BT HID | ✓ (ponyfill) | ✓ |
| iPad (iPadOS current − 1) | Safari, installed PWA | BT HID, Thai layout active | ✓ (ponyfill) | ✓ |
| Android phone | Chrome, installed PWA | BT / USB-OTG HID | ✓ (native or ponyfill) | ✓ |
| Windows PC | Chrome / Edge | USB HID, Thai layout active | webcam optional | ✓ |
| Mac | Chrome / Safari | USB / BT HID | webcam optional | ✓ |

Test labels:
- an app QR at 15 mm and 25 mm
- a Growatt inverter label (Code 128)
- a Teltonika router label (multi-field QR / DataMatrix)
- a CEWE meter label
- a PV module label
- a GS1 DataMatrix sample
- a dirty or creased red tag
- glare under sunlight
- low light (torch where available)

Pass criteria:
- an app QR is read in ≤ 2 s on every camera device
- keyboard scanner input is correct with the Thai layout active on Windows, macOS and iPadOS
- 0 wrong reads in 200 scans of the test set (a misread must fail to decode, never return a wrong value)
- the camera stops when the dialog closes or the app goes to the background
- an engineer resolving an unassigned plant's code gets 404

## 12. Build order

Built so far (2026-11-26): `/scan/resolve` matches app codes `tool` / `dev` and raw values against instruments, inverters, dataloggers and site register devices (red tags, spares, bins and defects have no register yet: their app codes answer `unsupported_kind`). Step 4 (2026-11-26): photo fallback (0/90/180/270°), the field picker with `scan_field_hints` per category + model (`GET/PUT /scan/field-hints`, `DELETE` admin; the first hint by anyone, a change by an admin; Settings → Scanning lists them for admins), and "Did you mean" for a typed code (`/scan/resolve?suggest=true` → `did_you_mean`: the O ↔ 0 / I ↔ 1 spellings that match exactly; the person chooses). Step 5 (2026-11-26, partly): `/labels?kind=tool|dev|rt` (`pages/LabelsPage.tsx`) prints instrument and site device labels and red tag batches on A4 (polyester 63.5 × 33.9 mm 24-up, paper tag 99.1 × 67.7 mm 8-up; "start at label N" for part-used sheets; CSV). The QR (level Q, 4-module quiet zone, 25 / 40 mm) is drawn in the browser (`lib/scan/qr.ts`, `qrcode-generator`) and holds the host's `/s/<kind>/<code>` URL, the short code printed under it; the page warns when opened on a local address. Red tags: `red_tags` table, `POST/GET /scan/labels/redtags` (admin) reserve and list batches; a scanned reserved tag answers `red_tag` (blank). Not built yet: binding a red tag to a failed unit and bin / spare labels (no failed-unit or stock register), `input_method` / `raw_scan` columns, the per-category expectation warnings of §6.3.

1. `parse.ts` + `keymap.ts` with `bun test`; `/scan/resolve`; `ScanDialog` Type tab; `/s/:kind/:code`.
2. `useHidScanner` + global listener + ScanField + Settings "Test your scanner" (desk and iPad with a BT scanner).
3. Camera: decoder (native + ponyfill, self-hosted WASM, PWA cache), `CameraScanner`, permission UI, torch / zoom.
4. Photo fallback; FieldPicker + field hints for multi-field labels.
5. Labels: red tag reservation, A4 sheet / CSV, instrument and bin labels.
6. Batch mode (receive / issue / transfer / count) with `POST /stock/movements/batch`.
7. Device matrix test (§11), then `bun run lint && bun run build`, role tests as admin and engineer, and an update of `frontend/CLAUDE.md` (scanning section, LAN HTTPS for testing).

## 13. Decisions and open questions

Decided 2026-11-26:

1. **Scanners:** one USB / Bluetooth scanner at the store desk only. Crews use the phone or iPad camera on site, so the camera path (§5) is the main one in the field and the keyboard scanner the main one at the store.
2. **Label payload:** the URL (`https://<app-host>/s/<kind>/<code>`) in the QR, with the short `kind:code` printed underneath. The resolver accepts both, so a domain change only needs a reprint, never a lookup change.
3. **Red tags:** pre-printed in batches (an admin reserves `RT-xxxx` numbers and prints a sheet); a crew binds a blank tag to a failed unit by scanning it.
4. **Label stock:** two A4 layouts: weatherproof polyester for instruments, bins and spares, plain paper tags for red tags on failed units.

Still open:

5. Should **manual entry** of a serial need a photo of the label (stronger evidence for claims), or stay optional?
