// ============================================================ 3) sync: Overview ⇄ plant files (the job, its bookkeeping, the finish)

/**
 * full = read every plant file. Otherwise only the files edited since the last complete sync are read,
 * unless the Overview's สถานี / Inverter sheets changed (then every file is read). True when the sync of `ym`
 * started (or carries on); a quiet call that does not start returns nothing.
 */
function startSync_(ym, quiet, full) {
  checkYm_(ym);
  if (archivedYears_().indexOf(Number(ym.slice(0, 4))) >= 0) {
    if (quiet) return;
    throw new Error(`ปี พ.ศ. ${Number(ym.slice(0, 4)) + 543} ย้ายปัญหาไปไฟล์เก็บแล้ว — ซิงก์เดือน ${ym} อีกจะสร้างแถวที่ย้ายไปแล้วซ้ำ`);
  }
  const props = PropertiesService.getScriptProperties();
  const cur = dropStaleJob_(props, props.getProperties());
  if (cur.job) {
    if (cur.job === 'sync' && cur.ym === ym) { kick_(); return true; }   // the same sync: carry on where it stopped
    if (quiet) {                                        // a scheduled sync waits for the next slot
      if (!hasTrigger_('continueJob')) after_(NEXT_RUN_MS);         // ... and restarts a job whose runs stopped
      return;
    }
    throw new Error(`มีงานค้างอยู่ (${status()}) — รอให้เสร็จ หรือรัน cancelJob() ก่อน`);
  }
  const file = overviewFile_();
  if (file.getMimeType() !== MimeType.GOOGLE_SHEETS) {
    throw new Error('Overview ยังเป็นไฟล์ .xlsx — สคริปต์เขียนกลับไม่ได้ ให้รัน convertOverview() หนึ่งครั้งก่อน');
  }
  const folder = findMonthFolder_(ym);
  if (!folder) {
    if (quiet) { warnNoFolder_(props, ym, file.getId()); return; }
    throw new Error(`ยังไม่มีโฟลเดอร์เดือน ${ym} — สร้างไฟล์ของเดือนนั้นก่อน`);
  }
  props.setProperties({
    job: 'sync', ym: ym, idx: '0', folder: folder.getId(), ov: file.getId(), ovTemp: '',
    only: '', made: '0', skipped: '0', errors: '', warn: '', full: full ? '1' : '', same: '0',
    root: rootId_(),
  });
  kick_();
  return true;
}

