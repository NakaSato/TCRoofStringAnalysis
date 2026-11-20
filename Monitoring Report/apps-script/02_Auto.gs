// ------------------------------------------------------------------ automatic runs

/** Creates today's empty DD.MM sheet (no-op if it already exists), then archives past months. */
function createTodaySheet() {
  const ss = SpreadsheetApp.getActive();
  const today = today_(), name = sheetName_(today);
  if (!ss.getSheetByName(name)) newDaySheet_(ss, name);
  try {
    const done = archivePastMonths_(ss, today);
    if (done.length) console.log(archiveText_(done).replace(/\n+/g, ' | '));
  } catch (e) { console.log('เก็บไฟล์รายเดือนไม่สำเร็จ: ' + errText_(e)); }
  try { forgetOldDone_(today); } catch (e) { console.log('ล้าง DONE_ ของวันก่อนไม่สำเร็จ: ' + errText_(e)); }
}

/** Deletes the DONE_yyyy-MM-dd script properties of past days (one is written per day by pollChecks). */
function forgetOldDone_(today) {
  const props = PropertiesService.getScriptProperties();
  props.getKeys().filter(k => /^DONE_/.test(k) && k !== 'DONE_' + today).forEach(k => props.deleteProperty(k));
}


/** Every POLL_EVERY min: fills each check inside its window that isn't done yet today; else returns at once. */
function pollChecks() {
  const hm = nowMin_(), times = fetchTimes_(), day = today_();
  const props = PropertiesService.getScriptProperties();
  const done = (props.getProperty('DONE_' + day) || '').split(',').filter(Boolean);
  const due = CHECK_HOURS.filter((h, k) => {
    const t = toMin_(times[k]);
    return hm >= t && hm <= t + FETCH_WINDOW && done.indexOf(pad_(h)) < 0;
  });
  if (!due.length) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    // ask for every check due so far, so weather Status covers them all; filled cells stay as they are
    const r = fillDay(day, passedHours_(hm, times));
    const nowDone = done.concat(due.filter(h => r.complete.indexOf(pad_(h)) >= 0).map(pad_));
    if (nowDone.length > done.length) props.setProperty('DONE_' + day, nowDone.join(','));
    console.log(r.msg.replace(/\n+/g, ' | '));
  } finally { lock.releaseLock(); }
}
