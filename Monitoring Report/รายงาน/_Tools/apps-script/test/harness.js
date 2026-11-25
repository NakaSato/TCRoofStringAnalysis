const fs = require('fs'), vm = require('vm');
const [codePath, ovPath] = process.argv.slice(2);
// codePath: the script folder (every *.gs in name order, as clasp pushes them) or one .gs file
const readCode = p => fs.statSync(p).isDirectory()
  ? fs.readdirSync(p).filter(f => f.endsWith('.gs')).sort().map(f => fs.readFileSync(require('path').join(p, f), 'utf8')).join('\n')
  : fs.readFileSync(p, 'utf8');
const ov = JSON.parse(fs.readFileSync(ovPath, 'utf8'));
let seq = 0; const files = {};
const colN = s => s.split('').reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0);
function parseA1(a) { const m = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/.exec(a); if (!m) throw new Error('bad A1 ' + a);
  const c1 = colN(m[1]), r1 = +m[2], c2 = m[3] ? colN(m[3]) : c1, r2 = m[4] ? +m[4] : r1; return [r1, c1, r2 - r1 + 1, c2 - c1 + 1]; }
class Sheet {
  constructor(ss, name, id) { Object.assign(this, { ss, name, id, rows: 1000, cols: 26, cells: {}, merges: [], hidden: false, hiddenCols: new Set(), fmt: {}, textFormulas: [] }); }
  isColumnHiddenByUser(c) { return this.hiddenCols.has(c); } hideColumns(c, n = 1) { for (let k = 0; k < n; k++) this.hiddenCols.add(c + k); }
  setName(n) { this.name = n; return this; } getName() { return this.name; } getSheetId() { return this.id; }
  getMaxRows() { return this.rows; } getMaxColumns() { return this.cols; }
  deleteRows(a, n) { const c = {}; for (const k in this.cells) { const [r, col] = k.split(',').map(Number); if (r < a) c[k] = this.cells[k]; else if (r >= a + n) c[`${r - n},${col}`] = this.cells[k]; } this.cells = c; this.rows -= n; } deleteColumns(a, n) { this.cols -= n; }
  insertRowsAfter(a, n) { if (a !== this.rows) throw new Error('insertRowsAfter not at end'); this.rows += n; }
  insertColumnsAfter(a, n) { if (a !== this.cols) throw new Error('insertColsAfter not at end'); this.cols += n; }
  insertImage(b, c, r) { if (!b) throw new Error('no blob'); const sh = this, o = { c, r, setHeight: () => o, setWidth: () => o, getAnchorCell: () => ({ getRow: () => o.r, getColumn: () => o.c }), remove: () => { sh.images = sh.images.filter(x => x !== o); } }; this.images = [...(this.images || []), o]; return o; } getImages() { return [...(this.images || [])]; } setHiddenGridlines() { return this; } clear() { this.cells = {}; return this; } setFrozenRows() {} hideSheet() { this.hidden = true; } setColumnWidth() {} setRowHeight() {} setRowHeights() {} setConditionalFormatRules(r) { this.cfRules = r; } getConditionalFormatRules() { return [...(this.cfRules || [])]; } getFilter() { return this.filter || null; }
  _ext() { let r = 0, c = 0; for (const k in this.cells) { if (this.cells[k] === '' ) continue; const [a, b] = k.split(',').map(Number); r = Math.max(r, a); c = Math.max(c, b); } return [r, c]; }
  getLastRow() { return this._ext()[0]; } getLastColumn() { return this._ext()[1]; }
  getDataRange() { const [r, c] = this._ext(); return this.getRange(1, 1, Math.max(r, 1), Math.max(c, 1)); }
  appendRow(v) { const r = this.getLastRow() + 1; if (r > this.rows) this.rows = r; v.forEach((x, i) => { this.cells[`${r},${i + 1}`] = x; }); }
  copyTo(ss) { const s = new Sheet(ss, 'Copy' + (++seq), ++seq); Object.assign(s, { rows: this.rows, cols: this.cols, cells: { ...this.cells }, images: [], merges: this.merges.map(m => [...m]), hiddenCols: new Set(this.hiddenCols), fmt: { ...this.fmt } }); (this.images || []).forEach(i => s.insertImage('PNG', i.c, i.r)); ss.sheets.push(s); return s; }
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
    v2d.forEach((row, i) => row.forEach((v, j) => { if (v === undefined || v === null) throw new Error('undefined value'); if (f && !isF(v)) throw new Error('not a formula: ' + v); const key = `${this.r + i},${this.c + j}`; if (isF(v) && this.sh.fmt[key] === '@') this.sh.textFormulas.push(key); this.sh.cells[key] = v; })); return this; }
  setValues(v) { return this._set(v); } setFormulas(v) { return this._set(v, true); }
  setValue(v) { this.sh.cells[`${this.r},${this.c}`] = v; return this; } setFormula(v) { if (!isF(v)) throw new Error('not formula ' + v); return this.setValue(v); }
  _box() { return [this.r, this.c, this.r + this.nr - 1, this.c + this.nc - 1]; }
  getRow() { return this.r; } getColumn() { return this.c; } getLastRow() { return this.r + this.nr - 1; } getLastColumn() { return this.c + this.nc - 1; }
  // merges as Sheets keeps them: a merge may not cut through another one (Sheets refuses that)
  merge() { const [r1, c1, r2, c2] = this._box(); const keep = [];
    for (const m of this.sh.merges) { const [a, b, c, d] = m; const meets = a <= r2 && c >= r1 && b <= c2 && d >= c1; const inside = a >= r1 && c <= r2 && b >= c1 && d <= c2;
      if (meets && !inside) throw new Error(`merge ${this.sh.name} ${JSON.stringify(this._box())} cuts through ${JSON.stringify(m)}`); if (!meets) keep.push(m); }
    if (this.nr * this.nc > 1) keep.push(this._box()); this.sh.merges = keep; return this; }
  mergeAcross() { return this; }
  getMergedRanges() { const [r1, c1, r2, c2] = this._box(); return this.sh.merges.filter(([a, b, c, d]) => a <= r2 && c >= r1 && b <= c2 && d >= c1).map(([a, b, c, d]) => new Range(this.sh, a, b, c - a + 1, d - b + 1)); }
  breakApart() { const [r1, c1, r2, c2] = this._box(); this.sh.merges = this.sh.merges.filter(([a, b, c, d]) => !(a <= r2 && c >= r1 && b <= c2 && d >= c1)); return this; }
  setNumberFormat(f) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.fmt[`${this.r + i},${this.c + j}`] = f; return this; }
  // copyTo(PASTE_FORMAT): formats only; merges are not carried over here (the code must make them itself)
  copyTo(dest, type) { if (type !== 'PASTE_FORMAT') throw new Error('copyTo: only PASTE_FORMAT is mocked'); for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) { const f = this.sh.fmt[`${this.r + i},${this.c + j}`]; const k = `${dest.r + i},${dest.c + j}`; if (f === undefined) delete dest.sh.fmt[k]; else dest.sh.fmt[k] = f; } ctx.__formatCopies = (ctx.__formatCopies || []).concat([[this._box(), dest._box()]]); }
  copyFormatToRange() {} getFormula() { return this.getFormulas()[0][0]; }
  getNumColumns() { return this.nc; } getNumRows() { return this.nr; }
  // data validation per cell (the object given), a filter and colour rules as Sheets keeps them
  setDataValidation(v) { this.sh.dv = this.sh.dv || {}; for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.dv[`${this.r + i},${this.c + j}`] = v; return this; }
  getDataValidations() { return this._grid(() => null).map((row, i) => row.map((_, j) => (this.sh.dv || {})[`${this.r + i},${this.c + j}`] || null)); }
  createFilter() { if (this.sh.filter) throw new Error('sheet has a filter'); const sh = this.sh, g = this, crit = {}; sh.filter = { getRange: () => g, getColumnFilterCriteria: c => crit[c] ? { copy: () => ({ build: () => crit[c] }) } : null, setColumnFilterCriteria: (c, v) => { crit[c] = v; }, remove: () => { sh.filter = null; }, crit }; return sh.filter; } }
