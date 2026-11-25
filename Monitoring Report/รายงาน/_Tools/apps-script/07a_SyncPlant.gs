// ============================================================ 3a) sync: reading one plant file (info sheet + day sheets)

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
  const out = { station: s, episodes: [], invStatus: {}, warnings: warnings, updated: !same, days: [] };
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
  out.lastReport = checkedDays.length ? date(checkedDays[checkedDays.length - 1]) : null;
  out.days = checkedDays;
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
