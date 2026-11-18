/**
 * String Check – Solar Rooftop กปภ. (Google Apps Script)
 *
 * ทำอะไร
 *  - ทุกเดือน: สร้างโฟลเดอร์ YYYY-MM ในโฟลเดอร์หลัก + Google Sheet ของทุกสถานี (233)
 *    แต่ละไฟล์มีหน้า "สรุปเดือน" + "วันที่ 1" … "วันที่ 30/31" (ฟอร์ม String Check)
 *  - ทุกเช้า: อัปเดตชื่อสถานี/kWp/Inverter/จำนวนสตริงในไฟล์เดือนปัจจุบันจาก Overview
 *
 * ใช้งาน
 *  1) รัน setup() ครั้งเดียว (กดอนุญาต) → ตั้งเวลาอัตโนมัติ
 *  2) สร้างเดือนนี้ทันที: รัน createThisMonth()  (ทำเป็นชุด ๆ ละ ~4 นาทีจนครบเอง)
 *  3) ดูความคืบหน้า: รัน status()
 */

const CONFIG = {
  ROOT_FOLDER_ID: '1ReoBcxIHLE_7RAjEjJCGfnNHT7K8iZas',          // โฟลเดอร์ "Solar Rooftop กปภ. – รายงาน String Check"
  OVERVIEW_ID: '1LxeaCAHQPjG5A07wODV6St9OIEAy9qtTWHbMnoqzylQ',   // Google Sheet 00_Overview_รายงานการแก้ไข
  CREATE_ON_DAY: 25,     // สร้างไฟล์ของเดือนถัดไปล่วงหน้าทุกวันที่ 25
  MAX_INV: 17,           // แถว Inverter สูงสุดต่อหน้า (แถวที่ไม่ใช้จะถูกซ่อน)
  ISSUE_ROWS: 15,        // แถวรายงานการแก้ไข
  RUN_SECONDS: 270,      // ทำงานต่อรอบ (Apps Script จำกัด 6 นาที)
  FONT: 'Sarabun',
};

const TH_MONTH = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const PROJECT = 'โครงการจัดการพลังงานไฟฟ้าจากระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ที่ติดตั้งบนหลังคา (Solar Rooftop)';
const STATUSES = ['รอดำเนินการ', 'กำลังแก้ไข', 'แก้ไขแล้ว', 'ปิดงาน'];
const CHECKS = ['ยืนยันมีปัญหา', 'ปกติ (แจ้งเตือนผิด)', 'เงา/เมฆ/สภาพอากาศ', 'รอเข้าพื้นที่'];
const C = { BLUE: '#B4C6E7', GREY: '#EDEDED', ORANGE: '#F7CAAC', RED: '#F8CBAD', YEL: '#FFEB9C', GRN: '#C6EFCE', FILL: '#FFF9E5', FILLH: '#FFD966' };
const INFO = '_ข้อมูลสถานี';
// ตำแหน่งในหน้า "วันที่ X"
const R = { INV0: 15, TOTAL: 15 + 17, ISSUE_HEAD: 34, ISSUE0: 36 };
R.ISSUE_END = R.ISSUE0 + 15 - 1;
R.SIGN = R.ISSUE_END + 3;

// ============================================================ เมนู / ตั้งค่า
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('String Check')
      .addItem('สร้างไฟล์เดือนนี้', 'createThisMonth')
      .addItem('สร้างไฟล์เดือนหน้า', 'createNextMonth')
      .addItem('อัปเดตข้อมูลสถานีจาก Overview', 'refreshInfoJob')
      .addItem('ดูความคืบหน้า', 'status')
      .addToUi();
  } catch (e) { /* standalone script */ }
}

function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('monthlyJob').timeBased().onMonthDay(CONFIG.CREATE_ON_DAY).atHour(1).create();
  ScriptApp.newTrigger('refreshInfoJob').timeBased().everyDays(1).atHour(6).create();
  Logger.log('ตั้งเวลาแล้ว: สร้างเดือนถัดไปทุกวันที่ %s เวลา 01:00 · อัปเดตข้อมูลสถานีทุกวัน 06:00', CONFIG.CREATE_ON_DAY);
}

