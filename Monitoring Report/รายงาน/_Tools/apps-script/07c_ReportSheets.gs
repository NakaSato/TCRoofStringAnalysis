// ============================================================ 3c) sync: report sheets of the Overview (บันทึกรายงานรายวัน, รายงานวันนี้)

/**
 * Sheet "บันทึกรายงานรายวัน MM/พ.ศ." (one per month, newest month first, after รายงานวันนี้): a grid with one
 * row per plant and one column per day of the month: ✓ = the plant has a checked row in that day's sheet,
 * ✗ = not yet, blank = a day still to come. Above the grid, per day: plants reported and the %; per plant:
 * days reported / not yet. A late report changes its own day. The header row has a filter (e.g. ✗ on one
 * day = the plants still to report). The sheet is rewritten only when a value changed; อัปเดตล่าสุด in row 2
 * is when that was. The old one-row-per-day sheet "บันทึกรายงานรายวัน" is replaced (deleted) by it.
 */
const LOG_HEAD_ROW = 5;                    // rows 1–2 title, 3–4 per-day totals, 5 header, plants from 6
const LOG_LEFT = ['รหัส', 'ระยะ', 'ชื่อสถานี', 'ทำแล้ว (วัน)', 'ยังไม่ทำ (วัน)'];
const DONE_MARK = '✓', MISS_MARK = '✗';
function reportLogName_(ym) { const [y, m] = ym.split('-').map(Number); return `${REPORT_LOG} ${String(m).padStart(2, '0')}/${y + 543}`; }
function reportLog_(overview, ym, stations) {
  const days = readDays_(PropertiesService.getScriptProperties(), ym);
  const lastDay = lastDayToRead_(ym);
  if (!days || lastDay < 1 || !stations.length) return;
  const [y, m] = ym.split('-').map(Number);
  const nDays = daysIn_(y, m), L = LOG_LEFT.length, W = L + nDays, H = LOG_HEAD_ROW;
  const n = stations.length, rows = H + n;

  // the values from row 3 down: per-day totals, the header, one row per plant
  const done = [], pct = [];
  const grid = stations.map(s => {
    const marks = [];
    for (let d = 1; d <= nDays; d++) marks.push(d > lastDay ? '' : reportedOn_(days[s.code], d) ? DONE_MARK : MISS_MARK);
    const k = marks.filter(v => v === DONE_MARK).length;
    return [s.code, s.phase === undefined || s.phase === null ? '' : s.phase, s.name, k, lastDay - k].concat(marks);
  });
  for (let d = 1; d <= nDays; d++) {
    const k = d > lastDay ? '' : grid.filter(r => r[L + d - 1] === DONE_MARK).length;
    done.push(k);
    pct.push(k === '' ? '' : Math.round(k / n * 1000) / 1000);
  }
  const pad = v => v.concat(Array(L - v.length).fill(''));
  const body = [pad(['ทำรายงานแล้ว (สถานี)']).concat(done), pad([`% ทำรายงาน (จาก ${n} สถานี)`]).concat(pct),
    LOG_LEFT.concat(Array.from({ length: nDays }, (_, i) => i + 1))].concat(grid);

  const name = reportLogName_(ym);
  let sh = overview.getSheetByName(name);
  if (sh && sh.getMaxRows() >= rows && sh.getMaxColumns() >= W && sh.getLastRow() === rows) {
    const was = sh.getRange(3, 1, body.length, W).getValues();
    if (was.every((r, i) => r.every((v, k) => String(v) === String(body[i][k])))) return;   // nothing changed
  }
  if (!sh) {
    // newest month first: after รายงานวันนี้ and after the sheets of later months
    const sheets = overview.getSheets();
    let pos = Math.max(sheets.findIndex(x => x.getName() === REPORTED_TODAY) + 1, 1);
    const monthKey = nm => { const t = /(\d{2})\/(\d{4})$/.exec(nm); return t ? Number(t[2]) * 100 + Number(t[1]) : 0; };
    sheets.forEach((x, i) => { const nm = x.getName(); if (nm.indexOf(`${REPORT_LOG} `) === 0 && monthKey(nm) > monthKey(name)) pos = Math.max(pos, i + 1); });
    sh = overview.insertSheet(name, pos);
  }
  const old = overview.getSheetByName(REPORT_LOG);        // the one-row-per-day sheet this grid replaces
  if (old) overview.deleteSheet(old);

  ensureSize_(sh, rows, W);
  trimSheet_(sh, rows, W);
  if (sh.getLastRow() > rows) sh.getRange(rows + 1, 1, sh.getLastRow() - rows, W).clearContent();
  const stamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/') +
    (Number(Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy')) + 543) + Utilities.formatDate(new Date(), 'Asia/Bangkok', ' HH:mm');

  // style: the font of the day sheets, a narrow column per day
  const all = sh.getRange(1, 1, rows, W);
  all.setFontFamily(CONFIG.FONT).setFontSize(CONFIG.FONT_SIZE).setVerticalAlignment('middle');
  [75, 50, 280, 90, 90].forEach((px, k) => sh.setColumnWidth(k + 1, px));
  for (let c = L + 1; c <= W; c++) sh.setColumnWidth(c, 34);
  sh.getRange(1, 1, 2, W).breakApart();
  sh.getRange(1, 1, 1, W).merge().setValue(`บันทึกรายงานรายวัน – ${TH_MONTH[m]} ${y + 543}`)
    .setFontSize(16).setFontWeight('bold').setHorizontalAlignment('left');
  sh.getRange(2, 1, 1, W).merge()
    .setValue(`${DONE_MARK} = ทำรายงานแล้ว   ·   ${MISS_MARK} = ยังไม่ทำรายงาน   ·   ว่าง = ยังไม่ถึงวัน   ·   ` +
      `กรองคอลัมน์วันที่ที่ ${MISS_MARK} เพื่อดูสถานีที่ยังไม่ทำ   ·   อัปเดตล่าสุด ${stamp}`)
    .setFontColor('#595959').setHorizontalAlignment('left');
  sh.getRange(3, 1, 2, W).breakApart();
  sh.getRange(3, 1, 1, L).merge();
  sh.getRange(4, 1, 1, L).merge();
  sh.getRange(3, 1, body.length, W).setValues(body);
  sh.getRange(3, 1, 2, L).setFontWeight('bold').setHorizontalAlignment('right').setBackground(COLOR.GREY);
  sh.getRange(3, L + 1, 1, nDays).setNumberFormat('0').setHorizontalAlignment('center').setBackground(COLOR.GREY);
  sh.getRange(4, L + 1, 1, nDays).setNumberFormat('0%').setHorizontalAlignment('center').setBackground(COLOR.GREY);
  sh.getRange(H, 1, 1, W).setFontWeight('bold').setBackground(COLOR.BLUE).setHorizontalAlignment('center').setWrap(true);
  sh.getRange(H + 1, 1, n, 2).setHorizontalAlignment('center');
  sh.getRange(H + 1, 3, n, 1).setHorizontalAlignment('left');
  sh.getRange(H + 1, 4, n, W - 3).setHorizontalAlignment('center');
  box_(sh.getRange(3, 1, rows - 2, W));
  sh.setRowHeights(1, rows, 22);
  sh.setRowHeight(1, 34);
  sh.setRowHeight(H, 36);
  sh.setFrozenRows(H);
  sh.setFrozenColumns(3);

  // colours: ✓ green, ✗ red, a day under 100 % amber; today's column header yellow (follows TODAY())
  const days_ = sh.getRange(H + 1, L + 1, n, nDays), pctRow = sh.getRange(4, L + 1, 1, nDays);
  const first = letter_(L + 1);
  const thisMonth = `TEXT(TODAY(),"yyyy-mm")="${ym}"`;
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(DONE_MARK).setBackground(COLOR.GREEN).setFontColor('#006100')
      .setRanges([days_]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(MISS_MARK).setBackground(COLOR.RED).setFontColor('#9C0006')
      .setRanges([days_]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(`=AND(${first}$4<>"",${first}$4<1)`)
      .setBackground(COLOR.YELLOW).setRanges([pctRow]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(`=AND(${thisMonth},${first}$${H}=DAY(TODAY()))`)
      .setBackground(COLOR.INPUT).setRanges([sh.getRange(H, L + 1, 1, nDays)]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setFontColor('#9C0006')
      .setRanges([sh.getRange(H + 1, L, n, 1)]).build(),
  ]);

  // the filter on the header row, over every plant (kept, criteria and all, while it already fits)
  const f = sh.getFilter(), g = f && f.getRange();
  if (!g || g.getRow() !== H || g.getLastRow() !== rows || g.getColumn() !== 1 || g.getLastColumn() !== W) {
    if (f) f.remove();
    sh.getRange(H, 1, n + 1, W).createFilter();
  }
}

/**
 * Sheet "รายงานวันนี้": left, the plants whose รายงานล่าสุด is today; right, the plants that have not reported
 * today. Formulas only (FILTER over "สถานี"), so the lists change with TODAY() and the next sync; the sheet
 * is written only when it is missing, its formulas or style differ (e.g. a column of "สถานี" moved) or the
 * number of plants changed.
 */
function todaySheet_(overview, sHead, nPlants) {
  const want = ['รหัส', 'ระยะ', 'ชื่อสถานี', 'กปภ.สาขา', LAST_REPORT].filter(h => sHead.indexOf(h) >= 0);
  if (want.indexOf(LAST_REPORT) < 0 || want.indexOf('รหัส') < 0) return;
  const ref = h => { const L = letter_(sHead.indexOf(h) + 1); return `'${STATIONS}'!$${L}$2:$${L}`; };
  const today = 'TEXT(TODAY(),"dd/mm/")&(YEAR(TODAY())+543)';
  const cols = `{${want.map(ref).join(',')}}`, code = ref('รหัส'), last = ref(LAST_REPORT);
  const w = want.length, right = w + 2;                 // one empty column between the two lists
  const done = `=IFERROR(FILTER(${cols},${last}=${today}),"ยังไม่มีสถานีที่ทำรายงานวันนี้")`;
  const notYet = `=IFERROR(FILTER(${cols},${code}<>"",${last}<>${today}),"ทำรายงานครบทุกสถานีแล้ว")`;
  const title = `="รายงานวันนี้ – วันที่ "&${today}&"   ·   ทำรายงานแล้ว "&COUNTIF(${last},${today})&"/"&COUNTA(${code})&" สถานี"`;
  const subtitle = `${PROJECT} · ${OWNER}`;              // row 2; also marks a sheet that has this style
  const n = Math.max(nPlants, 1), width = right + w - 1, rows = 4 + n + 20;
  let sh = overview.getSheetByName(REPORTED_TODAY);
  if (sh && sh.getRange(5, 1).getFormula() === done && sh.getRange(5, right).getFormula() === notYet &&
    sh.getRange(1, 1).getFormula() === title && sh.getRange(2, 1).getValue() === subtitle && sh.getMaxRows() === rows) return;
  if (!sh) sh = overview.insertSheet(REPORTED_TODAY, 1);   // next to รายงานการแก้ไข
  sh.clear();
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  ensureSize_(sh, rows, width);
  trimSheet_(sh, rows, width);

  // style: the font of the day sheets, no gridlines, one width per column
  sh.setHiddenGridlines(true);
  sh.getRange(1, 1, rows, width).setFontFamily(CONFIG.FONT).setFontSize(CONFIG.FONT_SIZE).setVerticalAlignment('middle');
  const colWidth = { 'รหัส': 75, 'ระยะ': 50, 'ชื่อสถานี': 280, 'กปภ.สาขา': 190, [LAST_REPORT]: 110 };
  [1, right].forEach(c => want.forEach((h, k) => sh.setColumnWidth(c + k, colWidth[h] || 110)));
  sh.setColumnWidth(w + 1, 24);                         // the gap between the two lists
  sh.setRowHeights(1, rows, 24);
  sh.setRowHeight(1, 36);
  sh.setRowHeight(3, 30);

  // heading
  sh.getRange(1, 1, 1, width).merge().setFormula(title).setFontSize(16).setFontWeight('bold').setHorizontalAlignment('center');
  sh.getRange(2, 1, 1, width).merge().setValue(subtitle).setFontColor('#595959').setHorizontalAlignment('center');

  // the two lists: a coloured heading with the count, a blue header row, borders round every plant row
  [[1, `="ทำรายงานแล้ว ("&COUNTIF(${last},${today})&" สถานี)"`, COLOR.GREEN, '#006100'],
    [right, `="ยังไม่ทำรายงาน ("&(COUNTA(${code})-COUNTIF(${last},${today}))&" สถานี)"`, COLOR.RED, '#9C0006']]
    .forEach(([c, label, fill, ink]) => {
      sh.getRange(3, c, 1, w).merge().setFormula(label).setFontSize(13).setFontWeight('bold')
        .setBackground(fill).setFontColor(ink).setHorizontalAlignment('center');
      sh.getRange(4, c, 1, w).setValues([want]).setFontWeight('bold').setBackground(COLOR.BLUE).setHorizontalAlignment('center');
      sh.getRange(5, c, n, w).setHorizontalAlignment('center');
      ['ชื่อสถานี', 'กปภ.สาขา'].forEach(h => {
        const k = want.indexOf(h);
        if (k >= 0) sh.getRange(5, c + k, n, 1).setHorizontalAlignment('left');
      });
      box_(sh.getRange(3, c, n + 2, w));
    });
  sh.getRange(5, 1).setFormula(done);
  sh.getRange(5, right).setFormula(notYet);
  sh.setFrozenRows(4);
}
