const fs = require('fs'), vm = require('vm');
const [codePath, sheetPath, apiPath] = process.argv.slice(2);
// codePath: the script folder (every *.gs in name order, as clasp pushes them) or one .gs file
const readCode = p => fs.statSync(p).isDirectory()
  ? fs.readdirSync(p).filter(f => f.endsWith('.gs')).sort().map(f => fs.readFileSync(require('path').join(p, f), 'utf8')).join('\n')
  : fs.readFileSync(p, 'utf8');
const src = JSON.parse(fs.readFileSync(sheetPath, 'utf8'));
const api = JSON.parse(fs.readFileSync(apiPath, 'utf8'));

class Sheet {
  constructor(name, grid) { this.name = name; this.grid = grid.map(r => r.slice()); this.width = grid[0].length; }
  getName() { return this.name; }
  setName(n) { this.name = n; return this; }
  getLastRow() { for (let i = this.grid.length - 1; i >= 0; i--) if (this.grid[i].some(v => v !== '')) return i + 1; return 0; }
  getLastColumn() { let m = 0; this.grid.forEach(r => r.forEach((v, k) => { if (v !== '' && k + 1 > m) m = k + 1; })); return m; }
  copyTo(ss) { const s = new Sheet('Copy of ' + this.name, this.grid); ss.sheets.push(s); return s; }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    if (r < 1 || c < 1 || nr < 1 || nc < 1) throw new Error(`bad range ${r},${c},${nr},${nc}`);
    const cell = (i, j) => { while (sh.grid.length < r + i) sh.grid.push(Array(sh.width).fill('')); return sh.grid[r - 1 + i]; };
    return {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => { const v = cell(i)[c - 1 + j]; return v === undefined ? '' : v; })),
      getDisplayValues() { return this.getValues().map(row => row.map(String)); },
      setValues(vals) {
        if (vals.length !== nr || vals.some(x => x.length !== nc)) throw new Error(`setValues size mismatch: got ${vals.length}x${vals[0] && vals[0].length}, range ${nr}x${nc}`);
        vals.forEach((row, i) => row.forEach((v, j) => { cell(i)[c - 1 + j] = v == null ? '' : v; }));
        sh.writes = (sh.writes || 0) + 1;
      },
      clearContent() { for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) cell(i)[c - 1 + j] = ''; },
    };
  }
}
function world(opts = {}) {
  const drive = { files: {}, folders: { root: { id: 'root', name: 'My Drive' }, home: { id: 'home', name: 'รายงาน PWA' }, FOLDERID1234: { id: 'FOLDERID1234', name: 'Archive 2026' } }, copies: [] };
  const mkss = (id, name, sheets) => ({ id, name, sheets, active: null, getId() { return this.id; }, getName() { return this.name; }, getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; },
    deleteSheet(s) { if (this.sheets.length <= 1) throw new Error('cannot delete the last sheet'); const i = this.sheets.indexOf(s); if (i < 0) throw new Error('no such sheet'); this.sheets.splice(i, 1); },
    getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; },
    getSheets() { return this.sheets.slice(); }, getNumSheets() { return this.sheets.length; },
    setActiveSheet(s) { this.active = s; }, moveActiveSheet(pos) { const i = this.sheets.indexOf(this.active); this.sheets.splice(i, 1); this.sheets.splice(pos - 1, 0, this.active); } });
  const ss = mkss('LIVE', 'Monitoring PWA Report', [new Sheet(src.name, src.grid)]);
  drive.files.LIVE = { ss, folder: 'home' };
  const ss_unused = { sheets: [], active: null,
    getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; },
    getSheets() { return this.sheets; }, getNumSheets() { return this.sheets.length; },
    setActiveSheet(s) { this.active = s; }, moveActiveSheet(pos) { const i = this.sheets.indexOf(this.active); this.sheets.splice(i, 1); this.sheets.splice(pos - 1, 0, this.active); } };
  const props = Object.assign({ REPORT_KEY: 'test-key' }, opts.props);
  const w = { ss, drive, props, calls: [], alerts: [], logs: [], now: opts.now || '2026-11-15T09:05', responder: opts.responder, triggers: [] };
  w.answers = (opts.answers || []).slice(); w.prompts = []; w.menu = [];
  const mk = (name, depth) => { const m = { addItem: (label, fn) => { w.menu.push('  '.repeat(depth) + label + ' → ' + fn); return m; }, addSeparator: () => m,
    addSubMenu: sub => m, addToUi: () => {} }; w.menu.push('  '.repeat(depth) + '[' + name + ']'); return m; };
  const ui = { Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' }, ButtonSet: { OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
    alert(a, b, c) { if (c === undefined) { w.alerts.push(a); return 'OK'; } w.alerts.push(a + '\n' + b); return opts.confirm || 'NO'; },
    prompt(title, text) { w.prompts.push(title + '\n' + text); const a = w.answers.shift(); return { getSelectedButton: () => (a == null ? 'CANCEL' : 'OK'), getResponseText: () => a || '' }; },
    createMenu: name => mk(name, name === 'PWA Report' ? 0 : 1) };
  const fol = id => ({ getId: () => id, getName: () => drive.folders[id].name });
  const part = () => { const [d, t] = w.now.split('T'); const [h, m] = t.split(':'); return { d, h: +h, m: +m }; };
  const ctx = {
    console: { log: (...a) => w.logs.push(a.join(' ')) },
    DriveApp: {
      getRootFolder: () => fol('root'),
      getFolderById: id => { if (!drive.folders[id]) throw new Error('not found'); return fol(id); },
      getFileById: id => { const f = drive.files[id]; if (!f) throw new Error('not found'); return {
        getParents: () => { let used = !f.folder; return { hasNext: () => !used, next: () => { used = true; return fol(f.folder); } }; },
        makeCopy: (name, folder) => { if (opts.copyFails) throw new Error('quota'); const nid = 'COPY' + (drive.copies.length + 1);
          const c = mkss(nid, name, f.ss.sheets.filter(sh => !(opts.dropTab && sh.name === opts.dropTab)).map(sh => new Sheet(sh.name, sh.grid)));
          drive.files[nid] = { ss: c, folder: folder.getId() }; drive.copies.push(nid); return { getId: () => nid, setTrashed: t => { drive.files[nid].trashed = t; } }; } }; },
    },
    SpreadsheetApp: { openById: id => drive.files[id].ss, getActive: () => ss, getUi: () => { if (opts.noUi) throw new Error('no UI'); return ui; } },
    PropertiesService: { getScriptProperties: () => ({ getKeys: () => Object.keys(props), deleteProperty: k => { delete props[k]; }, getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => !opts.locked, releaseLock() { w.released = true; } }) },
    Utilities: { sleep: ms => { w.slept = (w.slept || 0) + ms; },
      formatDate: (d, tz, f) => { const p = part(); if (tz !== 'Asia/Bangkok') throw new Error('tz ' + tz); return f === 'yyyy-MM-dd' ? p.d : f === 'H' ? String(p.h) : f === 'm' ? String(p.m) : (() => { throw new Error('fmt ' + f); })(); } },
    UrlFetchApp: { fetch(url, o) {
      w.calls.push({ url, key: o.headers['X-Report-Key'], mute: o.muteHttpExceptions });
      const r = w.responder ? w.responder(url, w.calls.length) : defaultResponder(url);
      if (r.throws) throw new Error(r.throws);
      return { getResponseCode: () => r.code, getContentText: () => r.body };
    } },
    ScriptApp: {
      getProjectTriggers: () => w.triggers.slice(),
      deleteTrigger: t => { w.triggers.splice(w.triggers.indexOf(t), 1); },
      newTrigger: fn => { const b = { spec: [] }; ['timeBased', 'atHour', 'everyDays', 'inTimezone', 'everyMinutes'].forEach(k => { b[k] = (...a) => { b.spec.push(k + (a.length ? ':' + a.join() : '')); return b; }; });
        b.create = () => { w.triggers.push({ getHandlerFunction: () => fn, spec: b.spec.join(' ') }); }; return b; },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(readCode(codePath) + '\n;this.C = {CHECK_HOURS, DEFAULT_FETCH, FETCH_WINDOW, DASH, FIRST_ROW, REPORT_URL};', ctx, { filename: 'apps-script' });
  w.ctx = ctx; return w;
}
// API stand-in: the saved sample holds check 09 only; other hours come back unpublished (no checks).
function defaultResponder(url) {
  const m = /\/pwa\/(\d{4}-\d{2}-\d{2})\/cells\?hours=([\d,]+)$/.exec(url);
  if (!m) return { code: 404, body: 'bad url ' + url };
  const hours = m[2].split(',').map(h => (h.length < 2 ? '0' : '') + h);
  const d = JSON.parse(JSON.stringify(api));
  d.day = m[1]; d.hours = hours;
  Object.values(d.plants).forEach(p => { const c = {}; hours.forEach(h => { if (p.checks[h]) c[h] = p.checks[h]; }); p.checks = c; });
  return { code: 200, body: JSON.stringify(d) };
}

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), name, JSON.stringify(a) === JSON.stringify(b) ? '' : `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const snap = sh => JSON.stringify(sh.grid);

// 1 helpers
{ const { ctx } = world();
  eq([ctx.pad_(9), ctx.pad_(13)], ['09', '13'], 'pad_');
  eq(['8:50', '08.50', '24:00', '9:60', 'x'].map(ctx.normTime_), ['08:50', '08:50', null, null, null], 'normTime_');
  eq(ctx.toMin_('08:50'), 530, 'toMin_');
  eq(ctx.sheetName_('2026-11-15'), '15.11', 'sheetName_');
  eq(['Normal', 'normal ', 'loss (13:00)', null, '—'].map(ctx.weatherStatus_), ['Normal', 'Normal', 'Abnormal', 'Abnormal', 'Abnormal'], 'weatherStatus_');
  eq(ctx.matchPlant_('SN1', 'x', { SN1: 'a' }, {}), 'a', 'matchPlant_ by SN');
  eq(ctx.matchPlant_('zz', 'บางไทร', {}, { a: 'P1 บางไทร', b: 'other' }), 'a', 'matchPlant_ by unique name');
  eq(ctx.matchPlant_('zz', 'สถานี', {}, { a: 'สถานี 1', b: 'สถานี 2' }), null, 'matchPlant_ ambiguous name → null');
  eq(ctx.fetchTimes_(), ['08:50', '12:50', '16:50'], 'fetchTimes_ default');
}
{ const { ctx } = world({ props: { FETCH_TIMES: '8:45,12:40,16:55' } }); eq(ctx.fetchTimes_(), ['08:45', '12:40', '16:55'], 'fetchTimes_ from property'); }
{ const { ctx } = world({ props: { FETCH_TIMES: '8:45,bad' } }); eq(ctx.fetchTimes_(), ['08:50', '12:50', '16:50'], 'fetchTimes_ bad property → default'); }

// 2 layout on the real sheet
{ const w = world(); const lay = w.ctx.layout_(w.ss.sheets[0]);
  eq({ weather: lay.weather, firmware: lay.firmware, yieldKwh: lay.yieldKwh, first: lay.first, last: lay.last }, { weather: 6, firmware: 5, yieldKwh: 0, first: 6, last: 18 }, 'layout_ columns (real 15.11 sheet)');
  eq(lay.blocks.map(b => [b.hour, b.status, b.irr, b.wx, b.log, b.note, b.kw, b.inv]), [[9, 7, 8, 9, 10, 0, 0, 0], [13, 11, 12, 13, 14, 0, 0, 0], [17, 15, 16, 17, 18, 0, 0, 0]], 'layout_ check blocks');
}

// 3 fillDay on the real sheet (09 already filled by hand/earlier run): nothing overwritten
{ const w = world(); const sh = w.ss.sheets[0]; const before = JSON.parse(snap(sh));
  const r = w.ctx.fillDay('2026-11-15', [9]);
  console.log('      ' + r.msg);
  let changed = [], overwrote = 0;
  sh.grid.forEach((row, i) => row.forEach((v, j) => { const o = before[i] ? before[i][j] : ''; if (v !== o) { changed.push(j + 1); if (o !== '' && [7, 8, 9, 10].indexOf(j + 1) >= 0) overwrote++; } }));
  eq(overwrote, 0, 'real sheet: no filled check cell (G–J) overwritten');
  const colsChanged = [...new Set(changed)].sort((a, b) => a - b);
  ok(colsChanged.every(c => [3, 5, 6, 7, 8, 9, 10].indexOf(c) >= 0), 'real sheet: changes only in C, E, F, G–J', 'changed cols ' + JSON.stringify(colsChanged) + ', cells ' + changed.length);
  eq(w.calls.length, 1, 'one API call'); eq([w.calls[0].key, w.calls[0].url], ['test-key', w.ctx.C.REPORT_URL + '/2026-11-15/cells?hours=9'], 'URL + X-Report-Key header');
}

// 4 new day sheet + full fill + idempotent second run
{ const w = world({ now: '2026-11-16T09:05' }); const { ctx, ss } = w;
  ctx.createTodaySheet();
  const sh = ss.getSheetByName('16.11');
  ok(!!sh && ss.sheets[ss.sheets.length - 1] === sh, 'createTodaySheet: 16.11 created as last tab');
  const tpl = ss.sheets[0], rows = sh.getLastRow();
  let dirty = 0, kept = true;
  sh.grid.forEach((row, i) => { if (i < 2) return; for (let c = 6; c <= 18; c++) if (row[c - 1] !== '') dirty++; [1, 2, 3, 4, 5].forEach(c => { if (row[c - 1] !== tpl.grid[i][c - 1]) kept = false; }); });
  eq(dirty, 0, 'new sheet: check columns F–R cleared'); ok(kept, 'new sheet: A–E (name, SN, kWp, Firmware) kept');
  eq(JSON.stringify(sh.grid.slice(0, 2)), JSON.stringify(tpl.grid.slice(0, 2)), 'new sheet: header rows kept');
  ctx.createTodaySheet(); eq(ss.sheets.length, 2, 'createTodaySheet twice: no duplicate');

  const r = ctx.fillDay('2026-11-16', [9, 13]);
  console.log('      ' + r.msg);
  eq(r.complete, ['09'], 'fillDay [9,13]: 13 unpublished → only 09 complete');
  eq(w.calls.map(c => c.url.split('hours=')[1]), ['9,13', '9'], 'refetch with published checks only');
  // compare every plant row with the API
  let bad = [], matched = 0, unmatched = 0, blank13 = true;
  const snOf = {}; Object.entries(api.loggers).forEach(([sn, id]) => { snOf[sn] = id; });
  sh.grid.forEach((row, i) => { if (i < 2) return; const sn = String(row[2]).trim(); if (!sn && !String(row[1]).trim()) return;
    const pid = snOf[sn]; if (!pid) { unmatched++; return; } matched++;
    const v = api.plants[pid].checks['09']; const want = v ? [v[0], v[2], v[3], v[4]] : ['', '', '', ''];
    const got = row.slice(6, 10); if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`row ${i + 1}: ${JSON.stringify(got)} vs ${JSON.stringify(want)}`);
    if (row.slice(10, 18).some(x => x !== '')) blank13 = false;
    const wx = String(api.plants[pid].weather_status).trim().toLowerCase() === 'normal' ? 'Normal' : 'Abnormal'; if (row[5] !== wx) bad.push(`row ${i + 1} weather ${row[5]} vs ${wx}`); });
  ok(bad.length === 0, `G–J + weather Status equal the API for ${matched} matched rows`, bad.slice(0, 3).join(' | '));
  ok(blank13, '13:00 / 17:00 columns left empty'); console.log(`      rows matched by SN ${matched}, not matched by SN ${unmatched}`);
  const s1 = snap(sh); const r2 = ctx.fillDay('2026-11-16', [9]);
  ok(/เติมช่องว่าง 0 ช่อง/.test(r2.msg) && snap(sh) === s1, 'second run: writes 0 cells, sheet unchanged', r2.msg);
}

// 5 never overwrite a hand-edited cell; fill the empty one next to it
{ const w = world({ now: '2026-11-16T09:05' }); w.ctx.createTodaySheet(); const sh = w.ss.getSheetByName('16.11');
  sh.grid[2][6] = 'abnormal'; sh.grid[2][8] = 'ฝนตก (manual)';
  w.ctx.fillDay('2026-11-16', [9]);
  eq([sh.grid[2][6], sh.grid[2][8]], ['abnormal', 'ฝนตก (manual)'], 'hand-typed Status / สภาพอากาศ kept');
  ok(sh.grid[2][7] !== '' && sh.grid[2][9] !== '', 'empty cells in the same row still filled');
}

// 6 API states
{ const w = world({ responder: () => ({ code: 200, body: JSON.stringify({ published_plants: 0, plants: {} }) }) }); const s = snap(w.ss.sheets[0]);
  const r = w.ctx.fillDay('2026-11-15', [9]); ok(/ยังไม่มีข้อมูล/.test(r.msg) && !r.complete.length && snap(w.ss.sheets[0]) === s, 'published_plants 0 → nothing written', r.msg); }
{ const d = JSON.parse(JSON.stringify(api)); Object.values(d.plants).forEach(p => { p.checks['09'] = ['—', '—', '—', '—', '—', '—', '—']; });
  const w = world({ responder: () => ({ code: 200, body: JSON.stringify(d) }) }); const s = snap(w.ss.sheets[0]);
  const r = w.ctx.fillDay('2026-11-15', [9]); ok(/ยังไม่มีข้อมูลในระบบ/.test(r.msg) && snap(w.ss.sheets[0]) === s, 'check all "—" → skipped, nothing written', r.msg); }
{ const w = world({ responder: (u, n) => (n === 1 ? { code: 503, body: 'cold' } : defaultResponder(u)) });
  const r = w.ctx.fillDay('2026-11-15', [9]); ok(w.calls.length === 2 && w.slept === 5000 && r.complete.length === 1, '503 then 200 → one retry after 5 s', `calls ${w.calls.length}`); }
{ const w = world({ responder: () => ({ code: 503, body: 'down' }) }); let e = ''; try { w.ctx.fillDay('2026-11-15', [9]); } catch (x) { e = x.message; }
  ok(/รหัส 503/.test(e) && /ขัดข้องชั่วคราว/.test(e) && w.calls.length === 2, '503 twice → error, 2 calls', e); }
{ const w = world({ responder: () => ({ code: 401, body: 'bad key' }) }); let e = ''; try { w.ctx.fillDay('2026-11-15', [9]); } catch (x) { e = x.message; }
  ok(/รหัส 401/.test(e) && /รหัสรายงานไม่ถูกต้อง/.test(e) && w.calls.length === 1, '401 → error, no retry', e); }
{ const w = world({ props: { REPORT_KEY: '' } }); delete w.props.REPORT_KEY; let e = ''; try { w.ctx.fillDay('2026-11-15', [9]); } catch (x) { e = x.message; }
  ok(/ยังไม่มีรหัสรายงาน/.test(e) && w.calls.length === 0, 'no key → error before any call', e); }

// 7 pollChecks schedule
{ const w = world({ now: '2026-11-16T08:45' }); w.ctx.createTodaySheet(); w.ctx.pollChecks(); eq(w.calls.length, 0, 'pollChecks 08:45: before fetch time, no call'); }
{ const w = world({ now: '2026-11-16T08:55' }); w.ctx.createTodaySheet(); w.ctx.pollChecks();
  eq([w.calls.length, w.props['DONE_2026-11-16'], w.released], [1, '09', true], 'pollChecks 08:55: fetches 09, marks DONE, releases lock');
  w.now = '2026-11-16T09:00'; w.ctx.pollChecks(); eq(w.calls.length, 1, 'pollChecks 09:00: 09 done → no more calls'); }
{ const w = world({ now: '2026-11-16T10:55' }); w.ctx.createTodaySheet(); w.ctx.pollChecks(); eq(w.calls.length, 0, 'pollChecks 10:55: window (120 min) over, no call'); }
{ const w = world({ now: '2026-11-16T12:55' }); w.ctx.createTodaySheet(); w.ctx.pollChecks();
  eq([w.calls.map(c => c.url.split('hours=')[1]), w.props['DONE_2026-11-16'] || ''], [['9,13', '9'], ''], 'pollChecks 12:55: 13 not published → not marked done, retried later'); }
{ const w = world({ now: '2026-11-16T08:55', locked: true }); w.ctx.createTodaySheet(); w.ctx.pollChecks(); eq(w.calls.length, 0, 'pollChecks: lock held by another run → skip'); }

// 8 fillNow menu
{ const w = world({ now: '2026-11-15T08:30' }); w.ctx.fillNow(); ok(/ยังไม่ถึงเวลา/.test(w.alerts[0]) && !w.calls.length, 'fillNow 08:30: alert, no call', w.alerts[0]); }
{ const w = world({ now: '2026-11-15T09:10', noUi: true }); w.ctx.fillNow(); ok(w.calls.length === 1 && w.logs.length >= 1, 'fillNow from a trigger (no UI): logs instead of alert'); }


// 9 menu + Thai dialogs
const thai = t => /[\u0E00-\u0E7F]/.test(t) && !/\b(error|failed|published?|undefined|null|NaN)\b/i.test(t);
const allThai = w => w.alerts.concat(w.prompts).every(thai);
{ const w = world({ now: '2026-11-15T09:05' }); w.ctx.onOpen(); eq(w.ss.active && w.ss.active.name, '15.11', 'onOpen: today\'s tab becomes the active sheet'); }
{ const w = world({ now: '2026-11-20T09:05' }); w.ctx.onOpen(); eq(w.ss.active, null, 'onOpen: no tab for today yet, the active sheet is left alone');
  w.ctx.goToday(); ok(w.alerts.length === 1 && /20\.11/.test(w.alerts[0]), 'goToday: says today\'s tab does not exist yet'); }
{ const w = world({ now: '2026-11-15T09:05' }); w.ctx.goToday(); eq(w.ss.active && w.ss.active.name, '15.11', 'goToday: shows today\'s tab'); eq(w.alerts.length, 0, 'goToday: no dialog when the tab exists'); }
{ const w = world(); w.ctx.onOpen(); console.log(w.menu.map(x => '      ' + x).join('\n')); eq(w.menu.filter(x => /→/.test(x)).length, 14, 'menu: 8 actions + 6 settings');
  ok(w.menu.filter(x => /→/.test(x)).every(x => typeof w.ctx[x.split(' → ')[1]] === 'function'), 'menu: every item points at a real function'); }
{ const { ctx } = world();
  eq(['', '9', '9,13', '17 09', '13:00', '9.00, 17', '10', 'x', '9,9'].map(ctx.parseHours_), [[9, 13, 17], [9], [9, 13], [9, 17], [13], [9, 17], null, null, [9]], 'parseHours_'); }
{ const { ctx } = world({ now: '2026-11-16T10:00' });
  eq(['', '2026-11-12', '12.11', '12/11', '12-11', '12/11/2026', '12/11/2569', '12.11.26', '1/3', '25.12', '17.11', '31.02', '12', 'abc', '2026-13-01'].map(ctx.parseDay_),
    ['2026-11-16', '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-12', '2026-03-01', '2026-12-25', '2026-11-17', null, null, null, null], 'parseDay_ (incl. Buddhist year)'); }
{ const { ctx } = world({ now: '2027-01-05T10:00' }); eq(['25.12', '4.1', '6.1'].map(ctx.parseDay_), ['2026-12-25', '2027-01-04', '2027-01-06'], 'parseDay_ in January: 25.12 = last December'); }
// setup: key, times, triggers
{ const w = world({ props: { REPORT_KEY: '' }, answers: ['secret-1', '8:45, 12:45, 16:45'] }); delete w.props.REPORT_KEY; w.ctx.setup();
  eq([w.props.REPORT_KEY, w.props.FETCH_TIMES, w.triggers.map(t => t.getHandlerFunction()).sort()], ['secret-1', '08:45,12:45,16:45', ['createTodaySheet', 'pollChecks']], 'setup: key + times stored, two triggers');
  ok(allThai(w) && /08:45  ดึงรอบ 09:00/.test(w.alerts[0]), 'setup: Thai dialogs, shows the schedule', w.alerts[0].split('\n')[0]);
  w.answers = ['', '']; w.ctx.setup(); eq([w.props.REPORT_KEY, w.props.FETCH_TIMES, w.triggers.length], ['secret-1', '08:45,12:45,16:45', 2], 'setup again with blanks: keeps key + times, no duplicate triggers'); }
{ const w = world({ answers: [null] }); w.ctx.setup(); eq([w.alerts.length, w.triggers.length], [0, 0], 'setup cancelled: nothing changes'); }
{ const w = world({ answers: ['8:45, 25:00, x'] }); w.ctx.setTimes(); ok(!('FETCH_TIMES' in w.props) && /ต้องใส่ 3 เวลา/.test(w.alerts[0]) && allThai(w), 'setTimes invalid: not saved, Thai message', w.alerts[0]); }
{ const w = world({ answers: ['new-key'] }); w.ctx.setKey(); eq([w.props.REPORT_KEY, w.alerts[0]], ['new-key', 'บันทึกรหัสรายงานแล้ว'], 'setKey'); }
{ const w = world(); w.ctx.autoOn(); const on = w.triggers.length; w.ctx.showStatus(); const st = w.alerts[1]; w.ctx.autoOff();
  ok(on === 2 && w.triggers.length === 0 && /การทำงานอัตโนมัติ: เปิด/.test(st) && /รหัสรายงาน: ตั้งไว้แล้ว/.test(st) && allThai(w), 'autoOn / showStatus / autoOff', st.replace(/\n+/g, ' | ')); }
{ const w = world({ props: { REPORT_KEY: '' } }); delete w.props.REPORT_KEY; w.ctx.autoOn(); ok(w.triggers.length === 0 && /ยังไม่มีรหัสรายงาน/.test(w.alerts[0]), 'autoOn without a key: refused'); }
{ const w = world({ now: '2026-11-16T07:30' }); w.ctx.menuCreateToday(); w.ctx.menuCreateToday();
  eq([w.ss.sheets.map(s => s.name), w.alerts], [['15.11', '16.11'], ['สร้างแท็บ 16.11 แล้ว', 'มีแท็บ 16.11 อยู่แล้ว']], 'menuCreateToday'); }
// pick checks today, before the fetch time
{ const w = world({ now: '2026-11-16T08:00', answers: ['9'] }); w.ctx.menuCreateToday(); w.ctx.fillPickChecks();
  ok(w.calls.length === 1 && /hours=9$/.test(w.calls[0].url) && /เติมช่องว่าง 932 ช่อง/.test(w.alerts[1]) && allThai(w), 'fillPickChecks "9" at 08:00: fetched regardless of fetch time', w.alerts[1].replace(/\n+/g, ' | ')); }
{ const w = world({ answers: ['10'] }); w.ctx.fillPickChecks(); ok(!w.calls.length && /ไม่รู้จักรอบ "10"/.test(w.alerts[0]), 'fillPickChecks "10": rejected, no call'); }
{ const w = world({ now: '2026-11-16T10:00', answers: ['9, 13'] }); w.ctx.menuCreateToday(); w.ctx.fillPickChecks();
  ok(/รอบ 13:00 ยังไม่มีข้อมูลในระบบ จึงข้ามไป/.test(w.alerts[1]), 'fillPickChecks "9, 13": says 13:00 was skipped'); }
// past day with flexible date
{ const w = world({ now: '2026-11-16T10:00', answers: ['15/11/2569', ''] }); w.ctx.fillAskDay();
  ok(w.calls.length === 2 && /2026-11-15\/cells\?hours=9,13,17$/.test(w.calls[0].url) && /^แท็บ 15.11 รอบ 09:00/.test(w.alerts[0]) && allThai(w), 'fillAskDay "15/11/2569", all checks', w.alerts[0].replace(/\n+/g, ' | ')); }
{ const w = world({ now: '2026-11-16T10:00', answers: ['17.11'] }); w.ctx.fillAskDay(); ok(!w.calls.length && w.alerts[0] === '17.11 ยังมาไม่ถึง', 'fillAskDay future date: rejected'); }
{ const w = world({ now: '2026-11-16T10:00', answers: ['31.02'] }); w.ctx.fillAskDay(); ok(!w.calls.length && /ไม่รู้จักวันที่/.test(w.alerts[0]), 'fillAskDay impossible date: rejected'); }
// overwrite
{ const w = world({ now: '2026-11-16T10:00', answers: ['15.11', '9'], confirm: 'NO' }); const s0 = snap(w.ss.sheets[0]); w.ctx.refillOverwrite();
  ok(!w.calls.length && snap(w.ss.sheets[0]) === s0 && /ยกเลิกแล้ว/.test(w.alerts[1]) && allThai(w), 'refillOverwrite answered No: nothing fetched or changed'); }
{ const w = world({ now: '2026-11-16T10:00', answers: ['15.11', '9'], confirm: 'YES' }); const sh = w.ss.sheets[0];
  const before = sh.grid[2].slice(6, 10); w.ctx.refillOverwrite(); const after = sh.grid[2].slice(6, 10);
  const pid = api.loggers[String(sh.grid[2][2])], v = api.plants[pid].checks['09'];
  ok(JSON.stringify(after) === JSON.stringify([v[0], v[2], v[3], v[4]]) && JSON.stringify(before) !== JSON.stringify(after) && /เขียนทับ\/เติม \d+ ช่อง/.test(w.alerts[1]) && allThai(w),
    'refillOverwrite answered Yes: row 3 now equals the API', `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  ok(sh.grid.slice(2).every(r => r.slice(10, 18).every(x => x === '')), 'refillOverwrite: other checks untouched'); }