function createThisMonth() { startCreate_(ym_(new Date())); }
function createNextMonth() { const d = new Date(); startCreate_(ym_(new Date(d.getFullYear(), d.getMonth() + 1, 1))); }
function monthlyJob() { createNextMonth(); }
function createMonth(ym) { startCreate_(ym); }       // เช่น createMonth('2026-12')

function status() {
  const p = PropertiesService.getScriptProperties().getProperties();
  const msg = p.job ? `กำลังทำ: ${p.job} ${p.ym} · ${p.idx}/${p.total} สถานี` : 'ไม่มีงานค้าง';
  Logger.log(msg);
  try { SpreadsheetApp.getActive().toast(msg, 'String Check'); } catch (e) {}
  return msg;
}

// ============================================================ งานสร้างไฟล์รายเดือน (ทำเป็นชุดต่อเนื่อง)
function startCreate_(ym) {
  const folder = monthFolder_(ym);
  const tpl = buildTemplate_(ym, folder);
  const stations = readStations_();
  PropertiesService.getScriptProperties().setProperties({
    job: 'create', ym: ym, idx: '0', total: String(stations.length), tpl: tpl.getId(), folder: folder.getId(),
  });
  continueJob();
}

function continueJob() {
  clearOneOff_('continueJob');
  const props = PropertiesService.getScriptProperties();
  const p = props.getProperties();
  if (p.job !== 'create' && p.job !== 'refresh') return;
  const t0 = Date.now();
  const stations = readStations_();
  const invs = readInverters_();
  const folder = DriveApp.getFolderById(p.folder);
  let i = Number(p.idx);
  while (i < stations.length && (Date.now() - t0) / 1000 < CONFIG.RUN_SECONDS) {
    const s = stations[i];
    try {
      const name = fileName_(s, p.ym);
      let file = findFile_(folder, name);
      if (p.job === 'create' && !file) file = DriveApp.getFileById(p.tpl).makeCopy(name, folder);
      if (file) fillStation_(SpreadsheetApp.openById(file.getId()), s, invs[s.code] || [], p.ym);
    } catch (e) {
      console.error(`${s.code}: ${e}`);
    }
    i++;
    props.setProperty('idx', String(i));
  }
  if (i < stations.length) {
    ScriptApp.newTrigger('continueJob').timeBased().after(60 * 1000).create();   // ทำชุดต่อไปอีก 1 นาที
  } else {
    if (p.job === 'create') DriveApp.getFileById(p.tpl).setTrashed(true);
    props.deleteAllProperties();
    console.log(`เสร็จ ${p.job} ${p.ym}: ${stations.length} สถานี`);
  }
}

// อัปเดตข้อมูลสถานี (ชื่อ, kWp, Inverter) ของไฟล์เดือนปัจจุบันจาก Overview
function refreshInfoJob() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('job')) return;                     // มีงานสร้างค้างอยู่
  const ym = ym_(new Date());
  const it = DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID).getFoldersByName(ym);
  if (!it.hasNext()) return;
  props.setProperties({ job: 'refresh', ym: ym, idx: '0', total: String(readStations_().length), folder: it.next().getId() });
  continueJob();
}

