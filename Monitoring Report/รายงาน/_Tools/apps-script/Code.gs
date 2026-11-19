/**
 * String Check monthly files — Solar Rooftop กปภ. (Google Apps Script, standalone)
 *
 * Everything is linked through the Overview workbook "00_Overview_รายงานการแก้ไข" (a Google Sheet in
 * the root Drive folder). Data moves in two directions, each value with one place where it is typed:
 *
 *   Overview ─► plant files     plant name, kWp, contract, start date, Inverter S/N, จำนวนสตริง
 *                               (typed in the Overview sheets "สถานี" and "Inverter")
 *   plant files ─► Overview     ผิดปกติ / สตริงที่มีปัญหา / Inverter Status / รายละเอียด, and for each
 *                               problem: การแก้ไข, สถานะ, ผู้รับผิดชอบ, วันที่แก้ไขเสร็จ
 *                               (typed in the yellow cells of the day sheets)
 *
 * Creating the month
 *   1) the month folder "yyyy-MM" inside the folder "String Check" of the root folder (CONFIG.MONTHS_FOLDER;
 *      both made if they are not there yet)
 *   2) one Google Sheet per plant, "<code>_<plant name>_<yyyy-MM>":
 *        สรุปเดือน            one row per day, read from the day sheets
 *        วันที่ 1 … 28-31     the daily String Check form, one sheet per day
 *        _ข้อมูลสถานี (hidden)  the plant's data from the Overview; every day sheet reads from it
 *
 * Sync (syncNow; automatically every CONFIG.SYNC_EVERY_MIN minutes during the day, and at each "ซิงก์"
 * event of the calendar) — for every plant file of the month:
 *   - _ข้อมูลสถานี is rewritten from the Overview when anything differs (name, kWp, S/N, จำนวนสตริง …)
 *   - Overview "รายงานการแก้ไข": one row per problem (an inverter that is ผิดปกติ > 0, Fault or Offline,
 *     from the first day it is seen until a later day shows it normal), with the newest รายละเอียด,
 *     การแก้ไข, สถานะ, ผู้รับผิดชอบ, วันที่แก้ไขเสร็จ and a link to the day sheet.
 *     The summary boxes above the table become formulas over the table.
 *     Do not type in that table: the day sheets are the source and a sync rewrites the row.
 *     Columns the script does not know (e.g. ผลการตรวจสอบ) are kept as typed.
 *   - Overview "Inverter": columns "Inverter Status" and "สถานะ ณ วันที่" (added if missing) = the newest
 *     status typed in the day sheets
 *   - Overview "สถานี": จำนวน Inverter, จำนวนสตริงรวม (formulas over "Inverter") and ไฟล์รายงาน (link)
 *
 * Where things are: the root folder is the folder the Overview sheet is in (rootId_), so logo.png and the
 * folder "String Check" sit next to the Overview, with the month folders "yyyy-MM" inside "String Check".
 * A month folder still left directly in the root folder is used where it is (never made twice).
 * No Drive id is written in this file; a copy of the
 * Overview in another folder or account works on its own folder as soon as setup() is run there.
 * The live copy belongs to engineer@tcrenewable.com (upload with `clasp push --user engineer`); the
 * triggers run as the account that ran setup().
 * The script is bound to the Overview Google Sheet: everything below is in the sheet's menu "String Check".
 * The same functions can be run from the Apps Script editor:
 *   convertOverview()   once, when the Overview in Drive is still an .xlsx: makes the Google Sheet copy
 *                       that becomes the master (edit that one from then on, not the .xlsx)
 *   createTestPlant()   one plant only (CONFIG.TEST_CODE), to look at the layout first
 *   createThisMonth() / createNextMonth()   every plant
 *   syncNow()           sync the current month now
 *   setup()             run once: creates the Google Calendar CONFIG.CALENDAR_NAME with the default events;
 *                       from then on the automatic runs happen at the start time of that calendar's events
 *                       (move, add or delete events to change the schedule — see "schedule = Google Calendar")
 *   planTriggers()      re-reads the calendar now
 *   setSyncInterval(n)  how often the automatic sync looks for edits (minutes; 0 = off). It is on by
 *                       default: every CONFIG.SYNC_EVERY_MIN minutes, CONFIG.SYNC_FROM_HOUR–SYNC_TO_HOUR.
 *                       Apps Script cannot react to an edit in another file, so "realtime" means this poll:
 *                       a run that finds no edited file ends in about a second, without touching the Overview
 *   status() / cancelJob()
 *
 * Apps Script stops a run after 6 minutes, so a job works in batches: each run works for about
 * CONFIG.RUN_SECONDS, then schedules itself again one minute later until every plant is done.
 * Creating is safe to run again: a plant that already has its file is skipped, never rebuilt.
 * The plant's old Excel report "<name>.xlsx" in the month folder is moved to the trash (CONFIG.REPLACE_XLSX).
 * A plant whose number of active inverters changed needs a new file (the sync reports it in "_log").
 *
 * Needs two advanced services (both in appsscript.json; in the editor: Services): Drive API v3, Sheets API v4.
 */

const CONFIG = {
  // Nothing here names a Drive location: the Overview is the sheet this script is bound to, and the root
  // folder is the folder that sheet is in. Move or copy the sheet and everything follows it.
  ROOT_FOLDER_ID: '',             // blank = the folder the Overview is in; an id = month folders go there instead
  MONTHS_FOLDER: 'String Check',  // the month folders "yyyy-MM" are in this folder of the root folder (blank = in the root folder itself)
  OVERVIEW_ID: '',                // blank = the sheet this script is bound to; an id = that Google Sheet instead
  OVERVIEW_NAME: '00_Overview',   // only without a bound sheet: the Overview is the file in the root folder whose name starts with this
  LOGO_FILE_ID: '',               // blank = the file LOGO_NAME in the root folder (none = no logo); an id = that image
  LOGO_NAME: 'logo.png',          // top right of every day sheet
  CALENDAR_NAME: 'String Check',  // Google Calendar whose events are the schedule of the automatic runs
  CREATE_ON_DAY: 25,              // setup(): default event — next month's files on this day, 01:00
  SYNC_HOURS: [12, 18],           // setup(): default events — sync every day at these hours (Bangkok)
  SYNC_EVERY_MIN: 5,              // interval sync, on by default: look for edits this often (one of SYNC_INTERVALS; 0 = off)
                                  // until another value is chosen in the menu "ตั้งรอบซิงก์อัตโนมัติ"
  SYNC_FROM_HOUR: 6,              // the interval sync only runs from this hour ...
  SYNC_TO_HOUR: 20,               // ... until this hour (Bangkok), to stay inside Google's daily run time
  RUN_SECONDS: 240,               // work per run (the Apps Script limit is 6 minutes)
  REPLACE_XLSX: true,             // a plant's old "<name>.xlsx" in the month folder goes to the trash once its Google Sheet exists
  TEST_CODE: 'P3-002',            // plant used by createTestPlant()
  FONT: 'Sarabun',
  FONT_SIZE: 11,
};

const TH_MONTH = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const PROJECT = 'โครงการจัดการพลังงานไฟฟ้าจากระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ที่ติดตั้งบนหลังคา (Solar Rooftop)';
const OWNER = 'การประปาส่วนภูมิภาค';
const STATUSES = ['รอดำเนินการ', 'กำลังแก้ไข', 'แก้ไขแล้ว', 'ปิดงาน'];   // same list as the Overview
const INV_STATUSES = ['Online', 'Waiting', 'Fault', 'Offline'];
const PROBLEM_STATUSES = ['Fault', 'Offline'];                       // an inverter in one of these is a problem
const DONE_STATUSES = ['แก้ไขแล้ว', 'ปิดงาน'];
const COLOR = { BLUE: '#B4C6E7', GREY: '#EDEDED', ORANGE: '#F7CAAC', RED: '#F8CBAD', YELLOW: '#FFEB9C',
  GREEN: '#C6EFCE', HEAD_GREEN: '#D9EAD3', INPUT: '#FFFF00', LINK: '#0563C1' };
const INFO = '_ข้อมูลสถานี';
const SUMMARY = 'สรุปเดือน';
const ISSUES = 'รายงานการแก้ไข';   // Overview sheets
const ISSUE_DATES = ['วันที่พบ', 'วันเข้าแก้ไข', 'วันที่แก้ไขเสร็จ'];   // shown as text dd/mm/พ.ศ. in the Overview
const STATIONS = 'สถานี';
const INVERTERS = 'Inverter';
const LOG = '_log';
const LOG_KEEP_ROWS = 1000;  // _log keeps this many newest lines (under its header); older ones are deleted
const EVENT_SYNC = 'String Check: ซิงก์ Overview';              // titles of the events setup() creates
const EVENT_CREATE = 'String Check: สร้างไฟล์เดือนถัดไป';
const MAX_PLANNED = 12;      // event triggers planned at a time (Apps Script allows 20 triggers per script)
const SUMMARY_SUBTITLE = `="กำลังการผลิต "&'${INFO}'!B2&"   ·   "&'${INFO}'!B5`;   // สรุปเดือน!A3
/**
 * สรุปเดือน!A4: a link that opens today's day sheet, during the file's month. The sheet id is taken from
 * that day's "เปิด" link in column I, so the same formula works in every file.
 */
function todayLink_(y, m, days) {
  return `=IF(AND(YEAR(TODAY())=${y},MONTH(TODAY())=${m}),HYPERLINK("#gid="&REGEXEXTRACT(FORMULATEXT(INDEX($I$6:$I$${5 + days},DAY(TODAY()))),"gid=(\\d+)"),"▶ เปิดหน้าวันนี้ (วันที่ "&DAY(TODAY())&")"),"–")`;
}
const TEMPLATE_VERSION = 3;  // in the info sheet (B7); sync brings a file of an older version up to date
/**
 * สรุปเดือน columns G:H, one row per day, from that day's รายงานการแก้ไข: วันเข้าแก้ไข = the earliest date
 * typed in column J, วันแล้วเสร็จ = the latest date typed in column M; blank while none is typed.
 */
function summaryDates_(days, n) {
  const L = layout_(n), out = [];
  for (let d = 1; d <= days; d++) {
    const r = c => `'วันที่ ${d}'!$${c}$${L.issue0}:$${c}$${L.issue1}`;
    out.push([`=IF(COUNT(${r('J')})>0,MIN(${r('J')}),"")`, `=IF(COUNT(${r('M')})>0,MAX(${r('M')}),"")`]);
  }
  return out;
}
const INFO_INV0 = 11;        // first inverter row in the info sheet
const DAY_INV0 = 17;         // first inverter row in a day sheet
const TEMP_OVERVIEW = '_overview_tmp';
const JOB_KEYS = ['job', 'ym', 'idx', 'folder', 'ov', 'ovTemp', 'only', 'made', 'skipped', 'errors', 'warn', 'fails',
  'full', 'sig', 'since', 'began', 'same', 'root', 'why'];
const SYNC_VERSION = '7';            // raised when sync starts repairing something new: every file is read once
const SYNC_INTERVALS = [1, 5, 10, 15, 30, 60, 120, 240, 360, 720];   // minutes; what a time trigger can do
const SYNC_MARGIN_MS = 15 * 60000;   // a file with no edit time on record (seen_<ym>) edited this long before the last sync started is read again
const SEEN_MAX_CHARS = 8500;         // seen_<ym> must fit one script property (9 kB); bigger = not kept, the margin rule applies
const WATCHDOG_MIN = 7;      // Google stops a run at 6 minutes; this trigger, set before the work, carries the job on
const NEXT_RUN_MS = 10000;   // pause between two runs of a job
const COPY_UNTIL_S = 300;    // create job: plants are copied until this second of a run (a copy takes about 5 s)
const TEMPLATE_BY_S = 120;   // ... but a template (up to about 130 s to build) is only started before this second
const MAX_FAILS = 3;         // failures in a row (plants, or whole runs) before the job stops and reports why

// ============================================================ menu (the script is bound to the Overview sheet)

let RUN_LATER = false;       // menu actions start the job in the background instead of blocking the sheet

