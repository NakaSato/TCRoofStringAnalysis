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
 * Setup: Extensions → Apps Script, paste Code.gs + appsscript.json, reload the sheet, PWA Report → ตั้งค่า…
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


// ------------------------------------------------------------------ menu

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('PWA Report')
    .addItem('ดึงข้อมูลตอนนี้', 'fillNow')
    .addItem('ดึงข้อมูลวันนี้ (เลือกรอบ)…', 'fillPickChecks')
    .addItem('ดึงข้อมูลย้อนหลัง…', 'fillAskDay')
    .addItem('ดึงใหม่และเขียนทับ…', 'refillOverwrite')
    .addSeparator()
    .addItem('สร้างแท็บวันนี้', 'menuCreateToday')
    .addItem('เก็บไฟล์รายเดือนตอนนี้…', 'menuArchive')
    .addItem('ดูสถานะ', 'showStatus')
    .addSeparator()
    .addSubMenu(ui.createMenu('ตั้งค่า')
      .addItem('ตั้งค่าทั้งหมด…', 'setup')
      .addItem('เปลี่ยนรหัสรายงาน (key)…', 'setKey')
      .addItem('เปลี่ยนเวลาดึงข้อมูล…', 'setTimes')
      .addItem('โฟลเดอร์เก็บไฟล์รายเดือน…', 'setArchiveFolder')
      .addSeparator()
      .addItem('เปิดการทำงานอัตโนมัติ', 'autoOn')
      .addItem('ปิดการทำงานอัตโนมัติ', 'autoOff'))
    .addToUi();
}

/** Runs a menu action: shows the text it returns, and any error, as a Thai dialog. */
function menu_(fn) {
  const ui = SpreadsheetApp.getUi();
  try {
    const msg = fn(ui);
    if (msg) ui.alert(msg);
  } catch (e) {
    ui.alert('เกิดข้อผิดพลาด\n\n' + (e && e.message ? e.message : e));
  }
}

/** A text prompt: the trimmed answer, or null when the user cancelled. */
function ask_(ui, title, text) {
  const r = ui.prompt(title, text, ui.ButtonSet.OK_CANCEL);
  return r.getSelectedButton() === ui.Button.OK ? r.getResponseText().trim() : null;
}

/** Asks for the report key. True when a key is stored afterwards. */
function askKey_(ui, title) {
  const props = PropertiesService.getScriptProperties();
  const hasKey = !!props.getProperty('REPORT_KEY');
  const key = ask_(ui, title || 'รหัสรายงาน',
    hasKey ? 'มีรหัสอยู่แล้ว ปล่อยว่างเพื่อใช้รหัสเดิม หรือวางรหัสใหม่:' : 'วางรหัสรายงานที่ได้รับจากผู้ดูแลระบบ:');
  if (key === null) return false;
  if (key) props.setProperty('REPORT_KEY', key);
  else if (!hasKey) { ui.alert('ยังไม่มีรหัสรายงาน จึงยังไม่ได้บันทึก'); return false; }
  return true;
}

/** Asks for the fetch time of each check. True when the times are valid (kept or changed). */
function askTimes_(ui, title) {
  const cur = fetchTimes_();
  const t = ask_(ui, title || 'เวลาดึงข้อมูล',
    `เวลาดึงข้อมูลของรอบ ${CHECK_HOURS.map(clock_).join(' / ')} คั่นด้วยจุลภาค\n` +
    `ตอนนี้: ${cur.join(', ')}\nปล่อยว่างเพื่อใช้เวลาเดิม`);
  if (t === null) return false;
  if (!t) return true;
  const times = t.split(',').map(x => x.trim()).filter(Boolean).map(normTime_);
  if (times.length !== CHECK_HOURS.length || times.some(x => !x)) {
    ui.alert(`ต้องใส่ ${CHECK_HOURS.length} เวลา รูปแบบ ชั่วโมง:นาที เช่น ${DEFAULT_FETCH.join(', ')}`);
    return false;
  }
  PropertiesService.getScriptProperties().setProperty('FETCH_TIMES', times.join(','));
  return true;
}

function installTriggers_() {
  removeTriggers_();
  ScriptApp.newTrigger('createTodaySheet').timeBased().atHour(6).everyDays(1).inTimezone('Asia/Bangkok').create();
  ScriptApp.newTrigger('pollChecks').timeBased().everyMinutes(POLL_EVERY).create();
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().filter(tr => HANDLERS.indexOf(tr.getHandlerFunction()) >= 0).forEach(tr => ScriptApp.deleteTrigger(tr));
}

function autoIsOn_() {
  return ScriptApp.getProjectTriggers().some(tr => tr.getHandlerFunction() === 'pollChecks');
}