// errors surface as Thai dialogs, never a raw exception
{ const w = world({ answers: ['9'], responder: () => ({ code: 401, body: '{"detail":"Invalid report key"}' }) }); let threw = false; try { w.ctx.fillPickChecks(); } catch (e) { threw = true; }
  ok(!threw && /^เกิดข้อผิดพลาด/.test(w.alerts[0]) && /รหัสรายงานไม่ถูกต้อง/.test(w.alerts[0]) && allThai(w), 'API 401 from a menu: Thai dialog', w.alerts[0].replace(/\n+/g, ' | ')); }
{ const w = world({ now: '2026-11-15T09:10', responder: () => ({ code: 500, body: 'Internal Server Error' }) }); w.ctx.fillNow();
  ok(/ระบบขัดข้องชั่วคราว/.test(w.alerts[0]) && allThai(w), 'fillNow with API 500: Thai dialog', w.alerts[0].replace(/\n+/g, ' | ')); }
{ const w = world({ answers: ['9'] }); w.ss.sheets[0].grid[0][5] = 'x'; w.ctx.fillPickChecks(); ok(/ไม่พบหัวคอลัมน์ "Weather Status"/.test(w.alerts[0]), 'broken header: Thai dialog', w.alerts[0].replace(/\n+/g, ' | ')); }


