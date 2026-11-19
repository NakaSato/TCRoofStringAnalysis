// ============================================================ Overview (plants and inverters)

/** The Overview as a Google Sheet: itself, or a temporary converted copy when it is an .xlsx. */
function overviewSnapshot_(folder) {
  const file = overviewFile_();
  if (file.getMimeType() === MimeType.GOOGLE_SHEETS) return { id: file.getId(), temp: false };
  const copy = Drive.Files.copy({ name: TEMP_OVERVIEW, mimeType: MimeType.GOOGLE_SHEETS, parents: [folder.getId()] }, file.getId());
  return { id: copy.id, temp: true };
}

/** The sheet this script is bound to (null when it runs as a standalone script). */
function boundSheet_() {
  try { return SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { return null; }
}

/**
 * The root folder: where the months folder (CONFIG.MONTHS_FOLDER) is. It is the folder the Overview sheet is in,
 * read from Drive each time, so it follows the sheet when it is moved (CONFIG.ROOT_FOLDER_ID overrides).
 */
function rootId_() {
  if (CONFIG.ROOT_FOLDER_ID) return CONFIG.ROOT_FOLDER_ID;
  const id = CONFIG.OVERVIEW_ID || (boundSheet_() && boundSheet_().getId());
  if (!id) throw new Error('ไม่รู้ว่าไฟล์ Overview อยู่ที่ไหน — เปิดสคริปต์จากไฟล์ Overview (ส่วนขยาย ▸ Apps Script) หรือใส่ CONFIG.OVERVIEW_ID');
  const parents = DriveApp.getFileById(id).getParents();
  if (!parents.hasNext()) throw new Error('หาโฟลเดอร์ของไฟล์ Overview ไม่ได้ — ย้ายไฟล์ Overview เข้าโฟลเดอร์ที่บัญชีนี้เปิดได้ หรือใส่ CONFIG.ROOT_FOLDER_ID');
  return parents.next().getId();
}

function overviewFile_() {
  if (CONFIG.OVERVIEW_ID) return DriveApp.getFileById(CONFIG.OVERVIEW_ID);
  const bound = boundSheet_();
  if (bound) return DriveApp.getFileById(bound.getId());
  const it = DriveApp.getFolderById(rootId_()).getFiles();
  let best = null;
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed() || f.getName().indexOf(CONFIG.OVERVIEW_NAME) !== 0) continue;
    const isSheet = f.getMimeType() === MimeType.GOOGLE_SHEETS;
    const bestIsSheet = best && best.getMimeType() === MimeType.GOOGLE_SHEETS;
    // a Google Sheet wins over an .xlsx; otherwise the most recently edited one
    if (!best || (isSheet && !bestIsSheet) || (isSheet === bestIsSheet && f.getLastUpdated() > best.getLastUpdated())) best = f;
  }
  if (!best) throw new Error(`ไม่พบไฟล์ Overview (ชื่อขึ้นต้นด้วย "${CONFIG.OVERVIEW_NAME}") ในโฟลเดอร์หลัก`);
  return best;
}

function readTable_(overview, sheetName) {
  const sh = overview.getSheetByName(sheetName);
  if (!sh) throw new Error(`ไม่พบชีต "${sheetName}" ในไฟล์ Overview`);
  const values = sh.getDataRange().getValues();
  const head = values.shift().map(h => String(h).trim());
  return values.filter(r => String(r[0]).trim() !== '').map(r => {
    const row = {};
    head.forEach((h, i) => { row[h] = r[i]; });
    return row;
  });
}

function readStations_(overview) {
  const out = readTable_(overview, STATIONS).map(r => ({
    code: String(r['รหัส']).trim(),
    phase: r['ระยะ'],
    name: String(r['ชื่อสถานี'] || r['ชื่อสถานี (ใช้ในรายงาน)'] || '').trim(),
    kwp: r['กำลังติดตั้ง (kWp)'],
    contract: r['อายุสัญญา'],
    start: r['วันที่เริ่มให้บริการ'],
  }));
  const unnamed = out.filter(s => !s.name).map(s => s.code);
  if (unnamed.length) throw new Error(`สถานีไม่มีชื่อใน Overview: ${unnamed.join(', ')}`);
  return out.sort((x, y) => x.code.localeCompare(y.code));
}

/** { plant code: [{ no, sn, strings }] }, inverters in use only, in NO. order. */
function readInverters_(overview) {
  const out = {};
  readTable_(overview, INVERTERS).forEach(r => {
    if (String(r['ใช้งาน (Y/N)'] || 'Y').trim().toUpperCase() === 'N') return;
    const code = String(r['รหัส']).trim();
    (out[code] = out[code] || []).push({ no: r['NO.'], sn: String(r['Inverter S/N']).trim(), strings: r['จำนวนสตริง'] });
  });
  Object.keys(out).forEach(code => out[code].sort((x, y) => (Number(x.no) || 999) - (Number(y.no) || 999)));
  return out;
}
