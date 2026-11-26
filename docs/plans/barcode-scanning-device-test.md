# Checklist: Barcode & QR scanning on real devices (plan step 7)

The acceptance test of docs/plans/barcode-scanning.md §11. Everything so far was tested with
simulated key presses and test images; this run uses the real reader, phones, iPad and printed
labels. Tick each box, and for every ✗ write what happened in the notes column (device, browser,
label, what was read, screenshot if you can). Nothing here writes data unless a step says so.

Tester: ____________ Date: ____________ Reader model: ____________ App commit: ____________

## 0. Set up (once, about 20 min)

- [ ] **Serve the app on the office network over https** (cameras need it). On the Mac:
  `PYTHONPATH=backend uv run uvicorn app.main:app --port 8000` and, in `frontend/`,
  `VITE_DEV_HTTPS=1 bun run dev --host`. Note the address it prints, e.g. `https://10.50.30.25:5173`.
- [ ] On **each phone / iPad**: open that address, accept the certificate warning once, sign in.
  For the PWA rows also *Add to Home Screen* and open it from there.
- [ ] Two logins: `admin` and an **engineer** assigned to one plant only (Users & Access). Write the
  plant the engineer has: ________ and one plant they don't: ________
- [ ] **Reader in keyboard (HID) mode**, sends **Enter** after each code (factory default on most;
  otherwise scan the setup barcodes in its manual). Bluetooth readers: pair with each device.
- [ ] **Print the app labels** from `/labels` on A4 at 100 % (no "fit to page"), opened **from the
  https LAN address** above, not `localhost`: the QR holds the address it was printed from, and the
  phone camera test (2.13) opens it.
  - [ ] instrument labels (`kind=tool`): one, at both sizes, **25 mm** (polyester sheet) and **15 mm**
        (re-print scaled to 60 % for the 15 mm test)
  - [ ] a site device label (`dev`) for a device on the engineer's plant, and one on the other plant
  - [ ] a red tag batch (reserve 8 in `/labels` → Red tags), on the paper tag sheet; crease and smudge one
  - [ ] a bin label (`loc`) and one spare label (`sp`) (needs a store, a bin and one spare in Inventory)
- [ ] **Collect the manufacturer labels** (photo of the label is not enough, use the real thing or a
  good print): Growatt inverter (Code 128), Teltonika router (multi-field QR / DataMatrix), CEWE
  meter, PV module, a GS1 DataMatrix sample (any medical / retail box with "(01)…(21)…").

| Label | Kind | Expected value when scanned | Have it |
|---|---|---|---|
| L1 | app QR, instrument, 25 mm | opens the instrument | ☐ |
| L2 | app QR, instrument, 15 mm | opens the instrument | ☐ |
| L3 | app QR, site device, engineer's plant | opens the plant's Documents, that device | ☐ |
| L4 | app QR, site device, other plant | admin: opens it · engineer: "Not found, or not on one of your plants." | ☐ |
| L5 | red tag, clean | blank tag / its failed unit | ☐ |
| L6 | red tag, creased and dirty | same as L5, or no read; never another number | ☐ |
| L7 | Growatt inverter SN (Code 128) | the SN printed under the barcode | ☐ |
| L8 | Teltonika router (multi-field) | field picker; SN pre-selected or remembered | ☐ |
| L9 | CEWE meter | `WP` + 6 digits | ☐ |
| L10 | PV module | the module SN | ☐ |
| L11 | GS1 DataMatrix | serial = the (21) part | ☐ |
| L12 | bin label `loc:` | opens the batch page at that bin | ☐ |

## 1. Keyboard reader at the store desk (Windows PC or Mac)

Do it once with the keyboard on **English** and once on **Thai** (switch the OS input language).

| # | Check | EN | TH | Notes |
|---|---|---|---|---|
| 1.1 | Settings → Scanning → click the test box, scan L7: "Read as" = the SN, "Taken as a scan", end key Enter | ☐ | ☐ | |
| 1.2 | Same for L1 and L9; time between keys max under the limit shown | ☐ | ☐ | |
| 1.3 | On any page, nothing focused, scan L1: the instrument opens | ☐ | ☐ | |
| 1.4 | Scan L3 the same way: the device opens | ☐ | ☐ | |
| 1.5 | In a form's serial field (Inventory → Receive → Serial no.), scan L7: the SN fills in, a "Scanner" badge shows, the form is **not** submitted | ☐ | ☐ | |
| 1.6 | Scan L8 into that field: the field picker opens; pick SN; scan L8 again: SN is pre-selected | ☐ | ☐ | |
| 1.7 | `/inventory/scan` (Receive, pick a bin): scan L7, L9, L10 one after another: one row each; scan L7 again: "duplicate in this list". **Do not press Confirm** (or Clear afterwards) | ☐ | ☐ | |
| 1.8 | Scan L12 on the batch page: it switches to that bin | ☐ | ☐ | |
| 1.9 | Type a serial by hand quickly in a normal text field (not a scan field): it is **not** taken as a scan | ☐ | ☐ | |