// 10 one file per month
const addTabs = (w, names) => names.forEach(n => { const t = w.ss.sheets[0].copyTo(w.ss); t.setName(n); });
const names = x => x.sheets.map(s => s.name);
{ const w = world({ now: '2026-11-16T06:00' }); w.ctx.createTodaySheet();
  eq([names(w.ss), w.drive.copies.length], [['15.11', '16.11'], 0], 'same month: no archive, no Drive file'); }
{ const w = world({ now: '2026-12-01T06:00' }); addTabs(w, ['16.11', '30.11']); w.ss.sheets.unshift(new Sheet('สรุป', [['x']]));
  w.ctx.createTodaySheet(); const c = w.drive.files.COPY1;
  eq(names(w.ss), ['สรุป', '01.12'], 'new month: working file keeps only the new tab (+ non-date sheets)');
  eq([c.ss.name, c.folder, names(c.ss)], ['Monitoring PWA Report 2026-11', 'home', ['สรุป', '15.11', '16.11', '30.11']], 'new month: November file in the same folder, with only November tabs');
  eq(JSON.stringify(c.ss.getSheetByName('15.11').grid), JSON.stringify(src.grid), 'archived tab content identical to the original');
  eq(w.props['ARCHIVED_2026-11'], 'COPY1', 'month marked archived');
  w.now = '2026-12-02T06:00'; w.ctx.createTodaySheet(); eq([names(w.ss), w.drive.copies.length], [['สรุป', '01.12', '02.12'], 1], 'next day: no second archive'); }
{ const w = world({ now: '2027-01-01T06:00' }); addTabs(w, ['01.12', '31.12']); w.ctx.createTodaySheet();
  eq([names(w.ss), w.drive.copies.map(id => w.drive.files[id].ss.name), names(w.drive.files.COPY1.ss), names(w.drive.files.COPY2.ss)],
    [['01.01'], ['Monitoring PWA Report 2026-11', 'Monitoring PWA Report 2026-12'], ['15.11'], ['01.12', '31.12']], 'January: two months behind → two files, years from the month'); }
{ const w = world({ now: '2026-12-01T06:00', props: { ARCHIVE_FOLDER_ID: 'FOLDERID1234' } }); w.ctx.createTodaySheet(); eq(w.drive.files.COPY1.folder, 'FOLDERID1234', 'archive folder from the setting'); }
{ const w = world({ now: '2026-12-01T06:00', dropTab: '15.11' }); w.ctx.createTodaySheet();
  ok(names(w.ss).join() === '15.11,01.12' && !w.props['ARCHIVED_2026-11'] && /จึงยังไม่ลบแท็บ/.test(w.logs.join()), 'copy incomplete: tabs NOT deleted here, error logged', w.logs.join(' ').slice(0, 120)); }
{ const w = world({ now: '2026-12-01T06:00', copyFails: true }); w.ctx.createTodaySheet(); eq(names(w.ss), ['15.11', '01.12'], 'Drive copy fails: today\'s tab still created, old tabs kept'); }
{ const w = world({ now: '2026-12-01T09:00', confirm: 'NO' }); w.ctx.menuArchive(); ok(names(w.ss).join() === '15.11' && !w.drive.copies.length && /เดือน 11\/2026: 1 แท็บ/.test(w.alerts[0]) && allThai(w), 'menuArchive answered No: nothing changes', w.alerts[0].split('\n')[1]); }
{ const w = world({ now: '2026-12-01T09:00', confirm: 'YES' }); w.ctx.menuArchive(); ok(names(w.ss).join() === '01.12' && /เก็บไฟล์รายเดือนแล้ว/.test(w.alerts[1]) && /docs.google.com/.test(w.alerts[1]), 'menuArchive answered Yes: archived, link shown', w.alerts[1].replace(/\n+/g, ' | ')); }
{ const w = world({ now: '2026-11-16T09:00' }); w.ctx.menuArchive(); ok(/ไม่มีแท็บของเดือนก่อน/.test(w.alerts[0]), 'menuArchive with only the current month: nothing to do'); }
{ const w = world({ answers: ['https://drive.google.com/drive/folders/FOLDERID1234?usp=sharing'] }); w.ctx.setArchiveFolder(); eq([w.props.ARCHIVE_FOLDER_ID, w.alerts[0]], ['FOLDERID1234', 'บันทึกแล้ว ไฟล์รายเดือนจะเก็บในโฟลเดอร์: Archive 2026'], 'setArchiveFolder from a Drive link');
  w.answers = ['https://drive.google.com/drive/folders/NOPE99999999']; w.ctx.setArchiveFolder(); ok(w.props.ARCHIVE_FOLDER_ID === 'FOLDERID1234' && /เปิดโฟลเดอร์นี้ไม่ได้/.test(w.alerts[1]), 'setArchiveFolder unknown folder: kept the old one');
  w.answers = ['']; w.ctx.setArchiveFolder(); ok(!('ARCHIVE_FOLDER_ID' in w.props) && /รายงาน PWA/.test(w.alerts[2]) && allThai(w), 'setArchiveFolder blank: back to this file\'s folder'); }