/** One run of the sync job; true when every plant is done. */
function syncBatch_(props, p, t0) {
  const overview = SpreadsheetApp.openById(p.ov);
  // dates are written as Bangkok days; in any other time zone the sheet would show the day before
  if (overview.getSpreadsheetTimeZone() !== 'Asia/Bangkok') overview.setSpreadsheetTimeZone('Asia/Bangkok');
  const stations = readStations_(overview);
  const inverters = readInverters_(overview);
  const files = folderFiles_(p.folder);                 // file name → { id, edited }
  const [y, m] = p.ym.split('-').map(Number);
  const lastDay = lastDayToRead_(p.ym);
  let i = Number(p.idx), made = Number(p.made), skipped = Number(p.skipped), same = Number(p.same || 0);
  const errors = p.errors ? p.errors.split(',') : [];
  const warnings = p.warn ? p.warn.split('\n') : [];
  const results = {}, invStatus = {};

  // First run of the job: decide which files need reading. A file not edited since the last complete
  // sync says what it said then, as long as the Overview's plants and inverters are the same too.
  let last = null;
  try { last = JSON.parse(props.getProperty(`synced_${p.ym}`) || 'null'); } catch (e) { last = null; }
  const otherFolder = !!(last && last.f !== p.folder);
  if (otherFolder) last = null;                          // the last sync was of another folder (CONFIG changed since)
  let since = Number(p.since || 0);
  if (!p.began) {
    const sig = signature_([stations, inverters]);
    const noDays = !daysOnRecord_(props, p.ym);          // the days each plant reported are not on record yet
    // they are rebuilt plant by plant: until the last one is read, the record is partial (a job stopped or
    // cancelled half-way must not leave it looking complete to nothingNew_ and the next sync)
    if (noDays) props.setProperty(`daysPart_${p.ym}`, '1');
    since = !p.full && !noDays && last && last.sig === sig && last.v === SYNC_VERSION ? Number(last.t) - SYNC_MARGIN_MS : 0;
    // why every file is read (shown in _log)
    const why = since ? '' : p.full ? 'สั่งอ่านทุกไฟล์' : otherFolder ? 'โฟลเดอร์เดือนเปลี่ยน'
      : !last ? 'ไม่มีบันทึกซิงก์ครั้งก่อน' : noDays ? 'ยังไม่มีบันทึกวันที่ทำรายงาน' : last.v !== SYNC_VERSION ? 'สคริปต์รุ่นใหม่' : 'แท็บสถานี/Inverter ใน Overview เปลี่ยน';
    p.sig = sig; p.began = String(t0); p.why = why;
    props.setProperties({ sig: sig, since: String(since), began: p.began, why: why });
  }
  const retry = since && last && last.err ? last.err : [];   // plants that could not be read last time
  // file → its edit time when it was last read: a file is read again only when that time changes, so one edit
  // is read once (a file with no time on record falls back to the margin rule above)
  const seen = readSeen_(props, p.ym) || {};

  while (i < stations.length && (Date.now() - t0) / 1000 < CONFIG.RUN_SECONDS) {
    const s = stations[i];
    const file = plantFile_(files, s, p.ym);
    const key = file && fileKey_(file.id), was = file && seen[key];
    if (!file) {
      skipped++;
    } else if (since > 0 && retry.indexOf(s.code) < 0 && (was !== undefined ? was === stamp_(file.edited) : file.edited < since)) {
      same++;
      seen[key] = stamp_(file.edited);
    } else {
      try {
        const r = syncPlant_(file.id, s, inverters[s.code] || [], y, m, lastDay);
        results[s.code] = r;
        Object.keys(r.invStatus).forEach(sn => { invStatus[sn] = r.invStatus[sn]; });
        r.warnings.forEach(w => warnings.push(w));
        made++;
        seen[key] = stamp_(file.edited);                 // the time listed before the read: an edit during it is read next time
      } catch (e) {
        console.error(`${s.code}: ${e}`);
        errors.push(s.code);
        delete seen[key];
      }
    }
    i++;
  }

  // The Overview is written before the position is saved: a run that is cut short repeats its batch.
  upsertIssues_(overview, y, m, results);
  writeInverterStatus_(overview, p.ym, invStatus);
  writeLastReport_(overview, p.ym, results);
  saveDays_(props, p.ym, results);
  props.setProperties({ idx: String(i), made: String(made), skipped: String(skipped), same: String(same),
    errors: errors.join(','), warn: warnings.join('\n').slice(0, 8000) });
  if (i >= stations.length) {
    // the end: files of no plant (notes, old copies) are taken as seen, files no longer there are dropped
    const plantIds = new Set();
    stations.forEach(st => { const f = plantFile_(files, st, p.ym); if (f) plantIds.add(f.id); });
    const kept = {};
    files.forEach(f => {
      const k = fileKey_(f.id);
      if (!plantIds.has(f.id)) kept[k] = stamp_(f.edited);
      else if (seen[k] !== undefined) kept[k] = seen[k];
    });
    saveSeen_(props, p.ym, kept);
    props.deleteProperty(`daysPart_${p.ym}`);           // every plant read: days_<ym> is complete
    dropOldSeen_(props, p.ym);
  } else {
    saveSeen_(props, p.ym, seen);
  }

  if (i < stations.length) {
    console.log(`ซิงก์ ${p.ym}: ${i}/${stations.length} สถานี — ทำต่ออัตโนมัติ`);
    return false;
  }
  const summary = `ซิงก์ ${p.ym}: อ่าน ${made} สถานี` + (p.why ? ` (อ่านทุกไฟล์: ${p.why})` : '') +
    (same ? `, ไม่มีการแก้ไข ${same} สถานี (ไม่ต้องอ่าน)` : '') +
    (skipped ? `, ยังไม่มีไฟล์ ${skipped} สถานี` : '') +
    (errors.length ? `, อ่านไม่ได้ ${errors.length} สถานี (${errors.join(', ')}) — จะอ่านใหม่ในการซิงก์ครั้งถัดไป` : '');
  // a sync that found nothing new leaves no line in _log (an interval sync would fill it)
  const os = finishSync_(overview, p.ym, stations, files, summary, warnings, made > 0 || errors.length > 0 || !!p.full);
  SpreadsheetApp.flush();                               // fin = after the last write to the Overview (nothingNew_)
  props.setProperty(`synced_${p.ym}`, JSON.stringify({ t: Number(p.began), sig: p.sig, err: errors, v: SYNC_VERSION,
    f: p.folder, ov: p.ov, root: p.root, fin: Date.now(), os: os }));
  note_(props, summary);
  console.log(summary + (warnings.length ? `\n${warnings.join('\n')}` : ''));
  return true;
}

