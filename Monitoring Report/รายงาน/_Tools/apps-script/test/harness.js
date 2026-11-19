const fs = require('fs'), vm = require('vm');
const [codePath, ovPath] = process.argv.slice(2);
const ov = JSON.parse(fs.readFileSync(ovPath, 'utf8'));
let seq = 0; const files = {};
const colN = s => s.split('').reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);
function parseA1(a) { const m = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/.exec(a); if (!m) throw new Error('bad A1 ' + a);
  const c1 = colN(m[1]), r1 = +m[2], c2 = m[3] ? colN(m[3]) : c1, r2 = m[4] ? +m[4] : r1; return [r1, c1, r2 - r1 + 1, c2 - c1 + 1]; }
class Sheet {
  constructor(ss, name, id) { Object.assign(this, { ss, name, id, rows: 1000, cols: 26, cells: {}, merges: [], hidden: false }); }
  setName(n) { this.name = n; return this; } getName() { return this.name; } getSheetId() { return this.id; }
  getMaxRows() { return this.rows; } getMaxColumns() { return this.cols; }
  deleteRows(a, n) { const c = {}; for (const k in this.cells) { const [r, col] = k.split(',').map(Number); if (r < a) c[k] = this.cells[k]; else if (r >= a + n) c[`${r - n},${col}`] = this.cells[k]; } this.cells = c; this.rows -= n; } deleteColumns(a, n) { this.cols -= n; }
  insertRowsAfter(a, n) { if (a !== this.rows) throw new Error('insertRowsAfter not at end'); this.rows += n; }
  insertColumnsAfter(a, n) { if (a !== this.cols) throw new Error('insertColsAfter not at end'); this.cols += n; }
  insertImage(b, c, r) { if (!b) throw new Error('no blob'); this.images = (this.images || 0) + 1; const o = { setHeight: () => o, setWidth: () => o }; return o; } getImages() { return Array(this.images || 0).fill(0); } setHiddenGridlines() { return this; } setFrozenRows() {} hideSheet() { this.hidden = true; } setColumnWidth() {} setRowHeight() {} setRowHeights() {} setConditionalFormatRules() {}
  _ext() { let r = 0, c = 0; for (const k in this.cells) { if (this.cells[k] === '' ) continue; const [a, b] = k.split(',').map(Number); r = Math.max(r, a); c = Math.max(c, b); } return [r, c]; }
  getLastRow() { return this._ext()[0]; } getLastColumn() { return this._ext()[1]; }
  getDataRange() { const [r, c] = this._ext(); return this.getRange(1, 1, Math.max(r, 1), Math.max(c, 1)); }
  appendRow(v) { const r = this.getLastRow() + 1; if (r > this.rows) this.rows = r; v.forEach((x, i) => { this.cells[`${r},${i + 1}`] = x; }); }
  copyTo(ss) { const s = new Sheet(ss, 'Copy' + (++seq), ++seq); Object.assign(s, { rows: this.rows, cols: this.cols, cells: { ...this.cells }, images: this.images || 0 }); ss.sheets.push(s); return s; }
  getRange(a, b, c, d) { const [r, col, nr, nc] = typeof a === 'string' ? parseA1(a) : [a, b, c || 1, d || 1];
    if (r < 1 || col < 1 || nr < 1 || nc < 1 || r + nr - 1 > this.rows || col + nc - 1 > this.cols) throw new Error(`range oob ${this.name} ${JSON.stringify([a, b, c, d])} (sheet ${this.rows}x${this.cols})`);
    return new Range(this, r, col, nr, nc); }
}
const isF = v => typeof v === 'string' && v.startsWith('=');
class Range { constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr, nc }); }
  _grid(fn) { return Array.from({ length: this.nr }, (_, i) => Array.from({ length: this.nc }, (_, j) => fn(this.sh.cells[`${this.r + i},${this.c + j}`]))); }
  getValues() { return this._grid(v => v === undefined ? '' : isF(v) ? (/HYPERLINK\(.*,"(.*)"\)/.exec(v) || [, '#F'])[1] : v); }
  getFormulas() { return this._grid(v => isF(v) ? v : ''); }
  getValue() { return this.getValues()[0][0]; }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) delete this.sh.cells[`${this.r + i},${this.c + j}`]; return this; }
  _set(v2d, f) { if (v2d.length !== this.nr || v2d.some(x => x.length !== this.nc)) throw new Error(`dims mismatch ${this.sh.name} r${this.r}c${this.c}: range ${this.nr}x${this.nc}, data ${v2d.length}x${(v2d[0] || []).length}`);
    v2d.forEach((row, i) => row.forEach((v, j) => { if (v === undefined || v === null) throw new Error('undefined value'); if (f && !isF(v)) throw new Error('not a formula: ' + v); this.sh.cells[`${this.r + i},${this.c + j}`] = v; })); return this; }
  setValues(v) { return this._set(v); } setFormulas(v) { return this._set(v, true); }
  setValue(v) { this.sh.cells[`${this.r},${this.c}`] = v; return this; } setFormula(v) { if (!isF(v)) throw new Error('not formula ' + v); return this.setValue(v); }
  merge() { return this; } mergeAcross() { return this; } }
