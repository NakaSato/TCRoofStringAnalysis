/**
 * Monitoring PWA Report — fill each day's sheet (DD.MM) from the TC Roof API (published daily data,
 * Firestore daily/{day}/plants/{id}), read with a shared key, so the script needs no Google Cloud permission.
 *
 * Menu "PWA Report" (3 items):
 *   ตั้งค่า…               report key + fetch time per check (default 08:50 / 12:50 / 16:50), then
 *                          turns on the automatic runs. Run it once; run again to change the times.
 *   ดึงข้อมูลตอนนี้          fills today's checks whose fetch time has passed (empty cells only)
 *   ดึงข้อมูลย้อนหลัง…       asks for a date (yyyy-MM-dd) and fills that day (empty cells only)
 *
 * Automatic runs (Bangkok time):
 *   06:00-07:00     today's DD.MM sheet is created (copy of the newest DD.MM sheet, check columns cleared)
 *   every 5 min     from each fetch time until FETCH_WINDOW min after it, the check is fetched as soon
 *                   as the API has published it; with 08:50 the 09:00 check is in the sheet by ~08:55.
 *                   Once every plant row has its check, that check is done for the day (no more calls).
 *
 * Never overwrites: a check cell (Status, Note, ค่าแสง, สภาพอากาศ, DATA LOG, kW, INV online) is written
 * only while it is empty. A check the API hasn't published yet (every plant "—") is skipped.
 * Kept up to date (summaries of the checks so far): weather Status, Yield (kWh).
 * weather Status is only "Normal" (sensor reported at every check so far) or "Abnormal" (anything
 * else: a missed check, no sensor, no data, plant not found).
 * Firmware (row-1 header) is written when empty or "—". Column C (SN Datalogger) is corrected from the
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
  SpreadsheetApp.getUi().createMenu('PWA Report')
    .addItem('ตั้งค่า…', 'setup')
    .addItem('ดึงข้อมูลตอนนี้', 'fillNow')
    .addItem('ดึงข้อมูลย้อนหลัง…', 'fillAskDay')
    .addToUi();
}

/** Report key + fetch times, then (re)installs the automatic runs. */
function setup() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const hasKey = !!props.getProperty('REPORT_KEY');
  const k = ui.prompt('ตั้งค่า 1/2 — Report key',
    hasKey ? 'มี key อยู่แล้ว ปล่อยว่างเพื่อใช้ key เดิม หรือวาง key ใหม่:' : 'วาง key (secret tcroof-report-key):',
    ui.ButtonSet.OK_CANCEL);
  if (k.getSelectedButton() !== ui.Button.OK) return;
  const key = k.getResponseText().trim();
  if (key) props.setProperty('REPORT_KEY', key);
  else if (!hasKey) return ui.alert('ยังไม่มี key — ยกเลิก');

  const cur = fetchTimes_();
  const t = ui.prompt('ตั้งค่า 2/2 — เวลาดึงข้อมูล',
    `เวลาดึงข้อมูลของรอบ ${CHECK_HOURS.map(h => pad_(h) + ':00').join(' / ')} คั่นด้วยจุลภาค\n` +
    `(ตอนนี้: ${cur.join(', ')}  ปล่อยว่าง = ใช้ค่าเดิม)`, ui.ButtonSet.OK_CANCEL);
  if (t.getSelectedButton() !== ui.Button.OK) return;
  let times = cur;
  if (t.getResponseText().trim()) {
    times = t.getResponseText().split(',').map(x => x.trim()).filter(Boolean).map(normTime_);
    if (times.length !== CHECK_HOURS.length || times.some(x => !x))
      return ui.alert(`ต้องใส่ ${CHECK_HOURS.length} เวลา รูปแบบ HH:MM เช่น ${DEFAULT_FETCH.join(', ')}`);
    props.setProperty('FETCH_TIMES', times.join(','));
  }

  ScriptApp.getProjectTriggers().filter(tr => HANDLERS.indexOf(tr.getHandlerFunction()) >= 0).forEach(tr => ScriptApp.deleteTrigger(tr));
  ScriptApp.newTrigger('createTodaySheet').timeBased().atHour(6).everyDays(1).inTimezone('Asia/Bangkok').create();
  ScriptApp.newTrigger('pollChecks').timeBased().everyMinutes(POLL_EVERY).create();
  ui.alert('บันทึกแล้ว — ทำงานอัตโนมัติ (เวลาไทย)\n\n' +
    '06:00–07:00  สร้างแท็บวันนี้\n' +
    CHECK_HOURS.map((h, k) => `${times[k]}  ดึงรอบ ${pad_(h)}:00 (ลองทุก ${POLL_EVERY} นาที จนได้ข้อมูล)`).join('\n') +
    '\n\nช่องที่มีค่าแล้วจะไม่ถูกเขียนทับ');
}

