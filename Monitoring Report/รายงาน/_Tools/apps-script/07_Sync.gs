// ============================================================ 3) sync: Overview ⇄ plant files

/**
 * full = read every plant file. Otherwise only the files edited since the last complete sync are read,
 * unless the Overview's สถานี / Inverter sheets changed (then every file is read).
 */
function startSync_(ym, quiet, full) {
  checkYm_(ym);
  if (archivedYears_().indexOf(Number(ym.slice(0, 4))) >= 0) {
    if (quiet) return;
    throw new Error(`ปี พ.ศ. ${Number(ym.slice(0, 4)) + 543} ย้ายปัญหาไปไฟล์เก็บแล้ว — ซิงก์เดือน ${ym} อีกจะสร้างแถวที่ย้ายไปแล้วซ้ำ`);
  }
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
    const noDays = !readDays_(props, p.ym);              // the days each plant reported are not on record yet
    since = !p.full && !noDays && last && last.sig === sig && last.v === SYNC_VERSION ? Number(last.t) - SYNC_MARGIN_MS : 0;
    // why every file is read (shown in _log)
    const why = since ? '' : p.full ? 'สั่งอ่านทุกไฟล์' : otherFolder ? 'โฟลเดอร์เดือนเปลี่ยน'
      : !last ? 'ไม่มีบันทึกซิงก์ครั้งก่อน' : noDays ? 'ยังไม่มีบันทึกวันที่ทำรายงาน' : last.v !== SYNC_VERSION ? 'สคริปต์รุ่นใหม่' : 'แท็บสถานี/Inverter ใน Overview เปลี่ยน';
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
  writeLastReport_(overview, p.ym, results);
  saveDays_(props, p.ym, results);
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
    const dm = k.indexOf('days_') === 0 ? k.slice(5) : '';   // the days each plant reported: the sheet keeps the counts
    if (dm && dm < prev && dm !== keep) props.deleteProperty(k);
  });
}
function saveSeen_(props, ym, seen) {
  const text = JSON.stringify(seen);
  if (text.length > SEEN_MAX_CHARS) props.deleteProperty(`seen_${ym}`);
  else props.setProperty(`seen_${ym}`, text);
}

/**
 * days_<ym>: { plant code: the days of the month it has a checked row, as a number (bit d-1 = day d) }.
 * A plant read by this sync gets its days from its file; plants not read keep what they had.
 */
function readDays_(props, ym) {
  try { return JSON.parse(props.getProperty(`days_${ym}`) || 'null'); } catch (e) { return null; }
}
function saveDays_(props, ym, results) {
  const codes = Object.keys(results).filter(c => results[c].days);
  const days = readDays_(props, ym) || {};
  let changed = !props.getProperty(`days_${ym}`);
  codes.forEach(c => {
    const mask = results[c].days.reduce((a, d) => a + Math.pow(2, d - 1), 0);
    if (days[c] !== mask) { days[c] = mask; changed = true; }
  });
  if (!changed) return;
  const text = JSON.stringify(days);
  if (text.length > DAYS_MAX_CHARS) props.deleteProperty(`days_${ym}`);   // the next sync reads every file again
  else props.setProperty(`days_${ym}`, text);
}
function reportedOn_(mask, d) { return Math.floor((mask || 0) / Math.pow(2, d - 1)) % 2 === 1; }

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

/** The Overview's "รายงานการแก้ไข" table: sheet, header row and the column number of each header. */
function issueTable_(overview) {
  const sh = overview.getSheetByName(ISSUES);
  if (!sh) throw new Error(`ไม่พบชีต "${ISSUES}" ในไฟล์ Overview`);
  const top = sh.getRange(1, 1, Math.min(20, sh.getMaxRows()), sh.getLastColumn()).getValues();
  const headRow = top.findIndex(r => r.some(v => String(v).trim() === 'รหัสปัญหา')) + 1;
  if (!headRow) throw new Error(`ไม่พบหัวตาราง "รหัสปัญหา" ในชีต "${ISSUES}"`);
  // the table is as wide as its header: a summary box above it may reach further right
  let width = 0;
  top[headRow - 1].forEach((h, k) => { if (String(h).trim() !== '') width = k + 1; });
  const head = top[headRow - 1].slice(0, width).map(h => String(h).trim());
  const col = {};
  head.forEach((h, k) => { if (h) col[h] = k + 1; });
  ['วันที่พบ', 'สถานะ'].forEach(h => { if (!col[h]) throw new Error(`ชีต "${ISSUES}" ไม่มีคอลัมน์ "${h}"`); });
  return { sh: sh, headRow: headRow, head: head, col: col, width: width, top: top };
}