for (const m of ['setFontFamily', 'setFontSize', 'setHorizontalAlignment', 'setVerticalAlignment', 'setWrap', 'setFontWeight', 'setBackground', 'setNumberFormat', 'setDataValidation', 'setBorder', 'setFontColor']) Range.prototype[m] = function () { return this; };
class SS { constructor(id, name) { this.id = id; this.name = name; this.sheets = [new Sheet(this, 'Sheet1', ++seq)]; }
  getId() { return this.id; } getSheets() { return this.sheets; } setSpreadsheetLocale() {} setSpreadsheetTimeZone(z) { this.tz = z; } getSpreadsheetTimeZone() { return this.tz || "Etc/GMT"; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n, idx) { const s = new Sheet(this, n, ++seq); idx === undefined ? this.sheets.push(s) : this.sheets.splice(idx, 0, s); return s; } }
class File { constructor(id, name, mime, parent, ss) { Object.assign(this, { id, name, mime, parent, ss, trashed: false }); files[id] = this; }
  getId() { return this.id; } getName() { return this.name; } getMimeType() { return this.mime; } isTrashed() { return this.trashed; } setTrashed(t) { this.trashed = t; }
  getLastUpdated() { if (globalThis.__old) return new Date(this.lastTime || 0); this.lastTime = this.editedAt || Date.now(); return new Date(this.lastTime); }   /* __old: not edited since = the time it had */ moveTo(f) { this.parent = f.id; } getUrl() { return 'url/' + this.id; }
  makeCopy(name, folder) { const id = 'f' + (++seq); const ss = new SS(id, name); ss.sheets = []; this.ss.sheets.forEach(s => { const c = s.copyTo(ss); c.name = s.name; c.id = s.id; c.hidden = s.hidden; }); return new File(id, name, this.mime, folder.id, ss); }
  getFoldersByName(n) { return iter(Object.values(files).filter(f => f.parent === this.id && f.mime === 'folder' && f.name === n)); }
  createFolder(n) { return new File('f' + (++seq), n, 'folder', this.id); }
  getParents() { return iter(this.parent ? [files[this.parent]] : []); } getFilesByName(n) { return iter(Object.values(files).filter(f => f.parent === this.id && f.mime !== 'folder' && f.name === n)); } getBlob() { return 'PNG'; }
  getFiles() { return iter(Object.values(files).filter(f => f.parent === this.id && f.mime !== 'folder')); }
  searchFiles() { return iter(Object.values(files).filter(f => f.parent === this.id && !f.trashed)); } }
const iter = a => { let i = 0; return { hasNext: () => i < a.length, next: () => a[i++] }; };
const GS = 'application/vnd.google-apps.spreadsheet';
const root = new File('1Z84sAP79HRmdkoUI09Yr3T3auhctsRdV', 'root', 'folder', null);
new File('ovx', '00_Overview_รายงานการแก้ไข.xlsx', 'xlsx', root.id);
const props = {}; const triggers = []; const events = [];
const chain = () => new Proxy(function () {}, { get: (t, k) => k === 'build' ? () => ({}) : (...a) => chain(), apply: () => chain() });
const pad = (n, w = 2) => String(n).padStart(w, '0');
function fmt(d, tz, f) { const b = new Date(d.getTime() + 7 * 3600000); const o = { yyyy: b.getUTCFullYear(), MM: pad(b.getUTCMonth() + 1), M: b.getUTCMonth() + 1, dd: pad(b.getUTCDate()), d: b.getUTCDate(), HH: pad(b.getUTCHours()), mm: pad(b.getUTCMinutes()) };
  return f.replace(/yyyy|MM|dd|HH|mm|M|d/g, k => o[k]); }
// what the Sheets API would return: values; the info-sheet references of the inverter table are resolved, other formulas read as ''
function apiValues(ss, a1) { const m = /^'(.+)'!(.+)$/.exec(a1); const sh = ss.getSheetByName(m[1]); if (!sh) throw new Error('no sheet ' + m[1]); const [r, c, nr, nc] = parseA1(m[2]); const info = ss.getSheetByName('_ข้อมูลสถานี');
  const out = []; for (let i = r; i < r + nr && i <= sh.rows; i++) { const row = []; for (let j = c; j < c + nc && j <= sh.cols; j++) { let v = sh.cells[`${i},${j}`]; if (isF(v) && v.startsWith('="กำลังการผลิต')) v = 'กำลังการผลิต x'; if (isF(v) && v.startsWith('=IF(AND(YEAR(TODAY())')) v = 'วันนี้'; if (isF(v)) { const ref = /^=IF\('_ข้อมูลสถานี'!B(\d+)="","",'_ข้อมูลสถานี'!([ABC])\d+\)$/.exec(v); v = ref ? (info.cells[`${ref[1]},${colN(ref[2])}`] ?? '') : ''; } if (v instanceof Date) v = 46000; row.push(v === undefined ? '' : v); } while (row.length && row[row.length - 1] === '') row.pop(); out.push(row); }
  while (out.length && !out[out.length - 1].length) out.pop(); return out.length ? out : undefined; }