// ============================================================ เทมเพลตของเดือน (สร้างครั้งเดียว แล้ว copy ให้ทุกสถานี)
function buildTemplate_(ym, folder) {
  const [y, m] = ym.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const ss = SpreadsheetApp.create(`_TEMPLATE_${ym}`);
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  ss.setSpreadsheetLocale('th_TH');
  ss.setSpreadsheetTimeZone('Asia/Bangkok');

  // ข้อมูลสถานี (ซ่อน) – หน้าวันอ่านจากที่นี่ทั้งหมด
  const info = ss.getSheets()[0].setName(INFO);
  info.getRange('A1:A6').setValues([['ชื่อสถานี'], ['กำลังติดตั้ง'], ['อายุสัญญา'], ['วันที่เริ่มให้บริการ'], ['รหัส / ระยะ'], ['จำนวน Inverter']]);
  info.getRange('A10:C10').setValues([['NO.', 'Inverter S/N', 'จำนวนสตริง']]);

  const d1 = ss.insertSheet('วันที่ 1');
  buildDay_(d1);
  setDayTitle_(d1, new Date(y, m - 1, 1));
  for (let d = 2; d <= days; d++) {
    const sh = d1.copyTo(ss).setName(`วันที่ ${d}`);
    setDayTitle_(sh, new Date(y, m - 1, d));
  }
  buildSummary_(ss, y, m, days);
  ss.setActiveSheet(ss.getSheetByName('สรุปเดือน'));
  ss.moveActiveSheet(1);
  info.hideSheet();
  info.getRange('A1').activate();
  SpreadsheetApp.flush();
  return ss;
}

function setDayTitle_(sh, date) {
  sh.getRange('C4').setValue(`สรุปผลความพร้อมระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ประจำวันที่  ${date.getDate()} ${TH_MONTH[date.getMonth() + 1]} พ.ศ. ${date.getFullYear() + 543}`);
}