function onOpen() {
  SpreadsheetApp.getUi().createMenu('String Check')
    .addItem('ซิงก์กับไฟล์สถานีตอนนี้', 'menuSync')
    .addItem('ซิงก์ใหม่ทั้งหมด (อ่านทุกไฟล์)', 'menuSyncAll')
    .addItem('ดูสถานะงาน', 'menuStatus')
    .addSeparator()
    .addItem('สร้างไฟล์เดือนนี้ (ทุกสถานี)', 'menuCreateThisMonth')
    .addItem('สร้างไฟล์เดือนหน้า (ทุกสถานี)', 'menuCreateNextMonth')
    .addItem(`สร้างไฟล์ทดสอบ 1 สถานี (${CONFIG.TEST_CODE})`, 'menuCreateTest')
    .addSeparator()
    .addItem('ตั้งค่าการทำงานอัตโนมัติ (ปฏิทิน)', 'menuSetup')
    .addItem('ตั้งรอบซิงก์อัตโนมัติ (ทุก … นาที)', 'menuInterval')
    .addItem('อ่านเวลาจากปฏิทินใหม่', 'menuPlan')
    .addItem('ยกเลิกงานที่ค้าง', 'menuCancel')
    .addItem('ใส่โลโก้ในไฟล์เดือนนี้ที่ยังไม่มี', 'addLogoToExisting')
    .addToUi();
}

function menuSync() { background_(() => startSync_(ym_(new Date()), false), 'เริ่มซิงก์แล้ว'); }
function menuSyncAll() { background_(() => startSync_(ym_(new Date()), false, true), 'เริ่มซิงก์ทุกไฟล์แล้ว'); }
function menuCreateThisMonth() { confirmCreate_(ym_(new Date()), ''); }
function menuCreateNextMonth() { confirmCreate_(nextYm_(), ''); }
function menuCreateTest() { confirmCreate_(ym_(new Date()), CONFIG.TEST_CODE); }
function menuStatus() { SpreadsheetApp.getUi().alert('String Check', status(), SpreadsheetApp.getUi().ButtonSet.OK); }
function menuCancel() { cancelJob(); toast_('ยกเลิกงานแล้ว'); }
function menuInterval() {
  const ui = SpreadsheetApp.getUi();
  const cur = syncEvery_(PropertiesService.getScriptProperties());
  const r = ui.prompt('String Check — รอบซิงก์อัตโนมัติ',
    `ซิงก์ทุกกี่นาที?  พิมพ์ ${SYNC_INTERVALS.join(', ')}  หรือ 0 เพื่อปิด\n` +
    `ทำงานเฉพาะ ${CONFIG.SYNC_FROM_HOUR}:00–${CONFIG.SYNC_TO_HOUR}:00 น.  ·  ตอนนี้: ${cur ? `ทุก ${cur} นาที` : 'ปิด'}`,
    ui.ButtonSet.OK_CANCEL);
  const typed = r.getResponseText().trim();
  if (r.getSelectedButton() !== ui.Button.OK || typed === '') return;   // blank = keep the current setting
  toast_(setSyncInterval(Number(typed)));
}
function menuPlan() { planTriggers(); toast_('อ่านเวลาจากปฏิทินแล้ว'); }
function menuSetup() {
  setup();
  const every = syncEvery_(PropertiesService.getScriptProperties());
  SpreadsheetApp.getUi().alert('String Check', `ตั้งค่าแล้ว — เวลาทำงานอัตโนมัติอยู่ในปฏิทิน "${CONFIG.CALENDAR_NAME}" ของ Google Calendar\n` +
    'ย้าย / เพิ่ม / ลบนัดในปฏิทินเพื่อเปลี่ยนเวลา\n' +
    (every ? `ซิงก์อัตโนมัติเมื่อมีการแก้ไขไฟล์สถานี: ตรวจทุก ${every} นาที ระหว่าง ${CONFIG.SYNC_FROM_HOUR}:00–${CONFIG.SYNC_TO_HOUR}:00 น.`
      : 'รอบซิงก์อัตโนมัติ: ปิด') + ' (เปลี่ยนได้ที่เมนู ตั้งรอบซิงก์อัตโนมัติ)', SpreadsheetApp.getUi().ButtonSet.OK);
}

function confirmCreate_(ym, onlyCode) {
  const ui = SpreadsheetApp.getUi();
  const what = onlyCode ? `ไฟล์ของสถานี ${onlyCode}` : 'ไฟล์ของทุกสถานี (สถานีที่มีไฟล์แล้วจะถูกข้าม)';
  if (ui.alert('String Check', `สร้าง${what} เดือน ${ym} ?`, ui.ButtonSet.OK_CANCEL) !== ui.Button.OK) return;
  background_(() => startCreate_(ym, onlyCode), 'เริ่มสร้างไฟล์แล้ว');
}

function background_(start, message) {
  RUN_LATER = true;
  start();
  toast_(`${message} — ทำงานเบื้องหลัง เริ่มภายใน 1 นาที ดูความคืบหน้าที่เมนู String Check ▸ ดูสถานะงาน`);
}

function toast_(message) {
  try { SpreadsheetApp.getActive().toast(message, 'String Check', 10); } catch (e) { console.log(message); }
}

/** Starts the job's first run: now, or (from the menu) a moment later in the background. */
function kick_() {
  if (RUN_LATER) after_(1000);
  else continueJob();
}

function after_(ms) { ScriptApp.newTrigger('continueJob').timeBased().after(ms).create(); }

function hasTrigger_(fn) { return ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === fn); }

/** Keeps the result of the last job for the status menu. */
function note_(props, message) {
  props.setProperty('last', `${Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM HH:mm')} ${message}`.slice(0, 2000));
}

function stop_(message) { const e = new Error(message); e.stop = true; return e; }

// ============================================================ entry points

function setup() {
  ['monthlyJob', 'scheduledSync', 'planTriggers', 'calendarSync', 'calendarCreate'].forEach(clearTriggers_);
  const cal = calendar_(true);
  seedCalendar_(cal);
  ScriptApp.newTrigger('planTriggers').timeBased().everyDays(1).atHour(0).nearMinute(5).create();
  try {                                                 // re-plan as soon as an event is added, moved or deleted
    ScriptApp.newTrigger('planTriggers').forUserCalendar(cal.getId()).onEventUpdated().create();
  } catch (e) {
    console.warn(`ตั้งให้อัปเดตทันทีเมื่อแก้ปฏิทินไม่ได้ (${e}) — เวลาที่แก้ในปฏิทินจะมีผลหลัง 00:05 หรือเมื่อรัน planTriggers()`);
  }
  planTriggers();                                       // also turns the interval sync on (ensureInterval_)
  console.log(`ตั้งค่าแล้ว: เวลาทำงานอัตโนมัติมาจากปฏิทิน "${CONFIG.CALENDAR_NAME}" — ย้าย / เพิ่ม / ลบนัดในปฏิทินเพื่อเปลี่ยนเวลา`);
}

// ============================================================ schedule = Google Calendar
//
// The automatic runs follow the events of the calendar CONFIG.CALENDAR_NAME: at an event's start time
//   title contains "ซิงก์" or "sync"     → sync the current month with the Overview
//   title contains "สร้าง" or "create"   → create the files of the next month, or of the month written
//                                          in the title as yyyy-MM (e.g. "สร้างไฟล์ 2026-12")
// setup() creates the calendar and the default repeating events; change the schedule by editing them.
// All-day events and events with other titles are ignored.

function calendar_(create) {
  const found = CalendarApp.getCalendarsByName(CONFIG.CALENDAR_NAME).filter(c => c.isOwnedByMe());
  if (found.length) return found[0];
  if (!create) throw new Error(`ไม่พบปฏิทิน "${CONFIG.CALENDAR_NAME}" — รัน setup() ก่อน`);
  return CalendarApp.createCalendar(CONFIG.CALENDAR_NAME, { timeZone: 'Asia/Bangkok' });
}

/** The default repeating events, only when the calendar has no run planned in the next 40 days. */
function seedCalendar_(cal) {
  const now = new Date();
  if (cal.getEvents(now, new Date(now.getTime() + 40 * 86400000)).some(e => eventAction_(e))) return;
  const today = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM-dd').split('-').map(Number);
  const at = (y, m, d, h) => new Date(Date.UTC(y, m - 1, d, h - 7));          // Bangkok is UTC+7, no DST
  CONFIG.SYNC_HOURS.forEach(h => {
    const start = at(today[0], today[1], today[2], h);
    cal.createEventSeries(EVENT_SYNC, start, new Date(start.getTime() + 15 * 60000), CalendarApp.newRecurrence().addDailyRule());
  });
  const start = at(today[0], today[1], CONFIG.CREATE_ON_DAY, 1);
  cal.createEventSeries(EVENT_CREATE, start, new Date(start.getTime() + 30 * 60000),
    CalendarApp.newRecurrence().addMonthlyRule().onlyOnMonthDay(CONFIG.CREATE_ON_DAY));
}

function eventAction_(event) {
  if (event.isAllDayEvent()) return null;
  const title = event.getTitle();
  if (/สร้าง|create/i.test(title)) return 'calendarCreate';
  if (/ซิงก์|sync/i.test(title)) return 'calendarSync';
  return null;
}

/**
 * One trigger per calendar event that starts in the next 25 hours. Runs every day at 00:05 and when the
 * calendar changes; run it by hand after editing the calendar if the change must apply at once.
 */
function planTriggers() {
  ['calendarSync', 'calendarCreate'].forEach(clearTriggers_);
  const now = new Date();
  const seen = {}, planned = [];
  calendar_(false).getEvents(now, new Date(now.getTime() + 25 * 3600000)).forEach(e => {
    const fn = eventAction_(e), start = e.getStartTime();
    const key = `${fn}@${start.getTime()}`;
    if (!fn || start <= now || seen[key] || planned.length >= MAX_PLANNED) return;
    seen[key] = true;
    ScriptApp.newTrigger(fn).timeBased().at(start).create();
    planned.push(`${Utilities.formatDate(start, 'Asia/Bangkok', 'dd/MM HH:mm')} ${fn === 'calendarSync' ? 'ซิงก์' : 'สร้างไฟล์'}`);
  });
  // a job whose chain of runs broke (for example the daily quota ran out) starts again here
  if (PropertiesService.getScriptProperties().getProperty('job') && !hasTrigger_('continueJob')) after_(NEXT_RUN_MS);
  ensureInterval_();
  console.log(planned.length ? `ตั้งเวลาจากปฏิทินแล้ว: ${planned.join(' · ')}` : 'ไม่มีนัดในปฏิทินภายใน 25 ชั่วโมงข้างหน้า');
}

/** Minutes between interval syncs: the value chosen with setSyncInterval, else CONFIG.SYNC_EVERY_MIN; 0 = off. */
function syncEvery_(props) {
  const chosen = props.getProperty('syncEvery');
  return Number(chosen === null ? CONFIG.SYNC_EVERY_MIN : chosen) || 0;
}

/** The interval sync is on by default: its trigger is put back whenever it is missing and not turned off. */
function ensureInterval_() {
  const minutes = syncEvery_(PropertiesService.getScriptProperties());
  if (minutes && !hasTrigger_('intervalSync')) console.log(setSyncInterval(minutes));
}

/**
 * Sync every `minutes` minutes (one of SYNC_INTERVALS; 0 = off), on top of the calendar's sync events.
 * A run first asks Drive whether any plant file was edited (nothingNew_) and stops there when none was;
 * a sync only reads the plant files edited since the one before, so a short interval stays cheap.
 */
function setSyncInterval(minutes) {
  if (minutes !== 0 && SYNC_INTERVALS.indexOf(minutes) < 0) {
    throw new Error(`รอบซิงก์ต้องเป็น ${SYNC_INTERVALS.join(', ')} นาที หรือ 0 เพื่อปิด (ได้รับ: ${minutes})`);
  }
  const props = PropertiesService.getScriptProperties();
  clearTriggers_('intervalSync');
  props.setProperty('syncEvery', String(minutes));       // "0" is kept: off stays off through setup()
  if (!minutes) {
    return 'ปิดรอบซิงก์อัตโนมัติแล้ว (ซิงก์ตามปฏิทินยังทำงาน)';
  }
  const t = ScriptApp.newTrigger('intervalSync').timeBased();
  (minutes < 60 ? t.everyMinutes(minutes) : t.everyHours(minutes / 60)).create();
  return `ตั้งแล้ว: ซิงก์ทุก ${minutes} นาที ระหว่าง ${CONFIG.SYNC_FROM_HOUR}:00–${CONFIG.SYNC_TO_HOUR}:00 น.`;
}

/** Fired by the interval trigger. */
function intervalSync() {
  const hour = Number(Utilities.formatDate(new Date(), 'Asia/Bangkok', 'H'));
  if (hour < CONFIG.SYNC_FROM_HOUR || hour >= CONFIG.SYNC_TO_HOUR) return;
  const ym = ym_(new Date());
  if (nothingNew_(ym)) return;
  startSync_(ym, true);
}

/**
 * True when a sync of `ym` would find nothing to do: no job is waiting, the last sync was complete, no
 * plant file in the month folder was edited since (same rule as syncBatch_), and the Overview's plants
 * and inverters are the same. Two Drive calls; the Overview is only opened after somebody edited it.
 * Any doubt (or a failed call) answers false, and the sync decides for itself.
 */