const ctx = { console, Set, Map, Date, Object, Math, Number, String, JSON, isNaN, Array,
  MimeType: { GOOGLE_SHEETS: GS },
  SpreadsheetApp: { getActiveSpreadsheet: () => ctx.__bound || null, create: n => { const id = 'f' + (++seq); const ss = new SS(id, n); new File(id, n, GS, null, ss); return ss; }, openById: id => { if (!files[id] || !files[id].ss) throw new Error('cannot open ' + id); return files[id].ss; }, flush() {}, newDataValidation: () => chain(), newConditionalFormatRule: () => chain(), BorderStyle: { SOLID: 1, SOLID_MEDIUM: 2 } },
  DriveApp: { getFolderById: id => files[id], getFileById: id => { if (id === '1Ic106EgW9ceYs8JOAXSfViAwh1YFqb4T') return { getBlob: () => 'PNG' }; if (!files[id]) throw new Error('no file ' + id); return files[id]; } },
  Drive: { Files: { list: o => { ctx.__lists = (ctx.__lists || 0) + 1; const all = /^'(.+)' in parents and trashed = false$/.exec(o.q); if (all) { ctx.__lists--; ctx.__folderLists = (ctx.__folderLists || 0) + 1; return { files: Object.values(files).filter(f => f.parent === all[1] && !f.trashed).map(f => ({ id: f.id, name: f.name, modifiedTime: f.getLastUpdated().toISOString() })) }; } const m = /^'(.+)' in parents and trashed = false and modifiedTime > '(.+)'$/.exec(o.q); if (!m) throw new Error('bad q ' + o.q); const t = new Date(m[2]).getTime(); return { files: Object.values(files).filter(f => f.parent === m[1] && !f.trashed && f.getLastUpdated().getTime() > t).slice(0, o.pageSize).map(f => ({ id: f.id, modifiedTime: f.getLastUpdated().toISOString() })) }; },
    get: id => ({ modifiedTime: new Date(ctx.__ovEdit || 0).toISOString() }), copy: (res, id) => { const nid = 'f' + (++seq); const ss = new SS(nid, res.name); ss.sheets = Object.keys(ov).map(n => { const s = new Sheet(ss, n, ++seq); s.rows = ov[n].rows; s.cols = ov[n].cols; for (const k in ov[n].cells) { const v = ov[n].cells[k]; s.cells[k] = v && v.__date ? new Date(v.__date) : v; } return s; }); new File(nid, res.name, GS, res.parents[0], ss); return { id: nid }; } } },
  Sheets: { Spreadsheets: { batchUpdate: (req, id) => { if (!req.requests[0].mergeCells) { ctx.__fmt = (ctx.__fmt || 0) + 1; ctx.__reqs = req.requests; req.requests.filter(q => q.updateCells).forEach(q => { const u = q.updateCells; const sh = files[id].ss.sheets.find(x => x.id === u.start.sheetId); sh.cells[`${u.start.rowIndex + 1},${u.start.columnIndex + 1}`] = u.rows[0].values[0].userEnteredValue.stringValue; }); return; } ctx.__today = (ctx.__today || 0) + 1; const sm = files[id].ss.sheets.find(x => x.id === req.requests[0].mergeCells.range.sheetId); sm.cells['4,1'] = req.requests[1].repeatCell.cell.userEnteredValue.formulaValue; }, get: id => ({ sheets: files[id].ss.sheets.map(s => ({ properties: { sheetId: s.id, title: s.name } })) }),
    Values: { batchGet: (id, o) => ({ valueRanges: o.ranges.map(r => ({ values: apiValues(files[id].ss, r) })) }),
      update: (req, id, range) => { ctx.__sub = (ctx.__sub || 0) + 1; const m = /^'(.+)'!(.+)$/.exec(range); files[id].ss.getSheetByName(m[1]).getRange(m[2]).setValue(req.values[0][0]); }, batchUpdate: (req, id) => { ctx.__writes = (ctx.__writes || 0) + 1; req.data.forEach(d => { const m = /^'(.+)'!(.+)$/.exec(d.range); const [r, c, nr, nc] = parseA1(m[2]); files[id].ss.getSheetByName(m[1]).getRange(r, c, nr, nc).setValues(d.values); }); } } } },
  CalendarApp: { getCalendarsByName: n => ctx.__cal && ctx.__cal.name === n ? [ctx.__cal] : [], createCalendar: n => (ctx.__cal = { name: n, isOwnedByMe: () => true, getId: () => 'cal1',
      getEvents: (a, b) => events.filter(e => e.start >= a && e.start < b).map(e => ({ getTitle: () => e.title, getStartTime: () => e.start, isAllDayEvent: () => false })),
      createEventSeries: (title, start, end, rec) => { for (let k = 0; k < 60; k++) events.push({ title, start: new Date(start.getTime() + k * 86400000 * (title.includes('สร้าง') ? 30 : 1)) }); } }), newRecurrence: () => chain() },
  PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({ ...props }), getProperty: k => props[k] ?? null, getKeys: () => Object.keys(props), setProperty: (k, v) => { props[k] = String(v); }, setProperties: o => Object.assign(props, o), deleteProperty: k => { delete props[k]; } }) },
  ScriptApp: { getProjectTriggers: () => triggers.map(t => ({ getHandlerFunction: () => t.fn, _t: t })), deleteTrigger: t => triggers.splice(triggers.indexOf(t._t), 1), newTrigger: fn => { const t = { fn }; const o = new Proxy({}, { get: (_, k) => k === 'create' ? () => triggers.push(t) : (...a) => { if (k === 'at') t.at = a[0]; if (k === 'forUserCalendar') t.cal = a[0]; return o; } }); return o; } },
  LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
  Utilities: { formatDate: fmt } };
