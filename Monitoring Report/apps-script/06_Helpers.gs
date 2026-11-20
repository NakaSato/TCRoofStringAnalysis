// ------------------------------------------------------------------ helpers

function pad_(n) { return (n < 10 ? '0' : '') + n; }

/** 9 → "09:00" (a check, as shown to the user). */
function clock_(h) { return pad_(h) + ':00'; }

/**
 * The checks a user typed: "9", "9,13", "09 17", "13:00", "13.00" → [9, 13] in CHECK_HOURS order;
 * blank → all; anything that isn't a check → null.
 */
function parseHours_(text) {
  const parts = String(text || '').split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return CHECK_HOURS.slice();
  const want = [];
  for (const p of parts) {
    const m = /^(\d{1,2})(?:[:.]00)?$/.exec(p);
    if (!m || CHECK_HOURS.indexOf(+m[1]) < 0) return null;
    want.push(+m[1]);
  }
  return CHECK_HOURS.filter(h => want.indexOf(h) >= 0);
}

/**
 * The day a user typed → "yyyy-MM-dd": 2026-11-12, 12.11, 12/11, 12-11, 12/11/2026, 12/11/2569
 * (Buddhist year), 12/11/26; blank → today. Without a year: this year, or last year when that date
 * is more than half a year ahead. Not a real date → null.
 */
function parseDay_(text) {
  const t = String(text || '').trim(), today = today_();
  if (!t) return today;
  let y, mo, d;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2}|\d{4}))?$/.exec(t);
    if (!m) return null;
    d = +m[1]; mo = +m[2];
    y = m[3] === undefined ? null : +m[3];
    if (y !== null && y < 100) y += 2000;
  }
  if (y !== null && y > 2400) y -= 543; // พ.ศ.
  const make = yy => {
    const dt = new Date(Date.UTC(yy, mo - 1, d));
    return dt.getUTCFullYear() === yy && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
      ? `${yy}-${pad_(mo)}-${pad_(d)}` : null;
  };
  if (y !== null) return make(y);
  const thisYear = +today.slice(0, 4);
  const day = make(thisYear);
  // in January "25.12" means last December; "17.11" typed on 16.11 is a future date (refused by the caller)
  const farAhead = day && (Date.parse(day) - Date.parse(today)) / 864e5 > 183;
  return farAhead ? make(thisYear - 1) : day;
}

function today_() { return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd'); }

function sheetName_(day) { return day.slice(8, 10) + '.' + day.slice(5, 7); }

function nowMin_() {
  const now = new Date();
  return Number(Utilities.formatDate(now, 'Asia/Bangkok', 'H')) * 60 + Number(Utilities.formatDate(now, 'Asia/Bangkok', 'm'));
}

/** "8:50" / "08:50" → "08:50"; anything else → null. */
function normTime_(t) {
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(String(t).trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return pad_(+m[1]) + ':' + m[2];
}

function toMin_(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

/** The checks whose fetch time has passed at minute-of-day `hm`. */
function passedHours_(hm, times) { return CHECK_HOURS.filter((h, k) => hm >= toMin_(times[k])); }

/** Fetch time per check from script property FETCH_TIMES, else DEFAULT_FETCH. */
function fetchTimes_() {
  const v = (PropertiesService.getScriptProperties().getProperty('FETCH_TIMES') || '').split(',').map(normTime_);
  return v.length === CHECK_HOURS.length && v.every(Boolean) ? v : DEFAULT_FETCH.slice();
}
