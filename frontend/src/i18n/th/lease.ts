/** Thai text of the TFRS 16 lease model charts on Energy & Billing (`pages/center/LeaseCharts.tsx`). */
export const TH_LEASE: Record<string, string> = {
  "TFRS 16 model": "แบบจำลอง TFRS 16",
  "TFRS 16 lease (model)": "สัญญาเช่าตาม TFRS 16 (แบบจำลอง)",
  "Whole contract, not the period above": "ทั้งสัญญา ไม่ขึ้นกับช่วงเวลาด้านบน",
  "Modelled (TFRS 16 model)": "แบบจำลอง (TFRS 16)",
  "Accounting figures of the TFRS 16 model workbook, not measured": "ตัวเลขทางบัญชีจากไฟล์แบบจำลอง TFRS 16 ไม่ใช่ค่าวัดจริง",
  "Contract minimum (model)": "ขั้นต่ำตามสัญญา (แบบจำลอง)",
  "Status list (workbook)": "รายการสถานะ (จากไฟล์)",
  "Not in the imported model": "ไม่มีในแบบจำลองที่นำเข้า",
  "No TFRS 16 model imported": "ยังไม่ได้นำเข้าแบบจำลอง TFRS 16",
  "An admin imports the model workbook with": "ผู้ดูแลระบบนำเข้าไฟล์แบบจำลองด้วยคำสั่ง",
  "The TFRS 16 model could not be read": "อ่านแบบจำลอง TFRS 16 ไม่ได้",
  "Source: {file} · imported {when}": "ที่มา: {file} · นำเข้าเมื่อ {when}",
  "{n} check warnings in the import": "คำเตือนจากการตรวจสอบตอนนำเข้า {n} รายการ",
  "FY{n}": "ปีงบ {n}",
  "Phase {n} (est.)": "ระยะที่ {n} (ประมาณการ)",
  "Phase {n}: {m} months": "ระยะที่ {n}: {m} เดือน",
  "Total": "รวม",
  "All phases": "ทุกระยะ",
  "Partial year": "ไม่เต็มปี",
  "Phases started": "ระยะโครงการที่เริ่มสัญญาแล้ว",
  "Share of all phases": "สัดส่วนของทุกระยะโครงการ",
  "Of all stations": "ของสถานีทั้งหมด",
  "Dotted = estimated phases ({list}): start date assumed.": "เส้นจุด = ระยะโครงการที่เป็นประมาณการ ({list}): วันเริ่มสัญญาเป็นค่าสมมติ",

  // B1 lease liability run-off
  "Lease liability run-off": "การทยอยลดลงของหนี้สินตามสัญญาเช่า",
  "Lease liability, end of month (M฿)": "หนี้สินตามสัญญาเช่า ณ สิ้นเดือน (ล้านบาท)",
  "Lease liability": "หนี้สินตามสัญญาเช่า",
  "Liability at the end of each month per phase; All phases = the sum of the phases whose lease has started.":
    "หนี้สิน ณ สิ้นแต่ละเดือนแยกตามระยะโครงการ · ทุกระยะโครงการ = ผลรวมของระยะโครงการที่เริ่มสัญญาเช่าแล้ว",

  // B3 right-of-use asset vs liability
  "Right-of-use asset vs lease liability": "สินทรัพย์สิทธิการใช้เทียบหนี้สินตามสัญญาเช่า",
  "All phases, end of month (M฿)": "ทุกระยะโครงการ ณ สิ้นเดือน (ล้านบาท)",
  "Right-of-use asset (net)": "สินทรัพย์สิทธิการใช้ (สุทธิ)",
  "Liability − asset": "หนี้สิน − สินทรัพย์",
  "All phases summed. The asset is depreciated on a straight line over the contract, while the liability falls with each payment net of interest, so the two lines part in the middle years and meet at zero at the end.":
    "รวมทุกระยะโครงการ · สินทรัพย์ตัดค่าเสื่อมราคาแบบเส้นตรงตลอดอายุสัญญา ส่วนหนี้สินลดลงตามค่างวดที่จ่ายหักดอกเบี้ย เส้นทั้งสองจึงห่างกันในช่วงกลางสัญญาและมาบรรจบที่ศูนย์เมื่อสิ้นสัญญา",

  // B2 interest vs principal
  "Interest vs principal by fiscal year": "ดอกเบี้ยเทียบเงินต้น รายปีงบประมาณ",
  "Lease payments by fiscal year (M฿)": "ค่างวดตามสัญญาเช่ารายปีงบ (ล้านบาท)",
  "Interest": "ดอกเบี้ย",
  "Principal": "เงินต้น",
  "Each bar = the minimum-fee payments of a Thai fiscal year (1 Oct – 30 Sep), split into interest and repayment of the liability (principal = payment − interest). The first and last years are partial.":
    "แต่ละแท่ง = ค่าจัดการพลังงานขั้นต่ำที่จ่ายในปีงบประมาณ (1 ต.ค. – 30 ก.ย.) แยกเป็นดอกเบี้ยและการชำระคืนหนี้สิน (เงินต้น = ค่างวด − ดอกเบี้ย) · ปีแรกและปีสุดท้ายไม่เต็มปี",

  // B4 expense
  "Depreciation and interest expense by fiscal year": "ค่าเสื่อมราคาและดอกเบี้ยจ่ายรายปีงบประมาณ",
  "Expense by fiscal year (M฿)": "ค่าใช้จ่ายรายปีงบ (ล้านบาท)",
  "Depreciation": "ค่าเสื่อมราคา",
  "Expense in the income statement = depreciation of the right-of-use asset + interest on the liability, before remeasurements. The first and last years are partial.":
    "ค่าใช้จ่ายในงบกำไรขาดทุน = ค่าเสื่อมราคาสินทรัพย์สิทธิการใช้ + ดอกเบี้ยของหนี้สิน (ก่อนการวัดมูลค่าใหม่) · ปีแรกและปีสุดท้ายไม่เต็มปี",

  // B5 minimum fee
  "Minimum fee over 20 years by phase": "ค่าจัดการพลังงานขั้นต่ำ 20 ปี แยกตามระยะโครงการ",
  "Minimum fee over 20 years, ex VAT (M฿)": "ค่าจัดการพลังงานขั้นต่ำ 20 ปี ไม่รวม VAT (ล้านบาท)",
  "Minimum fee": "ค่าจัดการพลังงานขั้นต่ำ",
  "Minimum energy-management fee, ex VAT. All phases: {total}; project budget in the contract: {budget}. Phases 3–4 split the remaining budget by kWp.":
    "ค่าจัดการพลังงานขั้นต่ำ ไม่รวม VAT · ทุกระยะโครงการ: {total} · วงเงินโครงการตามสัญญา: {budget} · ระยะที่ 3–4 แบ่งวงเงินคงเหลือตามสัดส่วน kWp",

  // B10 seasonal revenue
  "Seasonal revenue profile, contract year 1": "รูปแบบรายได้ตามฤดูกาล ปีแรกของสัญญา",
  "Revenue in contract year 1 (M฿ per month)": "รายได้ปีแรกของสัญญา (ล้านบาทต่อเดือน)",
  "Modelled revenue per month of each phase's first contract year, in contract-year order (October first); the phases start on different dates, so the months are not the same calendar year. Case: {case} · {price} ฿/kWh.":
    "รายได้ตามแบบจำลองรายเดือนในปีแรกของสัญญาแต่ละระยะโครงการ เรียงตามเดือนของปีสัญญา (เริ่ม ต.ค.) · แต่ละระยะโครงการเริ่มคนละวัน จึงไม่ใช่ปีปฏิทินเดียวกัน · กรณี: {case} · {price} บาท/kWh",

  // B9 remeasurement
  "Lease liability remeasurement": "การวัดมูลค่าหนี้สินตามสัญญาเช่าใหม่",
  "Book liability": "หนี้สินตามบัญชี",
  "Remeasured": "หนี้สินที่วัดมูลค่าใหม่",
  "Difference": "ส่วนต่าง",
  "Lease liability (M฿)": "หนี้สินตามสัญญาเช่า (ล้านบาท)",
  "Production share {share} · difference {diff} of the book liability (threshold {thr}) · account {acc}":
    "สัดส่วนการผลิต {share} · ส่วนต่าง {diff} ของหนี้สินตามบัญชี (เกณฑ์ {thr}) · บัญชี {acc}",
  "At a fiscal year end the liability is measured again at the expected production share, with the original discount rate. The difference goes to account 6279030 only when it exceeds the threshold.":
    "ณ สิ้นปีงบ วัดมูลค่าหนี้สินใหม่ตามสัดส่วนการผลิตที่คาดไว้ ด้วยอัตราคิดลดเดิม · บันทึกส่วนต่างเข้าบัญชี 6279030 เฉพาะเมื่อเกินเกณฑ์",

  // B11 rollout
  "Phase 3–4 rollout": "ความคืบหน้าระยะที่ 3–4",
  "Stations": "สถานี",
  "Interconnection fee paid": "ชำระค่าธรรมเนียมขนานไฟแล้ว",
  "Interconnected": "ขนานไฟแล้ว",
  "First Sync": "First Sync",
  "Stations of phases 3–4 by stage, from the status list in the model workbook: interconnection fee paid, interconnected with PEA, First Sync date given.":
    "สถานีระยะที่ 3–4 ตามขั้นตอน จากรายการสถานะในไฟล์แบบจำลอง: ชำระค่าธรรมเนียมขนานไฟแล้ว · ขนานไฟกับ กฟภ. แล้ว · มีวัน First Sync",
};