function nothingNew_(ym) {
  try {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('job')) return false;
    const last = JSON.parse(props.getProperty(`synced_${ym}`) || 'null');
    if (!last || !last.f || !last.ov || !last.fin || last.v !== SYNC_VERSION || (last.err && last.err.length)) return false;
    if (last.root !== rootId_()) return false;   // the last sync was of another root folder
    // files edited lately: nothing new when each one still has the edit time it had when it was last read
    const since = new Date(Number(last.t) - SYNC_MARGIN_MS).toISOString();
    const seen = readSeen_(props, ym);
    const page = Drive.Files.list({ q: `'${last.f}' in parents and trashed = false and modifiedTime > '${since}'`,
      pageSize: 1000, fields: 'nextPageToken, files(id,modifiedTime)' });
    if (page.nextPageToken) return false;
    if ((page.files || []).some(f => !seen || seen[fileKey_(f.id)] !== stamp_(new Date(f.modifiedTime).getTime()))) return false;
    // the Overview: untouched since the sync wrote it, or already compared at this edit time
    const at = Drive.Files.get(last.ov, { fields: 'modifiedTime' }).modifiedTime;
    if (new Date(at).getTime() <= Number(last.fin) || props.getProperty('ovSame') === at) return true;
    const overview = SpreadsheetApp.openById(last.ov);
    if (signature_([readStations_(overview), readInverters_(overview)]) !== last.sig) return false;
    props.setProperty('ovSame', at);
    return true;
  } catch (e) {
    console.warn(`ตรวจการแก้ไขไม่ได้ — ซิงก์ตามปกติ: ${e}`);
    return false;
  }
}

/** Fired at the start of a "ซิงก์" event. */
function calendarSync() { startSync_(ym_(new Date()), true); }

/** Fired at the start of a "สร้าง" event: the month in the event's title, else next month. */
function calendarCreate() {
  const now = new Date();
  const event = calendar_(false).getEvents(new Date(now.getTime() - 20 * 60000), new Date(now.getTime() + 20 * 60000))
    .filter(e => eventAction_(e) === 'calendarCreate')[0];
  const named = event && /\d{4}-(0[1-9]|1[0-2])/.exec(event.getTitle());
  // a sync that is working (the interval sync often is) is waited for: startCreate_ queues behind it
  if (PropertiesService.getScriptProperties().getProperty('job') === 'create') {
    console.warn('ข้ามการสร้างไฟล์ตามปฏิทิน: มีงานสร้างไฟล์ทำอยู่');
    return;
  }
  RUN_LATER = true;
  startCreate_(named ? named[0] : nextYm_(), '');
}

function createThisMonth() { startCreate_(ym_(new Date()), ''); }
function createNextMonth() { startCreate_(nextYm_(), ''); }
function createTestPlant() { startCreate_(ym_(new Date()), CONFIG.TEST_CODE); }
/** Any month, called from another function: createMonth('2026-12'). */
function createMonth(ym) { startCreate_(ym, ''); }

function syncNow() { startSync_(ym_(new Date()), false); }
/** Any month, called from another function: syncMonth('2026-10'). */
function syncMonth(ym) { startSync_(ym, false); }

/** Once: the Overview .xlsx in the root folder becomes a Google Sheet (the .xlsx is left as it is). */
function convertOverview() {
  const file = overviewFile_();
  if (file.getMimeType() === MimeType.GOOGLE_SHEETS) {
    console.log(`Overview เป็น Google Sheet อยู่แล้ว: ${file.getUrl()}`);
    return;
  }
  const copy = Drive.Files.copy({ name: file.getName().replace(/\.xlsx?$/i, ''), mimeType: MimeType.GOOGLE_SHEETS,
    parents: [rootId_()] }, file.getId());
  console.log(`สร้าง Overview แบบ Google Sheet แล้ว: https://docs.google.com/spreadsheets/d/${copy.id}/edit\n` +
    `ต่อจากนี้ให้แก้ไขที่ไฟล์นี้ (ไฟล์ .xlsx เดิมยังอยู่ แต่ระบบไม่ใช้แล้ว)`);
}

function status() {
  const p = PropertiesService.getScriptProperties().getProperties();
  const msg = p.job
    ? (p.job === 'sync'
      ? `กำลังซิงก์เดือน ${p.ym}: ทำแล้ว ${p.idx} สถานี (อ่าน ${p.made}, ไม่มีการแก้ไข ${p.same || 0}, ยังไม่มีไฟล์ ${p.skipped})`
      : `กำลังสร้างไฟล์เดือน ${p.ym}: ทำแล้ว ${p.idx} สถานี (สร้างใหม่ ${p.made}, มีอยู่แล้ว ${p.skipped})`) +
      (p.errors ? ` · ผิดพลาด: ${p.errors}` : '') +
      (hasTrigger_('continueJob') ? '' : ' · งานหยุดอยู่ — กดเมนูเดิมอีกครั้งเพื่อทำต่อ') +
      (p.queued ? ' · รอคิว: สร้างไฟล์ (เริ่มเองเมื่อซิงก์เสร็จ)' : '')
    : 'ไม่มีงานค้าง' + (p.last ? ` · งานล่าสุด: ${p.last}` : '');
  const n = syncEvery_(PropertiesService.getScriptProperties());
  const every = n ? ` · ซิงก์อัตโนมัติ: ตรวจการแก้ไขทุก ${n} นาที` : ' · รอบซิงก์อัตโนมัติ: ปิด';
  console.log(msg + every);
  return msg + every;
}

function cancelJob() {
  clearTriggers_('continueJob');
  const props = PropertiesService.getScriptProperties();
  cleanup_(props, props.getProperties());
  props.deleteProperty('queued');
  console.log('ยกเลิกงานแล้ว (ไฟล์สถานีที่สร้างไปแล้วยังอยู่)');
}

// ============================================================ the job (runs in batches)

function startCreate_(ym, onlyCode) {
  checkYm_(ym);
  const props = PropertiesService.getScriptProperties();
  const cur = dropStaleJob_(props, props.getProperties());
  if (cur.job) {
    // the same job again: carry on where it stopped (a run that is still working is left alone)
    if (cur.job === 'create' && cur.ym === ym && (cur.only || '') === (onlyCode || '')) {
      console.log(`ทำงานเดิมต่อ: ${status()}`);
      kick_();
      return;
    }
    if (cur.job === 'sync') {                           // a sync is working (the interval sync often is): the create waits for it
      props.setProperty('queued', JSON.stringify({ ym: ym, only: onlyCode || '' }));
      if (!hasTrigger_('continueJob')) after_(NEXT_RUN_MS);
      console.log(`กำลังซิงก์อยู่ — จะเริ่มสร้างไฟล์เดือน ${ym} ทันทีที่ซิงก์เสร็จ`);
      return;
    }
    throw new Error(`มีงานค้างอยู่ (${status()}) — รอให้เสร็จ หรือรัน cancelJob() ก่อน`);
  }
  const folder = monthFolder_(ym);
  const ov = overviewSnapshot_(folder);
  props.setProperties({
    job: 'create', ym: ym, idx: '0', folder: folder.getId(), ov: ov.id, ovTemp: ov.temp ? '1' : '',
    only: onlyCode || '', made: '0', skipped: '0', errors: '', warn: '', root: rootId_(),
  });
  console.log(`เริ่มสร้างไฟล์เดือน ${ym} ในโฟลเดอร์ ${folder.getUrl()}`);
  kick_();
}

/**
 * A job left over from another root folder (the Overview was moved or copied since it started) is given
 * up, so it cannot block a new one. Returns the job properties that still count.
 */
function dropStaleJob_(props, cur) {
  if (!cur.job || cur.root === rootId_()) return cur;
  clearTriggers_('continueJob');
  cleanup_(props, cur);
  console.warn(`ยกเลิกงานที่ค้างของโฟลเดอร์หลักเดิม (${cur.job} ${cur.ym})`);
  return {};
}

function continueJob() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;                      // another run is working
  try {
    clearTriggers_('continueJob');
    const props = PropertiesService.getScriptProperties();
    const p = props.getProperties();
    if (p.job !== 'create' && p.job !== 'sync') return;
    after_(WATCHDOG_MIN * 60000);                       // if this run is killed, the job still carries on
    let done = false;
    try {
      if (p.root !== rootId_()) {                         // started for another root folder (the Overview moved since)
        throw stop_('ยกเลิกงานที่ค้างของโฟลเดอร์หลักเดิม — สั่งงานใหม่อีกครั้ง จะใช้โฟลเดอร์ที่ไฟล์ Overview อยู่ตอนนี้');
      }
      done = p.job === 'create' ? createBatch_(props, p, Date.now()) : syncBatch_(props, p, Date.now());
      props.deleteProperty('fails');
    } catch (e) {
      const fails = Number(p.fails || 0) + 1;
      console.error(`รอบนี้ล้มเหลว (ครั้งที่ ${fails}): ${e}`);
      if (e.stop || fails >= MAX_FAILS) {
        const now = props.getProperties();
        note_(props, `งานหยุดที่ ${now.idx || 0} สถานี (สำเร็จ ${now.made || 0}) — ${e.message || e}`);
        done = true;
      } else {
        props.setProperty('fails', String(fails));
      }
    }
    clearTriggers_('continueJob');
    if (done) {
      cleanup_(props, props.getProperties());
      startQueued_(props);
    } else {
      after_(NEXT_RUN_MS);
    }
  } finally {
    lock.releaseLock();
  }
}

/** A create that was asked for while a sync was working starts now, in the background. */
function startQueued_(props) {
  const queued = props.getProperty('queued');
  if (!queued) return;
  props.deleteProperty('queued');
  try {
    const q = JSON.parse(queued);
    RUN_LATER = true;
    startCreate_(q.ym, q.only);
  } catch (e) {
    console.error(`เริ่มงานสร้างไฟล์ที่รอคิวไม่ได้: ${e}`);
    note_(props, `เริ่มงานสร้างไฟล์ที่รอคิวไม่ได้ — ${e.message || e}`);
  }
}

/** One run of the create job; true when every plant is done. */
function createBatch_(props, p, t0) {
  const overview = SpreadsheetApp.openById(p.ov);
  let stations = readStations_(overview);
  if (p.only) {
    stations = stations.filter(s => s.code === p.only);
    if (!stations.length) throw stop_(`ไม่พบสถานีรหัส ${p.only} ใน Overview`);
  }
  const inverters = readInverters_(overview);
  const folder = DriveApp.getFolderById(p.folder);
  const existing = folderFiles_(p.folder);
  // a template left half-built by a run that was cut short is not one of this job's templates
  const mine = Object.keys(p).filter(k => k.indexOf('tpl_') === 0).map(k => p[k]);
  existing.forEach((f, name) => { if (name.indexOf('_TEMPLATE_') === 0 && mine.indexOf(f.id) < 0) trash_(f.id); });
  let i = Number(p.idx), made = Number(p.made), skipped = Number(p.skipped);
  const errors = p.errors ? p.errors.split(',') : [];
  const seconds = () => (Date.now() - t0) / 1000;
  let streak = 0, lastError = '';

  while (i < stations.length && seconds() < COPY_UNTIL_S) {
    const s = stations[i];
    const name = fileName_(s, p.ym);
    let file = null;
    try {
      if (plantFile_(existing, s, p.ym)) {
        skipped++;
      } else {
        const list = inverters[s.code] || [];
        const n = Math.max(list.length, 1);
        // a new template does not fit in what is left of this run: the next run starts with it
        if (!props.getProperty(`tpl_${n}`) && seconds() > TEMPLATE_BY_S) break;
        const tplId = template_(props, p.ym, folder, n);
        file = DriveApp.getFileById(tplId).makeCopy(name, folder);
        writeInfo_(file.getId(), infoValues_(s), inverterValues_(list, list.length));
        made++;
      }
      // the Google Sheet replaces the old Excel report (the trash keeps it for 30 days)
      const old = CONFIG.REPLACE_XLSX && existing.get(`${name}.xlsx`);
      if (old) { DriveApp.getFileById(old.id).setTrashed(true); existing.delete(`${name}.xlsx`); }
      streak = 0;
    } catch (e) {
      console.error(`${s.code}: ${e}`);
      errors.push(s.code);
      lastError = String(e.message || e);
      streak++;
      if (file) { try { file.setTrashed(true); } catch (e2) { /* no half-filled file is left behind */ } }
    }
    i++;
    props.setProperties({ idx: String(i), made: String(made), skipped: String(skipped), errors: errors.join(',') });
    // the same failure plant after plant is a limit or an outage, not a problem with one plant
    if (streak >= MAX_FAILS) {
      throw stop_(`ผิดพลาดติดกัน ${streak} สถานี (${errors.slice(-streak).join(', ')}): ${lastError} — กดสร้างไฟล์อีกครั้งภายหลัง สถานีที่มีไฟล์แล้วจะถูกข้าม`);
    }
  }

  if (i < stations.length) {
    console.log(`${p.ym}: ${i}/${stations.length} สถานี — ทำต่ออัตโนมัติ`);
    return false;
  }
  const summary = `สร้างไฟล์ ${p.ym} เสร็จ: สร้างใหม่ ${made} ไฟล์, มีอยู่แล้ว ${skipped} ไฟล์` +
    (errors.length ? `, ผิดพลาด ${errors.length} สถานี (${errors.join(', ')}${lastError ? ': ' + lastError : ''}) — กดสร้างไฟล์อีกครั้งเพื่อสร้างสถานีที่ขาด` : '');
  note_(props, summary);
  console.log(summary);
  return true;
}