function buildDay_(sh) {
  const I = `'${INFO}'!`;
  sh.setHiddenGridlines(true);
  const all = sh.getRange(1, 1, R.SIGN + 4, 14);
  all.setFontFamily(CONFIG.FONT).setFontSize(14).setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  [[1, 12], [2, 12], [3, 60], [4, 150], [5, 80], [6, 80], [7, 80], [8, 130], [9, 150], [10, 190], [11, 115], [12, 120], [13, 125], [14, 12]]
    .forEach(([c, w]) => sh.setColumnWidth(c, w));
  sh.setRowHeights(1, R.SIGN + 4, 28);

  // หัวรายงาน
  sh.getRange('C2:M3').merge().setValue('รายงานความพร้อมระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ประจำวัน').setFontSize(20).setFontWeight('bold');
  sh.getRange('C4:M4').merge().setFontSize(15).setFontWeight('bold');

  // ข้อมูลโครงการ
  sh.getRange('C6:D7').merge().setValue('ชื่อโครงการ');
  sh.getRange('E6:M6').merge().setValue(PROJECT);
  sh.getRange('E7:M7').merge().setValue('การประปาส่วนภูมิภาค');
  [['ชื่อสถานี', `=${I}B1`], ['อายุสัญญา', `=${I}B3`], ['วันที่เริ่มให้บริการ', `=${I}B4`], ['กำลังติดตั้ง', `=${I}B2`]]
    .forEach(([lab, f], k) => {
      sh.getRange(8 + k, 3, 1, 2).merge().setValue(lab);
      sh.getRange(8 + k, 5, 1, 9).merge().setFormula(f);
    });
  sh.getRange('C6:D11').setFontWeight('bold').setBackground(C.GREY).setHorizontalAlignment('left');
  sh.getRange('E6:M11').setHorizontalAlignment('left');
  sh.getRange('E8').setFontWeight('bold');
  box_(sh.getRange('C6:M11'));

  // ตาราง Inverter (หัว 2 ชั้น)
  const H = R.INV0 - 2;
  [['C', 'NO.'], ['D', 'Inverter S/N'], ['H', 'สตริงที่มีปัญหา'], ['I', 'เวลาที่พบปัญหา'], ['J', 'สถานะ Inverter']]
    .forEach(([c, t]) => sh.getRange(`${c}${H}:${c}${H + 1}`).merge().setValue(t));
  sh.getRange(`K${H}:M${H + 1}`).merge().setValue('อาการ');
  sh.getRange(`E${H}:G${H}`).merge().setValue('จำนวนสตริง');
  sh.getRange(`E${H + 1}:G${H + 1}`).setValues([['ทั้งหมด', 'ปกติ', 'ผิดปกติ']]);
  sh.getRange(`C${H}:M${H + 1}`).setFontWeight('bold').setBackground(C.BLUE);
  const rows = [];
  for (let k = 0; k < CONFIG.MAX_INV; k++) {
    const r = R.INV0 + k, ir = 11 + k;
    rows.push([`=IF(${I}B${ir}="","",${I}A${ir})`, `=IF(${I}B${ir}="","",${I}B${ir})`, `=IF(${I}B${ir}="","",${I}C${ir})`,
      `=IF(D${r}="","",E${r}-N(G${r}))`]);
    sh.getRange(`K${r}:M${r}`).merge();
  }
  sh.getRange(R.INV0, 3, CONFIG.MAX_INV, 4).setFormulas(rows);
  sh.getRange(`K${R.INV0}:K${R.TOTAL - 1}`).setHorizontalAlignment('left').setFontSize(13);
  const T = R.TOTAL;
  sh.getRange(`C${T}:D${T}`).merge().setValue('รวม');
  sh.getRange(`E${T}:I${T}`).setFormulas([[`=SUM(E${R.INV0}:E${T - 1})`, `=SUM(F${R.INV0}:F${T - 1})`, `=SUM(G${R.INV0}:G${T - 1})`,
    'ความพร้อม', `=IF(E${T}=0,"-",F${T}/E${T})`]]);
  sh.getRange(`I${T}`).setNumberFormat('0.00%');
  sh.getRange(`K${T}:M${T}`).merge();
  sh.getRange(`C${T}:M${T}`).setFontWeight('bold').setBackground(C.GREY);
  box_(sh.getRange(`C${H}:M${T}`));

  // รายงานการแก้ไข
  const S = R.ISSUE_HEAD;
  sh.getRange(`C${S}:M${S}`).merge().setValue('รายงานการแก้ไข   (ผู้ทำรายงานกรอกเฉพาะช่องสีเหลือง)')
    .setFontWeight('bold').setFontSize(15).setBackground(C.ORANGE).setHorizontalAlignment('left');
  sh.getRange(`F${S + 1}:G${S + 1}`).merge();
  sh.getRange(`C${S + 1}:M${S + 1}`).setValues([['ลำดับ', 'Inverter S/N', 'String', 'อาการ', '', 'ค่าที่อ่านได้',
    'ผลการตรวจสอบ', 'การแก้ไข', 'สถานะ', 'ผู้รับผิดชอบ', 'วันที่แก้ไขเสร็จ']]).setFontWeight('bold');
  sh.getRange(`C${S + 1}:H${S + 1}`).setBackground(C.BLUE);
  sh.getRange(`I${S + 1}:M${S + 1}`).setBackground(C.FILLH);
  const n0 = R.ISSUE0, n1 = R.ISSUE_END, nRows = n1 - n0 + 1;
  const seq = [];
  for (let r = n0; r <= n1; r++) { seq.push([`=IF(D${r}="","",ROW()-${n0 - 1})`]); sh.getRange(`F${r}:G${r}`).merge(); }
  sh.getRange(n0, 3, nRows, 1).setFormulas(seq);
  sh.getRange(`F${n0}:F${n1}`).setHorizontalAlignment('left').setFontSize(13);
  sh.getRange(`I${n0}:M${n1}`).setBackground(C.FILL).setFontSize(13);
  sh.getRange(`J${n0}:J${n1}`).setHorizontalAlignment('left');
  sh.getRange(`M${n0}:M${n1}`).setNumberFormat('dd/mm/yyyy');
  sh.getRange(`I${n0}:I${n1}`).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(CHECKS, true).build());
  sh.getRange(`K${n0}:K${n1}`).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).build());
  sh.getRange(`M${n0}:M${n1}`).setDataValidation(SpreadsheetApp.newDataValidation().requireDate().build());
  box_(sh.getRange(`C${S}:M${n1}`));

  // สีตามสถานะ / % ความพร้อม
  const st = sh.getRange(`K${n0}:K${n1}`), pc = sh.getRange(`I${T}`);
  const cf = (rng, fn) => fn(SpreadsheetApp.newConditionalFormatRule().setRanges([rng])).build();
  sh.setConditionalFormatRules([
    cf(st, b => b.whenTextEqualTo('รอดำเนินการ').setBackground(C.RED)),
    cf(st, b => b.whenTextEqualTo('กำลังแก้ไข').setBackground(C.YEL)),
    cf(st, b => b.whenTextEqualTo('แก้ไขแล้ว').setBackground(C.GRN)),
    cf(st, b => b.whenTextEqualTo('ปิดงาน').setBackground(C.GREY)),
    cf(sh.getRange(`G${R.INV0}:G${T - 1}`), b => b.whenNumberGreaterThan(0).setBackground(C.RED).setBold(true)),
    cf(pc, b => b.whenNumberGreaterThanOrEqualTo(0.98).setBackground(C.GRN)),
    cf(pc, b => b.whenNumberBetween(0.95, 0.97999).setBackground(C.YEL)),
    cf(pc, b => b.whenNumberLessThan(0.95).setBackground(C.RED)),
  ]);

  // ลงนาม
  const G = R.SIGN;
  [['C', 'G', 'ผู้จัดทำรายงาน'], ['I', 'M', 'ผู้ตรวจสอบ']].forEach(([a, b, lab]) => {
    ['ลงชื่อ ..............................................', '(..............................................)', lab, 'วันที่ ......../......../........']
      .forEach((t, k) => sh.getRange(`${a}${G + k}:${b}${G + k}`).merge().setValue(t).setFontWeight(k === 2 ? 'bold' : 'normal'));
  });

  // ป้องกัน (เตือนอย่างเดียว) ยกเว้นช่องกรอก
  const p = sh.protect().setDescription('ข้อมูลจากระบบ – กรอกเฉพาะช่องที่กำหนด').setWarningOnly(true);
  p.setUnprotectedRanges([sh.getRange(`G${R.INV0}:M${T - 1}`), sh.getRange(`D${n0}:M${n1}`)]);
}

