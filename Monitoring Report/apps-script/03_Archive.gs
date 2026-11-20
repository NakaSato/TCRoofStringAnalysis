// ------------------------------------------------------------------ one file per month

/** The Drive folder for the monthly files: script property ARCHIVE_FOLDER_ID, else this file's folder. */
function archiveFolder_() {
  const id = PropertiesService.getScriptProperties().getProperty('ARCHIVE_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const parents = DriveApp.getFileById(SpreadsheetApp.getActive().getId()).getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}

/**
 * The past months that still have DD.MM tabs here and were not archived yet, oldest first:
 * [{key: "2026-10", label: "10/2026", file: "<name> 2026-10", tabs: ["01.10", …]}]. Tab names carry
 * no year: a month after the current one belongs to last year.
 */
function pastMonths_(ss, today) {
  const props = PropertiesService.getScriptProperties();
  const y = +today.slice(0, 4), cur = today.slice(5, 7);
  const by = {};
  ss.getSheets().forEach(s => {
    const m = /^\d{2}\.(\d{2})$/.exec(s.getName());
    if (!m || m[1] === cur || +m[1] < 1 || +m[1] > 12) return;
    const key = `${m[1] > cur ? y - 1 : y}-${m[1]}`;
    (by[key] = by[key] || []).push(s.getName());
  });
  return Object.keys(by).sort().filter(key => !props.getProperty('ARCHIVED_' + key))
    .map(key => ({ key, label: `${key.slice(5)}/${key.slice(0, 4)}`, file: `${ss.getName()} ${key}`, tabs: by[key] }));
}

/**
 * Saves each past month as its own Drive file and removes its tabs from this file. The month's file
 * is a copy of this spreadsheet with every other month's DD.MM tab deleted (other sheets are kept).
 * The tabs are deleted here only after the copy holds all of them. Returns
 * [{label, file, url, tabs: n}]; [] when there is nothing to archive.
 */
function archivePastMonths_(ss, today) {
  const months = pastMonths_(ss, today);
  if (!months.length) return [];
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return [];
  try {
    const props = PropertiesService.getScriptProperties();
    const name = sheetName_(today);
    if (!ss.getSheetByName(name)) newDaySheet_(ss, name); // this file must keep a tab (and a template)
    const folder = archiveFolder_();
    const out = [];
    months.forEach(m => {
      const copy = DriveApp.getFileById(ss.getId()).makeCopy(m.file, folder);
      const cs = SpreadsheetApp.openById(copy.getId());
      const kept = cs.getSheets().filter(s => m.tabs.indexOf(s.getName()) >= 0).length;
      if (kept !== m.tabs.length) {
        try { copy.setTrashed(true); } catch (e) { /* the incomplete file stays in Drive; the error below names it */ }
        throw new Error(`ไฟล์ "${m.file}" มี ${kept} แท็บ จากที่ควรมี ${m.tabs.length} แท็บ จึงยังไม่ลบแท็บออกจากไฟล์นี้`);
      }
      cs.getSheets().forEach(s => { if (/^\d{2}\.\d{2}$/.test(s.getName()) && m.tabs.indexOf(s.getName()) < 0) cs.deleteSheet(s); });
      m.tabs.forEach(t => ss.deleteSheet(ss.getSheetByName(t)));
      props.setProperty('ARCHIVED_' + m.key, copy.getId());
      out.push({ label: m.label, file: m.file, url: cs.getUrl(), tabs: kept });
    });
    return out;
  } finally { lock.releaseLock(); }
}

function archiveText_(done) {
  if (!done.length) return 'ไม่มีแท็บของเดือนก่อนให้เก็บ';
  return 'เก็บไฟล์รายเดือนแล้ว\n\n' + done.map(d => `เดือน ${d.label}: ${d.tabs} แท็บ → "${d.file}"\n${d.url}`).join('\n\n');
}