/**
 * A row of several inverters (รหัสปัญหา "P1-001|SN-A,SN-B|20261123", see groupIssues_) as one row per
 * inverter, each with the row's values: the sync works per inverter, and a value typed into the Overview
 * row stays with every inverter of it.
 */
function splitIssue_(row) {
  const [code, sns, day] = String(row['รหัสปัญหา']).split('|');
  const list = String(sns || '').split(',').map(v => v.trim()).filter(Boolean);
  if (list.length < 2) return [row];
  return list.map(sn => Object.assign({}, row, { 'รหัสปัญหา': `${code}|${sn}|${day}`, 'Inverter S/N': sn }));
}

/**
 * Inverters of one plant with the same problem (รายละเอียดปัญหา) found on the same day share one row:
 * Inverter S/N lists them all and รหัสปัญหา is "plant|S/N,S/N|day". สถานะ is the least finished one of
 * them; วันเข้าแก้ไข the earliest; วันที่แก้ไขเสร็จ the latest, and only when every inverter is done.
 * Other columns show each different value once ("a / b"); a link (formula) is the first one.
 */
function groupIssues_(rows) {
  const groups = {}, order = [];
  rows.forEach(row => {
    const [code, , day] = String(row['รหัสปัญหา']).split('|');
    const k = `${code}|${day}|${String(row['รายละเอียดปัญหา'] || '').trim()}`;
    if (!groups[k]) { groups[k] = []; order.push(k); }
    groups[k].push(row);
  });
  const rank = v => Math.max(STATUSES.indexOf(String(v || '').trim()), 0);
  const time = v => (v instanceof Date ? v.getTime() : null);
  return order.map(k => {
    const list = groups[k];
    if (list.length === 1) return list[0];
    list.sort((p, q) => String(p['Inverter S/N']).localeCompare(String(q['Inverter S/N'])));
    const [code, , day] = String(list[0]['รหัสปัญหา']).split('|');
    const sns = list.map(r => String(r['Inverter S/N']).trim());
    const row = {};
    Object.keys(Object.assign({}, ...list)).forEach(h => {
      const vals = list.map(r => r[h]).filter(v => v !== undefined && v !== null && v !== '');
      if (!vals.length) { row[h] = ''; return; }
      if (vals.some(v => v instanceof Date)) { row[h] = vals.find(v => v instanceof Date); return; }
      if (vals.some(v => typeof v === 'string' && v.charAt(0) === '=')) { row[h] = vals[0]; return; }
      const uniq = vals.map(String).filter((v, i, a) => a.indexOf(v) === i);
      row[h] = uniq.length === 1 ? vals[0] : uniq.join(' / ');
    });
    row['รหัสปัญหา'] = `${code}|${sns.join(',')}|${day}`;
    row['Inverter S/N'] = sns.join(', ');
    const least = list.reduce((a, r) => (rank(r['สถานะ']) < rank(a['สถานะ']) ? r : a), list[0]);
    row['สถานะ'] = least['สถานะ'];
    const enter = list.map(r => time(r['วันเข้าแก้ไข'])).filter(v => v !== null);
    row['วันเข้าแก้ไข'] = enter.length ? new Date(Math.min(...enter)) : '';
    const done = list.map(r => time(r['วันที่แก้ไขเสร็จ']));
    const allDone = list.every(r => DONE_STATUSES.indexOf(String(r['สถานะ'])) >= 0);
    row['วันที่แก้ไขเสร็จ'] = allDone && done.some(v => v !== null) ? new Date(Math.max(...done.filter(v => v !== null))) : '';
    return row;
  });
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
    rows = [].concat(...rows.map(splitIssue_));          // one row per inverter while the rows are worked out
  }
  const monthStart = new Date(y, m - 1, 1), monthEnd = new Date(y, m, 1);
  const inMonth = v => v instanceof Date && v >= monthStart && v < monthEnd;
  const ymd = d => Utilities.formatDate(d, 'Asia/Bangkok', 'yyyyMMdd');

  let kept = []; const byCode = {};                     // rows of other plants are kept; the scanned plants' rows by code
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
  kept = groupIssues_(kept);
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

