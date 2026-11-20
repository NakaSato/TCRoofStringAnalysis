// ============================================================ archive: closed problems of a past year

/** Years (A.D.) whose closed problems were moved out of the Overview (script property `archived`). */
function archivedYears_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('archived') || '[]'); } catch (e) { return []; }
}

/**
 * Moves the problems of year `year` (พ.ศ. or ค.ศ.) whose สถานะ is แก้ไขแล้ว / ปิดงาน from the Overview's
 * "รายงานการแก้ไข" into the Google Sheet "<ARCHIVE_PREFIX><พ.ศ.>" in the root folder (made when missing).
 * Open problems stay: a problem that goes on into the next months needs its row. Only a year that is over
 * including last month, which can still be synced (in January, last year's December still can: that year
 * waits until February). Rows already in the archive are not added twice, so a run that stopped half-way
 * can be run again. That year's months are not synced afterwards.
 */
function archiveYear(year) {
  let y = Number(year);
  if (y >= 2400) y -= 543;
  const now = new Date(), lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  if (!(y >= 2000) || y >= now.getFullYear()) throw new Error(`ย้ายได้เฉพาะปีก่อนปีนี้ (ได้รับ: ${year})`);
  if (y >= lastMonth.getFullYear()) {                   // January: last year's December can still be synced
    throw new Error(`ปี พ.ศ. ${y + 543} ยังซิงก์เดือนธันวาคมได้ — ย้ายได้ตั้งแต่เดือนกุมภาพันธ์`);
  }
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('มีงานอื่นกำลังทำงาน — ลองใหม่อีกครั้ง');
  try {
    // checked under the lock: a scheduled sync cannot start in between (a job of an old root folder is dropped)
    if (dropStaleJob_(props, props.getProperties()).job) throw new Error(`มีงานค้างอยู่ (${status()}) — รอให้เสร็จก่อน`);
    const file = overviewFile_();
    if (file.getMimeType() !== MimeType.GOOGLE_SHEETS) {
      throw new Error('Overview ยังเป็นไฟล์ .xlsx — ให้รัน convertOverview() หนึ่งครั้งก่อน');
    }
    const overview = SpreadsheetApp.openById(file.getId());
    const t = issueTable_(overview), sh = t.sh;
    const n = Math.max(sh.getLastRow() - t.headRow, 0);
    if (!n) return `ไม่มีปัญหาในตาราง`;
    const range = sh.getRange(t.headRow + 1, 1, n, t.width);
    const values = range.getValues(), formulas = range.getFormulas();
    const raw = values.map((r, i) => r.map((v, k) => formulas[i][k] || v));
    const keyCol = t.col['รหัสปัญหา'] - 1, foundCol = t.col['วันที่พบ'] - 1, stCol = t.col['สถานะ'] - 1;
    const moving = [], staying = [];
    const noCol = t.col['No.'] ? t.col['No.'] - 1 : -1;
    raw.forEach((r, i) => {
      const found = typedDate_(values[i][foundCol]);
      const go = String(r[keyCol] || '').trim() !== '' && found instanceof Date && found.getFullYear() === y &&
        found < lastMonth && DONE_STATUSES.indexOf(String(values[i][stCol]).trim()) >= 0;
      (go ? moving : staying).push(r);
    });
    if (!moving.length) return `ไม่มีปัญหาที่ปิดแล้วของปี พ.ศ. ${y + 543} ในตาราง`;

    // 1) the archive first: if anything stops after this, the rows are in both places, never in none
    const name = `${ARCHIVE_PREFIX}${y + 543}`;
    const root = DriveApp.getFolderById(rootId_());
    const it = root.getFilesByName(name);
    let ss = null;
    while (it.hasNext()) { const f = it.next(); if (!f.isTrashed() && f.getMimeType() === MimeType.GOOGLE_SHEETS) { ss = SpreadsheetApp.openById(f.getId()); break; } }
    if (!ss) {
      ss = SpreadsheetApp.create(name);
      DriveApp.getFileById(ss.getId()).moveTo(root);
    }
    const ash = ss.getSheets()[0];
    if (ash.getName() !== ISSUES) ash.setName(ISSUES);
    if (ash.getLastRow() < 1) ash.getRange(1, 1, 1, t.width).setValues([t.head]).setFontWeight('bold');
    const have = new Set(ash.getLastRow() > 1 ? ash.getRange(2, keyCol + 1, ash.getLastRow() - 1, 1).getValues().map(r => String(r[0])) : []);
    const add = moving.filter(r => !have.has(String(r[keyCol])));
    if (add.length) {
      const r0 = ash.getLastRow() + 1;
      ensureSize_(ash, r0 + add.length - 1, t.width);
      // only the date columns as text (dates stay dd/mm/พ.ศ.): a text cell would keep =HYPERLINK(...) as text
      ISSUE_DATES.forEach(h => { if (t.col[h]) ash.getRange(r0, t.col[h], add.length, 1).setNumberFormat('@'); });
      ash.getRange(r0, 1, add.length, t.width).setValues(add);
    }
    SpreadsheetApp.flush();

    // 2) the Overview keeps the other rows: written over the old ones, the rows left below cleared
    if (staying.length) {
      if (noCol >= 0) staying.forEach((r, i) => { r[noCol] = i + 1; });   // numbered 1… again, as upsertIssues_ does
      ISSUE_DATES.forEach(h => { if (t.col[h]) sh.getRange(t.headRow + 1, t.col[h], staying.length, 1).setNumberFormat('@'); });
      sh.getRange(t.headRow + 1, 1, staying.length, t.width).setValues(staying);
    }
    sh.getRange(t.headRow + 1 + staying.length, 1, moving.length, t.width).clearContent();

    const years = archivedYears_();
    if (years.indexOf(y) < 0) { years.push(y); props.setProperty('archived', JSON.stringify(years.sort())); }
    const msg = `ย้ายปัญหาที่ปิดแล้วของปี พ.ศ. ${y + 543} ${moving.length} แถว ไปไฟล์ "${name}"` +
      (add.length < moving.length ? ` (${moving.length - add.length} แถวมีในไฟล์เก็บอยู่แล้ว)` : '');
    note_(props, msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}
