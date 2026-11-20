// ------------------------------------------------------------------ menu

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('PWA Report')
    .addItem('ดึงข้อมูลตอนนี้', 'fillNow')
    .addItem('ดึงข้อมูลวันนี้ (เลือกรอบ)…', 'fillPickChecks')
    .addItem('ดึงข้อมูลย้อนหลัง…', 'fillAskDay')
    .addItem('ดึงใหม่และเขียนทับ…', 'refillOverwrite')
    .addSeparator()
    .addItem('ไปที่แท็บวันนี้', 'goToday')
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
  try { activateToday_(); } catch (e) { console.log('เปิดแท็บวันนี้ไม่สำเร็จ: ' + errText_(e)); }
}

/** Makes today's DD.MM tab the active sheet. Returns its name, or '' when the tab does not exist yet. */
function activateToday_() {
  const ss = SpreadsheetApp.getActive(), name = sheetName_(today_());
  const sh = ss.getSheetByName(name);
  if (!sh) return '';
  ss.setActiveSheet(sh);
  return name;
}

/** Menu: show today's tab. */
function goToday() {
  menu_(() => (activateToday_() ? '' : `ยังไม่มีแท็บ ${sheetName_(today_())}\nใช้เมนู PWA Report → สร้างแท็บวันนี้`));
}

/** Runs a menu action: shows the text it returns, and any error, as a Thai dialog. */
function menu_(fn) {
  const ui = SpreadsheetApp.getUi();
  try {
    const msg = fn(ui);
    if (msg) ui.alert(msg);
  } catch (e) {
    ui.alert('เกิดข้อผิดพลาด\n\n' + errText_(e));
  }
}

/** The message of anything thrown. */
function errText_(e) { return e && e.message ? e.message : String(e); }

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
  const hours = passedHours_(hm, times);
  let msg;
  try {
    msg = hours.length ? fillDay(today_(), hours).msg
      : `ยังไม่ถึงเวลาดึงรอบแรก (${times[0]})\nถ้าต้องการดึงเลย ใช้เมนู ดึงข้อมูลวันนี้ (เลือกรอบ)…`;
  } catch (e) { msg = 'เกิดข้อผิดพลาด\n\n' + errText_(e); }
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