vm.createContext(ctx); vm.runInContext(fs.readFileSync(codePath, 'utf8') + '\n;globalThis.__api={calendarCreate,cancelJob,plantFile_,folderFiles_,rootId_,monthFolder_,findMonthFolder_,overviewFile_,typedDate_,setSyncInterval,intervalSync,archiveYear,syncMonth,status,menuSyncAll,createThisMonth,continueJob,syncNow,convertOverview,setup,planTriggers,calendarSync,CONFIG,layout_,ym_};', ctx);
const api = ctx.__api; api.CONFIG.ROOT_FOLDER_ID = '1Z84sAP79HRmdkoUI09Yr3T3auhctsRdV';   /* first as a standalone script: fixed ids, Overview found by name */ const drain = () => { let n = 0; while (triggers.some(t => t.fn === 'continueJob')) { api.continueJob(); if (++n > 5000) throw new Error('loop'); } };
const A = n => { let s = ''; while (n) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); } return s; };
const show = (sh, rows, maxc = 99) => rows.forEach(r => { const o = []; for (let c = 1; c <= Math.min(sh.cols, maxc); c++) { const v = sh.cells[`${r},${c}`]; if (v !== undefined && v !== '') o.push(A(c) + r + '=' + (v instanceof Date ? fmt(v, '', 'dd/MM/yyyy') : String(v).slice(0, 95))); } if (o.length) console.log('   ' + o.join(' | ')); });
// 1) xlsx only → sync refuses; convert; create month
try { api.syncNow(); console.log('ERROR: sync ran on xlsx'); } catch (e) { console.log('sync on xlsx →', String(e).slice(0, 80)); }
api.convertOverview();
const ovFile = Object.values(files).find(f => f.mime === GS && f.name.startsWith('00_Overview')); const O = ovFile.ss;
const mf = root.createFolder(api.ym_(new Date())); const oldX = new File('x1', 'P3-002_สถานีผลิตจ่ายน้ำกุดตาเพชร_' + mf.name + '.xlsx', 'xlsx', mf.id); const other = new File('x2', 'notes.xlsx', 'xlsx', mf.id);
api.createThisMonth(); drain();
const ym = api.ym_(new Date()); const today = +fmt(new Date(), '', 'd');
const folder = Object.values(files).find(f => f.name === ym);
const plant = code => Object.values(files).find(f => f.parent === folder.id && f.name.startsWith(code) && !f.trashed);
console.log('created', Object.values(files).filter(f => f.parent === folder.id && !f.trashed).length, 'files for', ym, '· today is day', today);
console.log('old xlsx trashed:', oldX.trashed, '· unrelated xlsx trashed:', other.trashed);
const sm = plant('P1-002').ss.getSheetByName('สรุปเดือน'); sm.cells['3,1'] = '=old'; 
// 2) reporter types into P1-001 (several inverters) and P3-002
const p1 = plant('P1-001').ss, L1 = api.layout_(p1.getSheetByName('_ข้อมูลสถานี').getLastRow() - 10);
const day = (ss, d) => ss.getSheetByName(`วันที่ ${d}`); const put = (sh, a1, v) => sh.getRange(a1).setValue(v);
const d0 = today - 2, d1 = today - 1, d2 = today;
for (const d of [d0, d1, d2]) for (let r = L1.inv0; r <= L1.inv1; r++) { put(day(p1, d), `G${r}`, 0); put(day(p1, d), `J${r}`, 'Online'); }
put(day(p1, d0), 'G17', 2); put(day(p1, d0), 'H17', '3,4'); put(day(p1, d0), 'K17', 'กระแสต่ำ'); put(day(p1, d0), `I${L1.issue0}`, 'รอเข้าพื้นที่'); put(day(p1, d0), `L${L1.issue0}`, 'ต้า');
put(day(p1, d1), 'G17', 2); put(day(p1, d1), 'H17', '3,4'); put(day(p1, d1), 'K17', 'กระแสต่ำ'); put(day(p1, d1), `I${L1.issue0}`, 'เปลี่ยน MC4'); put(day(p1, d1), `K${L1.issue0}`, 'แก้ไขแล้ว'); put(day(p1, d1), `M${L1.issue0}`, new Date());
put(day(p1, d1), 'J18', 'Fault'); put(day(p1, d1), 'K18', 'AFCI');   // inverter 2 from yesterday, still today
put(day(p1, d2), 'J18', 'Fault'); put(day(p1, d2), 'K18', 'AFCI'); put(day(p1, d2), `L${L1.issue0 + 1}`, 'เอก');
const p3 = plant('P3-002').ss; put(day(p3, d2), 'G17', 4); put(day(p3, d2), 'H17', '1,2,3,4'); put(day(p3, d2), 'J17', 'Online'); put(day(p3, d2), 'K17', 'AFCI, ST2 No Voltage');
// 3) Overview edits: kWp and a replaced inverter
const st = O.getSheetByName('สถานี'), iv = O.getSheetByName('Inverter');
st.getRange('F2').setValue(500); const oldSn = iv.cells['4,4']; iv.getRange('D4').setValue('NEWSN00001');
ctx.__writes = 0; api.syncNow(); drain();
console.log('plant files rewritten from Overview:', ctx.__writes, '· P1-001 info B2 =', p1.getSheetByName('_ข้อมูลสถานี').cells['2,2'], '· inverter 2 S/N', oldSn, '→', p1.getSheetByName('_ข้อมูลสถานี').cells['12,2']);
const T = O.getSheetByName('รายงานการแก้ไข');
console.log('subtitle repaired on', ctx.__sub, 'file(s):', sm.cells['3,1']);
console.log('--- Overview รายงานการแก้ไข'); show(T, [2, 5, 10, 11, 12, 13]);
console.log('--- Overview Inverter (header + P1-001 rows)'); show(iv, [1, 2, 4].map(r => r), 99);
console.log('--- Overview สถานี row 2'); show(st, [2]);
console.log('--- _log'); show(O.getSheetByName('_log'), [1, 2, 3, 4]);
// 4) idempotency
api.syncNow(); drain(); const snap = sh => JSON.stringify(Object.entries(sh.cells).filter(([k, v]) => v !== '' && k !== '2,1').sort());
const b1 = [T, iv, st].map(snap); ctx.__writes = 0; api.syncNow(); drain(); const b2 = [T, iv, st].map(snap);
console.log('repeat sync identical (issues, Inverter, สถานี):', b1.map((x, i) => x === b2[i]).join(', '), '· plant files rewritten:', ctx.__writes, '· props left:', Object.keys(props).length);
console.log('   rows now:', [10, 11, 12].map(r => T.cells[`${r},2`]).join('  '), '· NEWSN status:', iv.cells['4,10']);
put(day(p3, d2), 'G17', 0); api.syncNow(); drain();
console.log('after clearing P3-002: rows =', T.getLastRow() - 9);
// 4b) incremental: nothing edited → nothing read; an Overview change or a full sync → everything read
{ const snap2 = () => JSON.stringify([T, iv].map(snap)); const before = snap2();
  globalThis.__old = true; api.syncNow(); drain(); console.log('unedited files: table identical =', before === snap2(), '·', props.last);
  api.startSync_ ? 0 : 0; api.menuSyncAll ? (api.menuSyncAll(), drain(), console.log('full sync:', props.last)) : 0;
  const c = st.cells['2,6']; st.cells['2,6'] = 501; api.syncNow(); drain(); console.log('after Overview change:', props.last, '· P1-001 B2 =', p1.getSheetByName('_ข้อมูลสถานี').cells['2,2']); st.cells['2,6'] = c;
  globalThis.__old = false; api.syncNow(); drain(); }
{ const sm2 = p1.getSheetByName('สรุปเดือน'); console.log('A4 built:', sm2.cells['4,1']); const keep = sm2.cells['4,1']; sm2.cells['4,1'] = ''; api.syncNow(); drain(); console.log('today link repaired on', ctx.__today, 'file(s), same formula:', sm2.cells['4,1'] === keep); }
{ const sm3 = p1.getSheetByName('สรุปเดือน'), inf = p1.getSheetByName('_ข้อมูลสถานี'), d16 = p1.getSheetByName('วันที่ 16');
  console.log('G21:', sm3.cells['21,7'], '· H21:', sm3.cells['21,8'], '· version', inf.cells['7,2'], '· day header I/J:', d16.cells['23,9'], '/', d16.cells['23,10']);
  const keep = sm3.cells['21,7']; sm3.cells['21,7'] = ''; d16.cells['23,10'] = ''; inf.cells['7,2'] = ''; ctx.__fmt = 0; api.syncNow(); drain();
  console.log('old file repaired:', ctx.__fmt, 'file(s), requests', ctx.__reqs.length, '· same formula:', sm3.cells['21,7'] === keep, '· version', inf.cells['7,2'], '· J header:', d16.cells['23,10']); }
