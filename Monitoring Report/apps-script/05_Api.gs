// ------------------------------------------------------------------ data (TC Roof API, shared key)

/**
 * The sheet's values for `day`, checks `hours` only:
 * {day, hours, columns, published_plants, loggers: {datalogger_sn: id}, names: {id: name},
 *  plants: {id: {checks: {"09": [status, note, irr, wx, log, kw, inv]}, weather_status, yield_kwh}},
 *  firmware: {datalogger_sn: datalogger firmware} (empty: Growatt gives none; without the key, e.g. an
 *  older API, the Firmware column is left as is),
 *  dataloggers: {datalogger_sn: {inverter_firmware: [text an older script wrote into Firmware]}}}
 */
function reportCells_(day, hours) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('REPORT_KEY');
  if (!key) throw new Error('ยังไม่มีรหัสรายงาน\nไปที่เมนู PWA Report → ตั้งค่า → ตั้งค่าทั้งหมด… ก่อน');
  const url = `${props.getProperty('REPORT_URL') || REPORT_URL}/${day}/cells?hours=${hours.join(',')}`;
  const failed = `ดึงข้อมูลวันที่ ${sheetName_(day)} ไม่สำเร็จ`;
  let res, netErr;
  for (let attempt = 1; ; attempt++) { // one retry: the API scales to zero and may be cold
    try { // fetch throws when there is no HTTP answer at all (timeout, DNS): retried like a 5xx
      res = UrlFetchApp.fetch(url, { headers: { 'X-Report-Key': key }, muteHttpExceptions: true });
    } catch (e) { res = null; netErr = e; }
    if ((res && res.getResponseCode() < 500) || attempt >= 2) break;
    Utilities.sleep(5000);
  }
  if (!res) {
    console.log(`Report API ${day}: ${errText_(netErr)}`);
    throw new Error(`${failed}\nเชื่อมต่อระบบไม่ได้ ลองใหม่ในอีกสักครู่`);
  }
  const code = res.getResponseCode();
  if (code !== 200) {
    console.log(`Report API ${day}: ${code} ${res.getContentText().slice(0, 300)}`); // detail for the execution log
    const why = code === 401 || code === 403 ? 'รหัสรายงานไม่ถูกต้อง ตรวจสอบที่เมนู ตั้งค่า → เปลี่ยนรหัสรายงาน (key)…'
      : code === 404 ? 'ระบบไม่มีข้อมูลของวันที่นี้'
      : code >= 500 ? 'ระบบขัดข้องชั่วคราว ลองใหม่ในอีกสักครู่'
      : 'ระบบไม่รับคำขอนี้';
    throw new Error(`${failed} (รหัส ${code})\n${why}`);
  }
  try {
    return JSON.parse(res.getContentText());
  } catch (e) { // 200 with a body that is not JSON (e.g. an HTML page from the hosting layer)
    console.log(`Report API ${day}: 200, not JSON: ${res.getContentText().slice(0, 300)}`);
    throw new Error(`${failed}\nระบบตอบกลับมาในรูปแบบที่อ่านไม่ได้ ลองใหม่ในอีกสักครู่`);
  }
}
