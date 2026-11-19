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