function fillAskDay() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('ดึงข้อมูลย้อนหลัง', 'วันที่ (yyyy-MM-dd) เช่น 2026-11-12:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const day = r.getResponseText().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return ui.alert('ใช้รูปแบบ yyyy-MM-dd เช่น 2026-11-12');
  ui.alert(fillDay(day).msg);
}

/** Menu: today's checks whose fetch time has passed. */
function fillNow() {
  const hm = nowMin_(), times = fetchTimes_();
  const hours = CHECK_HOURS.filter((h, k) => hm >= toMin_(times[k]));
  const msg = hours.length ? fillDay(today_(), hours).msg : `ยังไม่ถึงเวลาดึงรอบแรก (${times[0]})`;
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
}

// ------------------------------------------------------------------ automatic runs

/** Creates today's empty DD.MM sheet (no-op if it already exists). */
function createTodaySheet() {
  const ss = SpreadsheetApp.getActive();
  const name = sheetName_(today_());
  if (!ss.getSheetByName(name)) newDaySheet_(ss, name);
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
    console.log(r.msg);
  } finally { lock.releaseLock(); }
}

// ------------------------------------------------------------------ main

/**
 * Fills `day`'s sheet for checks `hours` (default all three). Check cells are written only while empty;
 * checks the API hasn't published yet are skipped. Returns {msg, complete: ["09", …]} where complete
 * lists the checks every matched plant row now has.
 */
function fillDay(day, hours) {
  const ss = SpreadsheetApp.getActive();
  const name = sheetName_(day);
  const sh = ss.getSheetByName(name) || newDaySheet_(ss, name);
  const lay = layout_(sh);
  let blocks = hours ? lay.blocks.filter(b => hours.indexOf(b.hour) >= 0) : lay.blocks;
  if (!blocks.length) return { msg: `${name}: ไม่มีรอบให้ดึง`, complete: [] };

  let data = reportCells_(day, blocks.map(b => b.hour));
  if (!data.published_plants) return { msg: `${day}: API ยังไม่มีข้อมูล`, complete: [] };
  const ready = blocks.filter(b => published_(data, pad_(b.hour)));
  if (!ready.length) return { msg: `${name}: รอบ ${blocks.map(b => pad_(b.hour)).join(', ')} ยังไม่ publish`, complete: [] };
  if (ready.length < blocks.length) { // refetch so weather Status / yield cover only published checks
    blocks = ready;
    data = reportCells_(day, blocks.map(b => b.hour));
  }
  const cols = data.columns; // ["status", "note", "irr", "wx", "log", "kw", "inv"]
  const names = data.names || {};

  const last = sh.getLastRow();
  if (last < FIRST_ROW) return { msg: `${name}: ไม่มีแถวสถานี`, complete: [] };
  const n = last - FIRST_ROW + 1;
  const keys = sh.getRange(FIRST_ROW, 2, n, 2).getValues(); // B name, C SN
  const block = sh.getRange(FIRST_ROW, lay.first, n, lay.last - lay.first + 1);
  const values = block.getValues();
  const get = (row, col) => values[row][col - lay.first];
  const set = (row, col, v) => { if (col) values[row][col - lay.first] = v; };
  const fill = (row, col, v) => { if (col && get(row, col) === '') { values[row][col - lay.first] = v; return 1; } return 0; };

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
      if (!wasEmpty) stats.kept++;
      if (get(i, b.status) === '') missing[pad_(b.hour)]++;
    });
    set(i, lay.weather, weatherStatus_(p.weather_status));
    set(i, lay.yieldKwh, p.yield_kwh);
  });
  block.setValues(values);
  if (stats.snUpdated) sh.getRange(FIRST_ROW, 3, snCol.length, 1).setValues(snCol);
  const fw = fillFirmware_(sh, lay.firmware, keys, data.firmware);
  if (fw !== null) stats.firmware = fw;
  const complete = Object.keys(missing).filter(hh => !missing[hh]);
  const msg = `${name} [${blocks.map(b => pad_(b.hour)).join(', ')}]: เขียนใหม่ ${stats.written} ช่อง, ` +
    `สถานีที่มีค่าอยู่แล้ว (ไม่เขียนทับ) ${stats.kept}, ไม่พบในระบบ ${stats.unmatched}, ` +
    `แก้ SN ${stats.snUpdated}${fw !== null ? ', firmware ' + fw : ''} (${stats.rows} สถานี)`;
  console.log(msg);
  return { msg, complete };
}