// 11 Firmware column: the datalogger's firmware; the API has none → blank
{ const w = world({ now: '2026-11-16T10:00' }); const sh = w.ss.sheets[0]; const sn = r => String(sh.grid[r][2]);
  const d = JSON.parse(JSON.stringify(api)); const old = d.firmware; d.firmware = {}; d.dataloggers = {};
  Object.keys(old).forEach(k => { d.dataloggers[k] = { inverter_firmware: ['TN1.0', old[k]] }; });
  sh.grid[2][4] = old[sn(2)]; sh.grid[3][4] = '—'; sh.grid[4][4] = '3.1.0.2'; sh.grid[5][4] = '';
  w.responder = () => ({ code: 200, body: JSON.stringify(d) });
  const r = w.ctx.fillDay('2026-11-15', [9]);
  eq([sh.grid[2][4], sh.grid[3][4], sh.grid[4][4], sh.grid[5][4]], ['', '', '3.1.0.2', ''], 'Firmware: old inverter code and "—" blanked, hand-typed kept, empty stays empty');
  ok(/ล้างช่อง Firmware 2 แถว/.test(r.msg) && !/เติม Firmware/.test(r.msg), 'Firmware: message says 2 cells cleared', r.msg.split('\n').pop());
  eq(sh.grid.slice(2).filter(row => row[4] === '—').length, 0, 'Firmware: no "—" written anywhere'); }
{ const w = world(); const sh = w.ss.sheets[0]; sh.grid[2][4] = 'x1'; const d = JSON.parse(JSON.stringify(api)); delete d.firmware;
  w.responder = () => ({ code: 200, body: JSON.stringify(d) }); w.ctx.fillDay('2026-11-15', [9]); eq(sh.grid[2][4], 'x1', 'Firmware: API without the map → column untouched'); }

