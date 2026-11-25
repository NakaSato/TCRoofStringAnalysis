// ============================================================ helpers

/**
 * Runs a Sheets API call again after a pause when Google answers "too many requests" or a passing
 * server error (the API allows about 60 reads a minute), instead of giving the plant up.
 */
function retry_(call) {
  for (let k = 0; ; k++) {
    try {
      return call();
    } catch (e) {
      const msg = String(e && e.message || e);
      if (k >= 4 || !/quota|rate limit|too many|429|50[0234]|internal error|unavailable|timed out|try again/i.test(msg)) throw e;
      console.warn(`รอแล้วลองใหม่ (ครั้งที่ ${k + 1}): ${msg}`);
      Utilities.sleep(5000 * Math.pow(2, k));           // 5, 10, 20, 40 s
    }
  }
}

/** A short fingerprint of a value: the same value always gives the same text. */
function signature_(value) {
  const text = JSON.stringify(value);
  let h = 5381;
  for (let k = 0; k < text.length; k++) h = ((h * 33) ^ text.charCodeAt(k)) >>> 0;
  return `${text.length}.${h}`;
}

function checkYm_(ym) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym))) throw new Error(`เดือนต้องเป็นรูปแบบ yyyy-MM เช่น 2026-12 (ได้รับ: ${ym})`);
}

/** Days in month m (1-12) of year y. */
function daysIn_(y, m) { return new Date(y, m, 0).getDate(); }

function ym_(d) { return Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM'); }

function nextYm_() {
  const [y, m] = ym_(new Date()).split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * A date typed in a day sheet (วันเข้าแก้ไข, วันที่แก้ไขเสร็จ) as a real A.D. date for the Overview. The year
 * may be typed as พ.ศ. (2400 or more, or short: 69 = 2569) or ค.ศ.; anything that is not a date is returned as typed.
 */
function typedDate_(v) {
  let y, m, d;
  if (v instanceof Date) {
    y = v.getFullYear(); m = v.getMonth() + 1; d = v.getDate();
  } else if (typeof v === 'number') {                          // a date cell, as the Sheets API reads it (serial number)
    const x = new Date(1899, 11, 30 + Math.floor(v));
    y = x.getFullYear(); m = x.getMonth() + 1; d = x.getDate();
  } else {                                              // text, e.g. 29/02/2571 (no such day in the A.D. year 2571)
    const t = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4}|\d{2})$/.exec(String(v === null || v === undefined ? '' : v).trim());
    if (!t) return v;
    d = Number(t[1]); m = Number(t[2]); y = Number(t[3]);
    if (y < 100) y += 2500;                             // a short Buddhist year: 26/11/69 = 26/11/2569
  }
  if (y >= 2400) y -= 543;                              // typed as a Buddhist year
  // 26/11/69 typed into a date cell: Sheets reads the short year as 1969 (shown as 2512 in the Overview);
  // no date of this work is in 1930–1999, so it is the short Buddhist year 2569
  if (y >= 1930 && y <= 1999) y += 2500 - 1900 - 543;
  const out = new Date(y, m - 1, d);
  return out.getMonth() === m - 1 && out.getDate() === d ? out : v;   // not a real day: kept as typed
}

/** A real date as the text the Overview shows: dd/mm/พ.ศ., e.g. 16/11/2569. */
function beText_(d) {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear() + 543}`;
}

/**
 * "01 เมษายน พ.ศ. 2568" from the Overview's วันที่เริ่มให้บริการ, which is typed as a Buddhist-year date
 * dd/mm/yyyy (text, e.g. 01/04/2568). A real date cell also works: a year below 2400 is read as A.D.
 */
function thDate_(v) {
  const long = (d, m, y) => `${String(d).padStart(2, '0')} ${TH_MONTH[m]} พ.ศ. ${y < 2400 ? y + 543 : y}`;
  if (v instanceof Date) return long(v.getDate(), v.getMonth() + 1, v.getFullYear());
  const text = v === null || v === undefined ? '' : String(v).trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return long(Number(m[1]), Number(m[2]), Number(m[3]));
  return text || '-';
}

function dropdown_(list) {
  return SpreadsheetApp.newDataValidation().requireValueInList(list, true).setAllowInvalid(true).build();
}

function rule_(range, configure) {
  return configure(SpreadsheetApp.newConditionalFormatRule().setRanges([range])).build();
}

function box_(range) {
  range.setBorder(true, true, true, true, true, true, '#000000', SpreadsheetApp.BorderStyle.SOLID);
  range.setBorder(true, true, true, true, null, null, '#000000', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
}

/** Drops the unused rows and columns of a new sheet (a file holds about 30 of them). */
function trimSheet_(sh, rows, cols) {
  if (sh.getMaxRows() > rows) sh.deleteRows(rows + 1, sh.getMaxRows() - rows);
  if (sh.getMaxColumns() > cols) sh.deleteColumns(cols + 1, sh.getMaxColumns() - cols);
}

/** Adds rows / columns when a write would go past the sheet's grid. */
function ensureSize_(sh, rows, cols) {
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
}

/** Column number → letter(s): 1 → A, 27 → AA. */
function letter_(n) {
  let out = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out;
  return out;
}

function clearTriggers_(fn) {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === fn).forEach(t => ScriptApp.deleteTrigger(t));
}
