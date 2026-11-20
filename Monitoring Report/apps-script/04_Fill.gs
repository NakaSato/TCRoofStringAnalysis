// ------------------------------------------------------------------ main

/**
 * Fills `day`'s sheet for checks `hours` (default all three). Check cells are written only while empty
 * (`opts.overwrite`: also where the API's value differs); checks the API hasn't published yet are
 * skipped. Returns {msg, complete: ["09", …]} where complete lists the checks every matched plant row
 * now has. `msg` is Thai (it is shown in a dialog).
 */
function fillDay(day, hours, opts) {
  const overwrite = !!(opts && opts.overwrite);
  const ss = SpreadsheetApp.getActive();
  const name = sheetName_(day);
  const sh = ss.getSheetByName(name) || newDaySheet_(ss, name);
  const lay = layout_(sh);
  let blocks = hours ? lay.blocks.filter(b => hours.indexOf(b.hour) >= 0) : lay.blocks;
  if (!blocks.length) return { msg: `แท็บ ${name}: ไม่มีรอบให้ดึง`, complete: [] };

  let data = reportCells_(day, blocks.map(b => b.hour));
  if (!data.published_plants) return { msg: `แท็บ ${name}: ระบบยังไม่มีข้อมูลของวันนี้`, complete: [] };
  const ready = blocks.filter(b => published_(data, pad_(b.hour)));
  if (!ready.length) return { msg: `แท็บ ${name}: รอบ ${blocks.map(b => clock_(b.hour)).join(', ')} ยังไม่มีข้อมูลในระบบ ลองใหม่ภายหลัง`, complete: [] };
  if (ready.length < blocks.length) { // refetch so weather Status / yield cover only published checks
    blocks = ready;
    data = reportCells_(day, blocks.map(b => b.hour));
  }
  const cols = data.columns; // ["status", "note", "irr", "wx", "log", "kw", "inv"]
  const names = data.names || {};

  const last = sh.getLastRow();
  if (last < FIRST_ROW) return { msg: `แท็บ ${name}: ไม่มีแถวสถานี`, complete: [] };
  const n = last - FIRST_ROW + 1;
  const keys = sh.getRange(FIRST_ROW, 2, n, 2).getValues(); // B name, C SN
  const block = sh.getRange(FIRST_ROW, lay.first, n, lay.last - lay.first + 1);
  const values = block.getValues();
  const before = values.map(row => row.slice());
  const get =(row, col) => values[row][col - lay.first];
  const set = (row, col, v) => { if (col) values[row][col - lay.first] = v; };
  const fill = (row, col, v) => {
    if (!col) return 0;
    const cur = get(row, col);
    if (cur === '' || (overwrite && cur !== v)) { values[row][col - lay.first] = v; return 1; }
    return 0;
  };

  const stats = { rows: 0, written: 0, kept: 0, unmatched: 0, snUpdated: 0 };
  const missing = {}; blocks.forEach(b => { missing[pad_(b.hour)] = 0; });
  const snOf = loggersByPlant_(data);
  const snCol = keys.map(k => [k[1]]);
  keys.forEach(([nm, sn], i) => {
    sn = String(sn || '').trim();
    nm = String(nm || '').trim();
    if (!sn && !nm) return; // not a plant row
    const pid = matchPlant_(sn, nm, data.loggers || {}, names);
    const p = pid && (data.plants || {})[pid]; // a logger / name may point at a plant the API left out
    if (!p) { if (sn) { stats.unmatched++; set(i, lay.weather, WX_ABNORMAL); } return; }
    stats.rows++;
    // SN Datalogger (column C): the plant's current datalogger, when the sheet's SN isn't one of its
    // loggers (replaced, or C empty) and the API names exactly one.
    const sns = snOf[pid] || [];
    if (sns.indexOf(sn) < 0 && sns.length === 1) { snCol[i] = [sns[0]]; keys[i][1] = sns[0]; stats.snUpdated++; }
    blocks.forEach(b => {
      const v = (p.checks || {})[pad_(b.hour)];
      if (!v) { if (get(i, b.status) === '') missing[pad_(b.hour)]++; return; }
      const wasEmpty = get(i, b.status) === '';
      cols.forEach((c, k) => { stats.written += fill(i, b[c], v[k]); });
      if (!wasEmpty && !overwrite) stats.kept++;
      if (get(i, b.status) === '') missing[pad_(b.hour)]++;
    });
    set(i, lay.weather, weatherStatus_(p.weather_status));
    set(i, lay.yieldKwh, p.yield_kwh);
  });
  writeColumns_(sh, lay.cols, lay.first, values, before);
  if (stats.snUpdated) sh.getRange(FIRST_ROW, 3, snCol.length, 1).setValues(snCol);
  const fw = fillFirmware_(sh, lay.firmware, keys, data.firmware, overwrite, data.dataloggers);
  const complete = Object.keys(missing).filter(hh => !missing[hh]);
  const skipped = hours ? hours.filter(h => blocks.every(b => b.hour !== h)) : [];
  const msg = `แท็บ ${name} รอบ ${blocks.map(b => clock_(b.hour)).join(', ')} (${stats.rows} สถานี)\n\n` +
    (overwrite ? `เขียนทับ/เติม ${stats.written} ช่อง\n`
      : `เติมช่องว่าง ${stats.written} ช่อง\nสถานีที่มีค่าอยู่แล้ว (ไม่เขียนทับ) ${stats.kept}\n`) +
    `สถานีที่ไม่พบในระบบ ${stats.unmatched}\nแก้เลข SN ${stats.snUpdated} แถว` +
    (fw && fw.hits ? `\nเติม Firmware ${fw.hits} แถว` : '') +
    (fw && fw.cleared ? `\nล้างช่อง Firmware ${fw.cleared} แถว (ระบบไม่มี Firmware ของ Datalogger)` : '') +
    (skipped.length ? `\n\nรอบ ${skipped.map(clock_).join(', ')} ยังไม่มีข้อมูลในระบบ จึงข้ามไป` : '');
  console.log(msg.replace(/\n+/g, ' | '));
  return { msg, complete };
}