// 12 robustness: network failure, non-JSON answer, plant missing from the API, minimal writes, old DONE_ keys
{ const w = world({ responder: (u, n) => (n === 1 ? { throws: 'Timeout: ' + u } : defaultResponder(u)) });
  const r = w.ctx.fillDay('2026-11-15', [9]); ok(w.calls.length === 2 && w.slept === 5000 && r.complete.length === 1, 'fetch throws then 200 → one retry after 5 s'); }
{ const w = world({ answers: ['9'], responder: u => ({ throws: 'DNS error: ' + u }) }); w.ctx.fillPickChecks();
  ok(w.calls.length === 2 && /เชื่อมต่อระบบไม่ได้/.test(w.alerts[0]) && !/DNS/.test(w.alerts[0]) && allThai(w), 'fetch throws twice: Thai dialog, detail only in the log', w.alerts[0].replace(/\n+/g, ' | ')); }
{ const w = world({ answers: ['9'], responder: () => ({ code: 200, body: '<html>Site Not Found</html>' }) }); const s = snap(w.ss.sheets[0]); w.ctx.fillPickChecks();
  ok(/อ่านไม่ได้/.test(w.alerts[0]) && snap(w.ss.sheets[0]) === s && allThai(w), '200 that is not JSON: Thai dialog, nothing written', w.alerts[0].replace(/\n+/g, ' | ')); }
{ const w = world({ now: '2026-11-16T09:05' }); w.ctx.createTodaySheet(); const sh = w.ss.getSheetByName('16.11');
  const d = JSON.parse(JSON.stringify(api)); const sn = String(sh.grid[2][2]); delete d.plants[d.loggers[sn]];
  w.responder = () => ({ code: 200, body: JSON.stringify(d) }); let e = ''; let r; try { r = w.ctx.fillDay('2026-11-16', [9]); } catch (x) { e = x.message; }
  ok(!e && /สถานีที่ไม่พบในระบบ 1/.test(r.msg) && sh.grid[2][5] === 'Abnormal' && sh.grid[3][6] !== '', 'logger points at a plant the API left out: row unmatched, other rows filled', e); }
{ const w = world({ now: '2026-11-16T09:05' }); w.ctx.createTodaySheet(); const sh = w.ss.getSheetByName('16.11');
  w.ctx.fillDay('2026-11-16', [9]); const n = sh.writes; w.ctx.fillDay('2026-11-16', [9]); eq(sh.writes, n, 'second run with nothing new: no write to the sheet at all'); }
{ const { ctx } = world(); eq([ctx.runs_([8, 6, 7, 11, 7]), ctx.runs_([])], [[[6, 3], [11, 1]], []], 'runs_'); }
{ const w = world(); const sh = w.ss.sheets[0]; const lay = w.ctx.layout_(sh); // a manual column between the report's columns is never rewritten
  const calls = []; const real = sh.getRange.bind(sh); sh.getRange = (r, c, nr, nc) => { const g = real(r, c, nr, nc); const sv = g.setValues.bind(g); g.setValues = v => { calls.push([c, nc]); sv(v); }; return g; };
  const vals = real(3, 6, 2, 13).getValues(), before = vals.map(x => x.slice()); vals[0][0] = 'A'; vals[1][12] = 'B'; vals[0][5] = 'manual';
  w.ctx.writeColumns_(sh, [6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18], 6, vals, before);
  eq([calls, sh.grid[2][5], sh.grid[3][17], sh.grid[2][10] === 'manual'], [[[6, 5], [12, 7]], 'A', 'B', false], 'writeColumns_: writes the report\'s runs only, skips the column between them'); }
{ const w = world({ now: '2026-11-16T06:00', props: { 'DONE_2026-11-14': '09,13,17', 'DONE_2026-11-15': '09', 'DONE_2026-11-16': '09' } }); w.ctx.createTodaySheet();
  eq(Object.keys(w.props).filter(k => /^DONE_/.test(k)), ['DONE_2026-11-16'], 'createTodaySheet: DONE_ of past days deleted, today kept'); }
{ const w = world({ now: '2026-12-01T06:00', dropTab: '15.11' }); w.ctx.createTodaySheet(); eq(w.drive.files.COPY1.trashed, true, 'copy incomplete: the incomplete file goes to the Drive bin'); }
{ const w = world({ now: '2026-11-16T06:00' }); const t = w.ss.sheets[0].copyTo(w.ss); t.setName('15.11 สำรอง'); t.grid[2][1] = 'WRONG'; w.ctx.createTodaySheet();
  ok(w.ss.getSheetByName('16.11').grid[2][1] !== 'WRONG', 'new day sheet: copied from a DD.MM tab, not from "15.11 สำรอง"'); }

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