for (const m of ['setFontFamily', 'setFontSize', 'setHorizontalAlignment', 'setVerticalAlignment', 'setWrap', 'setFontWeight', 'setBackground', 'setBorder', 'setFontColor']) Range.prototype[m] = function () { return this; };
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
// as on the live sheet: each summary box = label (row 4) over its number (rows 5–6), merged; _open_station hidden
function liveLayout(s) { [[1, 3], [4, 4], [5, 6], [7, 7], [8, 10], [11, 13]].forEach(([a, b]) => { if (b > a) s.merges.push([4, a, 4, b]); s.merges.push([5, a, 6, b]); }); s.hiddenCols.add(14); }
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
  SpreadsheetApp: { getActiveSpreadsheet: () => ctx.__bound || null, create: n => { const id = 'f' + (++seq); const ss = new SS(id, n); new File(id, n, GS, null, ss); return ss; }, openById: id => { if (!files[id] || !files[id].ss) throw new Error('cannot open ' + id); return files[id].ss; }, flush() {}, CopyPasteType: { PASTE_FORMAT: 'PASTE_FORMAT' }, newDataValidation: () => chain(), newConditionalFormatRule: () => chain(), BorderStyle: { SOLID: 1, SOLID_MEDIUM: 2 } },
  DriveApp: { getFolderById: id => files[id], getFileById: id => { if (id === '1Ic106EgW9ceYs8JOAXSfViAwh1YFqb4T') return { getBlob: () => 'PNG' }; if (!files[id]) throw new Error('no file ' + id); return files[id]; } },
  Drive: { Files: { list: o => { ctx.__lists = (ctx.__lists || 0) + 1; const all = /^'(.+)' in parents and trashed = false$/.exec(o.q); if (all) { ctx.__lists--; ctx.__folderLists = (ctx.__folderLists || 0) + 1; return { files: Object.values(files).filter(f => f.parent === all[1] && !f.trashed).map(f => ({ id: f.id, name: f.name, modifiedTime: f.getLastUpdated().toISOString() })) }; } const m = /^'(.+)' in parents and trashed = false and modifiedTime > '(.+)'$/.exec(o.q); if (!m) throw new Error('bad q ' + o.q); const t = new Date(m[2]).getTime(); return { files: Object.values(files).filter(f => f.parent === m[1] && !f.trashed && f.getLastUpdated().getTime() > t).slice(0, o.pageSize).map(f => ({ id: f.id, modifiedTime: f.getLastUpdated().toISOString() })) }; },
    get: id => ({ modifiedTime: new Date(ctx.__ovEdit || 0).toISOString() }), copy: (res, id) => { const nid = 'f' + (++seq); const ss = new SS(nid, res.name); ss.sheets = Object.keys(ov).map(n => { const s = new Sheet(ss, n, ++seq); s.rows = ov[n].rows; s.cols = ov[n].cols; for (const k in ov[n].cells) { const v = ov[n].cells[k]; s.cells[k] = v && v.__date ? new Date(v.__date) : v; } if (n === 'รายงานการแก้ไข') liveLayout(s); return s; }); new File(nid, res.name, GS, res.parents[0], ss); return { id: nid }; } } },
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
vm.createContext(ctx); vm.runInContext(readCode(codePath) + '\n;globalThis.__api={calendarCreate,cancelJob,plantFile_,folderFiles_,rootId_,monthFolder_,findMonthFolder_,overviewFile_,removeLogos,typedDate_,setSyncInterval,intervalSync,archiveYear,syncMonth,status,writeLastReport_,addBox_,issueTable_,menuSyncAll,createThisMonth,continueJob,syncNow,convertOverview,setup,planTriggers,calendarSync,CONFIG,layout_,ym_};', ctx);
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
{ const days = plant('P1-001').ss.sheets.filter(x => x.name.startsWith('วันที่')); days.forEach(x => x.insertImage('PNG', 12, 1)); days[0].insertImage('PNG', 4, 20);
  api.CONFIG.RUN_SECONDS = 0; console.log('remove logos, no time:', api.removeLogos(), '· progress kept:', props['logoRemoved_' + ym]); api.CONFIG.RUN_SECONDS = 240;
  console.log('remove logos:', api.removeLogos(), '· logos left:', days.reduce((a, x) => a + x.getImages().filter(i => i.r <= 4).length, 0), '· photo kept:', days[0].getImages().length === 1, '· progress cleared:', !('logoRemoved_' + ym in props)); }
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
{ const lc = Object.keys(st.cells).find(k => k.startsWith('1,') && st.cells[k] === 'รายงานล่าสุด'); const c = lc && +lc.split(',')[1];
  const filled = Object.keys(st.cells).filter(k => c && +k.split(',')[1] === c && +k.split(',')[0] > 1 && st.cells[k] !== '').map(k => st.cells[`${k.split(',')[0]},1`] + '=' + st.cells[k]);
  const at = Object.keys(T.cells).find(k => T.cells[k] === 'รายงานวันนี้'); console.log('รายงานล่าสุด column', c, ':', filled.join(' '), '· box', at, '→', at && T.cells[`5,${at.split(',')[1]}`]); }
{ const R = O.getSheetByName('รายงานวันนี้'); console.log('sheet รายงานวันนี้ at', O.sheets.indexOf(R), ':'); show(R, [1, 2, 3, 4, 5]); console.log('   grid', R.rows, 'x', R.cols); }
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
// 13) audit fixes: the รายงานวันนี้ box (#66), archive formulas / January / lock (#64), dates typed by hand (#66)
try {
  delete props.job;
  const box = () => Object.keys(T.cells).filter(k => T.cells[k] === 'รายงานวันนี้' && +k.split(',')[0] < 9);
  const m = () => JSON.stringify(T.merges.filter(x => x[1] >= 14).sort());
  const [lab] = box(), bc = lab && +lab.split(',')[1];
  console.log('box: label', lab, '(O4 = 4,15) · visible:', bc && !T.hiddenCols.has(bc), '· number under it:', /^=COUNTIF/.test(T.cells[`5,${bc}`] || ''),
    '· merges', m(), '(want [4,15,4,17] + [5,15,6,17]) · format copied over rows 4–6:', JSON.stringify((ctx.__formatCopies || []).slice(-1)[0]));
  // a sheet an older version wrote: label + number in the hidden _open_station column → moved, cleared there
  Object.keys(T.cells).filter(k => +k.split(',')[0] < 9 && +k.split(',')[1] >= 14).forEach(k => delete T.cells[k]);
  T.merges = T.merges.filter(x => x[1] < 14); T.cells['4,14'] = 'รายงานวันนี้'; T.cells['5,14'] = '=COUNTIF(x)';
  api.syncNow(); drain();
  console.log('hidden box repaired: label now', box().join(), '· N4/N5 cleared:', !T.cells['4,14'] && !T.cells['5,14'], '· merges', m());
  // the table is as wide as its header: archive / sync never touch the box columns
  console.log('table width = header (14):', api.issueTable_(O).width);

  // archive: =HYPERLINK keeps working (only date columns are text), the rows left are numbered 1…
  const hr = 9, head = {}; for (let c = 1; c <= 14; c++) { const v = T.cells[`${hr},${c}`]; if (v) head[String(v).trim()] = c; }
  const add = (key, found, status, link) => { const r = T.getLastRow() + 1; T.rows = Math.max(T.rows, r); T.cells[`${r},${head['No.']}`] = 99; T.cells[`${r},${head['รหัสปัญหา']}`] = key; T.cells[`${r},${head['วันที่พบ']}`] = found; T.cells[`${r},${head['สถานะ']}`] = status; if (link) T.cells[`${r},${head['รายงาน']}`] = link; };
  props.archived = '[]';
  add('P1-001|OLD9|20240305', '05/03/2567', 'ปิดงาน', '=HYPERLINK("https://docs.google.com/spreadsheets/d/x/edit","เปิด")');
  api.archiveYear(2024);
  const a24 = Object.values(files).find(f => f.name === 'รายงานการแก้ไข_เก็บ_2567').ss.sheets[0];
  const linkCell = Object.keys(a24.cells).find(k => /HYPERLINK/.test(a24.cells[k]));
  const nos = []; for (let r = hr + 1; r <= T.getLastRow(); r++) if (T.cells[`${r},${head['รหัสปัญหา']}`]) nos.push(T.cells[`${r},${head['No.']}`]);
  console.log('archive: link kept as a formula:', !!linkCell && a24.fmt[linkCell] !== '@' && a24.textFormulas.length === 0,
    '· date column text:', a24.fmt[`2,${head['วันที่พบ']}`] === '@', '· No. left 1…n:', nos.every((v, i) => v === i + 1), `(${nos.length} rows)`);

  // January: last year's December can still be synced, so that year is refused until February
  const RealDate = ctx.Date;
  const at2 = (y, mo) => class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(y, mo, 15, 12); } static now() { return new RealDate(y, mo, 15, 12).getTime(); } };
  ctx.Date = at2(2027, 0); let ej = ''; try { api.archiveYear(2026); } catch (e) { ej = e.message; }
  ctx.Date = at2(2027, 1); let ef = ''; try { api.archiveYear(2026); } catch (e) { ef = e.message; }
  ctx.Date = RealDate;
  console.log('January refuses last year:', /กุมภาพันธ์/.test(ej), '· February allows it:', !/กุมภาพันธ์/.test(ef), ef ? `(${ef.slice(0, 60)})` : '');

  // a job is checked under the lock; one left by another root folder no longer blocks
  props.job = 'sync'; props.ym = '2026-11'; props.root = api.rootId_(); let eb = ''; try { api.archiveYear(2023); } catch (e) { eb = e.message; }
  props.root = 'OLD_ROOT'; let eo = ''; try { api.archiveYear(2023); } catch (e) { eo = e.message; }
  console.log('active job refuses:', /มีงานค้าง/.test(eb), '· old-root job dropped:', !/มีงานค้าง/.test(eo) && !props.job);

  // รายงานล่าสุด: a date typed by hand into a row the sync does not touch is written back as พ.ศ. text
  const S = O.getSheetByName('สถานี'); const shead = []; for (let c = 1; c <= S.cols; c++) shead.push(String(S.cells[`1,${c}`] || '').trim());
  const lc = shead.indexOf('รายงานล่าสุด') + 1, codeA = S.cells['2,1'], codeB = S.cells['3,1'];
  S.cells[`3,${lc}`] = new Date(2026, 10, 3);
  api.writeLastReport_(O, '2026-11', { [codeA]: { lastReport: new Date(2026, 10, 20) } });
  console.log('typed date normalised:', S.cells[`3,${lc}`], '(want "03/11/2569") · synced row:', S.cells[`2,${lc}`], '· codes', codeA, codeB);
} catch (e) { console.log('section 13 failed:', e.stack); }
// 14) the problem table's filter, colour rules and dropdowns reach the last row (the Overview came with A9:N10 / row 210)
try {
  props.archived = '[]'; delete props.job;   // section 13 archived this year
  const T14 = O.getSheetByName('รายงานการแก้ไข'), hr = 9;
  T14.filter = null; T14.getRange(hr, 1, 2, 14).createFilter().setColumnFilterCriteria(9, 'only-open');
  const rule = (r, c, nr, nc) => { const o = { ranges: [T14.getRange(r, c, nr, nc)], getRanges: () => o.ranges, copy: () => { const b = { ranges: o.ranges, setRanges: x => { b.ranges = x; return b; }, build: () => { const n = { ranges: b.ranges, getRanges: () => n.ranges, copy: o.copy }; return n; } }; return b; } }; return o; };
  T14.cfRules = [rule(hr + 1, 1, 201, 14), rule(hr + 1, 9, 201, 1), rule(1, 1, 3, 3)];
  T14.dv = {}; T14.getRange(hr + 1, 9, 201, 1).setDataValidation('status-list'); T14.getRange(hr + 1, 12, 201, 1).setDataValidation('date');
  T14.rows = Math.max(T14.rows, 400);
  api.syncNow(); drain();
  const g = T14.getFilter().getRange(), last = T14.getMaxRows();
  console.log('filter now', `A${g.getRow()}:${A(g.getLastColumn())}${g.getLastRow()}`, `(want A9:N${last}) · criteria kept:`, T14.filter.crit[9] === 'only-open');
  console.log('colour rules to the last row:', T14.cfRules.slice(0, 2).every(r => r.getRanges()[0].getLastRow() === last), '· other rule untouched:', T14.cfRules[2].getRanges()[0].getLastRow() === 3);
  console.log('dropdowns to the last row:', T14.dv[`${last},9`] === 'status-list' && T14.dv[`${last},12`] === 'date', '· no dropdown added elsewhere:', !T14.dv[`${last},1`]);
  const rules0 = T14.cfRules; api.syncNow(); drain(); console.log('second sync leaves them as they are:', T14.cfRules.every((r, i) => r === rules0[i]));
} catch (e) { console.log('section 14 failed:', e.stack); }
// 15) บันทึกรายงานรายวัน: one row per day up to today, newest on top; a late report changes its own day only
try {
  const R = O.getSheetByName('บันทึกรายงานรายวัน'), S = O.getSheetByName('สถานี');
  const rowOf = d => { const k = `${pad(d)}/${fmt(new Date(), '', 'MM')}/${+fmt(new Date(), '', 'yyyy') + 543}`; for (let r = 2; r <= R.getLastRow(); r++) if (R.cells[`${r},1`] === k) return [1, 2, 3, 4, 5, 6, 7].map(c => R.cells[`${r},${c}`]); return null; };
  const nPlants = S.getLastRow() - 1;
  console.log('log sheet:', !!R, '· head', JSON.stringify([1, 2, 3, 4, 5, 6, 7].map(c => R.cells[`1,${c}`])), '· rows', R.getLastRow() - 1, '(want', today, ') · newest on top:', R.cells['2,1'] === rowOf(today)[0]);
  const t0 = rowOf(today), dd0 = rowOf(d0);
  console.log('today:', JSON.stringify(t0.slice(0, 5)), '· reported + not = all:', t0[1] + t0[2] === nPlants && t0[3] === nPlants, '· missing list length = not reported:', t0[5].split(', ').length === t0[2]);
  console.log(`day ${d0}:`, JSON.stringify(dd0.slice(0, 5)), '· P1-001 counted:', !dd0[5].includes('P1-001'), '· P3-002 not counted that day:', dd0[5].includes('P3-002'));
  // P3-002 reports day d0 late: that day goes up by one, its stamp changes; other days stay
  const before = rowOf(d1);
  put(day(p3, d0), 'G17', 0); put(day(p3, d0), 'J17', 'Online');
  files[Object.values(files).find(f => f.ss === p3).id].editedAt = Date.now() + 3600000;
  api.syncNow(); drain();
  const after0 = rowOf(d0);
  console.log(`late report for day ${d0}:`, dd0[1], '→', after0[1], '· P3-002 off the list:', !after0[5].includes('P3-002'), `· day ${d1} unchanged:`, JSON.stringify(rowOf(d1)) === JSON.stringify(before));
} catch (e) { console.log('section 15 failed:', e.stack); }
// 16) sync across months: on days 1–7 of next month, a late report in this month's file is still synced
try {
  props.archived = '[]'; delete props.job;
  const RealDate = ctx.Date, [yy, mo] = ym.split('-').map(Number);
  const at = (y, m0, d, h) => class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(Date.UTC(y, m0, d, h - 7)); } static now() { return Date.UTC(y, m0, d, h - 7); } };
  const R = O.getSheetByName('บันทึกรายงานรายวัน');
  const rowOf = d => { const k = `${pad(d)}/${pad(mo)}/${yy + 543}`; for (let r = 2; r <= R.getLastRow(); r++) if (R.cells[`${r},1`] === k) return [2, 3].map(c => R.cells[`${r},${c}`]); return null; };
  const before = rowOf(d1);
  // the late report: P3-002 fills yesterday's sheet after the month ended
  put(day(p3, d1), 'G17', 0); put(day(p3, d1), 'J17', 'Online');
  files[Object.values(files).find(f => f.ss === p3).id].editedAt = Date.now() + 7200000;
  ctx.Date = at(mo === 12 ? yy + 1 : yy, mo === 12 ? 0 : mo, 3, 10);     // day 3 of next month, 10:00 (no folder for it)
  api.intervalSync(); drain();
  const after3 = rowOf(d1);
  ctx.Date = at(mo === 12 ? yy + 1 : yy, mo === 12 ? 0 : mo, 8, 10);     // day 8: outside the window
  put(day(p3, d2), 'G17', 0); files[Object.values(files).find(f => f.ss === p3).id].editedAt = Date.now() + 9000000;
  const runs = triggers.length; api.intervalSync(); const started8 = !!props.job; drain();
  ctx.Date = RealDate;
  console.log(`day 3 of next month: day ${d1} reported`, before[0], '→', after3[0], '(want +1) · day 8: no sync of last month:', !started8);
} catch (e) { ctx.Date = Date; console.log('section 16 failed:', e.stack); }
// 17) inverters of one plant with the same problem found the same day share one row of the Overview
try {
  props.archived = '[]'; delete props.job;
  const T = O.getSheetByName('รายงานการแก้ไข'), hr = 9, head = {};
  for (let c = 1; c <= 15; c++) { const v = T.cells[`${hr},${c}`]; if (v) head[String(v).trim()] = c; }
  const rowsOf = code => { const out = []; for (let r = hr + 1; r <= T.getLastRow(); r++) { const k = String(T.cells[`${r},${head['รหัสปัญหา']}`] || ''); if (k.startsWith(code + '|')) out.push({ r, key: k, sn: T.cells[`${r},${head['Inverter S/N']}`], detail: T.cells[`${r},${head['รายละเอียดปัญหา']}`], st: T.cells[`${r},${head['สถานะ']}`], no: T.cells[`${r},${head['No.']}`] }); } return out; };
  console.log('P1-001 before:', JSON.stringify(rowsOf('P1-001').map(x => [x.key, x.detail, x.st])));
  // inverter 3 gets the same AFCI fault as inverter 2, from the same day
  for (const d of [d1, d2]) { put(day(p1, d), 'J19', 'Fault'); put(day(p1, d), 'K19', 'AFCI'); }
  files[Object.values(files).find(f => f.ss === p1).id].editedAt = Date.now() + 9e6;
  api.syncNow(); drain();
  const g = rowsOf('P1-001');
  console.log('P1-001 after:', JSON.stringify(g.map(x => [x.key, x.sn, x.detail, x.st])));
  const afci = g.filter(x => /AFCI/.test(x.detail));
  console.log('AFCI rows:', afci.length, '(want 1) · S/N lists two:', afci[0] && String(afci[0].sn).split(', ').length === 2, '· No. 1…n:', (() => { const nos = []; for (let r = hr + 1; r <= T.getLastRow(); r++) if (T.cells[`${r},${head['รหัสปัญหา']}`]) nos.push(T.cells[`${r},${head['No.']}`]); return nos.every((v, i) => v === i + 1); })());
  // a value typed into the grouped row of the Overview survives the next sync
  const noteCol = head['ผลการตรวจสอบ']; if (noteCol) T.cells[`${afci[0].r},${noteCol}`] = 'ตรวจหน้างานแล้ว';
  const snap = JSON.stringify(rowsOf('P1-001'));
  files[Object.values(files).find(f => f.ss === p1).id].editedAt = Date.now() + 9.5e6;
  api.syncNow(); drain();
  const again = rowsOf('P1-001'), a2 = again.find(x => /AFCI/.test(x.detail));
  console.log('typed note kept:', !noteCol || T.cells[`${a2.r},${noteCol}`] === 'ตรวจหน้างานแล้ว', '· rows stable:', JSON.stringify(again.map(x => x.key)) === JSON.stringify(JSON.parse(snap).map(x => x.key)));
  // one of them is fixed (normal again): the group keeps only the one still in trouble
  put(day(p1, d2), 'J19', 'Online'); put(day(p1, d2), 'K19', '');
  files[Object.values(files).find(f => f.ss === p1).id].editedAt = Date.now() + 9.9e6;
  api.syncNow(); drain();
  console.log('inverter 3 normal again: its fault days stay in the same row:', JSON.stringify(rowsOf('P1-001').map(x => [x.key, x.st])));
} catch (e) { console.log('section 17 failed:', e.stack); }