/** Trashes the job's temporary files (templates, converted Overview) and clears its state. */
function cleanup_(props, p) {
  Object.keys(p).filter(k => k.indexOf('tpl_') === 0).forEach(k => {
    trash_(p[k]);
    props.deleteProperty(k);
  });
  if (p.ovTemp && p.ov) trash_(p.ov);
  JOB_KEYS.forEach(k => props.deleteProperty(k));
}

function trash_(id) {
  try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { console.warn(`ลบไฟล์ชั่วคราว ${id} ไม่ได้: ${e}`); }
}

// ============================================================ 1) month folder

/** The folder `name` in `parent`, or null when there is none (one in the trash does not count). */
function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
  return null;
}

/**
 * The folder that holds the month folders: CONFIG.MONTHS_FOLDER in the root folder (made when `make`),
 * the root folder itself when MONTHS_FOLDER is blank; null when it is not there and not `make`.
 */
function monthsParent_(make) {
  const root = DriveApp.getFolderById(rootId_());
  if (!CONFIG.MONTHS_FOLDER) return root;
  return childFolder_(root, CONFIG.MONTHS_FOLDER) || (make ? root.createFolder(CONFIG.MONTHS_FOLDER) : null);
}

/**
 * The month folder "yyyy-MM", or null when there is none: the one in the months folder, else one still
 * left directly in the root folder (from before MONTHS_FOLDER), so a month is never made twice.
 */
function findMonthFolder_(ym) {
  const parent = monthsParent_(false);
  return (parent && childFolder_(parent, ym)) || childFolder_(DriveApp.getFolderById(rootId_()), ym);
}

function monthFolder_(ym) {
  return findMonthFolder_(ym) || monthsParent_(true).createFolder(ym);
}

/**
 * Everything in a folder that is not in the trash: Map name → { id, edited (ms) }. One Drive API call
 * per 1,000 files, instead of one DriveApp round trip per file.
 */
function folderFiles_(folderId) {
  const out = new Map();
  const args = { q: `'${folderId}' in parents and trashed = false`, pageSize: 1000, fields: 'nextPageToken, files(id,name,modifiedTime)' };
  do {
    const page = retry_(() => Drive.Files.list(args));
    (page.files || []).forEach(f => out.set(f.name, { id: f.id, edited: new Date(f.modifiedTime).getTime() }));
    args.pageToken = page.nextPageToken;
  } while (args.pageToken);
  return out;
}

function fileName_(s, ym) { return `${s.code}_${s.name.replace(/[\\/:*?"<>|]/g, '-').trim()}_${ym}`; }

/**
 * A plant's file of the month in `files` (folderFiles_): by its exact name, else by plant code and month,
 * so a plant renamed in the Overview after its file was made keeps that file. undefined = no file yet.
 */
function plantFile_(files, s, ym) {
  const exact = files.get(fileName_(s, ym));
  if (exact) return exact;
  const head = `${s.code}_`, tail = `_${ym}`;
  for (const [name, f] of files) if (name.indexOf(head) === 0 && name.slice(-tail.length) === tail) return f;
  return undefined;
}

// ============================================================ 2) one file per plant, one sheet per day

/**
 * The month's template for plants with n inverters: built once per job, then copied for every such
 * plant (a file copy keeps the sheet ids, so the links from สรุปเดือน to the day sheets still work).
 */
function template_(props, ym, folder, n) {
  const key = `tpl_${n}`;
  let id = props.getProperty(key);
  if (!id) {
    id = buildTemplate_(ym, folder, n);
    props.setProperty(key, id);
  }
  return id;
}

function buildTemplate_(ym, folder, n) {
  const [y, m] = ym.split('-').map(Number);
  const days = daysIn_(y, m);
  const ss = SpreadsheetApp.create(`_TEMPLATE_${ym}_${n}inv`);
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  ss.setSpreadsheetLocale('th_TH');
  ss.setSpreadsheetTimeZone('Asia/Bangkok');

  const info = ss.getSheets()[0].setName(INFO);
  info.getRange('A1:A5').setValues([['ชื่อสถานี'], ['กำลังติดตั้ง'], ['อายุสัญญา'], ['วันที่เริ่มให้บริการ'], ['รหัส / ระยะ']]);
  info.getRange('A6:B6').setValues([['ที่มา', 'คัดลอกจาก Overview ตอนสร้างไฟล์ — แก้ที่ไฟล์ Overview']]);
  info.getRange('A7:B7').setValues([['รุ่นแม่แบบ', TEMPLATE_VERSION]]);
  info.getRange(INFO_INV0 - 1, 1, 1, 3).setValues([['NO.', 'Inverter S/N', 'จำนวนสตริง']]);

  const logo = logoBlob_();
  const first = ss.insertSheet('วันที่ 1');
  buildDay_(first, n);
  setDayTitle_(first, y, m, 1);
  addLogo_(first, logo);
  const gids = [first.getSheetId()];
  let carried = false;
  for (let d = 2; d <= days; d++) {
    const sh = first.copyTo(ss).setName(`วันที่ ${d}`);
    setDayTitle_(sh, y, m, d);
    if (!carried) carried = !addLogo_(sh, logo);        // only if the copy did not bring the image along
    gids.push(sh.getSheetId());
  }
  buildSummary_(ss, y, m, days, n, gids);
  info.hideSheet();
  SpreadsheetApp.flush();
  return ss.getId();
}

function logoBlob_() {
  try {
    if (CONFIG.LOGO_FILE_ID) return DriveApp.getFileById(CONFIG.LOGO_FILE_ID).getBlob();
    const it = DriveApp.getFolderById(rootId_()).getFilesByName(CONFIG.LOGO_NAME);
    while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f.getBlob(); }
    return null;
  } catch (e) {
    console.warn(`อ่านไฟล์โลโก้ไม่ได้ (${e}) — สร้างไฟล์โดยไม่มีโลโก้`);
    return null;
  }
}

/** The logo at the top right of a day sheet (over columns L:M, rows 1-4), unless the sheet already has an image. */
function addLogo_(sh, blob) {
  if (!blob || sh.getImages().length) return false;
  sh.insertImage(blob, 12, 1, 150, 4).setHeight(92).setWidth(116);
  return true;
}

/**
 * Menu: puts the logo on the day sheets of this month's plant files that were created without it.
 * Works for about CONFIG.RUN_SECONDS; run it again to continue (sheets that have the logo are skipped).
 */
function addLogoToExisting() {
  const logo = logoBlob_();
  if (!logo) throw new Error(`ไม่มีไฟล์โลโก้ "${CONFIG.LOGO_NAME}" ในโฟลเดอร์เดียวกับไฟล์ Overview`);
  const t0 = Date.now(), ym = ym_(new Date());
  const folder = findMonthFolder_(ym);
  if (!folder) throw new Error(`ยังไม่มีโฟลเดอร์เดือน ${ym}`);
  let added = 0, finished = true;
  const files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (files.hasNext()) {
    if ((Date.now() - t0) / 1000 > CONFIG.RUN_SECONDS) { finished = false; break; }
    const f = files.next();
    if (f.isTrashed() || f.getName().indexOf('_') === 0) continue;
    SpreadsheetApp.openById(f.getId()).getSheets().filter(sh => /^วันที่ \d+$/.test(sh.getName()))
      .forEach(sh => { if (addLogo_(sh, logo)) added++; });
  }
  const msg = `ใส่โลโก้แล้ว ${added} หน้า` + (finished ? '' : ' — ยังไม่ครบ กดเมนูนี้อีกครั้งเพื่อทำต่อ');
  toast_(msg);
  return msg;
}

/** Row numbers of a day sheet for a plant with n inverters. */
function layout_(n) {
  const total = DAY_INV0 + n;
  const issue0 = total + 4;
  const issue1 = issue0 + n - 1;                        // one row per inverter, in the same order
  return { inv0: DAY_INV0, inv1: total - 1, total: total, issueTitle: total + 2, issueHead: total + 3,
    issue0: issue0, issue1: issue1, sign: issue1 + 3, last: issue1 + 6 };
}

function setDayTitle_(sh, y, m, d) {
  sh.getRange('C4').setValue(`สรุปผลความพร้อมระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ประจำวันที่  ${d} ${TH_MONTH[m]} พ.ศ. ${y + 543}`);
}