function scheduleText_() {
  const times = fetchTimes_();
  return '06:00–07:00  สร้างแท็บของวันนี้\n' +
    CHECK_HOURS.map((h, k) => `${times[k]}  ดึงรอบ ${clock_(h)} (ลองทุก ${POLL_EVERY} นาที จนได้ข้อมูล)`).join('\n');
}

/** Report key + fetch times, then (re)installs the automatic runs. */
function setup() {
  menu_(ui => {
    if (!askKey_(ui, 'ตั้งค่า 1/2 — รหัสรายงาน')) return '';
    if (!askTimes_(ui, 'ตั้งค่า 2/2 — เวลาดึงข้อมูล')) return '';
    installTriggers_();
    return 'บันทึกแล้ว ระบบจะทำงานอัตโนมัติ (เวลาไทย)\n\n' + scheduleText_() + '\n\nช่องที่มีค่าแล้วจะไม่ถูกเขียนทับ';
  });
}

function setKey() {
  menu_(ui => (askKey_(ui, 'เปลี่ยนรหัสรายงาน') ? 'บันทึกรหัสรายงานแล้ว' : ''));
}

function setTimes() {
  menu_(ui => (askTimes_(ui, 'เปลี่ยนเวลาดึงข้อมูล') ? 'เวลาดึงข้อมูล (เวลาไทย)\n\n' + scheduleText_() : ''));
}

function autoOn() {
  menu_(() => {
    if (!PropertiesService.getScriptProperties().getProperty('REPORT_KEY'))
      return 'ยังไม่มีรหัสรายงาน\nไปที่เมนู PWA Report → ตั้งค่า → ตั้งค่าทั้งหมด… ก่อน';
    installTriggers_();
    return 'เปิดการทำงานอัตโนมัติแล้ว (เวลาไทย)\n\n' + scheduleText_();
  });
}

function autoOff() {
  menu_(() => {
    removeTriggers_();
    return 'ปิดการทำงานอัตโนมัติแล้ว\nยังดึงข้อมูลเองได้จากเมนู PWA Report';
  });
}

function showStatus() {
  menu_(() => {
    const props = PropertiesService.getScriptProperties();
    const day = today_(), name = sheetName_(day);
    const done = (props.getProperty('DONE_' + day) || '').split(',').filter(Boolean);
    return 'สถานะ PWA Report\n\n' +
      `รหัสรายงาน: ${props.getProperty('REPORT_KEY') ? 'ตั้งไว้แล้ว' : 'ยังไม่ได้ตั้ง'}\n` +
      `การทำงานอัตโนมัติ: ${autoIsOn_() ? 'เปิด' : 'ปิด'}\n` +
      `เวลาดึงข้อมูล: ${fetchTimes_().join(', ')}\n` +
      `แท็บของวันนี้ (${name}): ${SpreadsheetApp.getActive().getSheetByName(name) ? 'มีแล้ว' : 'ยังไม่มี'}\n` +
      `รอบที่ดึงครบแล้ววันนี้: ${done.length ? done.map(h => clock_(Number(h))).join(', ') : 'ยังไม่มี'}\n` +
      `โฟลเดอร์เก็บไฟล์รายเดือน: ${archiveFolder_().getName()}`;
  });
}

function menuCreateToday() {
  menu_(() => {
    const ss = SpreadsheetApp.getActive(), name = sheetName_(today_());
    if (ss.getSheetByName(name)) return `มีแท็บ ${name} อยู่แล้ว`;
    newDaySheet_(ss, name);
    return `สร้างแท็บ ${name} แล้ว`;
  });
}

/** Menu: archive past months now, after a confirmation. */
function menuArchive() {
  menu_(ui => {
    const ss = SpreadsheetApp.getActive(), today = today_();
    const months = pastMonths_(ss, today);
    if (!months.length) return 'ไม่มีแท็บของเดือนก่อนให้เก็บ\nไฟล์นี้มีเฉพาะเดือนปัจจุบัน';
    const sure = ui.alert('ยืนยันการเก็บไฟล์รายเดือน',
      months.map(m => `เดือน ${m.label}: ${m.tabs.length} แท็บ → ไฟล์ "${m.file}"`).join('\n') +
      `\n\nโฟลเดอร์: ${archiveFolder_().getName()}\n` +
      'แท็บของเดือนเหล่านี้จะถูกย้ายออกจากไฟล์นี้ไปอยู่ในไฟล์รายเดือน\n\nต้องการดำเนินการหรือไม่', ui.ButtonSet.YES_NO);
    if (sure !== ui.Button.YES) return 'ยกเลิกแล้ว ไม่มีการเปลี่ยนแปลง';
    return archiveText_(archivePastMonths_(ss, today));
  });
}