/**
 * Overview "สถานี" column รายงานล่าสุด: the newest day each read plant has a checked row (dd/mm/พ.ศ.).
 * A sync of a month never moves the date back into an earlier month (syncMonth of last month), but within
 * its own month it follows the day sheets (a day cleared by mistake moves the date back).
 */
function writeLastReport_(overview, ym, results) {
  const codes = Object.keys(results).filter(c => results[c].lastReport !== undefined);
  if (!codes.length) return;
  const sh = overview.getSheetByName(STATIONS);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  if (head.indexOf(LAST_REPORT) < 0) {
    ensureSize_(sh, 1, head.length + 1);
    sh.getRange(1, head.length + 1).setValue(LAST_REPORT).setFontWeight('bold');
    head.push(LAST_REPORT);
  }
  const col = head.indexOf(LAST_REPORT) + 1, n = sh.getLastRow() - 1;
  if (n < 1) return;
  const keys = sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0]).trim());
  const cur = sh.getRange(2, col, n, 1).getValues();
  const inMonth = d => d instanceof Date && ym_(d) === ym;
  let changed = false;
  cur.forEach(r => {                                    // a date typed by hand: shown as พ.ศ. text like the rest
    if (r[0] instanceof Date) { r[0] = beText_(typedDate_(r[0])); changed = true; }
  });
  keys.forEach((code, k) => {
    const r = results[code];
    if (!r || r.lastReport === undefined) return;
    const was = typedDate_(cur[k][0]), now = r.lastReport;
    const take = !(was instanceof Date) || inMonth(was) || (now && now > was);
    const want = take ? (now ? beText_(now) : '') : cur[k][0];
    if (want !== cur[k][0]) { cur[k][0] = want; changed = true; }
  });
  if (changed) sh.getRange(2, col, n, 1).setNumberFormat('@').setValues(cur);
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
  // รายงานวันนี้ = plants whose รายงานล่าสุด (สถานี) is today / every plant in สถานี
  const ss = overview.getSheetByName(STATIONS);
  const sHead = ss.getRange(1, 1, 1, ss.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const lastCol = sHead.indexOf(LAST_REPORT) + 1;
  if (lastCol) {
    const L = letter_(lastCol);
    boxes.push([REPORTED_TODAY, `=COUNTIF('${STATIONS}'!$${L}$2:$${L},TEXT(TODAY(),"dd/mm/")&(YEAR(TODAY())+543))&"/"&COUNTA('${STATIONS}'!$A$2:$A)`]);
    addBox_(t, REPORTED_TODAY);
    try { todaySheet_(overview, sHead, stations.length); } catch (e) {      // never stops the sync: the reason goes to _log
      console.error(`ชีต ${REPORTED_TODAY}: ${e}`);
      warnings.push(`สร้างชีต "${REPORTED_TODAY}" ไม่ได้: ${e.message || e}`);
    }
  }
  try { fitIssueTable_(t); } catch (e) {               // never stops the sync: the reason goes to _log
    console.error(`ตารางปัญหา: ${e}`);
    warnings.push(`ขยายตัวกรอง / dropdown ของตารางปัญหาไม่ได้: ${e.message || e}`);
  }
  try { reportLog_(overview, ym, stations); } catch (e) {          // never stops the sync: the reason goes to _log
    console.error(`ชีต ${REPORT_LOG}: ${e}`);
    warnings.push(`เขียนชีต "${REPORT_LOG}" ไม่ได้: ${e.message || e}`);
  }
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
  const is = overview.getSheetByName(INVERTERS);
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

/**
 * Sheet "บันทึกรายงานรายวัน": one row per day of the synced month up to today (newest on top): how many plants
 * have a checked row in that day's sheet, how many have not, and which. Rows of other months are kept, so the
 * sheet is the record of every day. A day's row changes only when its counts change (a late report counts on
 * the day it is for); อัปเดตล่าสุด is when that was.
 */
const REPORT_LOG_HEAD = ['วันที่', 'ทำรายงานแล้ว', 'ยังไม่ทำรายงาน', 'สถานีทั้งหมด', '% ทำรายงาน', 'สถานีที่ยังไม่ทำรายงาน', 'อัปเดตล่าสุด'];
function reportLog_(overview, ym, stations) {
  const days = readDays_(PropertiesService.getScriptProperties(), ym);
  const lastDay = lastDayToRead_(ym);
  if (!days || lastDay < 1 || !stations.length) return;
  const [y, m] = ym.split('-').map(Number);
  const W = REPORT_LOG_HEAD.length;
  let sh = overview.getSheetByName(REPORT_LOG);
  const fresh = !sh;
  if (fresh) {
    const after = overview.getSheetByName(REPORTED_TODAY);
    sh = overview.insertSheet(REPORT_LOG, after ? 2 : 1);   // after รายงานวันนี้
    ensureSize_(sh, 2, W);
    trimSheet_(sh, Math.max(sh.getMaxRows(), 2), W);
    sh.getRange(1, 1, 1, W).setValues([REPORT_LOG_HEAD]).setFontWeight('bold').setBackground(COLOR.BLUE)
      .setHorizontalAlignment('center');
    sh.setFrozenRows(1);
    [110, 110, 120, 110, 100, 480, 140].forEach((px, k) => sh.setColumnWidth(k + 1, px));
  }
  const n = Math.max(sh.getLastRow() - 1, 0);
  const old = n ? sh.getRange(2, 1, n, W).getValues() : [];
  const byDate = {};
  old.forEach(r => { const k = String(r[0]).trim(); if (k) byDate[k] = r; });
  const key = t => { const [d, mo, be] = String(t).split('/').map(Number); return (be - 543) * 10000 + mo * 100 + d; };
  const stamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/') +
    (Number(Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy')) + 543) + Utilities.formatDate(new Date(), 'Asia/Bangkok', ' HH:mm');
  let changed = false;
  for (let d = 1; d <= lastDay; d++) {
    const day = beText_(new Date(y, m - 1, d));
    const missing = stations.filter(s => !reportedOn_(days[s.code], d)).map(s => s.code);
    const done = stations.length - missing.length;
    const row = [day, done, missing.length, stations.length, Math.round(done / stations.length * 1000) / 1000,
      missing.length ? missing.join(', ') : 'ครบทุกสถานี'];
    const was = byDate[day];
    if (was && row.every((v, k) => String(v) === String(was[k]))) continue;
    byDate[day] = row.concat([stamp]);
    changed = true;
  }
  if (!changed && !fresh) return;
  const out = Object.keys(byDate).sort((a, b) => key(b) - key(a)).map(k => byDate[k]);
  ensureSize_(sh, out.length + 1, W);
  sh.getRange(2, 1, out.length, 1).setNumberFormat('@');   // dd/mm/พ.ศ. stays text
  sh.getRange(2, 7, out.length, 1).setNumberFormat('@');
  sh.getRange(2, 5, out.length, 1).setNumberFormat('0.0%');
  sh.getRange(2, 1, out.length, W).setValues(out);
  sh.getRange(2, 1, out.length, 5).setHorizontalAlignment('center');
  sh.getRange(2, 6, out.length, 1).setWrap(true);
  if (n > out.length) sh.getRange(2 + out.length, 1, n - out.length, W).clearContent();
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

/**
 * The problem table's filter, colour rules and dropdowns reach the last row of the sheet. The Overview came
 * with them sized for a few rows (filter A9:N10, rules and dropdowns to row 210); rows the sync writes below
 * that were left out of the filter (its lists and sort saw only the first row) and had no dropdown or colour.
 * Only the parts that end too early are changed; the filter keeps the criteria it has.
 */
function fitIssueTable_(t) {
  const sh = t.sh, r0 = t.headRow + 1, last = sh.getMaxRows();
  if (last < r0) return;
  const f = sh.getFilter();
  if (f) {
    const g = f.getRange();
    if (g.getRow() === t.headRow && g.getLastRow() < last) {
      const c0 = g.getColumn(), w = g.getNumColumns(), criteria = [];
      for (let c = c0; c < c0 + w; c++) {
        const cr = f.getColumnFilterCriteria(c);
        if (cr) criteria.push([c, cr.copy().build()]);
      }
      f.remove();
      const nf = sh.getRange(t.headRow, c0, last - t.headRow + 1, w).createFilter();
      criteria.forEach(([c, cr]) => nf.setColumnFilterCriteria(c, cr));
    }
  }
  // colour rules whose range starts at the first table row: same rule, down to the last row
  let changed = false;
  const rules = sh.getConditionalFormatRules().map(rule => {
    let mine = false;
    const ranges = rule.getRanges().map(g => {
      if (g.getRow() !== r0 || g.getLastRow() >= last) return g;
      mine = true;
      return sh.getRange(r0, g.getColumn(), last - r0 + 1, g.getNumColumns());
    });
    if (!mine) return rule;
    changed = true;
    return rule.copy().setRanges(ranges).build();
  });
  if (changed) sh.setConditionalFormatRules(rules);
  // dropdowns / date checks of the first table row, down to the last row where the last row has none
  const first = sh.getRange(r0, 1, 1, t.width).getDataValidations()[0];
  const bottom = sh.getRange(last, 1, 1, t.width).getDataValidations()[0];
  first.forEach((v, k) => {
    if (v && !bottom[k]) sh.getRange(r0, k + 1, last - r0 + 1, 1).setDataValidation(v);
  });
}

/**
 * A box label missing above the problem table is added in the row of the other labels, right of the last
 * one (after its merged cells) and never over a hidden column (_open_station), with that box's format and
 * merges: the label across its width, the number under it across its width and rows (e.g. K4:M4 + K5:M6).
 * A label an earlier version put into a hidden column is taken out and the box made again.
 */
function addBox_(t, label) {
  const sh = t.sh;
  const hidden = col => col <= sh.getMaxColumns() && sh.isColumnHiddenByUser(col);
  let found = false;
  t.top.forEach((row, i) => row.forEach((v, k) => {
    if (String(v).trim() !== label) return;
    if (i < t.headRow - 1 && hidden(k + 1)) {           // out of sight: take the label and its number out
      sh.getRange(i + 1, k + 1, 2, 1).clearContent();
      row[k] = '';
    } else found = true;
  }));
  if (found) return;
  const r = t.top.findIndex((row, i) => i < t.headRow - 1 && row.some(v => String(v).trim() === 'ปัญหาทั้งหมด'));
  if (r < 0) return;
  let c = 0;
  t.top[r].forEach((v, k) => { if (String(v).trim() !== '' && !hidden(k + 1)) c = k + 1; });
  const span = (row, col) => { const m = sh.getRange(row, col).getMergedRanges(); return m.length ? m[0] : null; };
  const lab = span(r + 1, c), val = span(r + 2, c);
  const w = (lab ? lab.getLastColumn() : c) - c + 1;
  const bottom = val ? Math.max(val.getLastRow(), r + 2) : r + 2;   // the number's cell may span rows
  let at = c + w;
  for (let k = 0; k < w; k++) if (hidden(at + k)) { at += k + 1; k = -1; }   // w visible columns in a row
  ensureSize_(sh, bottom, at + w - 1);
  sh.getRange(r + 1, c, bottom - r, w)
    .copyTo(sh.getRange(r + 1, at, bottom - r, w), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  // merges are made here: copying a format does not merge the cells it is copied to
  sh.getRange(r + 1, at, bottom - r, w).breakApart();
  if (w > 1) sh.getRange(r + 1, at, 1, w).merge();
  if (w > 1 || bottom > r + 2) sh.getRange(r + 2, at, bottom - r - 1, w).merge();
  sh.getRange(r + 1, at).setValue(label);
  t.top[r][at - 1] = label;
}