function buildSummary_(ss, y, m, days) {
  const sh = ss.insertSheet('สรุปเดือน');
  sh.setHiddenGridlines(true);
  sh.getRange(1, 1, days + 8, 7).setFontFamily(CONFIG.FONT).setFontSize(14).setHorizontalAlignment('center').setVerticalAlignment('middle');
  sh.getRange('A1:G1').merge().setValue(`สรุปความพร้อมระบบรายเดือน – ${TH_MONTH[m]} ${y + 543}`).setFontSize(18).setFontWeight('bold');
  sh.getRange('A2:G2').merge().setFormula(`='${INFO}'!B1`).setFontWeight('bold');
  sh.getRange('A3:G3').merge().setFormula(`='${INFO}'!B2&"   ·   "&'${INFO}'!B5`);
  sh.getRange('A5:G5').setValues([['วันที่', 'สตริงทั้งหมด', 'ปกติ', 'ผิดปกติ', 'ความพร้อม', 'ปัญหาที่บันทึก', 'หน้า']])
    .setFontWeight('bold').setBackground(C.BLUE);
  const T = R.TOTAL, rows = [];
  for (let d = 1; d <= days; d++) {
    const t = `'วันที่ ${d}'!`;
    rows.push([`${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y + 543}`, `=${t}E${T}`, `=${t}F${T}`, `=${t}G${T}`,
      `=${t}I${T}`, `=COUNTA(${t}D${R.ISSUE0}:D${R.ISSUE_END})`, `วันที่ ${d}`]);
  }
  sh.getRange(6, 1, days, 7).setValues(rows);
  sh.getRange(6, 5, days, 1).setNumberFormat('0.00%');
  const tr = 6 + days;
  sh.getRange(tr, 1, 1, 6).setValues([['รวม/เฉลี่ย', `=SUM(B6:B${tr - 1})`, `=SUM(C6:C${tr - 1})`, `=SUM(D6:D${tr - 1})`,
    `=IF(B${tr}=0,"-",C${tr}/B${tr})`, `=SUM(F6:F${tr - 1})`]]).setFontWeight('bold').setBackground(C.GREY);
  sh.getRange(tr, 5).setNumberFormat('0.00%');
  box_(sh.getRange(5, 1, days + 2, 7));
  [110, 110, 80, 80, 100, 110, 90].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.setFrozenRows(5);
}

