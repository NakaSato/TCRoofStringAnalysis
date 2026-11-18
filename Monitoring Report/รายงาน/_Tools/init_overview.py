#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""สร้าง 00_Overview_รายงานการแก้ไข.xlsx ครั้งแรก จากทะเบียนสถานี (registry.csv) + plant_map.json + ไฟล์ input วันแรก
ใช้ครั้งเดียวตอนตั้งระบบ — หลังจากนั้นแก้ข้อมูลที่ไฟล์ Overview โดยตรง"""
import csv, json, re, sys, os, datetime as dt
from collections import defaultdict
import openpyxl
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import string_check as sc

reg_csv, map_json, first_input, template = sys.argv[1:5]
reg = list(csv.DictReader(open(reg_csv, encoding="utf-8")))
pmap = json.load(open(map_json, encoding="utf-8"))
if first_input in ("-", ""):          # ยังไม่มีข้อมูล monitoring → ทะเบียน Inverter ว่าง (เติมอัตโนมัติจากไฟล์วันแรก)
    import datetime as _dt
    day, data = _dt.date.today(), {}
else:
    day, data = sc.parse_input(first_input)

code2pids, code2mon = defaultdict(list), defaultdict(list)
for pid, m in pmap.items():
    code2pids[m["code"]].append(pid); code2mon[m["code"]].append(re.sub(r"\s+", " ", m["mon_name"]).strip())


def display(name):
    n = re.sub(r"^กปภ\.?\s*สาขา\s*\S+\s*(\(ชั้นพิเศษ\)\s*)?", "", name).strip()
    n = re.sub(r"\s+การประปาส่วนภูมิภาคสาขา\S+$", "", n).strip()
    return name if len(n) < 12 else n


def branch(name):
    m = re.match(r"^(กปภ\.?\s*สาขา\s*\S+)", name)
    return re.sub(r"\s+", "", m.group(1)).replace("กปภ.สาขา", "กปภ.สาขา") if m else None


st = []
for r in reg:
    st.append({"รหัส": r["code"], "ระยะ": int(r["phase"]), "ชื่อสถานี (ใช้ในรายงาน)": display(r["name"]),
               "กปภ.สาขา": branch(r["name"]), "เขต": int(r["zone"]), "กำลังติดตั้ง (kWp)": float(r["kwp"]),
               "อายุสัญญา": "20 ปี ( 240 เดือน )", "วันที่เริ่มให้บริการ": None,
               "Plant ID (monitoring)": ", ".join(code2pids[r["code"]]),
               "ชื่อในระบบ monitoring": " | ".join(code2mon[r["code"]])})

# inverters from first input
pid2code = {pid: m["code"] for pid, m in pmap.items()}
name_of = {s["รหัส"]: s["ชื่อสถานี (ใช้ในรายงาน)"] for s in st}
per = defaultdict(list)
for sn, rec in data.items():
    per[pid2code[rec["plant_id"]]].append((sn, rec))
inv = []
for code in [s["รหัส"] for s in st]:
    rows = sorted(per[code], key=lambda x: sc.natkey(x[1]["inv_name"]))
    no = 0
    for sn, rec in rows:
        old = "old" in str(rec["inv_name"]).lower()
        if not old: no += 1
        inv.append({"รหัส": code, "สถานี": name_of[code], "NO.": None if old else no, "Inverter S/N": sn,
                    "ชื่อในระบบ monitoring": rec["inv_name"], "พิกัด (kW)": rec["kw"],
                    "จำนวนสตริง": rec["used"], "ใช้งาน (Y/N)": "N" if old else "Y",
                    "หมายเหตุ": "Inverter เก่า (old) – ไม่นำมาคำนวณ" if old else
                    (None if rec["used"] else "ไม่มีข้อมูลจำนวนสตริง – กรุณากรอก")})

# สถานีบางวาด (P1-037): ใช้ค่าจากฟอร์มเดิม String Check.xlsx (NO./S/N/จำนวนสตริง + วันที่เริ่มให้บริการ)
tws = openpyxl.load_workbook(template).worksheets[0]
tpl = {}
for r in tws.iter_rows(min_row=17, max_row=40, min_col=4, max_col=6, values_only=True):
    if isinstance(r[0], (int, float)) and r[1]:
        tpl[r[1]] = (int(r[0]), int(r[2]))
for v in inv:
    if v["Inverter S/N"] in tpl:
        v["NO."], n = tpl[v["Inverter S/N"]]
        if n != v["จำนวนสตริง"]:
            v["หมายเหตุ"] = f"จำนวนสตริงตามฟอร์มเดิม {n} (monitoring เห็นใช้งาน {v['จำนวนสตริง']})"
        v["จำนวนสตริง"] = n
for s in st:
    if s["รหัส"] == "P1-037":
        s["วันที่เริ่มให้บริการ"] = dt.datetime(2025, 4, 1)
        s["ชื่อสถานี (ใช้ในรายงาน)"] = "สถานีผลิตน้ำบางวาด"
for v in inv:
    if v["รหัส"] == "P1-037": v["สถานี"] = "สถานีผลิตน้ำบางวาด"

wb = openpyxl.Workbook()
wb.active.title = "รายงานการแก้ไข"
for t in ["สถานี", "Inverter", "สรุปรายวัน", "วิธีใช้", "_log"]:
    wb.create_sheet(t)
wb["_log"].sheet_state = "hidden"
# วิธีใช้
how = [
    ("ไฟล์นี้", "ไฟล์หลักของ PM — หน้า 'รายงานการแก้ไข' คือภาพรวมปัญหาทั้ง 233 สถานีในหน้าเดียว"),
    ("รายงานการแก้ไข", "ระบบเพิ่มปัญหาใหม่ทุกวันอัตโนมัติ · PM/วิศวกรกรอก สถานะ, ผู้รับผิดชอบ, การแก้ไข, วันที่แก้ไขเสร็จ (ช่องสีเหลือง) — ระบบไม่เขียนทับ"),
    ("", "'ผลตรวจล่าสุด' = ไม่พบแล้ว → ข้อมูลวันล่าสุดไม่พบปัญหานี้ ให้ตรวจยืนยันแล้วเปลี่ยนสถานะเป็น 'ปิดงาน'"),
    ("", "ปัญหาที่ 'ปิดงาน' แล้วกลับมาเกิดซ้ำ ระบบจะเปิดแถวใหม่"),
    ("สถานี", "ทะเบียน 233 สถานี: ชื่อที่ใช้ในรายงาน, kWp, อายุสัญญา, วันที่เริ่มให้บริการ → ดึงไปหัวรายงานประจำวันทุกไฟล์"),
    ("Inverter", "NO., Inverter S/N, จำนวนสตริง → ดึงไปตารางรายงานประจำวัน · ใช้งาน = N คือไม่นำมาคิด (เช่น inverter เก่า)"),
    ("สรุปรายวัน", "ความพร้อมรวมทุกสถานีรายวัน"),
    ("ประเภทปัญหา", "กระแสสตริงต่ำ (LOW) · สตริงไม่มีกระแส / น้อยกว่าทะเบียน · ไม่มีข้อมูลจาก Inverter · Inverter Fault"),
    ("ขั้นตอนประจำวัน", "1) วางไฟล์ inverter_string_inputs_YYYY-MM-DD.xlsx ใน _Input  2) รัน python3 _Tools/string_check.py  3) เปิดไฟล์นี้"),
    ("ผลลัพธ์", "โฟลเดอร์เดือน YYYY-MM → 1 ไฟล์ต่อสถานี: 'สรุปเดือน' + 'วันที่ 1..31' (ฟอร์ม String Check)"),
    ("แก้ข้อมูลหลัก", "แก้ที่ชีต สถานี/Inverter ในไฟล์นี้ แล้วรันสคริปต์ซ้ำกับไฟล์วันที่ต้องการ (python3 _Tools/string_check.py _Input/<ไฟล์>) หน้าของวันนั้นจะถูกสร้างใหม่"),
]
ws = wb["วิธีใช้"]
for r in how: ws.append(r)
ws.column_dimensions["A"].width = 18; ws.column_dimensions["B"].width = 140
for row in ws.iter_rows():
    for c in row: c.font = sc.FS; c.alignment = sc.L
for r in range(1, len(how) + 1): ws.cell(r, 1).font = sc.FSB
sc.build_pm_sheet(wb["รายงานการแก้ไข"], [], day, len(st))
os.makedirs(os.path.dirname(sc.OVERVIEW), exist_ok=True)
wb.save(sc.OVERVIEW)
sc.save_overview(openpyxl.load_workbook(sc.OVERVIEW), st, inv, [], [], [], day)
print("overview:", len(st), "stations,", len(inv), "inverters")
