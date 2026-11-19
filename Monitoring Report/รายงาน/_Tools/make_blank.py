#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""สร้างไฟล์เปล่า:  python3 make_blank.py template          → _Template/แบบฟอร์ม_String_Check.xlsx
                    python3 make_blank.py month 2026-11      → ไฟล์ 233 สถานีในโฟลเดอร์ 2026-11 (สรุปเดือน + หน้าวันที่ 1..สิ้นเดือน ครบทุกวัน)"""
import os, sys, datetime as dt
import openpyxl
import string_check as SC


def template():
    wb = openpyxl.Workbook(); wb.remove(wb.active)
    st = {"รหัส": "", "ชื่อสถานี (ใช้ในรายงาน)": "", "ระยะ": ""}
    SC.ensure_info_sheet(wb, {**st, "กำลังติดตั้ง (kWp)": None}, [])
    invs = [{"NO.": i + 1, "Inverter S/N": f"_{i}", "จำนวนสตริง": None} for i in range(10)]
    results = {v["Inverter S/N"]: (None, "", "", "", []) for v in invs}
    issues = [{"Inverter S/N": "", "String": "", "ประเภทปัญหา": "", "ค่าที่อ่านได้": "", "สถานะ": ""} for _ in range(8)]
    ws = SC.build_day_sheet(wb, dt.date.today(), st, invs, results, issues, "")
    ws.title = "แบบฟอร์ม"
    ws.oddFooter.left.text = ""
    ws["C4"].value = "สรุปผลความพร้อมระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ประจำวันที่  ......../......../........"
    for row in ws.iter_rows():
        for c in row:
            v = c.value
            if isinstance(v, str) and (v.startswith("='_ข้อมูลสถานี'") or (c.row >= 17 and v in ("-", "ปกติ")) or
                                       (v.startswith("=E") and "-G" in v)):
                c.value = None
            if isinstance(v, int) and c.column == 3 and ws.cell(c.row, 4).value in ("", None):
                c.value = None                      # ลำดับในรายงานการแก้ไข
    del wb["_ข้อมูลสถานี"]
    out = os.path.join(SC.ROOT, "_Template", "แบบฟอร์ม_String_Check.xlsx")
    wb.save(out); print("→", out)


def month(m):
    y, mo = map(int, m.split("-")); day = dt.date(y, mo, 1)
    wb, st, inv, iss, daily, done = SC.load_overview()
    n = 0
    for s in st:
        folder, fname = SC.plant_file(s, day)
        path = os.path.join(folder, fname)
        invs = sorted([v for v in inv if v["รหัส"] == s["รหัส"] and str(v.get("ใช้งาน (Y/N)") or "Y").upper() != "N"],
                      key=lambda v: (v["NO."] is None, v["NO."] or 0))
        old = os.path.join(folder, fname.replace(f"_{m}.xlsx", ".xlsx"))   # ชื่อไฟล์แบบเก่า (ไม่มีเดือน)
        if not os.path.exists(path) and os.path.exists(old):
            os.rename(old, path)
        pwb = None
        if os.path.exists(path):                  # มีแล้ว → อัปเดตข้อมูลสถานี/Inverter + เติมหน้าวันที่ที่ยังขาด
            try:
                pwb = openpyxl.load_workbook(path)
            except Exception as e:
                print(f"   ! {fname} เสีย ({e}) → สร้างใหม่")
        if pwb is None:
            pwb = openpyxl.Workbook(); pwb.remove(pwb.active)
        SC.ensure_info_sheet(pwb, s, invs)
        ms = SC.build_month_sheet(pwb, s, day)
        nd = (dt.date(y + (mo == 12), mo % 12 + 1, 1) - dt.timedelta(days=1)).day
        for d in range(1, nd + 1):
            t = f"วันที่ {d}"
            blank = t in pwb.sheetnames and any(c.value == "ยังไม่ได้ประมวลผลข้อมูลวันนี้" for c in pwb[t]["C"])
            if t not in pwb.sheetnames or blank:          # หน้าที่ยังไม่ประมวลผล → สร้างใหม่ตามทะเบียนล่าสุด
                SC.build_blank_day(pwb, dt.date(y, mo, d), s, invs)
            c = ms.cell(5 + d, 9, "เปิด")
            c.hyperlink = f"#'วันที่ {d}'!A1"
            c.font = SC.Font(name=SC.FONT, size=16, color="0563C1", underline="single")
        pwb.move_sheet("สรุปเดือน", -pwb.sheetnames.index("สรุปเดือน"))
        pwb.move_sheet("_ข้อมูลสถานี", len(pwb.sheetnames) - 1 - pwb.sheetnames.index("_ข้อมูลสถานี"))
        pwb.active = 0
        for w in pwb.worksheets: w.sheet_view.tabSelected = (w.title == "สรุปเดือน")
        pwb.save(path); n += 1
    print(f"→ สร้าง/อัปเดต {n} ไฟล์ใน {m}/")


if __name__ == "__main__":
    if sys.argv[1:2] == ["template"]: template()
    elif sys.argv[1:2] == ["month"]: month(sys.argv[2])
    else: print(__doc__)