function buildDay_(sh, n) {
  const L = layout_(n);
  const I = `'${INFO}'!`;
  trimSheet_(sh, L.last, 14);
  sh.setHiddenGridlines(true);
  sh.getRange(1, 1, L.last, 14).setFontFamily(CONFIG.FONT).setFontSize(CONFIG.FONT_SIZE)
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  [10, 10, 75, 160, 82, 82, 82, 150, 110, 110, 150, 130, 150, 10].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.setRowHeights(1, L.last, 30);
  sh.setRowHeight(1, 10);
  sh.setRowHeights(5, 3, 6);
  [14, L.total + 1, L.issue1 + 1, L.issue1 + 2].forEach(r => sh.setRowHeight(r, 14));

  // title
  sh.getRange('C2:K3').merge().setValue('รายงานความพร้อมระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ประจำวัน').setFontSize(16).setFontWeight('bold');
  sh.getRange('C4:K4').merge().setFontSize(12);                 // columns L:M of rows 1-4 hold the logo

  // project and plant
  sh.getRange('C8:D9').merge().setValue('ชื่อโครงการ');
  sh.getRange('E8:M8').merge().setValue(PROJECT);
  sh.getRange('E9:M9').merge().setValue(OWNER);
  [['ชื่อสถานี', 'B1'], ['อายุสัญญา', 'B3'], ['วันที่เริ่มให้บริการ', 'B4'], ['กำลังติดตั้ง', 'B2']].forEach(([label, cell], k) => {
    sh.getRange(10 + k, 3, 1, 2).merge().setValue(label);
    sh.getRange(10 + k, 5, 1, 9).merge().setFormula(`=${I}${cell}`);
  });
  sh.getRange('C8:D13').setFontWeight('bold').setBackground(COLOR.GREY).setHorizontalAlignment('left');
  sh.getRange('E8:M13').setHorizontalAlignment('left');
  sh.getRange('E10').setFontWeight('bold');
  box_(sh.getRange('C8:M13'));

  // inverter table: two header rows, one row per inverter, total row
  [['C', 'NO.'], ['D', 'Inverter S/N'], ['H', 'สตริงที่มีปัญหา'], ['I', 'เวลาที่พบปัญหา'], ['J', 'Inverter Status']]
    .forEach(([c, text]) => sh.getRange(`${c}15:${c}16`).merge().setValue(text));
  sh.getRange('K15:M16').merge().setValue('รายละเอียด');
  sh.getRange('E15:G15').merge().setValue('จำนวนสตริง');
  sh.getRange('E16:G16').setValues([['ทั้งหมด', 'ปกติ', 'ผิดปกติ']]);
  sh.getRange('C15:M16').setFontWeight('bold').setBackground(COLOR.BLUE);

  const rows = [];
  for (let k = 0; k < n; k++) {
    const r = L.inv0 + k, ir = INFO_INV0 + k;
    rows.push([
      `=IF(${I}B${ir}="","",${I}A${ir})`,
      `=IF(${I}B${ir}="","",${I}B${ir})`,
      `=IF(${I}B${ir}="","",${I}C${ir})`,
      `=IF(OR(G${r}="",E${r}=""),"",E${r}-G${r})`,      // ปกติ = ทั้งหมด − ผิดปกติ, once ผิดปกติ is typed
    ]);
  }
  sh.getRange(L.inv0, 3, n, 4).setFormulas(rows);
  sh.getRange(`K${L.inv0}:M${L.inv1}`).mergeAcross().setHorizontalAlignment('left');
  sh.getRange(`G${L.inv0}:M${L.inv1}`).setBackground(COLOR.INPUT);                  // typed by the reporter
  sh.getRange(`J${L.inv0}:J${L.inv1}`).setDataValidation(dropdown_(INV_STATUSES));

  const T = L.total;
  const eRng = `E${L.inv0}:E${L.inv1}`, fRng = `F${L.inv0}:F${L.inv1}`, gRng = `G${L.inv0}:G${L.inv1}`;
  sh.getRange(`C${T}:D${T}`).merge().setValue('รวม');
  // ความพร้อม counts only the inverters whose ผิดปกติ is filled, so a half-filled day is not overstated
  sh.getRange(`E${T}:I${T}`).setValues([[`=SUM(${eRng})`, `=SUM(${fRng})`, `=SUM(${gRng})`, 'ความพร้อม',
    `=IF(N(SUMIF(${gRng},"<>",${eRng}))=0,"-",F${T}/SUMIF(${gRng},"<>",${eRng}))`]]);
  sh.getRange(`I${T}`).setNumberFormat('0.00%');
  sh.getRange(`K${T}:M${T}`).merge();
  sh.getRange(`C${T}:M${T}`).setFontWeight('bold').setBackground(COLOR.GREY);
  box_(sh.getRange(`C15:M${T}`));

  // รายงานการแก้ไข: row k belongs to inverter k and shows it only while that inverter is a problem
  // (ผิดปกติ > 0, Fault or Offline), so what is typed next to it can never slide to another inverter.
  const H = L.issueHead, a = L.issue0, b = L.issue1;
  sh.getRange(`C${L.issueTitle}:M${L.issueTitle}`).merge().setValue('รายงานการแก้ไข')
    .setFontWeight('bold').setBackground(COLOR.ORANGE).setHorizontalAlignment('left');
  sh.getRange(`C${H}:M${H}`).setValues([['ลำดับ', 'Inverter S/N', 'String', 'รายละเอียด', '', '', 'การแก้ไข', 'วันเข้าแก้ไข',
    'สถานะ', 'ผู้รับผิดชอบ', 'วันที่แก้ไขเสร็จ']]).setFontWeight('bold').setBackground(COLOR.BLUE);
  sh.getRange(`I${H}:M${H}`).setBackground(COLOR.HEAD_GREEN);
  sh.getRange(`F${H}:H${b}`).mergeAcross();
  const issues = [];
  for (let k = 0; k < n; k++) {
    const r = L.inv0 + k, x = a + k;
    const problem = `OR(AND(ISNUMBER(G${r}),G${r}>0),${PROBLEM_STATUSES.map(st => `J${r}="${st}"`).join(',')})`;
    issues.push([
      `=IF(D${x}="","",COUNTIF(D$${a}:D${x},"?*"))`,
      `=IF(${problem},D${r},"")`,
      `=IF(D${x}="","",H${r})`,
      `=IF(D${x}="","",K${r})`,
    ]);
  }
  sh.getRange(a, 3, n, 4).setFormulas(issues);
  sh.getRange(`I${a}:M${b}`).setBackground(COLOR.INPUT);                            // typed by the reporter
  sh.getRange(`F${a}:I${b}`).setHorizontalAlignment('left');
  sh.getRange(`K${a}:K${b}`).setDataValidation(dropdown_(STATUSES));
  sh.getRange(`J${a}:J${b}`).setNumberFormat('dd/mm/yyyy')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(true).build());
  sh.getRange(`M${a}:M${b}`).setNumberFormat('dd/mm/yyyy')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(true).build());
  box_(sh.getRange(`C${L.issueTitle}:M${b}`));

  // colours: status, abnormal strings, availability
  const status = sh.getRange(`K${a}:K${b}`), avail = sh.getRange(`I${T}`);
  sh.setConditionalFormatRules([
    rule_(status, r => r.whenTextEqualTo('รอดำเนินการ').setBackground(COLOR.RED)),
    rule_(status, r => r.whenTextEqualTo('กำลังแก้ไข').setBackground(COLOR.YELLOW)),
    rule_(status, r => r.whenTextEqualTo('แก้ไขแล้ว').setBackground(COLOR.GREEN)),
    rule_(status, r => r.whenTextEqualTo('ปิดงาน').setBackground(COLOR.GREY)),
    rule_(sh.getRange(gRng), r => r.whenNumberGreaterThan(0).setBackground(COLOR.RED).setBold(true)),
    rule_(avail, r => r.whenNumberGreaterThanOrEqualTo(0.98).setBackground(COLOR.GREEN)),
    rule_(avail, r => r.whenNumberBetween(0.95, 0.97999).setBackground(COLOR.YELLOW)),
    rule_(avail, r => r.whenNumberLessThan(0.95).setBackground(COLOR.RED)),
  ]);

  // signatures
  [['C', 'G', 'ผู้จัดทำรายงาน'], ['I', 'M', 'ผู้ตรวจสอบ']].forEach(([c1, c2, role]) => {
    ['ลงชื่อ ...................................................', '(...................................................)',
      role, 'วันที่ ......../......../........'].forEach((text, k) => {
      sh.getRange(`${c1}${L.sign + k}:${c2}${L.sign + k}`).merge().setValue(text).setFontWeight(k === 2 ? 'bold' : 'normal');
    });
  });
}

function buildSummary_(ss, y, m, days, n, gids) {
  const L = layout_(n);
  const sh = ss.insertSheet(SUMMARY, 0);
  const totalRow = 6 + days;
  trimSheet_(sh, totalRow + 1, 9);
  sh.setHiddenGridlines(true);
  sh.getRange(1, 1, totalRow + 1, 9).setFontFamily(CONFIG.FONT).setFontSize(CONFIG.FONT_SIZE)
    .setHorizontalAlignment('center').setVerticalAlignment('middle');
  [110, 110, 80, 80, 100, 260, 120, 120, 70].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.getRange('A1:I1').merge().setValue(`สรุปความพร้อมระบบรายเดือน – ${TH_MONTH[m]} ${y + 543}`).setFontSize(16).setFontWeight('bold');
  sh.getRange('A2:I2').merge().setFormula(`='${INFO}'!B1`).setFontWeight('bold');
  sh.getRange('A3:I3').merge().setFormula(SUMMARY_SUBTITLE);
  sh.getRange('A4:I4').merge().setFormula(todayLink_(y, m, days)).setFontWeight('bold').setFontColor(COLOR.LINK);
  sh.getRange('A5:I5').setValues([['วันที่', 'สตริงทั้งหมด', 'ปกติ', 'ผิดปกติ', 'ความพร้อม', 'รายละเอียดปัญหา',
    'วันเข้าแก้ไข', 'วันแล้วเสร็จ', 'หน้า']]).setFontWeight('bold').setBackground(COLOR.BLUE);

  // A day shows up here once ผิดปกติ is filled for at least one inverter on its sheet (0 = all normal).
  const rows = [];
  for (let d = 1; d <= days; d++) {
    const t = `'วันที่ ${d}'!`;
    const filled = `COUNT(${t}$G$${L.inv0}:$G$${L.inv1})>0`;
    rows.push([
      `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y + 543}`,
      `=IF(${filled},${t}$E$${L.total},"")`,
      `=IF(${filled},${t}$F$${L.total},"")`,
      `=IF(${filled},${t}$G$${L.total},"")`,
      `=IF(${filled},${t}$I$${L.total},"")`,
      `=IF(${filled},TEXTJOIN(", ",TRUE,${t}$K$${L.inv0}:$K$${L.inv1}),"")`,
      '', '',
      `=HYPERLINK("#gid=${gids[d - 1]}","เปิด")`,
    ]);
  }
  sh.getRange(6, 1, days, 1).setNumberFormat('@');            // the Buddhist-year date stays text
  sh.getRange(6, 1, days, 9).setValues(rows);
  sh.getRange(6, 5, days + 1, 1).setNumberFormat('0.00%');
  sh.getRange(6, 6, days, 1).setHorizontalAlignment('left').setWrap(true);
  sh.getRange(6, 7, days, 2).setNumberFormat('dd/mm/yyyy').setFormulas(summaryDates_(days, n));   // from the day sheets
  sh.getRange(6, 9, days, 1).setFontColor(COLOR.LINK);
  sh.getRange(totalRow, 1, 1, 5).setValues([['รวม/เฉลี่ย', `=SUM(B6:B${totalRow - 1})`, `=SUM(C6:C${totalRow - 1})`,
    `=SUM(D6:D${totalRow - 1})`, `=IF(N(B${totalRow})=0,"-",C${totalRow}/B${totalRow})`]]);
  sh.getRange(totalRow, 1, 1, 9).setFontWeight('bold').setBackground(COLOR.GREY);
  box_(sh.getRange(5, 1, days + 2, 9));
  sh.setFrozenRows(5);

  const abnormal = sh.getRange(6, 4, days, 1), avail = sh.getRange(6, 5, days, 1);
  sh.setConditionalFormatRules([
    rule_(abnormal, r => r.whenNumberGreaterThan(0).setBackground(COLOR.RED)),
    rule_(avail, r => r.whenNumberGreaterThanOrEqualTo(0.98).setBackground(COLOR.GREEN)),
    rule_(avail, r => r.whenNumberLessThan(0.95).setBackground(COLOR.RED)),
  ]);
}

/**
 * Writes a plant file's info sheet — B1:B5 (infoValues_) and the inverter rows (inverterValues_) — in one
 * Sheets API call, without opening the file. Values are stored as given (RAW): an S/N like 1E5 stays text.
 */
function writeInfo_(id, info, inv) {
  const data = [{ range: `'${INFO}'!B1:B5`, values: info }];
  if (inv.length) data.push({ range: `'${INFO}'!A${INFO_INV0}:C${INFO_INV0 + inv.length - 1}`, values: inv });
  retry_(() => Sheets.Spreadsheets.Values.batchUpdate({ valueInputOption: 'RAW', data: data }, id));
}

/** B1:B5 of the info sheet. */
function infoValues_(s) {
  const kwp = Number(s.kwp);
  return [
    [s.name],
    [s.kwp !== '' && !isNaN(kwp) ? `${kwp.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kWp` : '-'],
    [s.contract || '-'],
    [thDate_(s.start)],
    [`${s.code}  ·  ระยะที่ ${s.phase}`],
  ];
}

/** The inverter rows of the info sheet: NO., S/N, จำนวนสตริง — exactly `rows` rows, blank past the list. */
function inverterValues_(invs, rows) {
  const out = [];
  for (let k = 0; k < rows; k++) {
    const v = invs[k];
    out.push(v ? [v.no || k + 1, v.sn, v.strings === '' || v.strings == null ? '' : v.strings] : ['', '', '']);
  }
  return out;
}

// ============================================================ Overview (plants and inverters)

/** The Overview as a Google Sheet: itself, or a temporary converted copy when it is an .xlsx. */
function overviewSnapshot_(folder) {
  const file = overviewFile_();
  if (file.getMimeType() === MimeType.GOOGLE_SHEETS) return { id: file.getId(), temp: false };
  const copy = Drive.Files.copy({ name: TEMP_OVERVIEW, mimeType: MimeType.GOOGLE_SHEETS, parents: [folder.getId()] }, file.getId());
  return { id: copy.id, temp: true };
}

/** The sheet this script is bound to (null when it runs as a standalone script). */
function boundSheet_() {
  try { return SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { return null; }
}

/**
 * The root folder: where the logo and the months folder (CONFIG.MONTHS_FOLDER) are. It is the folder the Overview sheet is in,
 * read from Drive each time, so it follows the sheet when it is moved (CONFIG.ROOT_FOLDER_ID overrides).
 */
function rootId_() {
  if (CONFIG.ROOT_FOLDER_ID) return CONFIG.ROOT_FOLDER_ID;
  const id = CONFIG.OVERVIEW_ID || (boundSheet_() && boundSheet_().getId());
  if (!id) throw new Error('ไม่รู้ว่าไฟล์ Overview อยู่ที่ไหน — เปิดสคริปต์จากไฟล์ Overview (ส่วนขยาย ▸ Apps Script) หรือใส่ CONFIG.OVERVIEW_ID');
  const parents = DriveApp.getFileById(id).getParents();
  if (!parents.hasNext()) throw new Error('หาโฟลเดอร์ของไฟล์ Overview ไม่ได้ — ย้ายไฟล์ Overview เข้าโฟลเดอร์ที่บัญชีนี้เปิดได้ หรือใส่ CONFIG.ROOT_FOLDER_ID');
  return parents.next().getId();
}

function overviewFile_() {
  if (CONFIG.OVERVIEW_ID) return DriveApp.getFileById(CONFIG.OVERVIEW_ID);
  const bound = boundSheet_();
  if (bound) return DriveApp.getFileById(bound.getId());
  const it = DriveApp.getFolderById(rootId_()).getFiles();
  let best = null;
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed() || f.getName().indexOf(CONFIG.OVERVIEW_NAME) !== 0) continue;
    const isSheet = f.getMimeType() === MimeType.GOOGLE_SHEETS;
    const bestIsSheet = best && best.getMimeType() === MimeType.GOOGLE_SHEETS;
    // a Google Sheet wins over an .xlsx; otherwise the most recently edited one
    if (!best || (isSheet && !bestIsSheet) || (isSheet === bestIsSheet && f.getLastUpdated() > best.getLastUpdated())) best = f;
  }
  if (!best) throw new Error(`ไม่พบไฟล์ Overview (ชื่อขึ้นต้นด้วย "${CONFIG.OVERVIEW_NAME}") ในโฟลเดอร์หลัก`);
  return best;
}