/**
 * Writes `values` (rows from FIRST_ROW, columns from `first`) back to the sheet: only the report's own
 * columns `cols`, in contiguous runs, and only the runs that differ from `before`. A manual column or
 * formula between the report's columns is never rewritten, and a run that changes nothing writes nothing.
 */
function writeColumns_(sh, cols, first, values, before) {
  runs_(cols).forEach(([col, width]) => {
    const k = col - first;
    const changed = values.some((row, i) => row.slice(k, k + width).some((v, j) => v !== before[i][k + j]));
    if (changed) sh.getRange(FIRST_ROW, col, values.length, width).setValues(values.map(row => row.slice(k, k + width)));
  });
}

/** Column numbers as contiguous runs [first column, width]: [6, 7, 8, 11] → [[6, 3], [11, 1]]. */
function runs_(cols) {
  const out = [];
  Array.from(new Set(cols)).sort((a, b) => a - b).forEach(col => {
    const run = out[out.length - 1];
    if (run && run[0] + run[1] === col) run[1]++;
    else out.push([col, 1]);
  });
  return out;
}

/**
 * Firmware column (row-1 header "Firmware"), by the row's datalogger SN (column C):
 * firmware = {datalogger_sn: version} from the API = the DATALOGGER's own firmware. Growatt's API
 * gives none, so the map is empty and the cell is left blank (nothing is made up). A cell that holds
 * "—" or an inverter version an older script wrote there (dataloggers[sn].inverter_firmware from the
 * API) is blanked; anything else (typed by hand) is kept. Written on its own, so the check block and
 * newDaySheet_ (which clears only the report's own columns) never touch it. Returns {hits, cleared}
 * (rows that got a version / rows blanked), or null when the sheet has no Firmware column or the API
 * sent no firmware map (older API: the column is left as it is). `overwrite` (ดึงใหม่และเขียนทับ…):
 * a cell is also replaced when the API has a different version for the row.
 */
function fillFirmware_(sh, col, keys, firmware, overwrite, dataloggers) {
  if (!col || !firmware) return null;
  let hits = 0, cleared = 0;
  const range = sh.getRange(FIRST_ROW, col, keys.length, 1);
  const old = range.getValues();
  const vals = keys.map(([, sn], i) => {
    sn = String(sn || '').trim();
    if (!sn) return old[i]; // non-plant row: keep
    const cur = String(old[i][0] === null ? '' : old[i][0]).trim();
    const v = firmware[sn] || '';
    const stale = ((dataloggers || {})[sn] || {}).inverter_firmware || [];
    const ours = cur === '' || cur === DASH || stale.indexOf(cur) >= 0; // empty, or written by the report
    if (!ours && !(overwrite && v && v !== cur)) return old[i]; // typed by hand: kept
    if (v) hits++;
    else if (cur !== '') cleared++;
    return [v];
  });
  if (vals.some((row, i) => row[0] !== old[i][0])) range.setValues(vals);
  return { hits, cleared };
}

/**
 * {plant id: [datalogger SN, …]}: the plant's own `datalogger_sn` (list or string) when the API sends
 * one, else every SN in the API's loggers map that points at that plant.
 */
function loggersByPlant_(data) {
  const out = {};
  Object.keys(data.plants || {}).forEach(id => {
    const own = data.plants[id].datalogger_sn;
    if (own) out[id] = [].concat(own).map(String);
  });
  const loggers = data.loggers || {};
  Object.keys(loggers).forEach(sn => {
    const id = loggers[sn];
    if (data.plants && data.plants[id] && data.plants[id].datalogger_sn) return;
    (out[id] = out[id] || []).push(sn);
  });
  return out;
}

