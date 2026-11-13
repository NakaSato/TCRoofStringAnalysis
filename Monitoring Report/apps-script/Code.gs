/**
 * Monitoring PWA Report — fill a day's sheet (DD.MM) from the published daily data (Firestore),
 * read through the TC Roof API with a shared key, so the script needs no Google Cloud permission.
 *
 * Bound script of the Google Sheet. Rows 3+, B = plant name, C = datalogger SN. Columns are found
 * from the header rows, so both layouts work (see layout_):
 *   old: weather Status | per check: Status, Note
 *   new: weather Status | per check: Status, ค่าแสง, สภาพอากาศ, DATA LOG (Fault log)
 *
 * Source: GET {REPORT_URL}/{day} = Firestore daily/{day}/plants/{id} + plant registry
 * (nothing is made up; no source = "—"):
 *   Status            hourly_kw[9|13|17] + checks.{hh}     real Growatt power; inverters offline/fault
 *   DATA LOG          checks.{hh}: "online", "offline", or the faults ("INV2 Offline, INV3 Fault, INV1 <alarm>")
 *   Note              "INV ทำงานปกติ ค่าแสง 584 (ฝนตก)" …   built from checks, irradiance, rain (note_)
 *   ค่าแสง             weather.slots.{09|13|17}.irradiance_wm2   Growatt weather sensor
 *   สภาพอากาศ          sky class from that irradiance vs clear-sky; no sensor reading ->
 *                     google_weather.slots.{hh}.condition  (Google Weather, modelled, "(Google)")
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

const GOOGLE_TH = {
  CLEAR: 'ท้องฟ้าแจ่มใส', MOSTLY_CLEAR: 'ท้องฟ้าโปร่ง', PARTLY_CLOUDY: 'มีเมฆบางส่วน',
  MOSTLY_CLOUDY: 'เมฆมาก', CLOUDY: 'ฟ้าครึ้ม', CHANCE_OF_SHOWERS: 'อาจมีฝน',
  LIGHT_RAIN: 'ฝนตกเล็กน้อย', RAIN: 'ฝนตก', RAIN_SHOWERS: 'ฝนตก',
  SCATTERED_THUNDERSTORMS: 'ฝนฟ้าคะนอง', THUNDERSTORM: 'ฝนฟ้าคะนอง',
};

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

  const data = reportDay_(day);
  const byPlant = data.days || {};
  const nDocs = Object.keys(byPlant).length;
  if (!nDocs) return `No published data for ${day} yet.`;
  const byLogger = data.loggers || {};
  const plantInfo = data.plants || {};
  const registry = Object.keys(plantInfo).map(id => ({ id, data: plantInfo[id] }));

  const last = sh.getLastRow();
  if (last < FIRST_ROW) return `Sheet ${name} has no plant rows.`;
  const n = last - FIRST_ROW + 1;
  const keys = sh.getRange(FIRST_ROW, 2, n, 2).getValues(); // B name, C SN
  const block = sh.getRange(FIRST_ROW, lay.first, n, lay.last - lay.first + 1);
  const values = block.getValues();
  const set = (row, col, v) => { if (col) values[row][col - lay.first] = v; };

  const stats = { rows: 0, normal: 0, abnormal: 0, noPower: 0, wxGrowatt: 0, wxGoogle: 0, unmatched: 0 };
  keys.forEach(([nm, sn], i) => {
    sn = String(sn || '').trim();
    if (!sn) return;
    // SN first, then a unique plant-name match (datalogger replaced since the sheet was made)
    let pid = byLogger[sn];
    if (!pid) {
      nm = String(nm || '').trim();
      const hits = nm ? registry.filter(d => String(d.data.name || '').indexOf(nm) >= 0) : [];
      pid = hits.length === 1 ? hits[0].id : null;
    }
    if (!pid) { stats.unmatched++; set(i, lay.weather, 'ไม่พบในระบบ'); return; }
    stats.rows++;
    const doc = byPlant[pid] || {};
    const hourly = doc.hourly_kw || [];
    const hasSensor = !!(doc.weather && doc.weather.has_sensor);
    const sensorSlots = (doc.weather && doc.weather.slots) || {};
    const googleSlots = (doc.google_weather && doc.google_weather.slots) || {};
    const checks = doc.checks || {};
    const info = plantInfo[pid] || {};
    const sensorHit = [];

    blocks.forEach(b => {
      const hh = pad_(b.hour);
      const t = new Date(`${day}T${hh}:00:00+07:00`);
      const kw = hourly[b.hour];
      const c = checks[hh] || null;
      const s = sensorSlots[hh];
      const irr = s && s.irradiance_wm2 != null ? Math.round(s.irradiance_wm2) : null;
      sensorHit.push(irr !== null);
      const g = googleSlots[hh];
      const rain = !!(g && g.raining);

      const invProblem = !!(c && (c.offline.length || c.fault.length));
      const ok = kw != null && kw > 0 && !invProblem;
      if (kw == null) stats.noPower++; else if (ok) stats.normal++; else stats.abnormal++;
      set(i, b.status, kw == null && !c ? DASH : ok ? 'normal' : 'abnormal');
      set(i, b.note, note_(kw, c, irr, hasSensor, rain));
      set(i, b.irr, irr === null ? DASH : irr);
      set(i, b.log, dataLog_(kw, c));

      const sky = irr !== null && info.latitude != null ? skyTh_(irr, clearSky_(info.latitude, info.longitude, t)) : null;
      let wx = DASH;
      if (sky) { wx = sky + (rain ? ' (ฝนตก)' : ''); stats.wxGrowatt++; }
      else if (g) { wx = (GOOGLE_TH[g.condition] || g.condition || DASH) + ' (Google)'; stats.wxGoogle++; }
      set(i, b.wx, wx);
    });

    let ws;
    if (!byPlant[pid]) ws = DASH;
    else if (!hasSensor) ws = 'ไม่มีเซนเซอร์';
    else if (sensorHit.every(Boolean)) ws = 'normal';
    else ws = 'loss (' + blocks.filter((b, k) => !sensorHit[k]).map(b => pad_(b.hour) + ':00').join(', ') + ')';
    set(i, lay.weather, ws);
  });
  block.setValues(values);
  const msg = `${name} [${blocks.map(b => pad_(b.hour)).join(', ')}]: ${JSON.stringify(stats)} (published plants: ${nDocs})`;
  console.log(msg);
  return msg;
}

/**
 * Note in the team's wording (old layout only), e.g.
 *   "INV ทำงานปกติ ค่าแสง 584"            "INV ทำงานปกติ Weather offline"
 *   "(INV2 Relay fault) INV ทำงานปกติ ค่าแสง 237 (ฝนตก)"
 *   "INV1 Offline INV3 Fault ค่าแสง 300"   "INV Offline (ฝนตก)"
 */