function readTable_(overview, sheetName) {
  const sh = overview.getSheetByName(sheetName);
  if (!sh) throw new Error(`ไม่พบชีต "${sheetName}" ในไฟล์ Overview`);
  const values = sh.getDataRange().getValues();
  const head = values.shift().map(h => String(h).trim());
  return values.filter(r => String(r[0]).trim() !== '').map(r => {
    const row = {};
    head.forEach((h, i) => { row[h] = r[i]; });
    return row;
  });
}

function readStations_(overview) {
  const out = readTable_(overview, STATIONS).map(r => ({
    code: String(r['รหัส']).trim(),
    phase: r['ระยะ'],
    name: String(r['ชื่อสถานี'] || r['ชื่อสถานี (ใช้ในรายงาน)'] || '').trim(),
    kwp: r['กำลังติดตั้ง (kWp)'],
    contract: r['อายุสัญญา'],
    start: r['วันที่เริ่มให้บริการ'],
  }));
  const unnamed = out.filter(s => !s.name).map(s => s.code);
  if (unnamed.length) throw new Error(`สถานีไม่มีชื่อใน Overview: ${unnamed.join(', ')}`);
  return out.sort((x, y) => x.code.localeCompare(y.code));
}

/** { plant code: [{ no, sn, strings }] }, inverters in use only, in NO. order. */
function readInverters_(overview) {
  const out = {};
  readTable_(overview, INVERTERS).forEach(r => {
    if (String(r['ใช้งาน (Y/N)'] || 'Y').trim().toUpperCase() === 'N') return;
    const code = String(r['รหัส']).trim();
    (out[code] = out[code] || []).push({ no: r['NO.'], sn: String(r['Inverter S/N']).trim(), strings: r['จำนวนสตริง'] });
  });
  Object.keys(out).forEach(code => out[code].sort((x, y) => (Number(x.no) || 999) - (Number(y.no) || 999)));
  return out;
}

// ============================================================ 3) sync: Overview ⇄ plant files

/**
 * full = read every plant file. Otherwise only the files edited since the last complete sync are read,
 * unless the Overview's สถานี / Inverter sheets changed (then every file is read).
 */
function startSync_(ym, quiet, full) {
  checkYm_(ym);
  const props = PropertiesService.getScriptProperties();
  const cur = dropStaleJob_(props, props.getProperties());
  if (cur.job) {
    if (cur.job === 'sync' && cur.ym === ym) { kick_(); return; }   // the same sync: carry on where it stopped
    if (quiet) {                                        // a scheduled sync waits for the next slot
      if (!hasTrigger_('continueJob')) after_(NEXT_RUN_MS);         // ... and restarts a job whose runs stopped
      return;
    }
    throw new Error(`มีงานค้างอยู่ (${status()}) — รอให้เสร็จ หรือรัน cancelJob() ก่อน`);
  }
  const file = overviewFile_();
  if (file.getMimeType() !== MimeType.GOOGLE_SHEETS) {
    throw new Error('Overview ยังเป็นไฟล์ .xlsx — สคริปต์เขียนกลับไม่ได้ ให้รัน convertOverview() หนึ่งครั้งก่อน');
  }
  const folder = findMonthFolder_(ym);
  if (!folder) {
    if (quiet) return;
    throw new Error(`ยังไม่มีโฟลเดอร์เดือน ${ym} — สร้างไฟล์ของเดือนนั้นก่อน`);
  }
  props.setProperties({
    job: 'sync', ym: ym, idx: '0', folder: folder.getId(), ov: file.getId(), ovTemp: '',
    only: '', made: '0', skipped: '0', errors: '', warn: '', full: full ? '1' : '', same: '0',
    root: rootId_(),
  });
  kick_();
}

/** One run of the sync job; true when every plant is done. */
function syncBatch_(props, p, t0) {
  const overview = SpreadsheetApp.openById(p.ov);
  // dates are written as Bangkok days; in any other time zone the sheet would show the day before
  if (overview.getSpreadsheetTimeZone() !== 'Asia/Bangkok') overview.setSpreadsheetTimeZone('Asia/Bangkok');
  const stations = readStations_(overview);
  const inverters = readInverters_(overview);
  const files = folderFiles_(p.folder);                 // file name → { id, edited }
  const [y, m] = p.ym.split('-').map(Number);
  const lastDay = lastDayToRead_(p.ym);
  let i = Number(p.idx), made = Number(p.made), skipped = Number(p.skipped), same = Number(p.same || 0);
  const errors = p.errors ? p.errors.split(',') : [];
  const warnings = p.warn ? p.warn.split('\n') : [];
  const results = {}, invStatus = {};

  // First run of the job: decide which files need reading. A file not edited since the last complete
  // sync says what it said then, as long as the Overview's plants and inverters are the same too.
  let last = null;
  try { last = JSON.parse(props.getProperty(`synced_${p.ym}`) || 'null'); } catch (e) { last = null; }
  const otherFolder = !!(last && last.f !== p.folder);
  if (otherFolder) last = null;                          // the last sync was of another folder (CONFIG changed since)
  let since = Number(p.since || 0);
  if (!p.began) {
    const sig = signature_([stations, inverters]);
    since = !p.full && last && last.sig === sig && last.v === SYNC_VERSION ? Number(last.t) - SYNC_MARGIN_MS : 0;
    // why every file is read (shown in _log)
    const why = since ? '' : p.full ? 'สั่งอ่านทุกไฟล์' : otherFolder ? 'โฟลเดอร์เดือนเปลี่ยน'
      : !last ? 'ไม่มีบันทึกซิงก์ครั้งก่อน' : last.v !== SYNC_VERSION ? 'สคริปต์รุ่นใหม่' : 'แท็บสถานี/Inverter ใน Overview เปลี่ยน';
    p.sig = sig; p.began = String(t0); p.why = why;
    props.setProperties({ sig: sig, since: String(since), began: p.began, why: why });
  }
  const retry = since && last && last.err ? last.err : [];   // plants that could not be read last time
  // file → its edit time when it was last read: a file is read again only when that time changes, so one edit
  // is read once (a file with no time on record falls back to the margin rule above)
  const seen = readSeen_(props, p.ym) || {};

  while (i < stations.length && (Date.now() - t0) / 1000 < CONFIG.RUN_SECONDS) {
    const s = stations[i];
    const file = plantFile_(files, s, p.ym);
    const key = file && fileKey_(file.id), was = file && seen[key];
    if (!file) {
      skipped++;
    } else if (since > 0 && retry.indexOf(s.code) < 0 && (was !== undefined ? was === stamp_(file.edited) : file.edited < since)) {
      same++;
      seen[key] = stamp_(file.edited);
    } else {
      try {
        const r = syncPlant_(file.id, s, inverters[s.code] || [], y, m, lastDay);
        results[s.code] = r;
        Object.keys(r.invStatus).forEach(sn => { invStatus[sn] = r.invStatus[sn]; });
        r.warnings.forEach(w => warnings.push(w));
        made++;
        seen[key] = stamp_(file.edited);                 // the time listed before the read: an edit during it is read next time
      } catch (e) {
        console.error(`${s.code}: ${e}`);
        errors.push(s.code);
        delete seen[key];
      }
    }
    i++;
  }

  // The Overview is written before the position is saved: a run that is cut short repeats its batch.
  upsertIssues_(overview, y, m, results);
  writeInverterStatus_(overview, invStatus);
  props.setProperties({ idx: String(i), made: String(made), skipped: String(skipped), same: String(same),
    errors: errors.join(','), warn: warnings.join('\n').slice(0, 8000) });
  if (i >= stations.length) {
    // the end: files of no plant (notes, old copies) are taken as seen, files no longer there are dropped
    const plantIds = new Set();
    stations.forEach(st => { const f = plantFile_(files, st, p.ym); if (f) plantIds.add(f.id); });
    const kept = {};
    files.forEach(f => {
      const k = fileKey_(f.id);
      if (!plantIds.has(f.id)) kept[k] = stamp_(f.edited);
      else if (seen[k] !== undefined) kept[k] = seen[k];
    });
    saveSeen_(props, p.ym, kept);
    dropOldSeen_(props, p.ym);
  } else {
    saveSeen_(props, p.ym, seen);
  }

  if (i < stations.length) {
    console.log(`ซิงก์ ${p.ym}: ${i}/${stations.length} สถานี — ทำต่ออัตโนมัติ`);
    return false;
  }
  const summary = `ซิงก์ ${p.ym}: อ่าน ${made} สถานี` + (p.why ? ` (อ่านทุกไฟล์: ${p.why})` : '') +
    (same ? `, ไม่มีการแก้ไข ${same} สถานี (ไม่ต้องอ่าน)` : '') +
    (skipped ? `, ยังไม่มีไฟล์ ${skipped} สถานี` : '') +
    (errors.length ? `, อ่านไม่ได้ ${errors.length} สถานี (${errors.join(', ')}) — จะอ่านใหม่ในการซิงก์ครั้งถัดไป` : '');
  // a sync that found nothing new leaves no line in _log (an interval sync would fill it)
  finishSync_(overview, p.ym, stations, files, summary, warnings, made > 0 || errors.length > 0 || !!p.full);
  SpreadsheetApp.flush();                               // fin = after the last write to the Overview (nothingNew_)
  props.setProperty(`synced_${p.ym}`, JSON.stringify({ t: Number(p.began), sig: p.sig, err: errors, v: SYNC_VERSION,
    f: p.folder, ov: p.ov, root: p.root, fin: Date.now() }));
  note_(props, summary);
  console.log(summary + (warnings.length ? `\n${warnings.join('\n')}` : ''));
  return true;
}

/** seen_<ym>: file → edit time when last read, keyed by the end of the file id (short, to fit one property). */
function fileKey_(id) { return String(id).slice(-12); }
function stamp_(ms) { return Math.round(ms).toString(36); }
function readSeen_(props, ym) {
  try { return JSON.parse(props.getProperty(`seen_${ym}`) || 'null'); } catch (e) { return null; }
}
/** Removes seen_<ym> of months before last month (they are not synced on their own any more), except `keep`. */
function dropOldSeen_(props, keep) {
  const [y, m] = ym_(new Date()).split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  props.getKeys().forEach(k => {
    const ym = k.indexOf('seen_') === 0 ? k.slice(5) : '';
    if (ym && ym < prev && ym !== keep) props.deleteProperty(k);
  });
}
function saveSeen_(props, ym, seen) {
  const text = JSON.stringify(seen);
  if (text.length > SEEN_MAX_CHARS) props.deleteProperty(`seen_${ym}`);
  else props.setProperty(`seen_${ym}`, text);
}

/** Day sheets to read: up to today for the current month, the whole month for a past one, none for a future one. */
function lastDayToRead_(ym) {
  const now = new Date(), cur = ym_(now);
  if (ym > cur) return 0;
  if (ym === cur) return Number(Utilities.formatDate(now, 'Asia/Bangkok', 'd'));
  const [y, m] = ym.split('-').map(Number);
  return daysIn_(y, m);
}

/**
 * One plant file: one read (info sheet + the day sheets), the info sheet rewritten when it differs from
 * the Overview, and what the day sheets say: the problems and each inverter's newest status.
 */
