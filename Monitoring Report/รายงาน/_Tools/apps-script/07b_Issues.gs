// ============================================================ 3b) sync: the Overview's problem table (รายงานการแก้ไข), Inverter status, last report

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
      // each different value once, also inside values that were joined before ("a / b" and "a" give "a / b")
      const uniq = [].concat(...vals.map(v => String(v).split(' / '))).filter((v, i, a) => a.indexOf(v) === i);
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
  const origin = new Map();
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
    // one row per inverter while the rows are worked out; origin = the shared row each one came from
    rows = [].concat(...rows.map(row => {
      const parts = splitIssue_(row);
      if (parts.length > 1) parts.forEach(x => origin.set(x, row['รหัสปัญหา']));
      return parts;
    }));
  }
  const monthStart = new Date(y, m - 1, 1), monthEnd = new Date(y, m, 1);
  const inMonth = v => v instanceof Date && v >= monthStart && v < monthEnd;
  const ymd = d => Utilities.formatDate(d, 'Asia/Bangkok', 'yyyyMMdd');
  // Syncing last month on days 1–7: a row the new month's sync took on (its รายงาน links the plant's file of a
  // later month) is that month's now. This month's day sheets do not write it back to how it was at the month
  // end (fix, status, done day), nor add a second open row beside it.
  const later = laterFiles_(overview, `${y}-${String(m).padStart(2, '0')}`);
  const taken = (code, r) => !!later[code] && sheetFileId_(r['รายงาน']) === later[code];

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
        const before = r => String(r['รหัสปัญหา']).split('|')[1] === ep.sn && r['วันที่พบ'] instanceof Date && r['วันที่พบ'] < monthStart;
        // ... the open one, else one this month closed (done in this month), so the next sync finds it again
        row = mine.find(r => before(r) && DONE_STATUSES.indexOf(String(r['สถานะ'])) < 0) ||
          mine.find(r => before(r) && (inMonth(r['วันที่แก้ไขเสร็จ']) || taken(code, r)));
      }
      if (row && taken(code, row)) { if (used.indexOf(row) < 0) used.push(row); return; }   // a later month's row
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
    // A shared row of an earlier month that goes on in this month for some of its inverters only: the others'
    // problem ended in that month (their own status was lost when the row was shared), so they take the values
    // of an inverter that goes on. The row then closes when that one is fixed, and is not split or doubled.
    const goesOn = {};
    used.forEach(row => { const o = origin.get(row); if (o && !goesOn[o]) goesOn[o] = row; });
    // a row of this month that the day sheets no longer show was typed by mistake and then cleared
    mine.forEach(row => {
      if (used.indexOf(row) >= 0 || inMonth(row['วันที่พบ'])) return;
      const twin = goesOn[origin.get(row)];
      if (twin) Object.keys(twin).forEach(h => { if (h !== 'รหัสปัญหา' && h !== 'Inverter S/N') row[h] = twin[h]; });
      used.push(row);
    });
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

/**
 * { plant code: file id } of the plants whose "สถานี" ไฟล์รายงาน links a month later than `ym` (finishSync_
 * writes =HYPERLINK(".../d/<id>/edit","<ym>") and a sync of last month leaves a later one as it is).
 */
function laterFiles_(overview, ym) {
  const out = {};
  const sh = overview.getSheetByName(STATIONS);
  const n = sh ? sh.getLastRow() - 1 : 0;
  if (n < 1) return out;
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const codeCol = head.indexOf('รหัส'), linkCol = head.indexOf('ไฟล์รายงาน');
  if (codeCol < 0 || linkCol < 0) return out;
  const all = sh.getRange(2, 1, n, head.length);
  const values = all.getValues(), formulas = all.getFormulas();
  values.forEach((r, i) => {
    const link = /,"(\d{4}-\d{2})"\)\s*$/.exec(String(formulas[i][linkCol] || ''));
    const id = link && link[1] > ym && sheetFileId_(formulas[i][linkCol]);
    if (id) out[String(r[codeCol]).trim()] = id;
  });
  return out;
}

/** The spreadsheet id in a link (=HYPERLINK("https://docs.google.com/spreadsheets/d/<id>/edit…")), else ''. */
function sheetFileId_(v) {
  const m = /\/spreadsheets\/d\/([^/"#?]+)/.exec(String(v || ''));
  return m ? m[1] : '';
}

/**
 * Overview "Inverter": the newest Inverter Status typed in the day sheets, and its day. Like รายงานล่าสุด,
 * a sync of a month never moves them back from a later month (syncing last month on days 1–7), but within
 * its own month it follows the day sheets.
 */
function writeInverterStatus_(overview, ym, invStatus) {
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
  const [y, m] = ym.split('-').map(Number);
  const later = d => d instanceof Date && d.getFullYear() * 100 + d.getMonth() + 1 > y * 100 + m;
  sns.forEach((r, k) => {
    let v = invStatus[String(r[0]).trim()];
    if (v && later(typedDate_(day[k][0]))) v = null;   // a later month's status stays
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