// 5) calendar
api.setup();
console.log('triggers:', triggers.map(t => t.fn + (t.at ? '@' + fmt(t.at, '', 'dd/MM HH:mm') : t.cal ? '(calendar change)' : '(daily)')).join(' · '));
events.push({ title: 'sync พิเศษ', start: new Date(Date.now() + 3600000) }); api.planTriggers();
console.log('after adding an event in 1 h:', triggers.filter(t => t.at).map(t => t.fn + '@' + fmt(t.at, '', 'dd/MM HH:mm')).join(' · '));

// 6) interval sync
console.log('default after setup():', api.status().split(' · ').pop(), '· intervalSync triggers:', triggers.filter(t => t.fn === 'intervalSync').length);
try { console.log(api.setSyncInterval(30)); console.log('triggers:', triggers.map(t => t.fn).join(' · ')); const n0 = O.getSheetByName('_log').getLastRow(); api.intervalSync(); drain(); console.log('interval run:', props.last, '· new _log rows:', O.getSheetByName('_log').getLastRow() - n0); console.log(api.status()); try { api.setSyncInterval(7); } catch (e) { console.log('bad value →', e.message); } { delete props.last; const last = undefined, o0 = JSON.stringify(O.sheets.map(x => x.cells)); globalThis.__old = true; ctx.__lists = 0; api.intervalSync(); console.log('nothing edited → skipped:', props.last === last && !props.job && JSON.stringify(O.sheets.map(x => x.cells)) === o0, '· Drive lists:', ctx.__lists);
    ctx.__ovEdit = Date.now() + 1000; api.intervalSync(); console.log('Overview touched, same plants → skipped:', props.last === last && !props.job, '· remembered:', !!props.ovSame);
    const c = st.cells['2,6']; st.cells['2,6'] = 502; ctx.__ovEdit = Date.now() + 2000; api.intervalSync(); drain(); console.log('Overview plant changed → synced:', !!props.last, '·', props.last); st.cells['2,6'] = c; api.syncNow(); drain();
    delete props.last; api.intervalSync(); console.log('still nothing edited → skipped:', !props.last); globalThis.__old = false; api.intervalSync(); drain(); console.log('plant file edited → synced:', !!props.last, '·', props.last); }
  console.log(api.setSyncInterval(0), '· left:', triggers.filter(t => t.fn === 'intervalSync').length); api.planTriggers(); console.log('off stays off after planTriggers/setup:', triggers.filter(t => t.fn === 'intervalSync').length === 0, '·', api.status().split(' · ').pop()); } catch (e) { console.log('interval test failed:', e.message); }