function syncPlant_(id, s, invs, y, m, lastDay) {
  const ranges = [`'${INFO}'!A1:C${INFO_INV0 + 60}`, `'${SUMMARY}'!A3:A4`];
  for (let d = 1; d <= Math.max(lastDay, 1); d++) ranges.push(`'วันที่ ${d}'!A1:N200`);
  const got = retry_(() => Sheets.Spreadsheets.Values.batchGet(id, { ranges: ranges, valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER' })).valueRanges;
  const info = got[0].values || [];
  const days = [];
  for (let d = 2; d < got.length; d++) days.push(parseDay_(got[d].values || [], `${s.code} วันที่ ${d - 1}`));
  const warnings = [];

  // a file made before the line under the title read "กำลังการผลิต …" gets the current formula
  const subtitle = String(((got[1].values || [[]])[0] || [])[0] || '');
  if (subtitle.indexOf('กำลังการผลิต') !== 0) {
    retry_(() => Sheets.Spreadsheets.Values.update({ values: [[SUMMARY_SUBTITLE]] }, id, `'${SUMMARY}'!A3`, { valueInputOption: 'USER_ENTERED' }));
  }

  // ... and a file made before the "open today's sheet" link gets it under that line
  let meta = null;
  const sheetIds = () => {
    if (!meta) {
      meta = {};
      retry_(() => Sheets.Spreadsheets.get(id, { fields: 'sheets.properties(sheetId,title)' })).sheets
        .forEach(x => { meta[x.properties.title] = x.properties.sheetId; });
    }
    return meta;
  };
  if (String(((got[1].values || [])[1] || [])[0] || '') === '') {
    const cell = { sheetId: sheetIds()[SUMMARY], startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0 };
    retry_(() => Sheets.Spreadsheets.batchUpdate({ requests: [
      { mergeCells: { range: Object.assign({ endColumnIndex: 9 }, cell), mergeType: 'MERGE_ALL' } },
      { repeatCell: { range: Object.assign({ endColumnIndex: 1 }, cell),
        cell: { userEnteredValue: { formulaValue: todayLink_(y, m, daysIn_(y, m)) },
          userEnteredFormat: { horizontalAlignment: 'CENTER', textFormat: { bold: true, foregroundColor: { red: 0.02, green: 0.39, blue: 0.76 } } } },
        fields: 'userEnteredValue,userEnteredFormat.horizontalAlignment,userEnteredFormat.textFormat.bold,userEnteredFormat.textFormat.foregroundColor' } },
    ] }, id));
  }

  // Overview ─► plant file
  const rows = days[0].length;                          // inverter rows this file was built with
  if (invs.length > rows) {
    warnings.push(`${s.code}: Overview มี Inverter ใช้งาน ${invs.length} ตัว แต่ไฟล์มี ${rows} แถว — ลบไฟล์ของสถานีนี้แล้วสร้างใหม่`);
  }
  // A file of an older template: every day sheet gets the วันเข้าแก้ไข column (J, until then the second
  // half of การแก้ไข), and วันเข้าแก้ไข / วันแล้วเสร็จ of สรุปเดือน become formulas over the day sheets.
  if (Number((info[6] || [])[1] || 1) < TEMPLATE_VERSION) {
    const nDays = daysIn_(y, m), L = layout_(rows), ids = sheetIds();
    const requests = [{ repeatCell: {
      range: { sheetId: ids[SUMMARY], startRowIndex: 5, endRowIndex: 5 + nDays, startColumnIndex: 6, endColumnIndex: 8 },
      cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } } },
      fields: 'userEnteredFormat.backgroundColor' } }];
    for (let d = 1; d <= nDays; d++) {
      const sid = ids[`วันที่ ${d}`];
      if (sid === undefined) continue;
      const col = { sheetId: sid, startRowIndex: L.issue0 - 1, endRowIndex: L.issue1, startColumnIndex: 9, endColumnIndex: 10 };
      requests.push(
        { unmergeCells: { range: { sheetId: sid, startRowIndex: L.issueHead - 1, endRowIndex: L.issue1, startColumnIndex: 8, endColumnIndex: 10 } } },
        { updateCells: { start: { sheetId: sid, rowIndex: L.issueHead - 1, columnIndex: 9 },
          rows: [{ values: [{ userEnteredValue: { stringValue: 'วันเข้าแก้ไข' } }] }], fields: 'userEnteredValue' } },
        { repeatCell: { range: col,
          cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' }, horizontalAlignment: 'CENTER' } },
          fields: 'userEnteredFormat.numberFormat,userEnteredFormat.horizontalAlignment' } },
        { setDataValidation: { range: col, rule: { condition: { type: 'DATE_IS_VALID' }, strict: false } } });
    }
    retry_(() => Sheets.Spreadsheets.batchUpdate({ requests: requests }, id));
    retry_(() => Sheets.Spreadsheets.Values.batchUpdate({ valueInputOption: 'USER_ENTERED', data: [
      { range: `'${SUMMARY}'!G6:H${5 + nDays}`, values: summaryDates_(nDays, rows) },
      { range: `'${INFO}'!A7:B7`, values: [['รุ่นแม่แบบ', TEMPLATE_VERSION]] },
    ] }, id));
  }
  const wantInfo = infoValues_(s), wantInv = inverterValues_(invs, rows);
  const text = v => (v === undefined || v === null ? '' : String(v));
  const at = (r, c) => text((info[r - 1] || [])[c - 1]);
  const same = wantInfo.every((row, k) => at(k + 1, 2) === text(row[0])) &&
    wantInv.every((row, k) => row.every((v, c) => at(INFO_INV0 + k, c + 1) === text(v)));
  if (!same) writeInfo_(id, wantInfo, wantInv);

  // plant file ─► Overview
  const out = { station: s, episodes: [], invStatus: {}, warnings: warnings, updated: !same };
  if (lastDay < 1) return out;
  const date = d => new Date(y, m - 1, d);
  const checkedDays = [];
  const open = {};                                      // S/N → the problem that is still running
  for (let d = 1; d <= lastDay; d++) {
    const dayRows = days[d - 1].filter(r => r.sn && r.checked);
    if (!dayRows.length) continue;
    checkedDays.push(d);
    dayRows.forEach(r => {
      if (r.invStatus) out.invStatus[r.sn] = { status: r.invStatus, date: date(d) };
      let ep = open[r.sn];
      if (!r.problem) {                                 // seen normal: the problem is over
        if (ep) { ep.ended = true; delete open[r.sn]; }
        return;
      }
      if (!ep) {
        ep = open[r.sn] = { sn: r.sn, startDay: d, start: date(d), ended: false, fix: '', enter: '', status: '', owner: '', done: '' };
        out.episodes.push(ep);
      }
      ep.lastDay = d;
      ep.strings = r.strings;
      ep.detail = r.detail;
      ['fix', 'enter', 'status', 'owner', 'done'].forEach(k => { if (r[k] !== '') ep[k] = r[k]; });   // newest typed value wins
    });
  }
  if (!out.episodes.length) return out;

  const gids = sheetIds();
  out.episodes.forEach(ep => {
    ep.fromFirstDay = ep.startDay === checkedDays[0];   // may continue a problem of the month before
    ep.link = `=HYPERLINK("https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gids[`วันที่ ${ep.lastDay}`]}","เปิด")`;
    ['enter', 'done'].forEach(k => { ep[k] = typedDate_(ep[k]); });
  });
  return out;
}

/** The inverter rows of one day sheet (as read by the Sheets API), each with its row of รายงานการแก้ไข. */
function parseDay_(values, where) {
  const cell = (r, c) => {
    const v = (values[r - 1] || [])[c - 1];
    return v === undefined || v === null ? '' : v;
  };
  let total = DAY_INV0;
  while (total <= values.length && cell(total, 3) !== 'รวม') total++;
  let head = total + 1;
  while (head <= values.length && cell(head, 3) !== 'ลำดับ') head++;
  if (total > values.length || head > values.length) throw new Error(`${where}: ไม่พบตาราง Inverter / รายงานการแก้ไข (รูปแบบหน้าไม่ตรง)`);
  const out = [];
  for (let r = DAY_INV0; r < total; r++) {
    const x = head + 1 + (r - DAY_INV0);
    const abnormal = cell(r, 7), status = String(cell(r, 10)).trim();
    out.push({
      sn: String(cell(r, 4)).trim(),
      checked: typeof abnormal === 'number' || status !== '',
      problem: (typeof abnormal === 'number' && abnormal > 0) || PROBLEM_STATUSES.indexOf(status) >= 0,
      strings: String(cell(r, 8)).trim(),
      invStatus: status,                                // Inverter Status, typed in the inverter table
      detail: String(cell(r, 11)).trim(),
      fix: String(cell(x, 9)).trim(),                   // the rest is typed in รายงานการแก้ไข
      enter: typeof cell(x, 10) === 'number' ? cell(x, 10) : String(cell(x, 10)).trim(),
      status: String(cell(x, 11)).trim(),
      owner: String(cell(x, 12)).trim(),
      done: typeof cell(x, 13) === 'number' ? cell(x, 13) : String(cell(x, 13)).trim(),
    });
  }
  return out;
}

/** The Overview's "รายงานการแก้ไข" table: sheet, header row and the column number of each header. */
function issueTable_(overview) {
  const sh = overview.getSheetByName(ISSUES);
  if (!sh) throw new Error(`ไม่พบชีต "${ISSUES}" ในไฟล์ Overview`);
  const width = sh.getLastColumn();
  const top = sh.getRange(1, 1, Math.min(20, sh.getMaxRows()), width).getValues();
  const headRow = top.findIndex(r => r.some(v => String(v).trim() === 'รหัสปัญหา')) + 1;
  if (!headRow) throw new Error(`ไม่พบหัวตาราง "รหัสปัญหา" ในชีต "${ISSUES}"`);
  const head = top[headRow - 1].map(h => String(h).trim());
  const col = {};
  head.forEach((h, k) => { if (h) col[h] = k + 1; });
  ['วันที่พบ', 'สถานะ'].forEach(h => { if (!col[h]) throw new Error(`ชีต "${ISSUES}" ไม่มีคอลัมน์ "${h}"`); });
  return { sh: sh, headRow: headRow, head: head, col: col, width: width, top: top };
}

/**
 * Rewrites the rows of the scanned plants in the Overview's problem table (key: plant | S/N | first day).
 * Rows of other plants and of earlier months are kept as they are.
 */
function upsertIssues_(overview, y, m, results) {
  const codes = Object.keys(results);
  if (!codes.length) return;
  const t = issueTable_(overview), sh = t.sh;
  const n = Math.max(sh.getLastRow() - t.headRow, 0);
  let rows = [], current = [];                          // current = the table as it is now: formula, else value
  if (n) {
    const range = sh.getRange(t.headRow + 1, 1, n, t.width);
    const values = range.getValues(), formulas = range.getFormulas();
    current = values.map((r, i) => r.map((v, k) => formulas[i][k] || v));
    rows = current.map(r => {
      const row = {};
      t.head.forEach((h, k) => { if (h) row[h] = r[k]; });
      return row;
    }).filter(row => String(row['รหัสปัญหา'] || '').trim() !== '');
    rows.forEach(row => ISSUE_DATES.forEach(h => { if (row[h] !== undefined) row[h] = typedDate_(row[h]); }));
  }
  const monthStart = new Date(y, m - 1, 1), monthEnd = new Date(y, m, 1);
  const inMonth = v => v instanceof Date && v >= monthStart && v < monthEnd;
  const ymd = d => Utilities.formatDate(d, 'Asia/Bangkok', 'yyyyMMdd');

  const kept = [], byCode = {};                         // rows of other plants are kept; the scanned plants' rows by code
  codes.forEach(code => { byCode[code] = []; });
  rows.forEach(row => {
    const code = String(row['รหัสปัญหา']).split('|')[0];
    (Object.prototype.hasOwnProperty.call(byCode, code) ? byCode[code] : kept).push(row);
  });
  codes.forEach(code => {
    const res = results[code], s = res.station;
    const mine = byCode[code];
    const used = [];
    res.episodes.forEach(ep => {
      const key = `${code}|${ep.sn}|${ymd(ep.start)}`;
      let row = mine.find(r => r['รหัสปัญหา'] === key);
      if (!row && ep.fromFirstDay) {                    // still there from the month before: same row goes on
        row = mine.find(r => String(r['รหัสปัญหา']).split('|')[1] === ep.sn && r['วันที่พบ'] instanceof Date &&
          r['วันที่พบ'] < monthStart && DONE_STATUSES.indexOf(String(r['สถานะ'])) < 0);
      }
      if (!row) row = { 'รหัสปัญหา': key };
      if (row['รหัสปัญหา'] === key) row['วันที่พบ'] = ep.start;      // a row continued from an earlier month keeps its day
      used.push(row);
      Object.assign(row, {
        'ระยะ': s.phase, 'สถานี': s.name, 'Inverter S/N': ep.sn,
        'รายละเอียดปัญหา': (ep.strings ? `String ${ep.strings}: ` : '') + ep.detail,
        'สถานะ': ep.status || STATUSES[0], 'ผู้รับผิดชอบ': ep.owner,
        'การแก้ไข / หมายเหตุ': ep.fix, 'วันเข้าแก้ไข': ep.enter, 'วันที่แก้ไขเสร็จ': ep.done, 'รายงาน': ep.link,
      });
    });
    // a row of this month that the day sheets no longer show was typed by mistake and then cleared
    mine.forEach(row => { if (used.indexOf(row) < 0 && !inMonth(row['วันที่พบ'])) used.push(row); });
    used.forEach(row => kept.push(row));
  });

  const time = v => (v instanceof Date ? v.getTime() : 0);
  kept.sort((p, q) => time(p['วันที่พบ']) - time(q['วันที่พบ']) || String(p['รหัสปัญหา']).localeCompare(String(q['รหัสปัญหา'])));
  const openSeen = {};
  const out = kept.map((row, k) => {
    const code = String(row['รหัสปัญหา']).split('|')[0];
    const isOpen = DONE_STATUSES.indexOf(String(row['สถานะ'])) < 0;
    row['No.'] = k + 1;
    row['_open_station'] = isOpen && !openSeen[code] ? 1 : 0;      // 1 on one open row per plant
    if (isOpen) openSeen[code] = true;
    return t.head.map(h => {
      const v = h && row[h] !== undefined && row[h] !== null ? row[h] : '';
      return v instanceof Date ? beText_(v) : v;         // every date of this table is shown as พ.ศ.
    });
  });

  // nothing differs (the usual case when the edit was not about a problem): the Overview is not written
  if (out.length === n && out.every((row, i) => row.every((v, k) => v === current[i][k]))) return;
  // The new rows are written over the old ones and only the rows left below are cleared: a run that is
  // stopped half-way never leaves the table empty (columns typed by hand could not be brought back).
  if (out.length) {
    ensureSize_(sh, t.headRow + out.length, t.width);
    // text format first: written into a date cell, "16/11/2569" would turn into a date of the year 2569
    ISSUE_DATES.forEach(h => {
      if (t.col[h]) sh.getRange(t.headRow + 1, t.col[h], out.length, 1).setNumberFormat('@');
    });
    sh.getRange(t.headRow + 1, 1, out.length, t.width).setValues(out);
  }
  if (n > out.length) sh.getRange(t.headRow + 1 + out.length, 1, n - out.length, t.width).clearContent();
}