/**
 * Firmware column (row-1 header "Firmware"), by the row's datalogger SN (column C):
 * firmware = {datalogger_sn: version} from the API: the firmware of that datalogger's inverters
 * (Growatt innerVersion, else fwVersion; several versions joined with ", "). Growatt gives no
 * datalogger firmware. Written on its own, so the check block and
 * newDaySheet_ (which clears only the check block) never touch it. Returns the number of rows that
 * got a version, or null when the sheet has no Firmware column or the API sent no firmware map
 * (older API: the column is left as it is). Only empty / "—" cells are written; an SN the API
 * doesn't know gets "—".
 */
function fillFirmware_(sh, col, keys, firmware) {
  if (!col || !firmware) return null;
  let hits = 0;
  const range = sh.getRange(FIRST_ROW, col, keys.length, 1);
  const old = range.getValues();
  const vals = keys.map(([, sn], i) => {
    sn = String(sn || '').trim();
    if (!sn) return old[i]; // non-plant row: keep
    const cur = String(old[i][0] === null ? '' : old[i][0]).trim();
    if (cur !== '' && cur !== DASH) return old[i]; // already has a version: never overwrite
    const v = firmware[sn];
    if (v) hits++;
    return [v || DASH];
  });
  range.setValues(vals);
  return hits;
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
  if (!weather) throw new Error(`Sheet ${sh.getName()}: no "weather Status" header in row 1`);
  const starts = [];
  r2.forEach((v, k) => { if (k + 1 > weather && /^status/i.test(String(v).trim())) starts.push(k + 1); });
  if (starts.length < CHECK_HOURS.length) throw new Error(`Sheet ${sh.getName()}: expected ${CHECK_HOURS.length} "Status" columns in row 2`);
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
  return { weather, yieldKwh, firmware, blocks, first: Math.min(...cols), last: Math.max(...cols) };
}

/** New day sheet = copy of the newest DD.MM sheet with its check columns cleared. */
function newDaySheet_(ss, name) {
  const tpl = ss.getSheets().filter(s => /^\d{2}\.\d{2}/.test(s.getName())).pop();
  if (!tpl) throw new Error('No DD.MM template sheet to copy');
  const sh = tpl.copyTo(ss).setName(name);
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(ss.getNumSheets());
  const lay = layout_(sh);
  if (sh.getLastRow() >= FIRST_ROW) sh.getRange(FIRST_ROW, lay.first, sh.getLastRow() - FIRST_ROW + 1, lay.last - lay.first + 1).clearContent();
  return sh;
}

// ------------------------------------------------------------------ data (TC Roof API, shared key)

/**
 * The sheet's values for `day`, checks `hours` only:
 * {day, hours, columns, published_plants, loggers: {datalogger_sn: id}, names: {id: name},
 *  plants: {id: {checks: {"09": [status, note, irr, wx, log, kw, inv]}, weather_status, yield_kwh}},
 *  firmware: {datalogger_sn: inverter firmware}}   (without it, e.g. an older API, the Firmware column is left as is)
 */
function reportCells_(day, hours) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('REPORT_KEY');
  if (!key) throw new Error('ยังไม่มี report key: เมนู PWA Report → ตั้งค่า…');
  const url = `${props.getProperty('REPORT_URL') || REPORT_URL}/${day}/cells?hours=${hours.join(',')}`;
  let res;
  for (let attempt = 1; ; attempt++) { // one retry: the API scales to zero and may be cold
    res = UrlFetchApp.fetch(url, { headers: { 'X-Report-Key': key }, muteHttpExceptions: true });
    if (res.getResponseCode() < 500 || attempt >= 2) break;
    Utilities.sleep(5000);
  }
  if (res.getResponseCode() !== 200) throw new Error(`Report API ${day}: ${res.getResponseCode()} ${res.getContentText().slice(0, 300)}`);
  return JSON.parse(res.getContentText());
}

// ------------------------------------------------------------------ helpers

function pad_(n) { return (n < 10 ? '0' : '') + n; }

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
