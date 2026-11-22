/** Thai for the PVsyst design charts (Energy & Billing, `pages/center/PvsystCharts.tsx`). */
/** "Median", "Middle half (P25–P75)", "Stations", "{n} days", "modelled", "Phase {n}" come from other area files. */
export const TH_PVSYST: Record<string, string> = {
  "Modelled (PVsyst design)": "ค่าจากแบบจำลอง (ค่าออกแบบ PVsyst)",
  "PVsyst design figures (P50, unlimited load), not measured": "ค่าออกแบบจาก PVsyst (P50 ไม่จำกัดโหลด) ไม่ใช่ค่าวัดจริง",
  "PVsyst simulation reports": "รายงานผลจำลอง PVsyst",
  "Meter measured": "มิเตอร์ (ค่าวัดจริง)",
  "PVsyst design data could not be read": "อ่านข้อมูลออกแบบ PVsyst ไม่ได้",
  "No PVsyst design data": "ไม่มีข้อมูลออกแบบ PVsyst",
  "None of your plants is a PVsyst station of the model.": "ไม่มีโรงไฟฟ้าของคุณที่เป็นสถานี PVsyst ในแบบจำลอง",
  "Not imported yet (python -m app.services.pvsyst import --model …).": "ยังไม่ได้นำเข้า (python -m app.services.pvsyst import --model …)",
  "No PVsyst stations in this phase.": "ไม่มีสถานี PVsyst ในระยะโครงการนี้",
  "Your plants' stations only.": "เฉพาะสถานีในโรงไฟฟ้าที่คุณดูแล",

  "Monthly E_Grid by phase": "E_Grid รายเดือนแยกตามระยะโครงการ",
  "E_Grid (MWh, modelled)": "E_Grid (MWh, แบบจำลอง)",
  "Specific yield (kWh/kWp, modelled)": "ผลผลิตจำเพาะ (kWh/kWp, แบบจำลอง)",
  "No monthly E_Grid in the model.": "แบบจำลองไม่มี E_Grid รายเดือน",
  "E_Grid per calendar month from each station's PVsyst report, summed per phase; below as kWh/kWp.":
    "E_Grid รายเดือนจากรายงาน PVsyst ของแต่ละสถานี รวมตามระยะโครงการ ด้านล่างเป็น kWh/kWp",
  "Thin lines: one per station.": "เส้นบาง: หนึ่งเส้นต่อสถานี",
  "Choose a phase to see each station.": "เลือกระยะโครงการเพื่อดูรายสถานี",

  "PR by phase": "PR แยกตามระยะโครงการ",
  "PR (%, modelled)": "PR (%, แบบจำลอง)",
  "No PR in the model.": "แบบจำลองไม่มี PR",
  "Lowest station": "สถานีต่ำสุด",
  "Highest station": "สถานีสูงสุด",
  "Station": "สถานี",
  "Weighted PR (PVsyst_สรุป)": "PR ถ่วงน้ำหนัก (PVsyst_สรุป)",
  "Weighted PR (kWp, visible stations)": "PR ถ่วงน้ำหนักด้วย kWp (สถานีที่เห็น)",
  "Each station's PVsyst PR: box = middle half, ring = median, dots = stations, diamond = weighted PR.":
    "PR จาก PVsyst ของแต่ละสถานี: กล่อง = ครึ่งกลาง, วงแหวน = มัธยฐาน, จุด = สถานี, ข้าวหลามตัด = PR ถ่วงน้ำหนัก",
  "Weighted PR as the PVsyst_สรุป sheet states it.": "PR ถ่วงน้ำหนักตามที่ชีต PVsyst_สรุป ระบุ",
  "Weighted by kWp over the stations you can see.": "ถ่วงน้ำหนักด้วย kWp จากสถานีที่คุณเห็น",

  "Contract vs PVsyst specific yield": "ผลผลิตจำเพาะตามสัญญาเทียบ PVsyst",
  "Specific yield (kWh/kWp/yr, modelled)": "ผลผลิตจำเพาะ (kWh/kWp/ปี, แบบจำลอง)",
  "PVsyst P50": "PVsyst P50",
  "Contract, first year": "ตามสัญญา ปีแรก",
  "Contract ÷ PVsyst per kWp (%)": "สัญญา ÷ PVsyst ต่อ kWp (%)",
  "Contract ÷ PVsyst per kWp": "สัญญา ÷ PVsyst ต่อ kWp",
  "Sheet's contract ÷ PVsyst (kWh ÷ kWh)": "สัญญา ÷ PVsyst ตามชีต (kWh ÷ kWh)",
  "No contract figures in the model.": "แบบจำลองไม่มีตัวเลขตามสัญญา",
  "yr": "ปี",
  "First-year contract kWh/kWp (on the model's kWp) against PVsyst P50 kWh/kWp (on the reports' kWp). Phase 1's contract comes from the contract sheet; phases 2–4 are the model's estimate.":
    "kWh/kWp ตามสัญญาปีแรก (คิดจาก kWp ในแบบจำลอง) เทียบ kWh/kWp ของ PVsyst P50 (คิดจาก kWp ในรายงาน) ระยะที่ 1 ใช้ตัวเลขจากชีตสัญญา ระยะที่ 2–4 เป็นค่าประมาณของแบบจำลอง",
  "Phase 1: the sheet's kWh ÷ kWh is {a} %, but its PVsyst reports cover {p} kWp against the contract's {c} kWp, so per kWp it is {b} %.":
    "ระยะที่ 1: ชีตคิด kWh ÷ kWh ได้ {a} % แต่รายงาน PVsyst ครอบคลุม {p} kWp ขณะที่สัญญาคิด {c} kWp เมื่อเทียบต่อ kWp จึงเป็น {b} %",

  "Orientation and specific yield": "ทิศทางแผงกับผลผลิตจำเพาะ",
  "Azimuth": "มุมทิศ (Azimuth)",
  "Azimuth (°, PVsyst: 0 = south, −90 = east, 90 = west)": "มุมทิศ Azimuth (°, PVsyst: 0 = ใต้, −90 = ตะวันออก, 90 = ตะวันตก)",
  "No station with a single orientation.": "ไม่มีสถานีที่มีทิศทางแผงเดียว",
  "{n} stations with one orientation; {m} with several and {u} whose Tilt/Azimuth text did not read are left out.":
    "{n} สถานีมีทิศทางแผงเดียว ไม่รวม {m} สถานีที่มีหลายทิศ และ {u} สถานีที่อ่านข้อความ Tilt/Azimuth ไม่ได้",

  "DC/AC ratio and PR": "อัตราส่วน DC/AC กับ PR",
  "DC/AC ratio (kWp ÷ kWac, derived)": "อัตราส่วน DC/AC (kWp ÷ kWac, ค่าคำนวณ)",
  "No kWac in the model.": "แบบจำลองไม่มี kWac",
  "DC/AC = the report's kWp ÷ kWac (derived); PR from the same report.": "DC/AC = kWp ÷ kWac ในรายงาน (ค่าคำนวณ) PR จากรายงานเดียวกัน",

  "Metered vs PVsyst by site and month": "มิเตอร์เทียบ PVsyst รายสถานีรายเดือน",
  "Metered (MWh, measured)": "มิเตอร์ (MWh, ค่าวัดจริง)",
  "PVsyst E_Grid on the days read (MWh, modelled)": "E_Grid ของ PVsyst ในวันที่มีค่ามิเตอร์ (MWh, แบบจำลอง)",
  "Meter = PVsyst": "มิเตอร์ = PVsyst",
  "PVsyst": "PVsyst",
  "Meter comparison not loaded.": "ยังไม่ได้โหลดข้อมูลเทียบมิเตอร์",
  "No report day with a meter reading for a matched site in this period.": "ช่วงนี้ไม่มีวันรายงานที่มีค่ามิเตอร์ของสถานีที่จับคู่ได้",
  "Each point is a site-month: the meter's kWh on the days read against PVsyst E_Grid on the same days (the month ÷ its days, × site kWp ÷ PVsyst kWp).":
    "แต่ละจุด = หนึ่งสถานีหนึ่งเดือน: kWh จากมิเตอร์ในวันที่มีค่า เทียบ E_Grid ของ PVsyst ในวันเดียวกัน (ค่าเดือน ÷ จำนวนวัน × kWp สถานี ÷ kWp PVsyst)",
  "{m} sites matched by report id, {u} not matched (left out), {w} without a reading in the period; {n} site-months shown.":
    "จับคู่ด้วยรหัสในรายงานได้ {m} สถานี จับคู่ไม่ได้ {u} สถานี (ไม่แสดง) ไม่มีค่ามิเตอร์ในช่วงนี้ {w} สถานี แสดง {n} สถานี-เดือน",
};