/** Menu: the Drive folder for the monthly files (a folder link or id; blank = this file's folder). */
function setArchiveFolder() {
  menu_(ui => {
    const props = PropertiesService.getScriptProperties();
    const t = ask_(ui, 'โฟลเดอร์เก็บไฟล์รายเดือน',
      `ตอนนี้: ${archiveFolder_().getName()}\n\nวางลิงก์โฟลเดอร์ใน Google Drive\nปล่อยว่างเพื่อใช้โฟลเดอร์เดียวกับไฟล์นี้`);
    if (t === null) return '';
    if (!t) { props.deleteProperty('ARCHIVE_FOLDER_ID'); return `ใช้โฟลเดอร์เดียวกับไฟล์นี้: ${archiveFolder_().getName()}`; }
    const m = /folders\/([A-Za-z0-9_-]+)/.exec(t) || /^([A-Za-z0-9_-]{10,})$/.exec(t);
    if (!m) return 'ไม่ใช่ลิงก์โฟลเดอร์ของ Google Drive\nเปิดโฟลเดอร์ใน Drive แล้วคัดลอกลิงก์จากแถบที่อยู่';
    let name;
    try { name = DriveApp.getFolderById(m[1]).getName(); } catch (e) { return 'เปิดโฟลเดอร์นี้ไม่ได้\nตรวจสอบว่าบัญชีนี้มีสิทธิ์แก้ไขโฟลเดอร์'; }
    props.setProperty('ARCHIVE_FOLDER_ID', m[1]);
    return `บันทึกแล้ว ไฟล์รายเดือนจะเก็บในโฟลเดอร์: ${name}`;
  });
}

/** Asks for the checks; null = cancelled (an invalid answer is reported and also returns null). */
function askHours_(ui, title) {
  const t = ask_(ui, title, `รอบที่ต้องการ: ${CHECK_HOURS.join(', ')} คั่นด้วยจุลภาค เช่น 9,13\nปล่อยว่างเพื่อดึงทุกรอบ`);
  if (t === null) return null;
  const hours = parseHours_(t);
  if (!hours) ui.alert(`ไม่รู้จักรอบ "${t}"\nใส่ได้เฉพาะ ${CHECK_HOURS.join(', ')} เช่น 9,13`);
  return hours;
}

/** Asks for a day; null = cancelled (an invalid or future date is reported and also returns null). */
function askDay_(ui, title) {
  const t = ask_(ui, title, 'วันที่ เช่น 12.11 หรือ 12/11/2569 หรือ 2026-11-12\nปล่อยว่างเพื่อใช้วันนี้');
  if (t === null) return null;
  const day = parseDay_(t);
  if (!day) { ui.alert(`ไม่รู้จักวันที่ "${t}"\nตัวอย่างที่ใช้ได้: 12.11  12/11/2569  2026-11-12`); return null; }
  if (day > today_()) { ui.alert(`${sheetName_(day)} ยังมาไม่ถึง`); return null; }
  return day;
}

/** Menu: today's checks whose fetch time has passed. */
function fillNow() {
  const hm = nowMin_(), times = fetchTimes_();
  const hours = CHECK_HOURS.filter((h, k) => hm >= toMin_(times[k]));
  let msg;
  try {
    msg = hours.length ? fillDay(today_(), hours).msg
      : `ยังไม่ถึงเวลาดึงรอบแรก (${times[0]})\nถ้าต้องการดึงเลย ใช้เมนู ดึงข้อมูลวันนี้ (เลือกรอบ)…`;
  } catch (e) { msg = 'เกิดข้อผิดพลาด\n\n' + (e && e.message ? e.message : e); }
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
}

/** Menu: today, the checks the user names (whether or not their fetch time has passed). */
function fillPickChecks() {
  menu_(ui => {
    const hours = askHours_(ui, 'ดึงข้อมูลวันนี้');
    return hours ? fillDay(today_(), hours).msg : '';
  });
}

/** Menu: a past day, the checks the user names. */
function fillAskDay() {
  menu_(ui => {
    const day = askDay_(ui, 'ดึงข้อมูลย้อนหลัง 1/2 — วันที่');
    if (!day) return '';
    const hours = askHours_(ui, `ดึงข้อมูลย้อนหลัง 2/2 — รอบของ ${sheetName_(day)}`);
    return hours ? fillDay(day, hours).msg : '';
  });
}

/** Menu: replace a day's check cells with the API's values, after a confirmation. */
function refillOverwrite() {
  menu_(ui => {
    const day = askDay_(ui, 'ดึงใหม่และเขียนทับ 1/2 — วันที่');
    if (!day) return '';
    const hours = askHours_(ui, `ดึงใหม่และเขียนทับ 2/2 — รอบของ ${sheetName_(day)}`);
    if (!hours) return '';
    const sure = ui.alert('ยืนยันการเขียนทับ',
      `แท็บ ${sheetName_(day)} รอบ ${hours.map(clock_).join(', ')}\n\n` +
      'ค่าในคอลัมน์ของรอบที่เลือกจะถูกแทนด้วยค่าจากระบบ\nค่าที่พิมพ์แก้ไว้เองในคอลัมน์เหล่านั้นจะหายไป\n\nต้องการเขียนทับหรือไม่', ui.ButtonSet.YES_NO);
    return sure === ui.Button.YES ? fillDay(day, hours, { overwrite: true }).msg : 'ยกเลิกแล้ว ไม่มีการเปลี่ยนแปลง';
  });
}

