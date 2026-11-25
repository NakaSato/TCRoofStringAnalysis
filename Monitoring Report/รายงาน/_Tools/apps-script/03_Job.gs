// ============================================================ the job (runs in batches)

function startCreate_(ym, onlyCode) {
  checkYm_(ym);
  const props = PropertiesService.getScriptProperties();
  const cur = dropStaleJob_(props, props.getProperties());
  if (cur.job) {
    // the same job again: carry on where it stopped (a run that is still working is left alone)
    if (cur.job === 'create' && cur.ym === ym && (cur.only || '') === (onlyCode || '')) {
      console.log(`ทำงานเดิมต่อ: ${status()}`);
      kick_();
      return;
    }
    if (cur.job === 'sync') {                           // a sync is working (the interval sync often is): the create waits for it
      props.setProperty('queued', JSON.stringify({ ym: ym, only: onlyCode || '' }));
      if (!hasTrigger_('continueJob')) after_(NEXT_RUN_MS);
      console.log(`กำลังซิงก์อยู่ — จะเริ่มสร้างไฟล์เดือน ${ym} ทันทีที่ซิงก์เสร็จ`);
      return;
    }
    throw new Error(`มีงานค้างอยู่ (${status()}) — รอให้เสร็จ หรือรัน cancelJob() ก่อน`);
  }
  const folder = monthFolder_(ym);
  const ov = overviewSnapshot_(folder);
  props.setProperties({
    job: 'create', ym: ym, idx: '0', folder: folder.getId(), ov: ov.id, ovTemp: ov.temp ? '1' : '',
    only: onlyCode || '', made: '0', skipped: '0', errors: '', warn: '', root: rootId_(),
  });
  console.log(`เริ่มสร้างไฟล์เดือน ${ym} ในโฟลเดอร์ ${folder.getUrl()}`);
  kick_();
}

/**
 * A job left over from another root folder (the Overview was moved or copied since it started) is given
 * up, so it cannot block a new one. Returns the job properties that still count.
 */
function dropStaleJob_(props, cur) {
  if (!cur.job || cur.root === rootId_()) return cur;
  clearTriggers_('continueJob');
  cleanup_(props, cur);
  console.warn(`ยกเลิกงานที่ค้างของโฟลเดอร์หลักเดิม (${cur.job} ${cur.ym})`);
  return {};
}

function continueJob() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;                      // another run is working
  try {
    clearTriggers_('continueJob');
    const props = PropertiesService.getScriptProperties();
    const p = props.getProperties();
    if (p.job !== 'create' && p.job !== 'sync') return;
    after_(WATCHDOG_MIN * 60000);                       // if this run is killed, the job still carries on
    let done = false;
    try {
      if (p.root !== rootId_()) {                         // started for another root folder (the Overview moved since)
        throw stop_('ยกเลิกงานที่ค้างของโฟลเดอร์หลักเดิม — สั่งงานใหม่อีกครั้ง จะใช้โฟลเดอร์ที่ไฟล์ Overview อยู่ตอนนี้');
      }
      done = p.job === 'create' ? createBatch_(props, p, Date.now()) : syncBatch_(props, p, Date.now());
      props.deleteProperty('fails');
    } catch (e) {
      const fails = Number(p.fails || 0) + 1;
      console.error(`รอบนี้ล้มเหลว (ครั้งที่ ${fails}): ${e}`);
      if (e.stop || fails >= MAX_FAILS) {
        const now = props.getProperties();
        note_(props, `งานหยุดที่ ${now.idx || 0} สถานี (สำเร็จ ${now.made || 0}) — ${e.message || e}`);
        done = true;
      } else {
        props.setProperty('fails', String(fails));
      }
    }
    clearTriggers_('continueJob');
    if (done) {
      cleanup_(props, props.getProperties());
      startQueued_(props);
      if (p.job === 'sync' && p.ym === ym_(new Date())) syncPrevAfter_(props);
    } else {
      after_(NEXT_RUN_MS);
    }
  } finally {
    lock.releaseLock();
  }
}

/** A create that was asked for while a sync was working starts now, in the background. */
function startQueued_(props) {
  const queued = props.getProperty('queued');
  if (!queued) return;
  props.deleteProperty('queued');
  try {
    const q = JSON.parse(queued);
    RUN_LATER = true;
    startCreate_(q.ym, q.only);
  } catch (e) {
    console.error(`เริ่มงานสร้างไฟล์ที่รอคิวไม่ได้: ${e}`);
    note_(props, `เริ่มงานสร้างไฟล์ที่รอคิวไม่ได้ — ${e.message || e}`);
  }
}

