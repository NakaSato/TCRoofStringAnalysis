/**
 * Monitoring PWA Report — fill a day's sheet (DD.MM) from the published daily data (Firestore),
 * read through the TC Roof API with a shared key, so the script needs no Google Cloud permission.
 *
 * Bound script of the Google Sheet. Rows 3+, B = plant name, C = datalogger SN. Columns are found
 * from the header rows, so both layouts work (see layout_):
 *   old: weather Status | per check: Status, Note
 *   new: weather Status | per check: Status, ค่าแสง, สภาพอากาศ, DATA LOG (Fault log)
 *   optional, filled when present: per check "kW", "INV online"; per plant "Yield (kWh)" (row 1)
 *
 * Source: GET {REPORT_URL}/{day}/cells?hours=09,13 — the API builds every cell with the same rules
 * as the worker (backend/app/services/pwa_sheet.py, plant_cells) from the published daily docs
 * (Firestore daily/{day}/plants/{id}); this script only matches rows and writes. Nothing is made
 * up: no source = "—". Values per check: Status, Note, ค่าแสง (sensor W/m²), สภาพอากาศ (sky class
 * from the sensor vs clear-sky, else Google Weather "(Google)"), DATA LOG, kW, INV online.
 *
 * Setup (once):
 *   1. Extensions → Apps Script; paste Code.gs and appsscript.json (Project Settings → show manifest).
 *   2. Reload the sheet → menu "PWA Report" → "Set report key…" and paste the key, from:
 *        gcloud secrets versions access latest --secret tcroof-report-key --project tcroof-string-analysis
 *      (script properties REPORT_KEY; optional REPORT_URL, default below)
 *   3. Menu "PWA Report" → "Install daily triggers".
 *
 * Daily triggers (Bangkok time; Apps Script runs each one some time within that hour):
 *   06:00  createTodaySheet  new empty DD.MM sheet for today (copy of the newest DD.MM sheet, check columns cleared)
 *   10:00  fillChecks        the 09:00 check   ┐ the worker publishes today so far at 09:30 / 13:30 / 17:30,
 *   14:00  fillChecks        the 13:00 check   │ so each run fills only the checks already published
 *   18:00  fillChecks        the 17:00 check   ┘ (later checks are left as they are)
 *   22:00  fillToday         all three checks again, from the full day (published 19:30)
 */

const CHECK_HOURS = [9, 13, 17]; // daily check times; columns are found from the headers (layout_)
const PUBLISH_MIN = 30;           // the worker publishes today at hh:30 after each check
const FILL_HOURS = [10, 14, 18];  // fillChecks triggers, one per check
const FIRST_ROW = 3;
const DASH = '—';
const REPORT_URL = 'https://tcroof-string-analysis.web.app/api/report/pwa';


// ------------------------------------------------------------------ menu / triggers

function onOpen() {
  SpreadsheetApp.getUi().createMenu('PWA Report')
    .addItem('Create today\'s sheet', 'createTodaySheet')
    .addItem('Fill checks so far', 'fillChecks')
    .addItem('Fill today (all checks)', 'fillToday')
    .addItem('Fill a day…', 'fillAskDay')
    .addSeparator()
    .addItem('Set report key…', 'setReportKey')
    .addItem('Install daily triggers (06 new sheet · 10/14/18 checks · 22 all)', 'installTrigger')
    .addToUi();
}

function today_() { return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd'); }

function sheetName_(day) { return day.slice(8, 10) + '.' + day.slice(5, 7); }

function fillToday() { return fillDay(today_()); }

/** Today's checks that the worker has already published (hh:30 has passed). */
function fillChecks() {
  const now = new Date();
  const hm = Number(Utilities.formatDate(now, 'Asia/Bangkok', 'H')) * 60 + Number(Utilities.formatDate(now, 'Asia/Bangkok', 'm'));
  const hours = CHECK_HOURS.filter(h => hm >= h * 60 + PUBLISH_MIN);
  if (!hours.length) { console.log('No check published yet today.'); return 'No check published yet today.'; }
  return fillDay(today_(), hours);
}

/** Creates today's empty DD.MM sheet (no-op if it already exists). Safe to run any number of times. */
function createTodaySheet() {
  const ss = SpreadsheetApp.getActive();
  const name = sheetName_(today_());
  let msg;
  if (ss.getSheetByName(name)) msg = `Sheet ${name} already exists.`;
  else { newDaySheet_(ss, name); msg = `Created sheet ${name}.`; }
  console.log(msg);
  return msg;
}

function fillAskDay() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Fill a day', 'Plant-local date (yyyy-MM-dd):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const day = r.getResponseText().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return ui.alert('Use yyyy-MM-dd, e.g. 2026-11-12');
  ui.alert(fillDay(day));
}

