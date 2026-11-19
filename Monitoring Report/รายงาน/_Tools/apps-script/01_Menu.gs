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
    .addItem('ลบโลโก้ออกจากไฟล์เดือนนี้และเดือนหน้า', 'removeLogos')
    .addSeparator()
    .addItem('ย้ายปัญหาที่ปิดแล้วของปีเก่าไปไฟล์เก็บ…', 'menuArchive')
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
function menuArchive() {
  const ui = SpreadsheetApp.getUi(), be = new Date().getFullYear() + 543 - 1;
  const r = ui.prompt('String Check — ย้ายปัญหาไปไฟล์เก็บ',
    `ปี พ.ศ. ที่จะย้าย (เช่น ${be})\nย้ายเฉพาะปัญหาที่สถานะ ${DONE_STATUSES.join(' / ')} และพบในปีนั้น ไปไว้ในไฟล์ "${ARCHIVE_PREFIX}<ปี>"\n` +
    'ปัญหาที่ยังไม่ปิดอยู่ที่เดิม', ui.ButtonSet.OK_CANCEL);
  const typed = r.getResponseText().trim();
  if (r.getSelectedButton() !== ui.Button.OK || typed === '') return;
  let msg;
  try { msg = archiveYear(Number(typed)); } catch (e) { msg = `ย้ายไม่ได้: ${e.message || e}`; }
  ui.alert('String Check', msg, ui.ButtonSet.OK);
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