/** seen_<ym>: file → edit time when last read, keyed by the end of the file id (short, to fit one property). */
function fileKey_(id) { return String(id).slice(-12); }
function stamp_(ms) { return Math.round(ms).toString(36); }
function readSeen_(props, ym) {
  try { return JSON.parse(props.getProperty(`seen_${ym}`) || 'null'); } catch (e) { return null; }
}
/** Removes seen_<ym> of months before last month (they are not synced on their own any more), except `keep`. */
function dropOldSeen_(props, keep) {
  const [y, m] = ym_(new Date()).split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  props.getKeys().forEach(k => {
    const ym = k.indexOf('seen_') === 0 ? k.slice(5) : '';
    if (ym && ym < prev && ym !== keep) props.deleteProperty(k);
    const dm = k.indexOf('days_') === 0 ? k.slice(5) : k.indexOf('daysPart_') === 0 ? k.slice(9) : '';   // the days each plant reported: the sheet keeps the counts
    if (dm && dm < prev && dm !== keep) props.deleteProperty(k);
    const nf = k.indexOf('noFolder_') === 0 ? k.slice(9) : '';  // the day the missing month folder was last reported
    if (nf && nf < prev) props.deleteProperty(k);
    const os = k.indexOf('ovSame_') === 0 ? k.slice(7) : '';    // the Overview edit time last compared, per month
    if (os && os < prev && os !== keep) props.deleteProperty(k);
    if (k === 'ovSame') props.deleteProperty(k);                // before it was kept per month
  });
}
function saveSeen_(props, ym, seen) {
  const text = JSON.stringify(seen);
  if (text.length > SEEN_MAX_CHARS) props.deleteProperty(`seen_${ym}`);
  else props.setProperty(`seen_${ym}`, text);
}

/**
 * days_<ym>: { plant code: the days of the month it has a checked row, as a number (bit d-1 = day d) }.
 * A plant read by this sync gets its days from its file; plants not read keep what they had.
 */
function readDays_(props, ym) {
  try { return JSON.parse(props.getProperty(`days_${ym}`) || 'null'); } catch (e) { return null; }
}
/** days_<ym> is there and complete (not left half-built by a sync that stopped: daysPart_<ym>). */
function daysOnRecord_(props, ym) {
  return !!props.getProperty(`days_${ym}`) && !props.getProperty(`daysPart_${ym}`);
}
function saveDays_(props, ym, results) {
  const codes = Object.keys(results).filter(c => results[c].days);
  const days = readDays_(props, ym) || {};
  let changed = !props.getProperty(`days_${ym}`);
  codes.forEach(c => {
    const mask = results[c].days.reduce((a, d) => a + Math.pow(2, d - 1), 0);
    if (days[c] !== mask) { days[c] = mask; changed = true; }
  });
  if (!changed) return;
  const text = JSON.stringify(days);
  if (text.length > DAYS_MAX_CHARS) props.deleteProperty(`days_${ym}`);   // the next sync reads every file again
  else props.setProperty(`days_${ym}`, text);
}
function reportedOn_(mask, d) { return Math.floor((mask || 0) / Math.pow(2, d - 1)) % 2 === 1; }

/** Day sheets to read: up to today for the current month, the whole month for a past one, none for a future one. */
function lastDayToRead_(ym) {
  const now = new Date(), cur = ym_(now);
  if (ym > cur) return 0;
  if (ym === cur) return Number(Utilities.formatDate(now, 'Asia/Bangkok', 'd'));
  const [y, m] = ym.split('-').map(Number);
  return daysIn_(y, m);
}