// ============================================================ เติมข้อมูลสถานีลงไฟล์
function fillStation_(ss, s, invs, ym) {
  const info = ss.getSheetByName(INFO);
  const n = Math.min(invs.length, CONFIG.MAX_INV);
  const prevN = Number(info.getRange('B6').getValue() || -1);
  info.getRange('B1:B6').setValues([[s.name], [s.kwp ? `${Number(s.kwp).toLocaleString('en-US', { minimumFractionDigits: 2 })} kWp` : '-'],
    [s.contract || '-'], [thDate_(s.start)], [`${s.code}  ·  ระยะที่ ${s.phase}${s.branch ? '  ·  ' + s.branch : ''}`], [n]]);
  info.getRange(11, 1, CONFIG.MAX_INV, 3).clearContent();
  if (n) info.getRange(11, 1, n, 3).setValues(invs.slice(0, n).map((v, k) => [v.no || k + 1, v.sn, v.strings || '']));
  if (prevN !== n) {                       // ซ่อนแถว Inverter ที่ไม่ใช้ในทุกหน้า
    ss.getSheets().filter(sh => /^วันที่ \d+$/.test(sh.getName())).forEach(sh => {
      sh.showRows(R.INV0, CONFIG.MAX_INV);
      if (n < CONFIG.MAX_INV) sh.hideRows(R.INV0 + Math.max(n, 1), CONFIG.MAX_INV - Math.max(n, 1));
    });
  }
}

// ============================================================ อ่าน Overview
function readTable_(name) {
  const v = SpreadsheetApp.openById(CONFIG.OVERVIEW_ID).getSheetByName(name).getDataRange().getValues();
  const h = v.shift().map(String);
  return v.filter(r => r[0] !== '').map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}

function readStations_() {
  return readTable_('สถานี').map(r => ({
    code: String(r['รหัส']), phase: r['ระยะ'], name: String(r['ชื่อสถานี (ใช้ในรายงาน)']), branch: r['กปภ.สาขา'],
    kwp: r['กำลังติดตั้ง (kWp)'], contract: r['อายุสัญญา'], start: r['วันที่เริ่มให้บริการ'],
  })).sort((a, b) => a.code.localeCompare(b.code));
}

function readInverters_() {
  const out = {};
  readTable_('Inverter').forEach(r => {
    if (String(r['ใช้งาน (Y/N)'] || 'Y').toUpperCase() === 'N') return;
    (out[r['รหัส']] = out[r['รหัส']] || []).push({ no: r['NO.'], sn: String(r['Inverter S/N']), strings: r['จำนวนสตริง'] });
  });
  Object.values(out).forEach(a => a.sort((x, y) => (x.no || 999) - (y.no || 999)));
  return out;
}

// ============================================================ helpers
function ym_(d) { return Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM'); }

function monthFolder_(ym) {
  const root = DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID);
  const it = root.getFoldersByName(ym);
  return it.hasNext() ? it.next() : root.createFolder(ym);
}

function fileName_(s, ym) { return `${s.code}_${s.name.replace(/[\\/:*?"<>|]/g, '-').trim()}_${ym}`; }

function findFile_(folder, name) {
  const it = folder.getFilesByName(name);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
  return null;
}

function thDate_(v) {
  if (v instanceof Date) return `${String(v.getDate()).padStart(2, '0')} ${TH_MONTH[v.getMonth() + 1]} พ.ศ.${v.getFullYear() + 543}`;
  return v ? String(v) : '-';
}

function box_(rng) {
  rng.setBorder(true, true, true, true, true, true, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  rng.setBorder(true, true, true, true, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
}

function clearOneOff_(fn) {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === fn).forEach(t => ScriptApp.deleteTrigger(t));
}
