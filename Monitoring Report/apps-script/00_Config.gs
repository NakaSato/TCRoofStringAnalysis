/**
 * Monitoring PWA Report — fill each day's sheet (DD.MM) from the TC Roof API (published daily data,
 * Firestore daily/{day}/plants/{id}), read with a shared key, so the script needs no Google Cloud permission.
 *
 * Menu "PWA Report" (every dialog and message is in Thai):
 *   ดึงข้อมูลตอนนี้              fills today's checks whose fetch time has passed (empty cells only)
 *   ดึงข้อมูลวันนี้ (เลือกรอบ)…   asks which checks (9, 13, 17; blank = all) and fills them for today,
 *                              whether or not their fetch time has passed (empty cells only)
 *   ดึงข้อมูลย้อนหลัง…           asks for a date and the checks, fills that day (empty cells only)
 *   ดึงใหม่และเขียนทับ…          asks for a date and the checks, then, after a confirmation, REPLACES
 *                              the check cells with the API's values (the only way a filled cell changes)
 *   ไปที่แท็บวันนี้              shows today's DD.MM tab (also done each time the file is opened)
 *   สร้างแท็บวันนี้              creates today's DD.MM tab now
 *   ดูสถานะ                    key set or not, fetch times, automatic runs on / off, today's checks done
 *   ตั้งค่า ▸ ตั้งค่าทั้งหมด…      report key + fetch time per check (default 08:50 / 12:50 / 16:50), then
 *                              turns on the automatic runs. Run it once.
 *           เปลี่ยนรหัสรายงาน (key)… / เปลี่ยนเวลาดึงข้อมูล…   one setting at a time
 *           เปิด / ปิดการทำงานอัตโนมัติ                        installs / removes the two triggers
 *   เก็บไฟล์รายเดือนตอนนี้…      moves the tabs of past months into one Drive file per month (see below)
 *   ตั้งค่า ▸ โฟลเดอร์เก็บไฟล์รายเดือน…   the Drive folder for those files (blank = this file's folder)
 * Dates may be typed as 2026-11-12, 12.11, 12/11, 12/11/2026 or 12/11/2569 (Buddhist year); blank = today.
 * Checks may be typed as "9", "9,13", "09 17", "13:00"; blank = all three.
 *
 * Automatic runs (Bangkok time):
 *   06:00-07:00     today's DD.MM sheet is created (copy of the newest DD.MM sheet, check columns cleared)
 *   every 5 min     from each fetch time until FETCH_WINDOW min after it, the check is fetched as soon
 *                   as the API has published it; with 08:50 the 09:00 check is in the sheet by ~08:55.
 *                   Once every plant row has its check, that check is done for the day (no more calls).
 *
 * One file per month: this spreadsheet stays the working file (the script, its triggers, the key and
 * the backend's PWA_SHEET_ID all point at it) and holds the current month only. When a new month's
 * first tab is created (06:00 run, or the menu), each past month's tabs are saved as a Drive file
 * "<this file's name> yyyy-MM": a copy of this file with only that month's tabs, in the archive folder.
 * Only after the copy is checked (same number of tabs) are those tabs deleted here. A month is
 * archived once (script property ARCHIVED_yyyy-MM = the file's id).
 * Needs the scopes in appsscript.json (spreadsheets, drive): after updating the script, run any menu
 * item once and approve, or the automatic runs stop.
 *
 * Never overwrites: a check cell (Status, Note, ค่าแสง, สภาพอากาศ, DATA LOG, kW, INV online) is written
 * only while it is empty, except by the menu item ดึงใหม่และเขียนทับ… (confirmed by the user).
 * A check the API hasn't published yet (every plant "—") is skipped.
 * Kept up to date (summaries of the checks so far): weather Status, Yield (kWh).
 * weather Status is only "Normal" (sensor reported at every check so far) or "Abnormal" (anything
 * else: a missed check, no sensor, no data, plant not found).
 * Firmware (row-1 header) is the datalogger's firmware: the API has none, so the cell stays blank
 * (a "—" or an inverter version an older script wrote there is blanked; hand-typed text is kept). Column C (SN Datalogger) is corrected from the
 * API when the row matched by plant name and the plant has exactly one datalogger.
 *
 * Rows 3+: B = plant name, C = datalogger SN. Columns are found from the header rows (layout_):
 *   old: weather Status | per check: Status, Note
 *   new: weather Status | per check: Status, ค่าแสง, สภาพอากาศ, DATA LOG (Fault log) [, kW, INV online]
 * Source: GET {REPORT_URL}/{day}/cells?hours=09,13 (X-Report-Key). The API builds every cell
 * (backend/app/services/pwa_sheet.py, plant_cells); nothing is made up: no source = "—".
 *
 * Setup: Extensions → Apps Script, paste every .gs file (00_Config … 06_Helpers, in that order) + appsscript.json, reload the sheet, PWA Report → ตั้งค่า…
 *   key: gcloud secrets versions access latest --secret tcroof-report-key --project tcroof-string-analysis
 */

const CHECK_HOURS = [9, 13, 17];                     // the sheet's three checks (columns found by layout_)
const DEFAULT_FETCH = ['08:50', '12:50', '16:50'];   // default fetch time per check
const FETCH_WINDOW = 120;  // keep trying a check for this many minutes after its fetch time
const POLL_EVERY = 5;      // minutes between automatic runs (Apps Script allows 1, 5, 10, 15, 30)
const FIRST_ROW = 3;
const DASH = '—';
const WX_NORMAL = 'Normal', WX_ABNORMAL = 'Abnormal'; // the only two weather Status values
const REPORT_URL = 'https://tcroof-string-analysis.web.app/api/report/pwa';
const HANDLERS = ['createTodaySheet', 'pollChecks', 'fillChecks', 'fillToday']; // old ones removed on setup