// 6b) a create asked for while a sync works waits for it
try { api.syncNow === undefined; props.job = 'sync'; Object.assign(props, { ym: api.ym_(new Date()), idx: '0', folder: folder.id, ov: O.id, ovTemp: '', only: '', made: '0', skipped: '0', errors: '', warn: '', full: '', same: '0', root: root.id }); delete props.began; api.createThisMonth(); console.log('create during sync → queued:', !!props.queued, '· job still', props.job); let jobs = []; let n = 0; while (triggers.some(t => t.fn === 'continueJob')) { if (jobs[jobs.length - 1] !== props.job) jobs.push(props.job); api.continueJob(); if (++n > 5000) throw new Error('loop'); } console.log('ran in order:', jobs.join(' → '), '· queue empty:', !props.queued, '· job left:', props.job || 'none', '·', props.last); } catch (e) { console.log('queue test failed:', e.message); }

// 6c) leftovers of another root folder: the waiting sync is dropped, the old record is not trusted
try { Object.assign(props, { job: 'sync', ym: api.ym_(new Date()), idx: '0', folder: 'gone', ov: 'gone', root: 'old-root' }); api.continueJob(); console.log('sync of another root dropped:', !props.job); Object.assign(props, { job: 'create', ym: api.ym_(new Date()), idx: '0', folder: 'gone', ov: 'gone' }); api.continueJob(); console.log('create of another root dropped:', !props.job, '·', props.last); const rec = JSON.parse(props['synced_' + api.ym_(new Date())]); rec.root = 'old-root'; props['synced_' + api.ym_(new Date())] = JSON.stringify(rec); globalThis.__old = true; delete props.last; api.intervalSync(); drain(); console.log('old record not trusted → synced:', !!props.last); globalThis.__old = false; Object.assign(props, { job: 'create', ym: api.ym_(new Date()), idx: '0', folder: 'gone', ov: 'gone', root: 'old-root' }); delete props.last; api.syncNow(); drain(); console.log('stale job does not block a new one:', !props.job, '·', props.last); } catch (e) { console.log('root test failed:', e.message); }

// 6d) bound to the Overview, no id in CONFIG: the root folder is the folder the Overview is in
try { api.CONFIG.ROOT_FOLDER_ID = ''; ctx.__bound = O;
  console.log('root from the Overview:', api.rootId_() === root.id, '· Overview = bound sheet:', api.overviewFile_().getId() === O.getId());
  delete props.last; api.syncNow(); drain(); console.log('sync in that folder:', props.last);
  const other = new File('root2', 'moved', 'folder', null); files[O.getId()].parent = other.id; delete props.last; api.createThisMonth(); drain();
  console.log('Overview moved → month folder made in String Check next to it:', Object.values(files).some(f => f.name === api.ym_(new Date()) && files[f.parent] && files[f.parent].name === 'String Check' && files[f.parent].parent === other.id), '·', props.last);
  files[O.getId()].parent = root.id; } catch (e) { console.log('bound test failed:', e.message); }

