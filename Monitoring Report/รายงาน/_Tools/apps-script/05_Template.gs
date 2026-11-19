// ============================================================ 2) one file per plant, one sheet per day

/**
 * สรุปเดือน!A4: a link that opens today's day sheet, during the file's month. The sheet id is taken from
 * that day's "เปิด" link in column I, so the same formula works in every file.
 */
function todayLink_(y, m, days) {
  return `=IF(AND(YEAR(TODAY())=${y},MONTH(TODAY())=${m}),HYPERLINK("#gid="&REGEXEXTRACT(FORMULATEXT(INDEX($I$6:$I$${5 + days},DAY(TODAY()))),"gid=(\\d+)"),"▶ เปิดหน้าวันนี้ (วันที่ "&DAY(TODAY())&")"),"–")`;
}
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

  const first = ss.insertSheet('วันที่ 1');
  buildDay_(first, n);
  setDayTitle_(first, y, m, 1);
  const gids = [first.getSheetId()];
  for (let d = 2; d <= days; d++) {
    const sh = first.copyTo(ss).setName(`วันที่ ${d}`);
    setDayTitle_(sh, y, m, d);
    gids.push(sh.getSheetId());
  }
  buildSummary_(ss, y, m, days, n, gids);
  info.hideSheet();
  SpreadsheetApp.flush();
  return ss.getId();
}

/**
 * Menu: removes the old logo from the day sheets of this month's and next month's plant files.
 * Only an image anchored where the logo was (rows 1-4, column L or M) is removed; other images stay.
 * Works for about CONFIG.RUN_SECONDS; run it again to continue from the next file
 * (progress in the script property logoRemoved_<yyyy-MM>, cleared when every file is done).
 */
function removeLogos() {
  const props = PropertiesService.getScriptProperties();
  const months = [ym_(new Date()), nextYm_()];
  const t0 = Date.now();
  let removed = 0, opened = 0, left = 0;
  months.forEach(ym => {
    const folder = findMonthFolder_(ym);
    if (!folder) return;
    const files = folderFiles_(folder.getId());
    const names = [...files.keys()]
      .filter(name => name.indexOf('_') !== 0 && name.slice(-ym.length - 1) === `_${ym}`).sort();
    const key = `logoRemoved_${ym}`;
    let i = Number(props.getProperty(key) || 0);
    for (; i < names.length && (Date.now() - t0) / 1000 < CONFIG.RUN_SECONDS; i++) {
      SpreadsheetApp.openById(files.get(names[i]).id).getSheets()
        .filter(sh => /^วันที่ \d+$/.test(sh.getName()))
        .forEach(sh => sh.getImages().forEach(img => {
          const at = img.getAnchorCell();
          if (at.getRow() <= 4 && at.getColumn() >= 12) { img.remove(); removed++; }
        }));
      opened++;
    }
    left += names.length - i;
    props.setProperty(key, String(i));
  });
  if (!left) months.forEach(ym => props.deleteProperty(`logoRemoved_${ym}`));
  const msg = `ลบโลโก้แล้ว ${removed} รูป (เปิด ${opened} ไฟล์)` +
    (left ? ` — เหลืออีก ${left} ไฟล์ กดเมนูนี้อีกครั้งเพื่อทำต่อ` : ' — ครบทุกไฟล์แล้ว');
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
  sh.getRange('C4:K4').merge().setFontSize(12);

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
