# ตั้งค่า Google Sheets API (ทำครั้งเดียว ~10 นาที)

ใช้บัญชี Google ที่จะเป็นเจ้าของไฟล์ (เช่น wit.chanthawat@gmail.com) — ไฟล์รายงานทั้งหมดจะอยู่ใน Drive ของบัญชีนี้

## 1. สร้าง Project และเปิด API
1. ไปที่ https://console.cloud.google.com → มุมบนซ้าย **Select a project → New Project** → ตั้งชื่อ เช่น `solar-string-check` → Create
2. เมนู **APIs & Services → Library** → ค้นหาแล้วกด **Enable** ทั้ง 2 ตัว
   - Google Sheets API
   - Google Drive API

## 2. หน้าขออนุญาต (OAuth consent screen)
1. **APIs & Services → OAuth consent screen** (หรือ Google Auth Platform → Branding)
2. User type: **External** → ใส่ชื่อแอป เช่น `String Check` + อีเมลของคุณ → Save
3. หัวข้อ **Audience / Test users** → **Add users** → ใส่อีเมลของคุณเอง → Save
   (ไม่ต้อง publish — ใช้แบบ Testing ได้)

## 3. สร้าง Client ID แบบ Desktop
1. **APIs & Services → Credentials → Create credentials → OAuth client ID**
2. Application type: **Desktop app** → Create
3. กด **Download JSON** → เปลี่ยนชื่อไฟล์เป็น `credentials.json` → วางใน `รายงาน/_Tools/`

## 4. โฟลเดอร์ใน Drive
1. ใน Google Drive สร้างโฟลเดอร์ เช่น `Solar Rooftop กปภ. – รายงาน String Check`
2. เปิดโฟลเดอร์ → คัดลอก ID จาก URL (ส่วนหลัง `/folders/`)
3. สร้างไฟล์ `รายงาน/_Tools/gsheet_config.json` ข้อความ:
   ```json
   {"root_folder_id": "วาง_ID_ตรงนี้"}
   ```

## 5. รันครั้งแรก
ดับเบิลคลิก `รันรายงานประจำวัน.command` → เบราว์เซอร์จะเปิดให้เลือกบัญชีและกด **Allow**
(ถ้าขึ้น "Google hasn't verified this app" ให้กด Continue — เป็นแอปของคุณเอง)
ระบบจะเก็บสิทธิ์ไว้ที่ `_Tools/token.json` ครั้งต่อไปไม่ต้องกดอีก

> ห้ามแชร์ `credentials.json` และ `token.json` ให้คนอื่น