/**
 * weather Status is only "Normal" / "Abnormal" (header "(Normal / Abnormal)"): Normal when the API
 * says the weather sensor reported at every check so far; anything else — a missed check
 * ("loss (13:00)"), no sensor, no data, plant not found — is Abnormal.
 */
function weatherStatus_(v) {
  return String(v == null ? '' : v).trim().toLowerCase() === 'normal' ? WX_NORMAL : WX_ABNORMAL;
}

/** True when at least one plant has a real value (not "—" / empty) in check `hh`. */
function published_(data, hh) {
  return Object.keys(data.plants || {}).some(id => {
    const v = (data.plants[id].checks || {})[hh];
    return v && v.some(x => x !== DASH && x !== '' && x != null);
  });
}

/** Plant id of a sheet row: datalogger SN, else a unique plant-name match (datalogger replaced). */
function matchPlant_(sn, nm, loggers, names) {
  if (loggers[sn]) return loggers[sn];
  const hits = nm ? Object.keys(names).filter(id => String(names[id] || '').indexOf(nm) >= 0) : [];
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Column map from header rows 1–2. Works for both layouts:
 *   old (≤ 30.10): weather Status | Status, Note  ×3
 *   new (12.11+):  weather Status | Status, ค่าแสง, สภาพอากาศ, DATA LOG  ×3
 *   optional:      per check "kW" (or กำลังผลิต), "INV online"; row 1 "Yield (kWh)" (or พลังงาน)
 * Each "Status" in row 2 starts the next check block (09, 13, 17).
 */
function layout_(sh) {
  const width = sh.getLastColumn();
  const [r1, r2] = sh.getRange(1, 1, 2, width).getDisplayValues();
  const weather = r1.findIndex(v => /weather\s*status/i.test(v)) + 1;
  if (!weather) throw new Error(`แท็บ ${sh.getName()}: ไม่พบหัวคอลัมน์ "Weather Status" ในแถวที่ 1`);
  const starts = [];
  r2.forEach((v, k) => { if (k + 1 > weather && /^status/i.test(String(v).trim())) starts.push(k + 1); });
  if (starts.length < CHECK_HOURS.length) throw new Error(`แท็บ ${sh.getName()}: แถวที่ 2 ต้องมีหัวคอลัมน์ "Status" ${CHECK_HOURS.length} คอลัมน์ (รอบละหนึ่ง)`);
  const blocks = CHECK_HOURS.map((hour, k) => {
    const from = starts[k], to = k + 1 < starts.length ? starts[k + 1] - 1 : Math.min(width, from + 6);
    const b = { hour, status: from, note: 0, irr: 0, wx: 0, log: 0, kw: 0, inv: 0 };
    for (let col = from + 1; col <= to; col++) {
      const v = String(r2[col - 1]).trim();
      if (/^note/i.test(v)) b.note = col;
      else if (/ค่าแสง/.test(v)) b.irr = col;
      else if (/สภาพอากาศ/.test(v)) b.wx = col;
      else if (/data\s*log/i.test(v)) b.log = col;
      else if (/^kw\b/i.test(v) || /กำลังผลิต/.test(v)) b.kw = col;
      else if (/inv\s*online/i.test(v)) b.inv = col;
    }
    return b;
  });
  const yieldKwh = r1.findIndex(v => /yield/i.test(v) || /พลังงาน/.test(v)) + 1;
  const firmware = r1.findIndex(v => /firmware/i.test(v)) + 1; // own column, outside the check block
  const cols = [weather, yieldKwh].concat(...blocks.map(b => [b.status, b.note, b.irr, b.wx, b.log, b.kw, b.inv])).filter(Boolean);
  return { weather, yieldKwh, firmware, blocks, cols, first: Math.min(...cols), last: Math.max(...cols) };
}

/**
 * New day sheet = copy of the newest DD.MM sheet with its check columns cleared: only the columns
 * the report writes (layout_ cols), in contiguous runs, so a manual column between them is kept.
 */
function newDaySheet_(ss, name) {
  const tpl = ss.getSheets().filter(s => /^\d{2}\.\d{2}$/.test(s.getName())).pop();
  if (!tpl) throw new Error('ไม่มีแท็บรูปแบบ วัน.เดือน (เช่น 12.11) ให้คัดลอกเป็นแท็บใหม่');
  const sh = tpl.copyTo(ss).setName(name);
  ss.setActiveSheet(sh);
  ss.moveActiveSheet(ss.getNumSheets());
  const lay = layout_(sh);
  const rows = sh.getLastRow() - FIRST_ROW + 1;
  if (rows > 0) runs_(lay.cols).forEach(([col, width]) => sh.getRange(FIRST_ROW, col, rows, width).clearContent());
  return sh;
}
