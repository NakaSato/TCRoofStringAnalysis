/** Thai text for Inventory: the Installed and Spares per model tabs, From installed models (L-1, L-2, L-4); docs/plans/inventory-installed-base.md. Keyed by the English text in the code. See ../th.ts. */
export const TH_STOCK_INSTALLED: Record<string, string> = {
  // ---- Installed tab (InstalledTab.tsx)
  "Serial, model, plant, IP, SIM…": "SN, รุ่น, โรงไฟฟ้า, IP, ซิม…",
  "No installed devices.": "ยังไม่มีอุปกรณ์ที่ติดตั้ง",
  "No installed devices match.": "ไม่พบอุปกรณ์ที่ติดตั้งตามตัวกรอง",
  "Failed unit open": "มีอุปกรณ์เสียค้างอยู่",
  "Open {label}": "เปิด {label}",
  SIM: "ซิม",
  "Could not load the installed devices: {error}": "โหลดอุปกรณ์ที่ติดตั้งไม่สำเร็จ: {error}",
  // ---- Spares per model tab (ModelsTab.tsx)
  "Spares per model": "อะไหล่ตามรุ่น",
  "Could not load the spares per model: {error}": "โหลดอะไหล่ตามรุ่นไม่สำเร็จ: {error}",
  "Model not recorded": "ไม่ได้บันทึกรุ่น",
  "By phase": "แยกตามเฟส",
  "No phase": "ไม่ระบุเฟส",
  "Failed open": "เสียค้างอยู่",
  "Catalogue parts": "อะไหล่ในรายการ",
  Thin: "สำรองน้อย",
  "In stock is below the parts' minimum ({n})": "จำนวนในคลังต่ำกว่าขั้นต่ำของอะไหล่ ({n})",
  "min {n}": "ขั้นต่ำ {n}",
  "Add to catalogue": "เพิ่มในรายการอะไหล่",
  "No part": "ไม่มีในรายการ",
  "No installed models.": "ยังไม่มีรุ่นที่ติดตั้ง",
  "Installed counts come from the Growatt registry and the site register; spares from the catalogue parts that match the model. Counts only.":
    "จำนวนที่ติดตั้งมาจากทะเบียน Growatt และทะเบียนอุปกรณ์หน้างาน ส่วนอะไหล่นับจากรายการอะไหล่ที่ตรงกับรุ่น แสดงเฉพาะจำนวน",
  // ---- From installed models (FromModelsDialog.tsx)
  "From installed models": "สร้างจากรุ่นที่ติดตั้ง",
  "A catalogue part for each model on the plants. Check the code, name and make; only the ticked rows are added, all or none.":
    "เสนอรายการอะไหล่หนึ่งรายการต่อรุ่นที่ติดตั้งอยู่ในโรงไฟฟ้า ตรวจรหัส ชื่อ และยี่ห้อก่อน ระบบจะเพิ่มเฉพาะแถวที่เลือก และเพิ่มทั้งหมดหรือไม่เพิ่มเลย",
  "Already in the catalogue": "มีในรายการอะไหล่แล้ว",
  "No installed models with a model recorded.": "ยังไม่มีอุปกรณ์ที่ติดตั้งและบันทึกรุ่นไว้",
  "{n} installed": "ติดตั้ง {n}",
  "Add {model}": "เพิ่ม {model}",
  "Add {n} parts": "เพิ่ม {n} รายการ",
  "Added {n} parts to the catalogue.": "เพิ่ม {n} รายการในรายการอะไหล่แล้ว",
  "{n} of {total} new models ticked": "เลือก {n} จาก {total} รุ่นใหม่",
};