/**
 * After the last plant: summary boxes, "as of" line, the link columns of "สถานี", one line in "_log".
 * Returns the signature of the owners (ผู้รับผิดชอบ) written into the report log.
 */
function finishSync_(overview, ym, stations, files, summary, warnings, logIt) {
  const t = issueTable_(overview), sh = t.sh, r0 = t.headRow + 1;
  const col = h => (t.col[h] ? `$${letter_(t.col[h])}$${r0}:$${letter_(t.col[h])}` : null);
  const key = col('รหัสปัญหา'), st = col('สถานะ'), found = col('วันที่พบ'), open = col('_open_station');
  const done = DONE_STATUSES.map(v => `COUNTIF(${st},"${v}")`).join('+');
  const boxes = [
    ['ปัญหาทั้งหมด', `=COUNTA(${key})`],
    ['พบวันนี้', `=COUNTIF(${found},TEXT(TODAY(),"dd/mm/")&(YEAR(TODAY())+543))`],                     // problems first seen today
    ['ปัญหาที่คงค้าง', `=COUNTA(${key})-(${done})`],
    ['จำนวนสถานี', open && `=SUM(${open})`],
    ['กำลังแก้ไข', `=COUNTIF(${st},"กำลังแก้ไข")`],
    ['แก้ไขแล้วเสร็จ', `=${done}`],
  ];
  let owners = {};
  try { owners = ownersSheet_(overview, stations); } catch (e) {     // never stops the sync: the reason goes to _log
    console.error(`ชีต ${OWNERS}: ${e}`);
    warnings.push(`เขียนชีต "${OWNERS}" ไม่ได้: ${e.message || e}`);
  }
  // รายงานวันนี้ = plants whose รายงานล่าสุด (สถานี) is today / every plant in สถานี
  const ss = overview.getSheetByName(STATIONS);
  const sHead = ss.getRange(1, 1, 1, ss.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const lastCol = sHead.indexOf(LAST_REPORT) + 1;
  if (lastCol) {
    const L = letter_(lastCol);
    boxes.push([REPORTED_TODAY, `=COUNTIF('${STATIONS}'!$${L}$2:$${L},TEXT(TODAY(),"dd/mm/")&(YEAR(TODAY())+543))&"/"&COUNTA('${STATIONS}'!$A$2:$A)`]);
    addBox_(t, REPORTED_TODAY);
    try { todaySheet_(overview, sHead, stations.length, !!overview.getSheetByName(OWNERS)); } catch (e) {      // never stops the sync: the reason goes to _log
      console.error(`ชีต ${REPORTED_TODAY}: ${e}`);
      warnings.push(`สร้างชีต "${REPORTED_TODAY}" ไม่ได้: ${e.message || e}`);
    }
  }
  try { fitIssueTable_(t); } catch (e) {               // never stops the sync: the reason goes to _log
    console.error(`ตารางปัญหา: ${e}`);
    warnings.push(`ขยายตัวกรอง / dropdown ของตารางปัญหาไม่ได้: ${e.message || e}`);
  }
  try { reportLog_(overview, ym, stations, owners); } catch (e) {          // never stops the sync: the reason goes to _log
    console.error(`ชีต ${reportLogName_(ym)}: ${e}`);
    warnings.push(`เขียนชีต "${reportLogName_(ym)}" ไม่ได้: ${e.message || e}`);
  }
  const norm = v => String(v).replace(/เเ/g, 'แ').trim();          // the sheet spells some labels with "เเ"
  for (let r = 0; r < t.headRow - 1; r++) {
    t.top[r].forEach((v, c) => {
      const box = boxes.find(b => b[0] === norm(v));
      if (box && box[1]) sh.getRange(r + 2, c + 1).setFormula(box[1]);   // the number sits under its label
    });
  }
  const now = new Date();
  const [yy, mm, dd, hm] = Utilities.formatDate(now, 'Asia/Bangkok', 'yyyy-M-d-HH:mm').split('-');
  sh.getRange('A2').setValue(`ข้อมูล ณ วันที่ ${dd} ${TH_MONTH[Number(mm)]} พ.ศ.${Number(yy) + 543} เวลา ${hm} น.`);

  // สถานี: counts are formulas over "Inverter"; ไฟล์รายงาน links this month's file
  const is = overview.getSheetByName(INVERTERS);
  const iHead = is.getRange(1, 1, 1, is.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const iCol = h => { const k = iHead.indexOf(h) + 1; return k ? `${INVERTERS}!$${letter_(k)}:$${letter_(k)}` : null; };
  const code = iCol('รหัส'), used = iCol('ใช้งาน (Y/N)'), strings = iCol('จำนวนสตริง');
  const n = ss.getLastRow() - 1;
  if (n > 0) {
    const codes = ss.getRange(2, 1, n, 1).getValues().map(r => String(r[0]).trim());
    const byCode = {};
    stations.forEach(s => { byCode[s.code] = s; });
    const all = ss.getRange(2, 1, n, sHead.length);
    const values = all.getValues(), formulas = all.getFormulas();
    const put = (h, make) => {                          // a column is written only when it differs (no recalculation otherwise)
      const k = sHead.indexOf(h) + 1;
      if (!k) return;
      const want = codes.map((c, i) => [c ? make(c, i + 2) : '']);
      if (want.some((w, i) => w[0] !== (formulas[i][k - 1] || values[i][k - 1]))) ss.getRange(2, k, n, 1).setValues(want);
    };
    if (code && used) put('จำนวน Inverter', (c, r) => `=COUNTIFS(${code},$A${r},${used},"<>N")`);
    if (code && used && strings) put('จำนวนสตริงรวม', (c, r) => `=SUMIFS(${strings},${code},$A${r},${used},"<>N")`);
    const linkCol = sHead.indexOf('ไฟล์รายงาน');
    put('ไฟล์รายงาน', (c, r) => {
      // a sync of last month (days 1–7) leaves the link to a later month's file as it is
      const was = linkCol >= 0 ? String(formulas[r - 2][linkCol] || '') : '';
      const later = /,"(\d{4}-\d{2})"\)\s*$/.exec(was);
      if (later && later[1] > ym) return was;
      const file = byCode[c] && plantFile_(files, byCode[c], ym);
      return file ? `=HYPERLINK("https://docs.google.com/spreadsheets/d/${file.id}/edit","${ym}")` : '';
    });
  }

  logLines_(overview, (logIt ? [summary] : []).concat(warnings));
  return signature_(owners);                            // the owners the report log shows (nothingNew_)
}

/** Appends lines to "_log" (one write, however many), each with the time; keeps the newest LOG_KEEP_ROWS. */
function logLines_(overview, texts) {
  if (!texts.length) return;
  const log = overview.getSheetByName(LOG) || overview.insertSheet(LOG);
  const stamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm');
  const r = log.getLastRow() + 1;
  ensureSize_(log, r + texts.length - 1, 2);
  log.getRange(r, 1, texts.length, 2).setValues(texts.map(t => [stamp, t]));
  const extra = log.getLastRow() - 1 - LOG_KEEP_ROWS;   // row 1 is the header
  if (extra > 0) log.deleteRows(2, extra);
}

/**
 * The automatic sync of this month found no month folder: the month's files were not created (the calendar's
 * "สร้าง" event did not run or failed). Said once a day in "_log" and status(), instead of nothing at all;
 * the sync of last month (days 1–7) still runs.
 */
function warnNoFolder_(props, ym, overviewId) {
  if (ym !== ym_(new Date())) return;
  const today = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd');
  if (props.getProperty(`noFolder_${ym}`) === today) return;
  props.setProperty(`noFolder_${ym}`, today);
  const msg = `ยังไม่มีโฟลเดอร์เดือน ${ym} — ซิงก์เดือนนี้ไม่ได้ และยังไม่มีชีต "${reportLogName_(ym)}": รัน createMonth('${ym}')`;
  console.warn(msg);
  note_(props, msg);
  try { logLines_(SpreadsheetApp.openById(overviewId), [msg]); } catch (e) { console.error(`เขียน ${LOG} ไม่ได้: ${e}`); }
}