function setReportKey() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Report key', 'Paste the key (secret tcroof-report-key):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK || !r.getResponseText().trim()) return;
  PropertiesService.getScriptProperties().setProperty('REPORT_KEY', r.getResponseText().trim());
  ui.alert('Saved. Try "Fill checks so far".');
}

function installTrigger() {
  const handlers = ['createTodaySheet', 'fillChecks', 'fillToday'];
  ScriptApp.getProjectTriggers().filter(t => handlers.indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t));
  const daily = (fn, h) => ScriptApp.newTrigger(fn).timeBased().atHour(h).everyDays(1).inTimezone('Asia/Bangkok').create();
  daily('createTodaySheet', 6);
  FILL_HOURS.forEach(h => daily('fillChecks', h));
  daily('fillToday', 22);
  SpreadsheetApp.getUi().alert('Daily triggers installed (Bangkok):\n06:00 create today\'s sheet\n10:00 / 14:00 / 18:00 fill the 09 / 13 / 17 check\n22:00 fill all checks again (full day)');
}

// ------------------------------------------------------------------ main

/** Fills `day`'s sheet; `hours` limits it to those checks (default all three), other checks are left as they are. */
function fillDay(day, hours) {
  const ss = SpreadsheetApp.getActive();
  const name = sheetName_(day);
  const sh = ss.getSheetByName(name) || newDaySheet_(ss, name);
  const lay = layout_(sh);
  const blocks = hours ? lay.blocks.filter(b => hours.indexOf(b.hour) >= 0) : lay.blocks;
  if (!blocks.length) return `${name}: no check to fill.`;

  const data = reportCells_(day, blocks.map(b => b.hour));
  if (!data.published_plants) return `No published data for ${day} yet.`;
  const cols = data.columns; // ["status", "note", "irr", "wx", "log", "kw", "inv"]
  const names = data.names || {};

  const last = sh.getLastRow();
  if (last < FIRST_ROW) return `Sheet ${name} has no plant rows.`;
  const n = last - FIRST_ROW + 1;
  const keys = sh.getRange(FIRST_ROW, 2, n, 2).getValues(); // B name, C SN
  const block = sh.getRange(FIRST_ROW, lay.first, n, lay.last - lay.first + 1);
  const values = block.getValues();
  const set = (row, col, v) => { if (col) values[row][col - lay.first] = v; };

  const stats = { rows: 0, normal: 0, abnormal: 0, noPower: 0, unmatched: 0 };
  keys.forEach(([nm, sn], i) => {
    sn = String(sn || '').trim();
    if (!sn) return;
    const pid = matchPlant_(sn, String(nm || '').trim(), data.loggers || {}, names);
    if (!pid) { stats.unmatched++; set(i, lay.weather, 'ไม่พบในระบบ'); return; }
    stats.rows++;
    const p = data.plants[pid];
    blocks.forEach(b => {
      const v = p.checks[pad_(b.hour)];
      cols.forEach((c, k) => set(i, b[c], v[k]));
      const kw = v[cols.indexOf('kw')], st = v[cols.indexOf('status')];
      if (kw === DASH) stats.noPower++; else if (st === 'normal') stats.normal++; else stats.abnormal++;
    });
    set(i, lay.weather, p.weather_status);
    set(i, lay.yieldKwh, p.yield_kwh);
  });
  block.setValues(values);
  const msg = `${name} [${blocks.map(b => pad_(b.hour)).join(', ')}]: ${JSON.stringify(stats)} (published plants: ${data.published_plants})`;
  console.log(msg);
  return msg;
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
  const cols = [weather, yieldKwh].concat(...blocks.map(b => [b.status, b.note, b.irr, b.wx, b.log, b.kw, b.inv])).filter(Boolean);
  return { weather, yieldKwh, blocks, first: Math.min(...cols), last: Math.max(...cols) };
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
 *  plants: {id: {checks: {"09": [status, note, irr, wx, log, kw, inv]}, weather_status, yield_kwh}}}
 */
function reportCells_(day, hours) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('REPORT_KEY');
  if (!key) throw new Error('No report key: menu PWA Report → Set report key…');
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