## 2. Camera and photo, per device

Fill one column per device. Live = the Scan button in the top bar, Camera tab. Photo = Photo tab.
Time the app QR from pointing the camera until the record opens.

| # | Check | iPhone Safari | iPhone PWA | iPad Safari | iPad PWA | Android Chrome | Android PWA |
|---|---|---|---|---|---|---|---|
| 2.1 | First use asks for camera permission with the app's explanation; allow works | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 2.2 | L1 (25 mm) opens in **≤ 2 s** (write the time) | ☐ ___s | ☐ ___s | ☐ ___s | ☐ ___s | ☐ ___s | ☐ ___s |
| 2.3 | L2 (15 mm) opens in ≤ 2 s at 10–20 cm | ☐ ___s | ☐ ___s | ☐ ___s | ☐ ___s | ☐ ___s | ☐ ___s |
| 2.4 | L7 Growatt Code 128 reads the right SN (hold the phone sideways if needed) | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 2.5 | L8 router: field picker, SN chosen | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 2.6 | L9, L10, L11 read correctly (L11: the serial, not the whole GS1 string) | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 2.7 | L6 dirty red tag: reads RT-number or nothing; **never a wrong number** | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 2.8 | Low light: torch button shows (where the device has one) and helps | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 2.9 | Outdoors in sunlight with glare on L1 / L7: tilt until it reads; note how long | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 2.10 | Photo tab: a photo of L10 (small / curved) reads, also when taken rotated | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 2.11 | Close the dialog: the camera light / indicator goes off within a second | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 2.12 | With the camera open, switch to another app and back: off while away, on again after | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 2.13 | The phone's **own camera app** on L1: tapping the link opens the app on the instrument (signing in first if needed) | ☐ | — | ☐ | — | ☐ | — |

Desktop webcam (optional): Windows Chrome ☐ · Windows Edge ☐ · Mac Chrome ☐ · Mac Safari ☐ (2.2 and 2.11 only).

## 3. Bluetooth reader on iPad and Android

| # | Check | iPad, EN keyboard | iPad, **Thai** keyboard | Android |
|---|---|---|---|---|
| 3.1 | Settings → Scanning test box: L7 reads right, taken as a scan | ☐ | ☐ | ☐ |
| 3.2 | `loc:` / `sp:` codes (L12) read with the colon, not `;` | ☐ | ☐ | ☐ |
| 3.3 | 1.5 and 1.7 above work | ☐ | ☐ | ☐ |
| 3.4 | The on-screen keyboard does not pop up over the page after a scan with nothing focused | ☐ | ☐ | ☐ |

## 4. Accuracy run: 200 scans, 0 wrong reads

On the store PC with the keyboard reader, and once with one phone camera.

1. Open `/inventory/scan?mode=receive`, pick any bin (nothing is saved until Confirm: **don't press it**).
2. Scan the 10 labels L1–L3, L5–L11 twenty times each, in any order, including L6 (dirty) and at angles.
3. Every row must show one of the expected values from the table in §0. A code that does not read
   is fine (it just doesn't add a row); **a row with any other value is a fail**. Write it down exactly.
4. Clear the list.

| Run | Scans | No read | Wrong value | Pass (wrong = 0) |
|---|---|---|---|---|
| Keyboard reader | 200 | | | ☐ |
| Camera: ________ | 200 | | | ☐ |

## 5. Access (engineer)

Signed in as the engineer:

- [ ] 5.1 Scan L3 (their plant): opens.
- [ ] 5.2 Scan L4 (other plant): "Not found, or not on one of your plants." Nothing about the other plant shows.
- [ ] 5.3 Open L4's link from the phone camera app: same message, no data.
- [ ] 5.4 Type L4's device serial in the Scan dialog: no match from the other plant.

## 6. Pass / fail

The run passes when all of these hold:

- [ ] an app QR (L1) opens in ≤ 2 s on every camera device (2.2)
- [ ] the keyboard reader is right with the Thai layout on Windows, macOS and iPadOS (1.x TH column, 3.x Thai column)
- [ ] 0 wrong reads in both 200-scan runs (§4)
- [ ] the camera stops when the dialog closes or the app goes to the background (2.11, 2.12)
- [ ] an engineer gets "not found" for another plant's label (5.2–5.4)

Result: ☐ pass ☐ fail. Send back this sheet (photo is fine) with the notes; each ✗ becomes an issue.