/** Overview "Inverter": the newest Inverter Status typed in the day sheets, and its day. */
function writeInverterStatus_(overview, invStatus) {
  if (!Object.keys(invStatus).length) return;
  const sh = overview.getSheetByName(INVERTERS);
  let head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  ['Inverter Status', 'สถานะ ณ วันที่'].forEach(h => {
    if (head.indexOf(h) >= 0) return;
    ensureSize_(sh, 1, head.length + 1);
    sh.getRange(1, head.length + 1).setValue(h).setFontWeight('bold');
    head.push(h);
  });
  const snCol = head.indexOf('Inverter S/N') + 1, stCol = head.indexOf('Inverter Status') + 1, dayCol = head.indexOf('สถานะ ณ วันที่') + 1;
  const n = sh.getLastRow() - 1;
  if (!snCol || n < 1) return;
  const sns = sh.getRange(2, snCol, n, 1).getValues();
  const st = sh.getRange(2, stCol, n, 1).getValues(), day = sh.getRange(2, dayCol, n, 1).getValues();
  let stChanged = false, dayChanged = false;
  sns.forEach((r, k) => {
    const v = invStatus[String(r[0]).trim()];
    let d = v ? v.date : day[k][0];
    if (d instanceof Date) d = beText_(typedDate_(d));   // shown as พ.ศ., like the problem table
    if (v && v.status !== st[k][0]) { st[k][0] = v.status; stChanged = true; }
    if (d !== day[k][0]) { day[k][0] = d; dayChanged = true; }
  });
  if (stChanged) sh.getRange(2, stCol, n, 1).setValues(st);
  if (dayChanged) sh.getRange(2, dayCol, n, 1).setNumberFormat('@').setValues(day);
}

/** After the last plant: summary boxes, "as of" line, the link columns of "สถานี", one line in "_log". */
function finishSync_(overview, ym, stations, files, summary, warnings, logIt) {
  const t = issueTable_(overview), sh = t.sh, r0 = t.headRow + 1;
  const col = h => (t.col[h] ? `$${letter_(t.col[h])}$${r0}:$${letter_(t.col[h])}` : null);
  const key = col('รหัสปัญหา'), st = col('สถานะ'), found = col('วันที่พบ'), open = col('_open_station');
  const done = DONE_STATUSES.map(v => `COUNTIF(${st},"${v}")`).join('+');
  const boxes = [
    ['ปัญหาทั้งหมด', `=COUNTA(${key})`],
    ['พบวันนี้', `=COUNTIF(${found},TEXT(TODAY(),"dd/mm/")&(YEAR(TODAY())+543))`],                     // problems first seen today
    ['ปัญหาที่คงค้าง', `=COUNTA(${key})-(${done})`],
    ['จำนวนสถานี', open && `=SUM(${open})`],
    ['กำลังแก้ไข', `=COUNTIF(${st},"กำลังแก้ไข")`],
    ['แก้ไขแล้วเสร็จ', `=${done}`],
  ];
  const norm = v => String(v).replace(/เเ/g, 'แ').trim();          // the sheet spells some labels with "เเ"
  for (let r = 0; r < t.headRow - 1; r++) {
    t.top[r].forEach((v, c) => {
      const box = boxes.find(b => b[0] === norm(v));
      if (box && box[1]) sh.getRange(r + 2, c + 1).setFormula(box[1]);   // the number sits under its label
    });
  }
  const now = new Date();
  const [yy, mm, dd, hm] = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-M-d-HH:mm').split('-');
  sh.getRange('A2').setValue(`ข้อมูล ณ วันที่ ${dd} ${TH_MONTH[Number(mm)]} พ.ศ.${Number(yy) + 543} เวลา ${hm} น.`);

  // สถานี: counts are formulas over "Inverter"; ไฟล์รายงาน links this month's file
  const ss = overview.getSheetByName(STATIONS), is = overview.getSheetByName(INVERTERS);
  const sHead = ss.getRange(1, 1, 1, ss.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const iHead = is.getRange(1, 1, 1, is.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const iCol = h => { const k = iHead.indexOf(h) + 1; return k ? `${INVERTERS}!$${letter_(k)}:$${letter_(k)}` : null; };
  const code = iCol('รหัส'), used = iCol('ใช้งาน (Y/N)'), strings = iCol('จำนวนสตริง');
  const n = ss.getLastRow() - 1;
  if (n > 0) {
    const codes = ss.getRange(2, 1, n, 1).getValues().map(r => String(r[0]).trim());
    const byCode = {};
    stations.forEach(s => { byCode[s.code] = s; });
    const all = ss.getRange(2, 1, n, sHead.length);
    const values = all.getValues(), formulas = all.getFormulas();
    const put = (h, make) => {                          // a column is written only when it differs (no recalculation otherwise)
      const k = sHead.indexOf(h) + 1;
      if (!k) return;
      const want = codes.map((c, i) => [c ? make(c, i + 2) : '']);
      if (want.some((w, i) => w[0] !== (formulas[i][k - 1] || values[i][k - 1]))) ss.getRange(2, k, n, 1).setValues(want);
    };
    if (code && used) put('จำนวน Inverter', (c, r) => `=COUNTIFS(${code},$A${r},${used},"<>N")`);
    if (code && used && strings) put('จำนวนสตริงรวม', (c, r) => `=SUMIFS(${strings},${code},$A${r},${used},"<>N")`);
    put('ไฟล์รายงาน', c => {
      const file = byCode[c] && plantFile_(files, byCode[c], ym);
      return file ? `=HYPERLINK("https://docs.google.com/spreadsheets/d/${file.id}/edit","${ym}")` : '';
    });
  }

  const log = overview.getSheetByName(LOG) || overview.insertSheet(LOG);
  const stamp = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-MM-dd HH:mm');
  const lines = (logIt ? [[stamp, summary]] : []).concat(warnings.map(w => [stamp, w]));
  if (lines.length) {                                   // one write, however many warnings
    const r = log.getLastRow() + 1;
    ensureSize_(log, r + lines.length - 1, 2);
    log.getRange(r, 1, lines.length, 2).setValues(lines);
    const extra = log.getLastRow() - 1 - LOG_KEEP_ROWS;   // row 1 is the header
    if (extra > 0) log.deleteRows(2, extra);
  }
}

// ============================================================ helpers

/**
 * Runs a Sheets API call again after a pause when Google answers "too many requests" or a passing
 * server error (the API allows about 60 reads a minute), instead of giving the plant up.
 */
function retry_(call) {
  for (let k = 0; ; k++) {
    try {
      return call();
    } catch (e) {
      const msg = String(e && e.message || e);
      if (k >= 4 || !/quota|rate limit|too many|429|50[0234]|internal error|unavailable|timed out|try again/i.test(msg)) throw e;
      console.warn(`รอแล้วลองใหม่ (ครั้งที่ ${k + 1}): ${msg}`);
      Utilities.sleep(5000 * Math.pow(2, k));           // 5, 10, 20, 40 s
    }
  }
}

/** A short fingerprint of a value: the same value always gives the same text. */
function signature_(value) {
  const text = JSON.stringify(value);
  let h = 5381;
  for (let k = 0; k < text.length; k++) h = ((h * 33) ^ text.charCodeAt(k)) >>> 0;
  return `${text.length}.${h}`;
}

function checkYm_(ym) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym))) throw new Error(`เดือนต้องเป็นรูปแบบ yyyy-MM เช่น 2026-12 (ได้รับ: ${ym})`);
}

/** Days in month m (1-12) of year y. */
function daysIn_(y, m) { return new Date(y, m, 0).getDate(); }

function ym_(d) { return Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM'); }

function nextYm_() {
  const [y, m] = ym_(new Date()).split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * A date typed in a day sheet (วันเข้าแก้ไข, วันที่แก้ไขเสร็จ) as a real A.D. date for the Overview. The year
 * may be typed as พ.ศ. (2400 or more) or ค.ศ.; anything that is not a date is returned as typed.
 */
function typedDate_(v) {
  let y, m, d;
  if (v instanceof Date) {
    y = v.getFullYear(); m = v.getMonth() + 1; d = v.getDate();
  } else if (typeof v === 'number') {                          // a date cell, as the Sheets API reads it (serial number)
    const x = new Date(1899, 11, 30 + Math.floor(v));
    y = x.getFullYear(); m = x.getMonth() + 1; d = x.getDate();
  } else {                                              // text, e.g. 29/02/2571 (no such day in the A.D. year 2571)
    const t = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(String(v === null || v === undefined ? '' : v).trim());
    if (!t) return v;
    d = Number(t[1]); m = Number(t[2]); y = Number(t[3]);
  }
  if (y >= 2400) y -= 543;                              // typed as a Buddhist year
  const out = new Date(y, m - 1, d);
  return out.getMonth() === m - 1 && out.getDate() === d ? out : v;   // not a real day: kept as typed
}

/** A real date as the text the Overview shows: dd/mm/พ.ศ., e.g. 16/11/2569. */
function beText_(d) {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear() + 543}`;
}

/**
 * "01 เมษายน พ.ศ. 2568" from the Overview's วันที่เริ่มให้บริการ, which is typed as a Buddhist-year date
 * dd/mm/yyyy (text, e.g. 01/04/2568). A real date cell also works: a year below 2400 is read as A.D.
 */
function thDate_(v) {
  const long = (d, m, y) => `${String(d).padStart(2, '0')} ${TH_MONTH[m]} พ.ศ. ${y < 2400 ? y + 543 : y}`;
  if (v instanceof Date) return long(v.getDate(), v.getMonth() + 1, v.getFullYear());
  const text = v === null || v === undefined ? '' : String(v).trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return long(Number(m[1]), Number(m[2]), Number(m[3]));
  return text || '-';
}

function dropdown_(list) {
  return SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(true).build();
}

function rule_(range, configure) {
  return configure(SpreadsheetApp.newConditionalFormatRule().setRanges([range])).build();
}

function box_(range) {
  range.setBorder(true, true, true, true, true, true, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  range.setBorder(true, true, true, true, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
}

/** Drops the unused rows and columns of a new sheet (a file holds about 30 of them). */
function trimSheet_(sh, rows, cols) {
  if (sh.getMaxRows() > rows) sh.deleteRows(rows + 1, sh.getMaxRows() - rows);
  if (sh.getMaxColumns() > cols) sh.deleteColumns(cols + 1, sh.getMaxColumns() - cols);
}

/** Adds rows / columns when a write would go past the sheet's grid. */
function ensureSize_(sh, rows, cols) {
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
}

/** Column number → letter(s): 1 → A, 27 → AA. */
function letter_(n) {
  let out = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out;
  return out;
}

function clearTriggers_(fn) {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === fn).forEach(t => ScriptApp.deleteTrigger(t));
}