// ------------------------------------------------------------------ automatic runs

/** Creates today's empty DD.MM sheet (no-op if it already exists), then archives past months. */
function createTodaySheet() {
  const ss = SpreadsheetApp.getActive();
  const today = today_(), name = sheetName_(today);
  if (!ss.getSheetByName(name)) newDaySheet_(ss, name);
  try {
    const done = archivePastMonths_(ss, today);
    if (done.length) console.log(archiveText_(done).replace(/\n+/g, ' | '));
  } catch (e) { console.log('เก็บไฟล์รายเดือนไม่สำเร็จ: ' + (e && e.message ? e.message : e)); }
}

// ------------------------------------------------------------------ one file per month

/** The Drive folder for the monthly files: script property ARCHIVE_FOLDER_ID, else this file's folder. */
function archiveFolder_() {
  const id = PropertiesService.getScriptProperties().getProperty('ARCHIVE_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const parents = DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}

/**
 * The past months that still have DD.MM tabs here and were not archived yet, oldest first:
 * [{key: "2026-10", label: "10/2026", file: "<name> 2026-10", tabs: ["01.10", …]}]. Tab names carry
 * no year: a month after the current one belongs to last year.
 */
function pastMonths_(ss, today) {
  const props = PropertiesService.getScriptProperties();
  const y = +today.slice(0, 4), cur = today.slice(5, 7);
  const by = {};
  ss.getSheets().forEach(s => {
    const m = /^\d{2}\.(\d{2})$/.exec(s.getName());
    if (!m || m[1] === cur || +m[1] < 1 || +m[1] > 12) return;
    const key = `${m[1] > cur ? y - 1 : y}-${m[1]}`;
    (by[key] = by[key] || []).push(s.getName());
  });
  return Object.keys(by).sort().filter(key => !props.getProperty('ARCHIVED_' + key))
    .map(key => ({ key, label: `${key.slice(5)}/${key.slice(0, 4)}`, file: `${ss.getName()} ${key}`, tabs: by[key] }));
}

/**
 * Saves each past month as its own Drive file and removes its tabs from this file. The month's file
 * is a copy of this spreadsheet with every other month's DD.MM tab deleted (other sheets are kept).
 * The tabs are deleted here only after the copy holds all of them. Returns
 * [{label, file, url, tabs: n}]; [] when there is nothing to archive.
 */
function archivePastMonths_(ss, today) {
  const months = pastMonths_(ss, today);
  if (!months.length) return [];
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return [];
  try {
    const props = PropertiesService.getScriptProperties();
    const name = sheetName_(today);
    if (!ss.getSheetByName(name)) newDaySheet_(ss, name); // this file must keep a tab (and a template)
    const folder = archiveFolder_();
    const out = [];
    months.forEach(m => {
      const copy = DriveApp.getFileById(ss.getId()).makeCopy(m.file, folder);
      const cs = SpreadsheetApp.openById(copy.getId());
      const kept = cs.getSheets().filter(s => m.tabs.indexOf(s.getName()) >= 0).length;
      if (kept !== m.tabs.length)
        throw new Error(`ไฟล์ "${m.file}" มี ${kept} แท็บ จากที่ควรมี ${m.tabs.length} แท็บ จึงยังไม่ลบแท็บออกจากไฟล์นี้`);
      cs.getSheets().forEach(s => { if (/^\d{2}\.\d{2}$/.test(s.getName()) && m.tabs.indexOf(s.getName()) < 0) cs.deleteSheet(s); });
      m.tabs.forEach(t => ss.deleteSheet(ss.getSheetByName(t)));
      props.setProperty('ARCHIVED_' + m.key, copy.getId());
      out.push({ label: m.label, file: m.file, url: cs.getUrl(), tabs: kept });
    });
    return out;
  } finally { lock.releaseLock(); }
}

function archiveText_(done) {
  if (!done.length) return 'ไม่มีแท็บของเดือนก่อนให้เก็บ';
  return 'เก็บไฟล์รายเดือนแล้ว\n\n' + done.map(d => `เดือน ${d.label}: ${d.tabs} แท็บ → "${d.file}"\n${d.url}`).join('\n\n');
}

/** Every POLL_EVERY min: fills each check inside its window that isn't done yet today; else returns at once. */
function pollChecks() {
  const hm = nowMin_(), times = fetchTimes_(), day = today_();
  const props = PropertiesService.getScriptProperties();
  const done = (props.getProperty('DONE_' + day) || '').split(',').filter(Boolean);
  const due = CHECK_HOURS.filter((h, k) => {
    const t = toMin_(times[k]);
    return hm >= t && hm <= t + FETCH_WINDOW && done.indexOf(pad_(h)) < 0;
  });
  if (!due.length) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    // ask for every check due so far, so weather Status covers them all; filled cells stay as they are
    const hours = CHECK_HOURS.filter((h, k) => hm >= toMin_(times[k]));
    const r = fillDay(day, hours);
    const nowDone = done.concat(due.filter(h => r.complete.indexOf(pad_(h)) >= 0).map(pad_));
    if (nowDone.length > done.length) props.setProperty('DONE_' + day, nowDone.join(','));
    console.log(r.msg.replace(/\n+/g, ' | '));
  } finally { lock.releaseLock(); }
}

// ------------------------------------------------------------------ main

/**
 * Fills `day`'s sheet for checks `hours` (default all three). Check cells are written only while empty
 * (`opts.overwrite`: also where the API's value differs); checks the API hasn't published yet are
 * skipped. Returns {msg, complete: ["09", …]} where complete lists the checks every matched plant row
 * now has. `msg` is Thai (it is shown in a dialog).
 */
function fillDay(day, hours, opts) {
  const overwrite = !!(opts && opts.overwrite);
  const ss = SpreadsheetApp.getActive();
  const name = sheetName_(day);
  const sh = ss.getSheetByName(name) || newDaySheet_(ss, name);
  const lay = layout_(sh);
  let blocks = hours ? lay.blocks.filter(b => hours.indexOf(b.hour) >= 0) : lay.blocks;
  if (!blocks.length) return { msg: `แท็บ ${name}: ไม่มีรอบให้ดึง`, complete: [] };

  let data = reportCells_(day, blocks.map(b => b.hour));
  if (!data.published_plants) return { msg: `แท็บ ${name}: ระบบยังไม่มีข้อมูลของวันนี้`, complete: [] };
  const ready = blocks.filter(b => published_(data, pad_(b.hour)));
  if (!ready.length) return { msg: `แท็บ ${name}: รอบ ${blocks.map(b => clock_(b.hour)).join(', ')} ยังไม่มีข้อมูลในระบบ ลองใหม่ภายหลัง`, complete: [] };
  if (ready.length < blocks.length) { // refetch so weather Status / yield cover only published checks
    blocks = ready;
    data = reportCells_(day, blocks.map(b => b.hour));
  }
  const cols = data.columns; // ["status", "note", "irr", "wx", "log", "kw", "inv"]
  const names = data.names || {};

  const last = sh.getLastRow();
  if (last < FIRST_ROW) return { msg: `แท็บ ${name}: ไม่มีแถวสถานี`, complete: [] };
  const n = last - FIRST_ROW + 1;
  const keys = sh.getRange(FIRST_ROW, 2, n, 2).getValues(); // B name, C SN
  const block = sh.getRange(FIRST_ROW, lay.first, n, lay.last - lay.first + 1);
  const values = block.getValues();
  const get = (row, col) => values[row][col - lay.first];
  const set = (row, col, v) => { if (col) values[row][col - lay.first] = v; };
  const fill = (row, col, v) => {
    if (!col) return 0;
    const cur = get(row, col);
    if (cur === '' || (overwrite && cur !== v)) { values[row][col - lay.first] = v; return 1; }
    return 0;
  };

  const stats = { rows: 0, written: 0, kept: 0, unmatched: 0, snUpdated: 0 };
  const missing = {}; blocks.forEach(b => { missing[pad_(b.hour)] = 0; });
  const snOf = loggersByPlant_(data);
  const snCol = keys.map(k => [k[1]]);
  keys.forEach(([nm, sn], i) => {
    sn = String(sn || '').trim();
    nm = String(nm || '').trim();
    if (!sn && !nm) return; // not a plant row
    const pid = matchPlant_(sn, nm, data.loggers || {}, names);
    if (!pid) { if (sn) { stats.unmatched++; set(i, lay.weather, WX_ABNORMAL); } return; }
    stats.rows++;
    // SN Datalogger (column C): the plant's current datalogger, when the sheet's SN isn't one of its
    // loggers (replaced, or C empty) and the API names exactly one.
    const sns = snOf[pid] || [];
    if (sns.indexOf(sn) < 0 && sns.length === 1) { snCol[i] = [sns[0]]; keys[i][1] = sns[0]; stats.snUpdated++; }
    const p = data.plants[pid];
    blocks.forEach(b => {
      const v = (p.checks || {})[pad_(b.hour)];
      if (!v) { if (get(i, b.status) === '') missing[pad_(b.hour)]++; return; }
      const wasEmpty = get(i, b.status) === '';
      cols.forEach((c, k) => { stats.written += fill(i, b[c], v[k]); });
      if (!wasEmpty && !overwrite) stats.kept++;
      if (get(i, b.status) === '') missing[pad_(b.hour)]++;
    });
    set(i, lay.weather, weatherStatus_(p.weather_status));
    set(i, lay.yieldKwh, p.yield_kwh);
  });
  block.setValues(values);
  if (stats.snUpdated) sh.getRange(FIRST_ROW, 3, snCol.length, 1).setValues(snCol);
  const fw = fillFirmware_(sh, lay.firmware, keys, data.firmware, overwrite, data.dataloggers);
  const complete = Object.keys(missing).filter(hh => !missing[hh]);
  const skipped = hours ? hours.filter(h => blocks.every(b => b.hour !== h)) : [];
  const msg = `แท็บ ${name} รอบ ${blocks.map(b => clock_(b.hour)).join(', ')} (${stats.rows} สถานี)\n\n` +
    (overwrite ? `เขียนทับ/เติม ${stats.written} ช่อง\n`
      : `เติมช่องว่าง ${stats.written} ช่อง\nสถานีที่มีค่าอยู่แล้ว (ไม่เขียนทับ) ${stats.kept}\n`) +
    `สถานีที่ไม่พบในระบบ ${stats.unmatched}\nแก้เลข SN ${stats.snUpdated} แถว` +
    (fw && fw.hits ? `\nเติม Firmware ${fw.hits} แถว` : '') +
    (fw && fw.cleared ? `\nล้างช่อง Firmware ${fw.cleared} แถว (ระบบไม่มี Firmware ของ Datalogger)` : '') +
    (skipped.length ? `\n\nรอบ ${skipped.map(clock_).join(', ')} ยังไม่มีข้อมูลในระบบ จึงข้ามไป` : '');
  console.log(msg.replace(/\n+/g, ' | '));
  return { msg, complete };
}

/**
 * Firmware column (row-1 header "Firmware"), by the row's datalogger SN (column C):
 * firmware = {datalogger_sn: version} from the API = the DATALOGGER's own firmware. Growatt's API
 * gives none, so the map is empty and the cell is left blank (nothing is made up). A cell that holds
 * "—" or an inverter version an older script wrote there (dataloggers[sn].inverter_firmware from the
 * API) is blanked; anything else (typed by hand) is kept. Written on its own, so the check block and
 * newDaySheet_ (which clears only the report's own columns) never touch it. Returns {hits, cleared}
 * (rows that got a version / rows blanked), or null when the sheet has no Firmware column or the API
 * sent no firmware map (older API: the column is left as it is). `overwrite` (ดึงใหม่และเขียนทับ…):
 * a cell is also replaced when the API has a different version for the row.
 */
function fillFirmware_(sh, col, keys, firmware, overwrite, dataloggers) {
  if (!col || !firmware) return null;
  let hits = 0, cleared = 0;
  const range = sh.getRange(FIRST_ROW, col, keys.length, 1);
  const old = range.getValues();
  const vals = keys.map(([, sn], i) => {
    sn = String(sn || '').trim();
    if (!sn) return old[i]; // non-plant row: keep
    const cur = String(old[i][0] === null ? '' : old[i][0]).trim();
    const v = firmware[sn] || '';
    const stale = ((dataloggers || {})[sn] || {}).inverter_firmware || [];
    const ours = cur === '' || cur === DASH || stale.indexOf(cur) >= 0; // empty, or written by the report
    if (!ours && !(overwrite && v && v !== cur)) return old[i]; // typed by hand: kept
    if (v) hits++;
    else if (cur !== '') cleared++;
    return [v];
  });
  range.setValues(vals);
  return { hits, cleared };
}

/**
 * {plant id: [datalogger SN, …]}: the plant's own `datalogger_sn` (list or string) when the API sends
 * one, else every SN in the API's loggers map that points at that plant.
 */
function loggersByPlant_(data) {
  const out = {};
  Object.keys(data.plants || {}).forEach(id => {
    const own = data.plants[id].datalogger_sn;
    if (own) out[id] = [].concat(own).map(String);
  });
  const loggers = data.loggers || {};
  Object.keys(loggers).forEach(sn => {
    const id = loggers[sn];
    if (data.plants && data.plants[id] && data.plants[id].datalogger_sn) return;
    (out[id] = out[id] || []).push(sn);
  });
  return out;
}

/**
 * weather Status is only "Normal" / "Abnormal" (header "(Normal / Abnormal)"): Normal when the API
 * says the weather sensor reported at every check so far; anything else — a missed check
 * ("loss (13:00)"), no sensor, no data, plant not found — is Abnormal.
 */
function weatherStatus_(v) {
  return String(v == null ? '' : v).trim().toLowerCase() === 'normal' ? WX_NORMAL : WX_ABNORMAL;
}

/** True when at least one plant has a real value (not "—" / empty) in check `hh`. */
function published_(data, hh) {
  return Object.keys(data.plants || {}).some(id => {
    const v = (data.plants[id].checks || {})[hh];
    return v && v.some(x => x !== DASH && x !== '' && x != null);
  });
}

/** Plant id of a sheet row: datalogger SN, else a unique plant-name match (datalogger replaced). */
function matchPlant_(sn, nm, loggers, names) {
  if (loggers[sn]) return loggers[sn];
  const hits = nm ? Object.keys(names).filter(id => String(names[id] || '').indexOf(nm) >= 0) : [];
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Column map from header rows 1–2. Works for both layouts:
 *   old (≤ 30.10): weather Status | Status, Note  ×3
 *   new (12.11+):  weather Status | Status, ค่าแสง, สภาพอากาศ, DATA LOG  ×3
 *   optional:      per check "kW" (or กำลังผลิต), "INV online"; row 1 "Yield (kWh)" (or พลังงาน)
 * Each "Status" in row 2 starts the next check block (09, 13, 17).
 */
function layout_(sh) {
  const width = sh.getLastColumn();
  const [r1, r2] = sh.getRange(1, 1, 2, width).getDisplayValues();
  const weather = r1.findIndex(v => /weather\s*status/i.test(v)) + 1;
  if (!weather) throw new Error(`แท็บ ${sh.getName()}: ไม่พบหัวคอลัมน์ "Weather Status" ในแถวที่ 1`);
  const starts = [];
  r2.forEach((v, k) => { if (k + 1 > weather && /^status/i.test(String(v).trim())) starts.push(k + 1); });
  if (starts.length < CHECK_HOURS.length) throw new Error(`แท็บ ${sh.getName()}: แถวที่ 2 ต้องมีหัวคอลัมน์ "Status" ${CHECK_HOURS.length} คอลัมน์ (รอบละหนึ่ง)`);
  const blocks = CHECK_HOURS.map((hour, k) => {
    const from = starts[k], to = k + 1 < starts.length ? starts[k + 1] - 1 : Math.min(width, from + 6);
    const b = { hour, status: from, note: 0, irr: 0, wx: 0, log: 0, kw: 0, inv: 0 };
    for (let col = from + 1; col <= to; col++) {
      const v = String(r2[col - 1]).trim();
      if (/^note/i.test(v)) b.note = col;
      else if (/ค่าแสง/.test(v)) b.irr = col;
      else if (/สภาพอากาศ/.test(v)) b.wx = col;
      else if (/data\s*log/i.test(v)) b.log = col;
      else if (/^kw\b/i.test(v) || /กำลังผลิต/.test(v)) b.kw = col;
      else if (/inv\s*online/i.test(v)) b.inv = col;
    }
    return b;
  });
  const yieldKwh = r1.findIndex(v => /yield/i.test(v) || /พลังงาน/.test(v)) + 1;
  const firmware = r1.findIndex(v => /firmware/i.test(v)) + 1; // own column, outside the check block
  const cols = [weather, yieldKwh].concat(...blocks.map(b => [b.status, b.note, b.irr, b.wx, b.log, b.kw, b.inv])).filter(Boolean);
  return { weather, yieldKwh, firmware, blocks, cols, first: Math.min(...cols), last: Math.max(...cols) };
}

/**
 * New day sheet = copy of the newest DD.MM sheet with its check columns cleared: only the columns
 * the report writes (layout_ cols), in contiguous runs, so a manual column between them is kept.
 */
function newDaySheet_(ss, name) {
  const tpl = ss.getSheets().filter(s => /^\d{2}\.\d{2}/.test(s.getName())).pop();
  if (!tpl) throw new Error('ไม่มีแท็บรูปแบบ วัน.เดือน (เช่น 12.11) ให้คัดลอกเป็นแท็บใหม่');
  const sh = tpl.copyTo(ss).setName(name);
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(ss.getNumSheets());
  const lay = layout_(sh);
  const rows = sh.getLastRow() - FIRST_ROW + 1;
  if (rows > 0) {
    const cols = Array.from(new Set(lay.cols)).sort((a, b) => a - b);
    for (let i = 0; i < cols.length; ) {
      let j = i;
      while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++;
      sh.getRange(FIRST_ROW, cols[i], rows, cols[j] - cols[i] + 1).clearContent();
      i = j + 1;
    }
  }
  return sh;
}

// ------------------------------------------------------------------ data (TC Roof API, shared key)

/**
 * The sheet's values for `day`, checks `hours` only:
 * {day, hours, columns, published_plants, loggers: {datalogger_sn: id}, names: {id: name},
 *  plants: {id: {checks: {"09": [status, note, irr, wx, log, kw, inv]}, weather_status, yield_kwh}},
 *  firmware: {datalogger_sn: datalogger firmware} (empty: Growatt gives none; without the key, e.g. an
 *  older API, the Firmware column is left as is),
 *  dataloggers: {datalogger_sn: {inverter_firmware: [text an older script wrote into Firmware]}}}
 */
function reportCells_(day, hours) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('REPORT_KEY');
  if (!key) throw new Error('ยังไม่มีรหัสรายงาน\nไปที่เมนู PWA Report → ตั้งค่า → ตั้งค่าทั้งหมด… ก่อน');
  const url = `${props.getProperty('REPORT_URL') || REPORT_URL}/${day}/cells?hours=${hours.join(',')}`;
  let res;
  for (let attempt = 1; ; attempt++) { // one retry: the API scales to zero and may be cold
    res = UrlFetchApp.fetch(url, { headers: { 'X-Report-Key': key }, muteHttpExceptions: true });
    if (res.getResponseCode() < 500 || attempt >= 2) break;
    Utilities.sleep(5000);
  }
  const code = res.getResponseCode();
  if (code !== 200) {
    console.log(`Report API ${day}: ${code} ${res.getContentText().slice(0, 300)}`); // detail for the execution log
    const why = code === 401 || code === 403 ? 'รหัสรายงานไม่ถูกต้อง ตรวจสอบที่เมนู ตั้งค่า → เปลี่ยนรหัสรายงาน (key)…'
      : code === 404 ? 'ระบบไม่มีข้อมูลของวันที่นี้'
      : code >= 500 ? 'ระบบขัดข้องชั่วคราว ลองใหม่ในอีกสักครู่'
      : 'ระบบไม่รับคำขอนี้';
    throw new Error(`ดึงข้อมูลวันที่ ${sheetName_(day)} ไม่สำเร็จ (รหัส ${code})\n${why}`);
  }
  return JSON.parse(res.getContentText());
}

// ------------------------------------------------------------------ helpers

function pad_(n) { return (n < 10 ? '0' : '') + n; }

/** 9 → "09:00" (a check, as shown to the user). */
function clock_(h) { return pad_(h) + ':00'; }

/**
 * The checks a user typed: "9", "9,13", "09 17", "13:00", "13.00" → [9, 13] in CHECK_HOURS order;
 * blank → all; anything that isn't a check → null.
 */
function parseHours_(text) {
  const parts = String(text || '').split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return CHECK_HOURS.slice();
  const want = [];
  for (const p of parts) {
    const m = /^(\d{1,2})(?:[:.]00)?$/.exec(p);
    if (!m || CHECK_HOURS.indexOf(+m[1]) < 0) return null;
    want.push(+m[1]);
  }
  return CHECK_HOURS.filter(h => want.indexOf(h) >= 0);
}

/**
 * The day a user typed → "yyyy-MM-dd": 2026-11-12, 12.11, 12/11, 12-11, 12/11/2026, 12/11/2569
 * (Buddhist year), 12/11/26; blank → today. Without a year: this year, or last year when that date
 * is more than half a year ahead. Not a real date → null.
 */
function parseDay_(text) {
  const t = String(text || '').trim(), today = today_();
  if (!t) return today;
  let y, mo, d;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?$/.exec(t);
    if (!m) return null;
    d = +m[1]; mo = +m[2];
    y = m[3] === undefined ? null : +m[3];
    if (y !== null && y < 100) y += 2000;
  }
  if (y !== null && y > 2400) y -= 543; // พ.ศ.
  const make = yy => {
    const dt = new Date(Date.UTC(yy, mo - 1, d));
    return dt.getUTCFullYear() === yy && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
      ? `${yy}-${pad_(mo)}-${pad_(d)}` : null;
  };
  if (y !== null) return make(y);
  const thisYear = +today.slice(0, 4);
  const day = make(thisYear);
  // in January "25.12" means last December; "17.11" typed on 16.11 is a future date (refused by the caller)
  const farAhead = day && (Date.parse(day) - Date.parse(today)) / 864e5 > 183;
  return farAhead ? make(thisYear - 1) : day;
}

function today_() { return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd'); }

function sheetName_(day) { return day.slice(8, 10) + '.' + day.slice(5, 7); }

function nowMin_() {
  const now = new Date();
  return Number(Utilities.formatDate(now, 'Asia/Bangkok', 'H')) * 60 + Number(Utilities.formatDate(now, 'Asia/Bangkok', 'm'));
}

/** "8:50" / "08:50" → "08:50"; anything else → null. */
function normTime_(t) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(t).trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return pad_(+m[1]) + ':' + m[2];
}

function toMin_(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

/** Fetch time per check from script property FETCH_TIMES, else DEFAULT_FETCH. */
function fetchTimes_() {
  const v = (PropertiesService.getScriptProperties().getProperty('FETCH_TIMES') || '').split(',').map(normTime_);
  return v.length === CHECK_HOURS.length && v.every(Boolean) ? v : DEFAULT_FETCH.slice();
}