// 7) dates typed as พ.ศ.
{ const f = v => { const r = api.typedDate_(v); return r instanceof Date ? r.getFullYear() + '-' + (r.getMonth() + 1) + '-' + r.getDate() : JSON.stringify(r); };
  console.log('typed dates:', [244668.375, 46342, '15/11/2569', '15/11/2026', '29/02/2571', '31/02/2569', 'รออะไหล่', ''].map(v => JSON.stringify(v) + ' → ' + f(v)).join(' | ')); }

// 8) folder listing, renamed plant, the problem table is never cleared first, calendar create waits for a sync
try { const ymNow = api.ym_(new Date());
  ctx.__folderLists = 0; const listed = api.folderFiles_(folder.id); const one = listed.get(plant('P1-001').name);
  console.log('folder listed in', ctx.__folderLists, 'Drive call:', listed.size, 'files · entry has id + edit time:', one.id === plant('P1-001').id && one.edited > 0);
  // a plant renamed in the Overview keeps its file: synced, and not created a second time
  const nameCell = Object.keys(st.cells).find(k => k.startsWith('2,') && st.cells[k] === 'สถานีผลิตน้ำประปาบางไทร'); const oldName = st.cells[nameCell];
  st.cells[nameCell] = 'สถานีบางไทร (ชื่อใหม่)'; delete props.last; api.syncNow(); drain();
  console.log('renamed plant still synced:', !/ยังไม่มีไฟล์/.test(props.last), '· info B1 =', p1.getSheetByName('_ข้อมูลสถานี').cells['1,2']);
  const before = Object.values(files).filter(f => f.parent === folder.id && !f.trashed).length; api.createThisMonth(); drain();
  console.log('renamed plant not created twice:', Object.values(files).filter(f => f.parent === folder.id && !f.trashed).length === before, '·', props.last);
  st.cells[nameCell] = oldName; api.syncNow(); drain();
  // problem table: an unchanged sync writes nothing to it; a changed one writes before it clears
  const ops = []; const real = T.getRange.bind(T);
  T.getRange = (...a) => { const g = real(...a); for (const m of ['setValues', 'clearContent']) { const f = g[m].bind(g); g[m] = (...x) => { ops.push(`${m}@${g.r}+${g.nr}`); return f(...x); }; } return g; };
  api.syncNow(); drain(); console.log('unchanged sync → writes to the problem table:', ops.length);
  put(day(p3, d2), 'G17', 3); api.syncNow(); drain(); const grow = ops.splice(0);
  put(day(p3, d2), 'G17', 0); api.syncNow(); drain(); const shrink = ops.splice(0);
  console.log('one more problem:', grow.join(' '), '· one fewer:', shrink.join(' '), '· rows left:', T.getLastRow() - 9);
  T.getRange = real;
  // a "สร้าง" event while a sync is working: queued behind it, not skipped
  Object.assign(props, { job: 'sync', ym: ymNow, idx: '0', folder: folder.id, ov: O.id, ovTemp: '', only: '', made: '0', skipped: '0', errors: '', warn: '', full: '', same: '0', root: api.rootId_() }); delete props.began;
  api.calendarCreate(); console.log('calendar create during a sync → queued:', props.queued, '· job still', props.job);
  api.cancelJob(); console.log('cancelled: job', props.job || 'none', '· queue', props.queued || 'empty');
} catch (e) { console.log('section 8 failed:', e.stack); }
// 9) month folders: a new month goes into "String Check" (made once); one left in the root folder is used where it is
try {
  const legacy = api.findMonthFolder_(api.ym_(new Date()));
  const a = api.monthFolder_('2027-01'), b = api.monthFolder_('2027-01');
  const sc = Object.values(files).filter(f => f.mime === 'folder' && f.name === 'String Check' && f.parent === root.id);
  console.log('month left in root found there:', legacy.parent === root.id, '· new month in String Check:', sc.length === 1 && a.parent === sc[0].id,
    '· made once:', a.id === b.id && Object.values(files).filter(f => f.name === '2027-01').length === 1);
  const moved = new File('fm1', '2027-02', 'folder', sc[0].id); console.log('moved month found in String Check:', api.findMonthFolder_('2027-02').id === moved.id);
} catch (e) { console.log('section 9 failed:', e.stack); }
// 10) one edit is read once: a file edited within the margin is not read again while its edit time stays the same
try {
  props.syncEvery = '5'; delete props.job;
  const ym = api.ym_(new Date()), mfolder = api.findMonthFolder_(ym);
  const inMonth = Object.values(files).filter(f => f.parent === mfolder.id && !f.trashed);
  const t0 = Date.now() - 60000; inMonth.forEach(f => { f.editedAt = t0; });
  api.syncNow(); drain(); const first = props.last;
  delete props.last; api.intervalSync(); drain();
  const again = props.last;
  const one = inMonth.find(f => f.name.startsWith('P1-001')); one.editedAt = Date.now();
  api.intervalSync(); drain(); const after = props.last;
  delete props.last; api.intervalSync(); drain();
  console.log('edits on record:', !!props['seen_' + ym], '· first sync read all:', /อ่าน 233 สถานี$/.test(first),
    '· nothing new within the margin → skipped:', again === undefined,
    '· one file edited → read 1:', /อ่าน 1 สถานี, ไม่มีการแก้ไข 232/.test(after || ''), '· then skipped:', props.last === undefined);
  inMonth.forEach(f => { delete f.editedAt; });
} catch (e) { console.log('section 10 failed:', e.stack); }
// 11) why every file was read; seen_ of old months dropped; _log keeps its newest LOG_KEEP_ROWS lines
try {
  delete props.job; api.menuSyncAll(); drain(); const a = props.last;
  const c = st.cells['2,6']; st.cells['2,6'] = 777; api.syncNow(); drain(); const b = props.last; st.cells['2,6'] = c; api.syncNow(); drain();
  console.log('reason in _log: full =', /อ่านทุกไฟล์: สั่งอ่านทุกไฟล์/.test(a), '· Overview changed =', /อ่านทุกไฟล์: แท็บสถานี\/Inverter/.test(b));
  props['seen_2020-01'] = '{}'; props['seen_2099-01'] = '{}'; api.syncNow(); drain();
  console.log('old seen_ dropped:', !('seen_2020-01' in props), '· current kept:', ('seen_' + api.ym_(new Date())) in props, '· later month kept:', 'seen_2099-01' in props);
  const log = O.getSheetByName('_log'); for (let r = 2; r <= 1100; r++) log.cells[`${r},1`] = 'old ' + r; log.rows = Math.max(log.rows, 1100);
  api.menuSyncAll(); drain();
  console.log('_log capped:', log.getLastRow() - 1 === 1000, '· rows', log.getLastRow() - 1, '· header kept:', log.cells['1,1'] !== undefined && !/^old/.test(log.cells['1,1']), '· newest last:', /สั่งอ่านทุกไฟล์/.test(log.cells[`${log.getLastRow()},2`]));
} catch (e) { console.log('section 11 failed:', e.stack); }
// 12) archive: closed problems of a past year move to "รายงานการแก้ไข_เก็บ_<พ.ศ.>", open ones stay; that year is not synced again
try {
  delete props.job;
  const hr = [...Array(20).keys()].map(i => i + 1).find(r => Object.keys(T.cells).some(k => k.startsWith(r + ',') && T.cells[k] === 'รหัสปัญหา'));
  const head = {}; for (let c = 1; c <= T.cols; c++) { const v = T.cells[`${hr},${c}`]; if (v) head[String(v).trim()] = c; }
  const before = T.getLastRow() - hr;
  const add = (key, found, status) => { const r = T.getLastRow() + 1; T.rows = Math.max(T.rows, r); T.cells[`${r},${head['รหัสปัญหา']}`] = key; T.cells[`${r},${head['วันที่พบ']}`] = found; T.cells[`${r},${head['สถานะ']}`] = status; };
  add('P1-001|OLD1|20250305', '05/03/2568', 'ปิดงาน'); add('P1-001|OLD2|20250610', '10/06/2568', 'กำลังแก้ไข'); add('P1-002|OLD3|20251201', '01/12/2568', 'แก้ไขแล้ว');
  let e1 = ''; try { api.archiveYear(new Date().getFullYear()); } catch (e) { e1 = e.message; }
  const msg = api.archiveYear(2568);
  const arch = Object.values(files).find(f => f.name === 'รายงานการแก้ไข_เก็บ_2568' && f.parent === root.id);
  const aRows = arch && arch.ss.sheets[0].getLastRow() - 1;
  const left = Object.keys(T.cells).filter(k => /OLD/.test(T.cells[k])).map(k => T.cells[k]);
  console.log(msg);
  console.log('this year refused:', /ปีก่อนปีนี้/.test(e1), '· archive in root:', !!arch, '· archived rows:', aRows,
    '· open row stays:', left.join() === 'P1-001|OLD2|20250610', '· other rows kept:', T.getLastRow() - hr === before + 1);
  const again = api.archiveYear(2568); console.log('run again:', again);
  let e2 = ''; try { api.syncMonth('2025-06'); } catch (e) { e2 = e.message; } console.log('sync of an archived year refused:', /ย้ายปัญหาไปไฟล์เก็บแล้ว/.test(e2));
  add('P1-003|OLD4|20250701', '01/07/2568', 'ปิดงาน'); const m3 = api.archiveYear(2025);
  console.log('second run adds to the same file:', m3, '· rows now', arch.ss.sheets[0].getLastRow() - 1);
} catch (e) { console.log('section 12 failed:', e.stack); }