function note_(kw, c, irr, hasSensor, rain) {
  const parts = [];
  if (c && c.alarms.length) parts.push('(' + c.alarms.join(', ') + ')');
  const allOffline = c ? c.offline.length >= c.inverters : kw == null;
  if (kw == null || allOffline) {
    parts.push('INV Offline');
  } else {
    const bad = c ? c.offline.map(l => l + ' Offline').concat(c.fault.map(l => l + ' Fault')) : [];
    parts.push(bad.length ? bad.join(' ') : kw > 0 ? 'INV ทำงานปกติ' : 'INV ไม่ผลิตไฟ');
    if (irr !== null) parts.push('ค่าแสง ' + irr);
    else if (hasSensor) parts.push('Weather offline');
  }
  if (rain) parts.push('(ฝนตก)');
  return parts.join(' ');
}

/**
 * DATA LOG (Fault log): "offline" (no power data / every inverter silent), the faults, or "online".
 *   "online"   "offline"   "INV2 Offline, INV3 Fault, INV1 Relay fault"
 */
function dataLog_(kw, c) {
  if (kw == null || (c && c.offline.length >= c.inverters)) return 'offline';
  if (!c) return 'online';
  const faults = c.offline.map(l => l + ' Offline').concat(c.fault.map(l => l + ' Fault'), c.alarms);
  return faults.length ? faults.join(', ') : 'online';
}

/**
 * Column map from header rows 1–2. Works for both layouts:
 *   old (≤ 30.10): weather Status | Status, Note  ×3
 *   new (12.11+):  weather Status | Status, ค่าแสง, สภาพอากาศ, DATA LOG  ×3
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
    const from = starts[k], to = k + 1 < starts.length ? starts[k + 1] - 1 : Math.min(width, from + 3);
    const b = { hour, status: from, note: 0, irr: 0, wx: 0, log: 0 };
    for (let col = from + 1; col <= to; col++) {
      const v = String(r2[col - 1]).trim();
      if (/^note/i.test(v)) b.note = col;
      else if (/ค่าแสง/.test(v)) b.irr = col;
      else if (/สภาพอากาศ/.test(v)) b.wx = col;
      else if (/data\s*log/i.test(v)) b.log = col;
    }
    return b;
  });
  const cols = [weather].concat(...blocks.map(b => [b.status, b.note, b.irr, b.wx, b.log])).filter(Boolean);
  return { weather, blocks, first: Math.min(...cols), last: Math.max(...cols) };
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

/** {day, plants: {id: {name, latitude, longitude}}, loggers: {datalogger_sn: id}, days: {id: daily doc}} */
function reportDay_(day) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('REPORT_KEY');
  if (!key) throw new Error('No report key: menu PWA Report → Set report key…');
  const url = (props.getProperty('REPORT_URL') || REPORT_URL) + '/' + day;
  const res = UrlFetchApp.fetch(url, { headers: { 'X-Report-Key': key }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error(`Report API ${day}: ${res.getResponseCode()} ${res.getContentText().slice(0, 300)}`);
  return JSON.parse(res.getContentText());
}

// ------------------------------------------------------------------ helpers

function pad_(n) { return (n < 10 ? '0' : '') + n; }

/** Haurwitz clear-sky GHI (W/m²) at instant t for a plant at lat/lon. */
function clearSky_(lat, lon, t) {
  const local = new Date(t.getTime() + 7 * 3600e3); // Bangkok wall clock in UTC fields
  const start = Date.UTC(local.getUTCFullYear(), 0, 1);
  const doy = Math.floor((local - start) / 864e5) + 1;
  const hr = local.getUTCHours(), mi = local.getUTCMinutes();
  const g = 2 * Math.PI / 365 * (doy - 1 + (hr - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const solarMin = hr * 60 + mi + eqt + 4 * lon - 420;
  const ha = (solarMin / 4 - 180) * Math.PI / 180;
  const la = lat * Math.PI / 180;
  const cosz = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha);
  return cosz <= 0.01 ? 0 : 1098 * cosz * Math.exp(-0.057 / cosz);
}

/** Measured ÷ clear-sky → Thai sky class; null when the sun is too low to judge. */
function skyTh_(irr, cs) {
  if (cs < 80) return null;
  const k = irr / cs;
  if (k >= 0.75) return 'แดดดี';
  if (k >= 0.45) return 'มีเมฆบางส่วน';
  if (k >= 0.2) return 'เมฆมาก';
  return 'ฟ้าครึ้ม/ฝน';
}