/**
 * After a sync of this month (by the calendar, the menu or the interval): last month too, within
 * CONFIG.PREV_MONTH_SYNC_DAYS, when its files were edited since its last sync. A create queued behind the
 * sync goes first; last month then waits for the next interval sync.
 */
function syncPrevAfter_(props) {
  if (props.getProperty('job')) return;
  const prev = prevMonthToSync_();
  if (!prev || nothingNew_(prev)) return;
  try {
    RUN_LATER = true;
    startSync_(prev, true);
  } catch (e) {
    console.error(`ซิงก์เดือน ${prev} ต่อไม่ได้: ${e}`);
  }
}

/** One run of the create job; true when every plant is done. */
function createBatch_(props, p, t0) {
  const overview = SpreadsheetApp.openById(p.ov);
  let stations = readStations_(overview);
  if (p.only) {
    stations = stations.filter(s => s.code === p.only);
    if (!stations.length) throw stop_(`ไม่พบสถานีรหัส ${p.only} ใน Overview`);
  }
  const inverters = readInverters_(overview);
  const folder = DriveApp.getFolderById(p.folder);
  const existing = folderFiles_(p.folder);
  // a template left half-built by a run that was cut short is not one of this job's templates
  const mine = Object.keys(p).filter(k => k.indexOf('tpl_') === 0).map(k => p[k]);
  existing.forEach((f, name) => { if (name.indexOf('_TEMPLATE_') === 0 && mine.indexOf(f.id) < 0) trash_(f.id); });
  let i = Number(p.idx), made = Number(p.made), skipped = Number(p.skipped);
  const errors = p.errors ? p.errors.split(',') : [];
  const seconds = () => (Date.now() - t0) / 1000;
  let streak = 0, lastError = '';

  while (i < stations.length && seconds() < COPY_UNTIL_S) {
    const s = stations[i];
    const name = fileName_(s, p.ym);
    let file = null;
    try {
      if (plantFile_(existing, s, p.ym)) {
        skipped++;
      } else {
        const list = inverters[s.code] || [];
        const n = Math.max(list.length, 1);
        // a new template does not fit in what is left of this run: the next run starts with it
        if (!props.getProperty(`tpl_${n}`) && seconds() > TEMPLATE_BY_S) break;
        const tplId = template_(props, p.ym, folder, n);
        file = DriveApp.getFileById(tplId).makeCopy(name, folder);
        writeInfo_(file.getId(), infoValues_(s), inverterValues_(list, list.length));
        made++;
      }
      // the Google Sheet replaces the old Excel report (the trash keeps it for 30 days)
      const old = CONFIG.REPLACE_XLSX && existing.get(`${name}.xlsx`);
      if (old) { DriveApp.getFileById(old.id).setTrashed(true); existing.delete(`${name}.xlsx`); }
      streak = 0;
    } catch (e) {
      console.error(`${s.code}: ${e}`);
      errors.push(s.code);
      lastError = String(e.message || e);
      streak++;
      if (file) { try { file.setTrashed(true); } catch (e2) { /* no half-filled file is left behind */ } }
    }
    i++;
    props.setProperties({ idx: String(i), made: String(made), skipped: String(skipped), errors: errors.join(',') });
    // the same failure plant after plant is a limit or an outage, not a problem with one plant
    if (streak >= MAX_FAILS) {
      throw stop_(`ผิดพลาดติดกัน ${streak} สถานี (${errors.slice(-streak).join(', ')}): ${lastError} — กดสร้างไฟล์อีกครั้งภายหลัง สถานีที่มีไฟล์แล้วจะถูกข้าม`);
    }
  }

  if (i < stations.length) {
    console.log(`${p.ym}: ${i}/${stations.length} สถานี — ทำต่ออัตโนมัติ`);
    return false;
  }
  const summary = `สร้างไฟล์ ${p.ym} เสร็จ: สร้างใหม่ ${made} ไฟล์, มีอยู่แล้ว ${skipped} ไฟล์` +
    (errors.length ? `, ผิดพลาด ${errors.length} สถานี (${errors.join(', ')}${lastError ? ': ' + lastError : ''}) — กดสร้างไฟล์อีกครั้งเพื่อสร้างสถานีที่ขาด` : '');
  note_(props, summary);
  console.log(summary);
  return true;
}

/** Trashes the job's temporary files (templates, converted Overview) and clears its state. */
function cleanup_(props, p) {
  Object.keys(p).filter(k => k.indexOf('tpl_') === 0).forEach(k => {
    trash_(p[k]);
    props.deleteProperty(k);
  });
  if (p.ovTemp && p.ov) trash_(p.ov);
  JOB_KEYS.forEach(k => props.deleteProperty(k));
}

function trash_(id) {
  try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { console.warn(`ลบไฟล์ชั่วคราว ${id} ไม่ได้: ${e}`); }
}
