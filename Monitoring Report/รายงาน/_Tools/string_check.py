#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
String Check – ระบบรายงานความพร้อมระบบ Solar Rooftop กปภ. (233 สถานี)

โครงสร้างโฟลเดอร์ (ทั้งหมดอยู่ใต้โฟลเดอร์ "รายงาน"):
    00_Overview_รายงานการแก้ไข.xlsx   ← ไฟล์ PM: หน้า "รายงานการแก้ไข" + ทะเบียนสถานี/Inverter
    _Input/                           ← วางไฟล์ inverter_string_inputs_YYYY-MM-DD.xlsx ทุกวัน
    _Template/logo.png                ← โลโก้หัวรายงาน
    _Tools/string_check.py            ← สคริปต์นี้
    2026-11/                          ← 1 โฟลเดอร์ต่อเดือน
        P1-037_สถานีผลิตน้ำบางวาด(สำนักงาน).xlsx   ← 1 ไฟล์ต่อสถานี: "สรุปเดือน" + "วันที่ 1..31"

วิธีใช้:
    python3 string_check.py            # ประมวลผลทุกไฟล์ใน _Input ที่ยังไม่เคยทำ
    python3 string_check.py <ไฟล์.xlsx>  # ประมวลผลไฟล์ที่ระบุ (ทำซ้ำได้ จะเขียนทับหน้าของวันนั้น)
"""
import os, re, sys, glob, datetime as dt
from collections import OrderedDict, defaultdict
import openpyxl
import gsheets_sync as GS
from openpyxl.styles import Font, Alignment, Border, Side, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import FormulaRule, CellIsRule
from openpyxl.drawing.image import Image as XLImage

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE) if os.path.basename(HERE) == "_Tools" else HERE
OVERVIEW = os.path.join(ROOT, "00_Overview_รายงานการแก้ไข.xlsx")
INPUT_DIR = os.path.join(ROOT, "_Input")
LOGO = os.path.join(ROOT, "_Template", "logo.png")

PROJECT = "โครงการจัดการพลังงานไฟฟ้าจากระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ที่ติดตั้งบนหลังคา (Solar Rooftop)"
OWNER = "การประปาส่วนภูมิภาค"
STATUSES = ["รอดำเนินการ", "กำลังแก้ไข", "แก้ไขแล้ว", "ปิดงาน"]
CLOSED = ("ปิดงาน",)
TH_DATE = '[$-1070000]dd/mm/yyyy;@'   # แสดงวันที่เป็น พ.ศ. แต่ยังเป็นค่าวันที่จริง (เรียง/กรองได้)
TH_MONTH = ["", "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
            "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"]

# ---------- styles (ตามฟอร์มเดิม: Sarabun 16, หัวตารางฟ้า B4C6E7, หัวรายงานการแก้ไขส้ม F7CAAC)
FONT = "TH SarabunPSK"
F = Font(name=FONT, size=16)                 # ตัวอักษรปกติ
FB = Font(name=FONT, size=16, bold=True)     # หัวตาราง / ค่าเน้น
FT = Font(name=FONT, size=20, bold=True)     # หัวรายงาน / ตัวเลข KPI
FS = Font(name=FONT, size=14)                # ตาราง Overview
FSB = Font(name=FONT, size=14, bold=True)    # หัวตาราง Overview
FM = Font(name=FONT, size=15)                # อาการ / การแก้ไข (ข้อความยาว)
BLUE = PatternFill("solid", fgColor="B4C6E7")
ORANGE = PatternFill("solid", fgColor="F7CAAC")
GREY = PatternFill("solid", fgColor="EDEDED")
RED = PatternFill("solid", fgColor="F8CBAD")
GREEN = PatternFill("solid", fgColor="C6EFCE")
YELLOW = PatternFill("solid", fgColor="FFEB9C")
thin, med = Side("thin"), Side("medium")
C = Alignment(horizontal="center", vertical="center", wrap_text=True)
L = Alignment(horizontal="left", vertical="center", wrap_text=True)
BOX = Border(thin, thin, thin, thin)


def box(ws, rng, outer=med, inner=thin):
    rows = list(ws[rng])
    for i, row in enumerate(rows):
        for j, c in enumerate(row):
            c.border = Border(left=outer if j == 0 else inner, right=outer if j == len(row) - 1 else inner,
                              top=outer if i == 0 else inner, bottom=outer if i == len(rows) - 1 else inner)


def put(ws, ref, val, font=F, align=None, fill=None, merge=None, fmt=None):
    if merge:
        ws.merge_cells(merge)
    c = ws[ref]
    c.value = val
    c.font = font
    if align: c.alignment = align
    if fill: c.fill = fill
    if fmt: c.number_format = fmt
    return c


def th_date(d):
    return f"{d.day:02d} {TH_MONTH[d.month]} พ.ศ.{d.year + 543}" if d else "-"


def safe(s):
    return re.sub(r'[\\/:*?"<>|]', "-", s).strip()


def natkey(s):
    return [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", str(s or ""))]


# =====================================================================  OVERVIEW (master)
ST_COLS = ["รหัส", "ระยะ", "ชื่อสถานี (ใช้ในรายงาน)", "กปภ.สาขา", "เขต", "กำลังติดตั้ง (kWp)",
           "อายุสัญญา", "วันที่เริ่มให้บริการ", "Plant ID (monitoring)", "ชื่อในระบบ monitoring",
           "จำนวน Inverter", "จำนวนสตริงรวม", "ไฟล์รายงาน"]
INV_COLS = ["รหัส", "สถานี", "NO.", "Inverter S/N", "ชื่อในระบบ monitoring", "พิกัด (kW)",
            "จำนวนสตริง", "ใช้งาน (Y/N)", "หมายเหตุ"]
ISS_COLS = ["No.", "รหัสปัญหา", "วันที่พบ", "พบล่าสุด", "จำนวนวัน", "ระยะ", "รหัส", "สถานี",
            "Inverter S/N", "String", "ประเภทปัญหา", "ค่าที่อ่านได้", "ผลตรวจล่าสุด", "สถานะ",
            "ผู้รับผิดชอบ", "การแก้ไข / หมายเหตุ", "วันที่แก้ไขเสร็จ", "รายงาน", "ผลการตรวจสอบ"]
ISS_HDR = 9  # แถวหัวตารางในหน้า "รายงานการแก้ไข"


def read_table(ws, header_row, cols):
    out = []
    for r in ws.iter_rows(min_row=header_row + 1, max_col=len(cols), values_only=True):
        if r[0] in (None, ""):
            continue
        out.append(dict(zip(cols, r)))
    return out


def load_overview():
    wb = openpyxl.load_workbook(OVERVIEW)
    st = read_table(wb["สถานี"], 1, ST_COLS)
    inv = read_table(wb["Inverter"], 1, INV_COLS)
    iss = read_table(wb["รายงานการแก้ไข"], ISS_HDR, ISS_COLS)
    daily = read_table(wb["สรุปรายวัน"], 1, DAILY_COLS)
    done = [r[0] for r in wb["_log"].iter_rows(min_row=2, values_only=True) if r[0]]
    return wb, st, inv, iss, daily, done


def write_sheet_table(ws, cols, rows, widths, header_row=1, fills=None):
    ws.delete_rows(header_row, ws.max_row + 5)
    for j, h in enumerate(cols, 1):
        c = ws.cell(header_row, j, h)
        c.font, c.fill, c.alignment, c.border = FSB, BLUE, C, BOX
    for i, r in enumerate(rows, header_row + 1):
        for j, h in enumerate(cols, 1):
            c = ws.cell(i, j, r.get(h))
            c.font, c.border = FS, BOX
            c.alignment = L if widths[j - 1] >= 20 else C
    for j, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(j)].width = w
    ws.freeze_panes = ws.cell(header_row + 1, 3)
    ws.auto_filter.ref = f"A{header_row}:{get_column_letter(len(cols))}{max(header_row + 1, header_row + len(rows))}"


DAILY_COLS = ["วันที่", "สถานีที่มีข้อมูล", "สตริงทั้งหมด", "สตริงปกติ", "สตริงผิดปกติ", "ความพร้อม (%)",
              "สถานีที่มีปัญหา", "ปัญหาใหม่", "ปัญหาเปิดอยู่"]


def save_overview(wb, st, inv, iss, daily, done, asof):
    write_sheet_table(wb["สถานี"], ST_COLS, st, [9, 6, 42, 22, 6, 12, 18, 20, 13, 45, 9, 10, 40])
    ws = wb["สถานี"]
    for i, r in enumerate(st, 2):
        ws.cell(i, 6).number_format = "#,##0.00"
        ws.cell(i, 8).number_format = TH_DATE
        if r.get("ไฟล์รายงาน"):
            ws.cell(i, 13).hyperlink = r["ไฟล์รายงาน"]
            ws.cell(i, 13).font = Font(name=FONT, size=14, color="0563C1", underline="single")
    write_sheet_table(wb["Inverter"], INV_COLS, inv, [9, 36, 6, 16, 22, 10, 11, 11, 30])
    dv = DataValidation(type="list", formula1='"Y,N"', allow_blank=True)
    wb["Inverter"].add_data_validation(dv); dv.add(f"H2:H{len(inv) + 50}")
    write_sheet_table(wb["สรุปรายวัน"], DAILY_COLS, daily, [12, 12, 12, 12, 12, 12, 12, 12, 12])
    for i in range(2, len(daily) + 2):
        wb["สรุปรายวัน"].cell(i, 1).number_format = TH_DATE
        wb["สรุปรายวัน"].cell(i, 6).number_format = "0.00"
    lg = wb["_log"]
    lg.delete_rows(1, lg.max_row + 1)
    lg.append(["ไฟล์ที่ประมวลผลแล้ว"])
    for d in done: lg.append([d])
    build_pm_sheet(wb["รายงานการแก้ไข"], iss, asof, len(st))
    wb.save(OVERVIEW)


def build_pm_sheet(ws, iss, asof, n_station):
    # unmerge + clear
    for m in list(ws.merged_cells.ranges): ws.unmerge_cells(str(m))
    ws.delete_rows(1, ws.max_row + 5)
    ws.conditional_formatting = type(ws.conditional_formatting)()
    ws.data_validations.dataValidation = []
    ws.sheet_view.showGridLines = False
    last = ISS_HDR + max(len(iss), 1) + 200
    rng = lambda col: f"${col}${ISS_HDR + 1}:${col}${last}"
    put(ws, "A1", "รายงานการแก้ไข – ระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ (Solar Rooftop) กปภ.", FT, merge="A1:S1")
    put(ws, "A2", f"ข้อมูล ณ วันที่ {th_date(asof)}   ·   สถานีทั้งหมด {n_station} สถานี", F, merge="A2:S2")
    kpis = [("ปัญหาที่ยังเปิด", f'=COUNTIFS({rng("N")},"<>ปิดงาน",{rng("B")},"<>")', RED),
            ("พบวันนี้", f'=COUNTIFS({rng("D")},DATE({asof.year},{asof.month},{asof.day}))', YELLOW),
            ("ปัญหาใหม่วันนี้", f'=COUNTIFS({rng("C")},DATE({asof.year},{asof.month},{asof.day}))', YELLOW),
            ("สถานีที่มีปัญหาเปิด", f'=SUM({rng("T")})', RED),
            ("กำลังแก้ไข", f'=COUNTIFS({rng("N")},"กำลังแก้ไข")', YELLOW),
            ("ปิดงานแล้ว", f'=COUNTIFS({rng("N")},"ปิดงาน")', GREEN)]
    col = 1
    for name, f, fill in kpis:
        a, b = get_column_letter(col), get_column_letter(col + 2)
        put(ws, f"{a}4", name, FSB, C, fill, merge=f"{a}4:{b}4")
        put(ws, f"{a}5", f, FT, C, fill, merge=f"{a}5:{b}6")
        box(ws, f"{a}4:{b}6")
        col += 3
    put(ws, "A7", "สถานะ: รอดำเนินการ → กำลังแก้ไข → แก้ไขแล้ว → ปิดงาน   ·   ช่องสีเหลืองมาจากผู้ทำรายงาน (Google Sheets ของแต่ละสถานี) — ระบบดึงมาอัปเดตทุกวัน", FS, merge="A7:S7")
    for j, h in enumerate(ISS_COLS, 1):
        c = ws.cell(ISS_HDR, j, h)
        c.font, c.fill, c.alignment, c.border = FSB, BLUE, C, BOX
    ws.cell(ISS_HDR, 20, "_open_station").font = FS
    # open first, then newest
    iss.sort(key=lambda r: (r.get("สถานะ") in CLOSED, -(r["พบล่าสุด"].toordinal() if r.get("พบล่าสุด") else 0),
                            r.get("รหัส") or "", natkey(r.get("Inverter S/N")), natkey(r.get("String"))))
    seen_open = set()
    for i, r in enumerate(iss, ISS_HDR + 1):
        r["No."] = i - ISS_HDR
        for j, h in enumerate(ISS_COLS, 1):
            v = r.get(h)
            if h == "จำนวนวัน":
                v = f"=IF(D{i}=\"\",\"\",D{i}-C{i}+1)"
            if h == "รายงาน":
                v = "เปิด" if r.get("_link") or r.get("รายงาน") else None
            c = ws.cell(i, j, v)
            c.font, c.border = FS, BOX
            c.alignment = (L if h == "การแก้ไข / หมายเหตุ" else
                           Alignment(horizontal="left", vertical="center", shrink_to_fit=True)
                           if h in ("สถานี", "ผลตรวจล่าสุด", "ประเภทปัญหา") else
                           Alignment(horizontal="center", vertical="center", shrink_to_fit=True))
            if h in ("วันที่พบ", "พบล่าสุด", "วันที่แก้ไขเสร็จ"): c.number_format = TH_DATE
            if h in ("สถานะ", "ผู้รับผิดชอบ", "การแก้ไข / หมายเหตุ", "วันที่แก้ไขเสร็จ", "ผลการตรวจสอบ"): c.fill = PatternFill("solid", fgColor="FFF9E5")
        ws.row_dimensions[i].height = 22
        link = r.get("_link")
        if link:
            ws.cell(i, 18).hyperlink = link
            ws.cell(i, 18).font = Font(name=FONT, size=14, color="0563C1", underline="single")
        key = r.get("รหัส")
        open_ = r.get("สถานะ") not in CLOSED
        ws.cell(i, 20, 1 if (open_ and key not in seen_open) else 0).font = FS
        if open_: seen_open.add(key)
    ws.column_dimensions["T"].hidden = True
    ws.column_dimensions["B"].hidden = True  # รหัสปัญหา (คีย์ภายใน ห้ามแก้)
    # ช่องวันที่แก้ไขเสร็จ: แสดง พ.ศ. + บังคับกรอกเป็นวันที่ (รวมแถวว่างที่จะกรอกภายหลัง)
    for rr in range(ISS_HDR + 1, last + 1):
        ws.cell(rr, 17).number_format = TH_DATE
    dvd = DataValidation(type="date", operator="greaterThan", formula1="DATE(2024,1,1)", allow_blank=True,
                         error="กรอกเป็นวันที่ เช่น 15/11/2026 (ระบบจะแสดงเป็น พ.ศ. ให้เอง)", errorTitle="วันที่ไม่ถูกต้อง")
    ws.add_data_validation(dvd); dvd.add(f"Q{ISS_HDR + 1}:Q{last}")
    dv = DataValidation(type="list", formula1='"' + ",".join(STATUSES) + '"', allow_blank=False)
    ws.add_data_validation(dv); dv.add(f"N{ISS_HDR + 1}:N{last}")
    end = ISS_HDR + max(len(iss), 1)
    ws.conditional_formatting.add(f"N{ISS_HDR + 1}:N{last}", CellIsRule(operator="equal", formula=['"รอดำเนินการ"'], fill=RED))
    ws.conditional_formatting.add(f"N{ISS_HDR + 1}:N{last}", CellIsRule(operator="equal", formula=['"กำลังแก้ไข"'], fill=YELLOW))
    ws.conditional_formatting.add(f"N{ISS_HDR + 1}:N{last}", CellIsRule(operator="equal", formula=['"แก้ไขแล้ว"'], fill=GREEN))
    ws.conditional_formatting.add(f"A{ISS_HDR + 1}:S{last}", FormulaRule(formula=[f'$N{ISS_HDR + 1}="ปิดงาน"'], fill=GREY))
    ws.conditional_formatting.add(f"M{ISS_HDR + 1}:M{last}", FormulaRule(formula=[f'LEFT($M{ISS_HDR + 1},4)="ไม่พบ"'], fill=GREEN))
    widths = [6, 4, 13, 13, 8, 6, 9, 38, 17, 9, 26, 12, 26, 14, 16, 34, 14, 8, 20]
    for j, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(j)].width = w
    ws.row_dimensions[1].height = 30
    ws.row_dimensions[ISS_HDR].height = 40
    ws.freeze_panes = f"C{ISS_HDR + 1}"
    ws.auto_filter.ref = f"A{ISS_HDR}:S{end}"
    ws.page_setup.orientation = "landscape"; ws.page_setup.paperSize = 9
    ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_title_rows = f"{ISS_HDR}:{ISS_HDR}"


# =====================================================================  INPUT parsing
def parse_input(path):
    ws = openpyxl.load_workbook(path, read_only=True, data_only=True).active
    rows = list(ws.iter_rows(values_only=True))
    hdr = [str(h) for h in rows[0]]
    idx = {h: i for i, h in enumerate(hdr)}
    scols = [i for i, h in enumerate(hdr) if h.startswith("String ")]
    data, day = {}, None
    for r in rows[1:]:
        if not r or not r[idx["inverter_sn"]]:
            continue
        day = day or r[idx["day"]]
        strings = []
        for i in scols:
            v = r[i]
            if v is None: continue
            n = int(re.match(r"String (\d+)", hdr[i]).group(1))
            v = str(v).strip()
            m = re.match(r"USED\s+([\d.]+)\s*A(\s+LOW)?", v)
            if m:
                strings.append((n, "LOW" if m.group(2) else "OK", float(m.group(1))))
            elif v in ("NO DATA", "N/R"):
                strings.append((n, "NODATA", None))
        data[str(r[idx["inverter_sn"]]).strip()] = dict(
            plant_id=str(r[idx["plant_id"]]), plant_name=r[idx["plant_name"]], phase=r[idx["phase"]],
            inv_name=r[idx["inverter_name"]], kw=r[idx["rated_power_kw"]], status=r[idx["inverter_status"]],
            used=r[idx["inputs_used"]], strings=strings)
    if isinstance(day, str):
        day = dt.date.fromisoformat(day[:10])
    elif isinstance(day, dt.datetime):
        day = day.date()
    if not day:
        m = re.search(r"(\d{4}-\d{2}-\d{2})", os.path.basename(path))
        day = dt.date.fromisoformat(m.group(1))
    return day, data


def evaluate(inv_master, rec):
    """คืนค่า (ผิดปกติ, รายการสตริงที่มีปัญหา, สถานะ, อาการ, issues[])"""
    n = inv_master.get("จำนวนสตริง") or 0
    sn = inv_master["Inverter S/N"]
    if rec is None:
        return n, "ทั้งหมด", "ไม่พบในข้อมูล", "ไม่มีข้อมูลจาก monitoring", [(sn, "-", "ไม่มีข้อมูลจาก Inverter", "-")]
    status = rec["status"] or "-"
    used = [s for s in rec["strings"] if s[1] in ("OK", "LOW")]
    if not used:
        return n, "ทั้งหมด", status, "ไม่มีข้อมูล (NO DATA)", [(sn, "-", "ไม่มีข้อมูลจาก Inverter", "-")]
    issues, bad, sym = [], [], []
    for num, st, a in used:
        if st == "LOW":
            bad.append(f"S{num}")
            issues.append((sn, f"S{num}", "กระแสสตริงต่ำ (LOW)", f"{a:.1f} A"))
    missing = max(0, n - len(used))
    if bad: sym.append(f"กระแสต่ำ {len(bad)} สตริง")
    if missing:
        sym.append(f"สตริงทำงานน้อยกว่าทะเบียน {missing} สตริง")
        issues.append((sn, f"ขาด {missing}", "สตริงไม่มีกระแส / น้อยกว่าทะเบียน", f"{len(used)}/{n}"))
    if status == "Fault":
        sym.append("Inverter Fault")
        issues.append((sn, "-", "Inverter Fault", "Fault"))
    abn = len(bad) + missing
    lst = ", ".join(bad + ([f"ขาด {missing}"] if missing else []))
    return abn, lst, status, " · ".join(sym), issues


# =====================================================================  PLANT monthly file
def plant_file(station, day):
    folder = os.path.join(ROOT, f"{day:%Y-%m}")
    os.makedirs(folder, exist_ok=True)
    name = f"{station['รหัส']}_{safe(station['ชื่อสถานี (ใช้ในรายงาน)'])}_{day:%Y-%m}.xlsx"
    return folder, name


def ensure_info_sheet(wb, station, invs):
    ws = wb["_ข้อมูลสถานี"] if "_ข้อมูลสถานี" in wb.sheetnames else wb.create_sheet("_ข้อมูลสถานี")
    ws.delete_rows(1, ws.max_row + 5)
    start = station.get("วันที่เริ่มให้บริการ")
    if isinstance(start, dt.datetime): start = start.date()
    rows = [("ชื่อสถานี", station["ชื่อสถานี (ใช้ในรายงาน)"]),
            ("กำลังติดตั้ง", f"{station['กำลังติดตั้ง (kWp)']:,.2f} kWp" if station.get("กำลังติดตั้ง (kWp)") else "-"),
            ("อายุสัญญา", station.get("อายุสัญญา") or "-"),
            ("วันที่เริ่มให้บริการ", th_date(start) if isinstance(start, dt.date) else (start or "-")),
            ("รหัส / ระยะ", f"{station['รหัส']}  ·  ระยะที่ {station['ระยะ']}  ·  {station.get('กปภ.สาขา') or ''}".strip(" ·")),
            ("ที่มา", "คัดลอกจาก 00_Overview_รายงานการแก้ไข.xlsx อัตโนมัติ — แก้ที่ไฟล์ Overview")]
    for r in rows: ws.append(r)
    ws.append([]); ws.append([]); ws.append([])
    ws.append(["NO.", "Inverter S/N", "จำนวนสตริง"])  # row 10
    for v in invs: ws.append([v["NO."], v["Inverter S/N"], v["จำนวนสตริง"]])
    ws.sheet_state = "hidden"
    return ws


SHORT_TYPE = {"กระแสสตริงต่ำ (LOW)": "กระแสต่ำ (LOW)",
              "สตริงไม่มีกระแส / น้อยกว่าทะเบียน": "สตริงไม่มีกระแส",
              "ไม่มีข้อมูลจาก Inverter": "ไม่มีข้อมูล Inverter"}


def th_short(d):
    """11/11/2569"""
    return f"{d.day:02d}/{d.month:02d}/{d.year + 543}"


def th_long(d):
    """11 พฤศจิกายน พ.ศ. 2569"""
    return f"{d.day} {TH_MONTH[d.month]} พ.ศ. {d.year + 543}"


def build_day_sheet(wb, day, station, invs, results, issue_rows, logo, time_txt):
    """หน้ารายงานประจำวัน – ทุกบล็อกชิดขอบ C ถึง M, A4 แนวนอน, ฟอนต์ 3 ระดับ (20 หนา / 16 หนา / 16)"""
    from openpyxl.worksheet.pagebreak import Break
    from openpyxl.cell.rich_text import CellRichText, TextBlock
    from openpyxl.cell.text import InlineFont
    title = f"วันที่ {day.day}"
    if title in wb.sheetnames:
        del wb[title]
    days = [s for s in wb.sheetnames if s.startswith("วันที่ ")]
    pos = 1 + sum(1 for s in days if int(s.split()[1]) < day.day)
    ws = wb.create_sheet(title, pos)
    ws.sheet_view.showGridLines = False
    ws.sheet_view.zoomScale = 90
    widths = {"A": 1, "B": 1, "C": 8, "D": 22, "E": 11, "F": 11, "G": 11, "H": 18,
              "I": 15, "J": 14, "K": 15, "L": 18, "M": 18, "N": 1}
    for k, w in widths.items(): ws.column_dimensions[k].width = w
    I = "'_ข้อมูลสถานี'!"
    CC = Alignment(horizontal="center", vertical="center", wrap_text=True)
    LL = Alignment(horizontal="left", vertical="center", wrap_text=True, indent=1)
    ROW = 24          # ความสูงแถวข้อมูลมาตรฐาน
    ROW2 = 42         # แถวที่ข้อความยาว 2 บรรทัด

    def h(r, v): ws.row_dimensions[r].height = v

    # ---------- ส่วนหัว
    h(1, 10); h(2, 27); h(3, 27); h(4, 26)
    for rr in (5, 6, 7): h(rr, 5)
    put(ws, "C2", "รายงานความพร้อมระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ประจำวัน", FT, CC, merge="C2:K3")
    put(ws, "C4", None, F, CC, merge="C4:K4")
    ws["C4"].value = CellRichText(
        TextBlock(InlineFont(rFont=FONT, sz=16), "สรุปผลความพร้อมระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ประจำวันที่  "),
        TextBlock(InlineFont(rFont=FONT, sz=16, b=True), th_long(day)))
    if logo and os.path.exists(logo):
        from openpyxl.drawing.spreadsheet_drawing import OneCellAnchor, AnchorMarker
        from openpyxl.drawing.xdr import XDRPositiveSize2D
        from openpyxl.utils.units import pixels_to_EMU
        img = XLImage(logo); w, hh = 100, 80
        img.anchor = OneCellAnchor(_from=AnchorMarker(col=11, colOff=pixels_to_EMU(60), row=1, rowOff=0),
                                   ext=XDRPositiveSize2D(pixels_to_EMU(w), pixels_to_EMU(hh)))
        ws.add_image(img)

    # ---------- ข้อมูลโครงการ (ป้าย C:D หนาพื้นเทา, ค่า E:M)
    info = [("ชื่อโครงการ", PROJECT, F), (None, OWNER, F), ("ชื่อสถานี", f"={I}B1", FB),
            ("อายุสัญญา", f"={I}B3", F), ("วันที่เริ่มให้บริการ", f"={I}B4", F), ("กำลังติดตั้ง", f"={I}B2", F)]
    for k, (lab, val, ft) in enumerate(info):
        r = 8 + k
        h(r, ROW)
        if lab == "ชื่อโครงการ":
            put(ws, f"C{r}", lab, FB, LL, GREY, merge=f"C{r}:D{r + 1}")
        elif lab:
            put(ws, f"C{r}", lab, FB, LL, GREY, merge=f"C{r}:D{r}")
        put(ws, f"E{r}", val, ft, LL, merge=f"E{r}:M{r}")
    box(ws, "C8:M13")
    h(14, 12)

    # ---------- ตาราง Inverter: หัว 2 ชั้น
    H = 15
    for colL, txt in [("C", "NO."), ("D", "Inverter S/N"), ("H", "สตริงที่มีปัญหา"),
                      ("I", "เวลาที่พบปัญหา"), ("J", "สถานะ Inverter"), ("K", "อาการ")]:
        rng = f"{colL}{H}:{'M' if colL == 'K' else colL}{H + 1}"
        put(ws, f"{colL}{H}", txt, FB, CC, BLUE, merge=rng)
    put(ws, f"E{H}", "จำนวนสตริง", FB, CC, BLUE, merge=f"E{H}:G{H}")
    for colL, txt in [("E", "ทั้งหมด"), ("F", "ปกติ"), ("G", "ผิดปกติ")]:
        put(ws, f"{colL}{H + 1}", txt, FB, CC, BLUE)
    for cl in "CDEFGHIJKLM":
        ws[f"{cl}{H}"].fill = BLUE; ws[f"{cl}{H + 1}"].fill = BLUE
    h(H, ROW); h(H + 1, ROW)
    r = H + 1
    for k, v in enumerate(invs):
        r = H + 2 + k
        abn, lst, status, sym, _ = results[v["Inverter S/N"]]
        row = 11 + k  # แถวใน _ข้อมูลสถานี
        put(ws, f"C{r}", f"={I}A{row}", F, CC)
        put(ws, f"D{r}", f"={I}B{row}", F, CC)
        put(ws, f"E{r}", f"={I}C{row}", F, CC)
        put(ws, f"F{r}", f"=E{r}-G{r}", F, CC)
        put(ws, f"G{r}", abn, FB if abn else F, CC, RED if abn else None)
        put(ws, f"H{r}", lst or "-", F, CC)
        put(ws, f"I{r}", time_txt if abn else "-", F, CC)
        put(ws, f"J{r}", status, F, CC, RED if status in ("Fault", "ไม่พบในข้อมูล") else None)
        put(ws, f"K{r}", sym or "ปกติ", F, LL, merge=f"K{r}:M{r}")
        h(r, ROW2 if len(sym) > 34 else ROW)
    tr = r + 1
    put(ws, f"C{tr}", "รวม", FB, CC, GREY, merge=f"C{tr}:D{tr}")
    for colL in "EFG":
        put(ws, f"{colL}{tr}", f"=SUM({colL}{H + 2}:{colL}{r})", FB, CC, GREY)
    put(ws, f"H{tr}", "ความพร้อม", FB, CC, GREY)
    put(ws, f"I{tr}", f"=IF(E{tr}=0,\"-\",F{tr}/E{tr})", FB, CC, GREY, fmt="0.00%")
    put(ws, f"J{tr}", None, F, CC, GREY)
    put(ws, f"K{tr}", None, F, LL, GREY, merge=f"K{tr}:M{tr}")
    h(tr, ROW)
    box(ws, f"C{H}:M{tr}")
    # ---- เซลล์ช่วย (คอลัมน์ P ซ่อน) ให้หน้า "สรุปเดือน" ดึงค่าอัตโนมัติ
    first = H + 2
    helpers = [1, len(issue_rows), f"=E{tr}", f"=F{tr}", f"=G{tr}",
               f'=COUNTIF(H{first}:H{max(r, first)},"ทั้งหมด")', f'=COUNTIF(J{first}:J{max(r, first)},"Fault")']
    for k, v in enumerate(helpers, 1):
        ws[f"P{k}"].value = v
    ws.column_dimensions["O"].width = 2
    ws.column_dimensions["P"].hidden = True
    ws[f"C{H + 1}"].border = Border(left=med, bottom=thin, right=thin)
    # สี % ความพร้อม
    ws.conditional_formatting.add(f"I{tr}", CellIsRule(operator="greaterThanOrEqual", formula=["0.98"], fill=GREEN))
    ws.conditional_formatting.add(f"I{tr}", CellIsRule(operator="between", formula=["0.95", "0.97999"], fill=YELLOW))
    ws.conditional_formatting.add(f"I{tr}", CellIsRule(operator="lessThan", formula=["0.95"], fill=RED))

    # ---------- รายงานการแก้ไข
    R0 = tr + 2
    h(tr + 1, 14)
    put(ws, f"C{R0}", "รายงานการแก้ไข", FB, LL, ORANGE, merge=f"C{R0}:M{R0}")
    h(R0, ROW)
    R = R0 + 1
    h2 = [("C", "ลำดับ"), ("D", "Inverter S/N"), ("E", "String"), ("F", "อาการ"), ("H", "ค่าที่อ่านได้"),
          ("I", "การแก้ไข"), ("K", "สถานะ"), ("L", "ผู้รับผิดชอบ"), ("M", "วันที่แก้ไขเสร็จ")]
    ws.merge_cells(f"F{R}:G{R}"); ws.merge_cells(f"I{R}:J{R}")
    for colL, t in h2:
        put(ws, f"{colL}{R}", t, FB, CC, BLUE)
    for cl in "GJ": ws[f"{cl}{R}"].fill = BLUE
    h(R, ROW)
    STATUS_FILL = {"รอดำเนินการ": RED, "กำลังแก้ไข": YELLOW, "แก้ไขแล้ว": GREEN, "ปิดงาน": GREY}
    end = R + 1
    if not issue_rows:
        put(ws, f"C{end}", "ไม่พบปัญหา – ระบบทำงานปกติ", F, CC, merge=f"C{end}:M{end}")
        h(end, ROW)
    for k, it in enumerate(issue_rows):
        end = R + 1 + k
        typ = SHORT_TYPE.get(it["ประเภทปัญหา"], it["ประเภทปัญหา"])
        d = it.get("วันที่แก้ไขเสร็จ")
        put(ws, f"C{end}", k + 1, F, CC)
        put(ws, f"D{end}", it["Inverter S/N"], F, CC)
        put(ws, f"E{end}", it["String"], F, CC)
        put(ws, f"F{end}", typ, F, LL, merge=f"F{end}:G{end}")
        put(ws, f"H{end}", it["ค่าที่อ่านได้"], F, CC)
        put(ws, f"I{end}", it.get("การแก้ไข / หมายเหตุ"), F, LL, merge=f"I{end}:J{end}")
        put(ws, f"K{end}", it.get("สถานะ"), F, CC, STATUS_FILL.get(it.get("สถานะ")))
        put(ws, f"L{end}", it.get("ผู้รับผิดชอบ"), F, CC)
        put(ws, f"M{end}", th_short(d) if isinstance(d, (dt.date, dt.datetime)) else d, F, CC)
        h(end, ROW2 if len(typ) > 20 or len(str(it.get("การแก้ไข / หมายเหตุ") or "")) > 30 else ROW)
    box(ws, f"C{R0}:M{end}")

    # ---------- ลงนาม
    S = end + 3
    h(end + 1, 12); h(end + 2, 12)
    for k, (a, b) in enumerate([("C", "G"), ("I", "M")]):
        lab = "ผู้จัดทำรายงาน" if k == 0 else "ผู้ตรวจสอบ"
        put(ws, f"{a}{S}", "ลงชื่อ ...................................................", F, CC, merge=f"{a}{S}:{b}{S}")
        put(ws, f"{a}{S + 1}", "(...................................................)", F, CC, merge=f"{a}{S + 1}:{b}{S + 1}")
        put(ws, f"{a}{S + 2}", lab, FB, CC, merge=f"{a}{S + 2}:{b}{S + 2}")
        put(ws, f"{a}{S + 3}", "วันที่ ......../......../........", F, CC, merge=f"{a}{S + 3}:{b}{S + 3}")
    for rr in range(S, S + 4): h(rr, ROW)

    # ---------- ตัดหน้า: ไม่ให้หัวตารางค้างท้ายหน้า / ลายเซ็นไม่แยกหน้า
    total_w = sum(widths.values()) * 7.0 * 0.75          # pt โดยประมาณ
    scale = min(1.0, (11.69 - 0.8) * 72 / total_w)
    page_h = (8.27 - 1.0) * 72 / scale - 10              # ความสูงแถวที่ลงได้ต่อหน้า (pt)
    rh = lambda a, b: sum(ws.row_dimensions[x].height or 15 for x in range(a, b + 1))
    used = rh(1, R0 - 1)
    sec = rh(R0, end)
    one_page = rh(1, S + 3) <= page_h * 1.15          # เกินนิดเดียว → ย่อให้พอดี 1 หน้า ไม่ตัดหน้า
    if one_page:
        pass
    elif used + rh(R0, min(end, R + 2)) > page_h:          # หัวรายงานการแก้ไข + 2 แถวแรกไม่พอ → ขึ้นหน้าใหม่
        ws.row_breaks.append(Break(id=R0 - 1)); used = 0
    used = (used + sec) % page_h if used + sec > page_h else used + sec
    if not one_page and used + rh(end + 1, S + 3) > page_h:
        ws.row_breaks.append(Break(id=end + 1))

    # ---------- ตั้งค่าการพิมพ์
    ws.page_setup.orientation = "landscape"; ws.page_setup.paperSize = 9
    ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 1 if one_page else 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_options.horizontalCentered = True
    ws.page_margins.left = ws.page_margins.right = 0.4
    ws.page_margins.top = 0.4; ws.page_margins.bottom = 0.6
    ws.page_margins.header = 0.2; ws.page_margins.footer = 0.3
    ws.oddFooter.left.text = "&\"TH SarabunPSK,Regular\"&14" + station["รหัส"] + "  " + station["ชื่อสถานี (ใช้ในรายงาน)"]
    ws.oddFooter.right.text = "&\"TH SarabunPSK,Regular\"&14หน้า &P / &N"
    ws.print_area = f"B1:N{S + 4}"
    return ws


def build_blank_day(wb, day, station, invs, logo=None):
    """หน้าวันที่ล่วงหน้า: หัว/ข้อมูลสถานี/Inverter S/N/จำนวนสตริง ครบ – ช่องผลตรวจยังว่าง (เติมเมื่อรันรายงานวันนั้น)"""
    logo = logo or LOGO
    results = {v["Inverter S/N"]: (None, "", "", "", []) for v in invs}
    ws = build_day_sheet(wb, day, station, invs, results, [], logo, "")
    H = 15
    last = H + 1 + len(invs)
    for r in range(H + 2, last + 1):
        for colL in "FGHIJK":
            ws[f"{colL}{r}"].value = None
    tr = last + 1
    ws[f"I{tr}"].value = f'=IF(SUM(G{H + 2}:G{last})+SUM(F{H + 2}:F{last})=0,"-",F{tr}/E{tr})'
    R0 = tr + 2
    ws[f"C{R0 + 2}"].value = "ยังไม่ได้ประมวลผลข้อมูลวันนี้"
    ws["P1"].value = 0; ws["P2"].value = 0
    return ws


def dedupe_media(path):
    """openpyxl ฝังโลโก้ซ้ำทุกหน้า → ให้ทุกหน้าใช้ไฟล์รูปเดียวกัน (ไฟล์เล็กลงมาก)"""
    import zipfile, hashlib, shutil, tempfile
    zin = zipfile.ZipFile(path)
    names = zin.namelist()
    media = [n for n in names if n.startswith("xl/media/")]
    if len(media) < 2:
        zin.close(); return
    first, rename = {}, {}
    for n in media:
        h = hashlib.md5(zin.read(n)).hexdigest()
        if h in first: rename[n] = first[h]
        else: first[h] = n
    if not rename:
        zin.close(); return
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx").name
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for n in names:
            if n in rename: continue
            data = zin.read(n)
            if n.startswith("xl/drawings/_rels/"):
                t = data.decode("utf-8")
                for old, new in rename.items():
                    t = t.replace("/" + old[3:], "/" + new[3:]).replace('"../' + old[3:], '"../' + new[3:])
                data = t.encode("utf-8")
            zout.writestr(zin.getinfo(n), data)
    zin.close()
    shutil.move(tmp, path)


MONTH_COLS = ["วันที่", "สตริงทั้งหมด", "ปกติ", "ผิดปกติ", "ความพร้อม", "Inverter ไม่มีข้อมูล", "Inverter Fault", "จำนวนปัญหา", "หน้า"]


def build_month_sheet(wb, station, day):
    ws = wb["สรุปเดือน"] if "สรุปเดือน" in wb.sheetnames else wb.create_sheet("สรุปเดือน", 0)
    if ws["A1"].value is None:
        ws.sheet_view.showGridLines = False
        put(ws, "A1", f"สรุปความพร้อมระบบรายเดือน – {TH_MONTH[day.month]} {day.year + 543}", FT, merge="A1:I1")
        put(ws, "A2", "='_ข้อมูลสถานี'!B1", FB, merge="A2:I2")
        ws.merge_cells("A3:I3")
        for j, h in enumerate(MONTH_COLS, 1):
            c = ws.cell(5, j, h); c.font, c.fill, c.alignment, c.border = FB, BLUE, C, BOX
        nd = (dt.date(day.year + (day.month == 12), day.month % 12 + 1, 1) - dt.timedelta(days=1)).day
        for d in range(1, nd + 1):
            r = 5 + d
            ws.cell(r, 1, dt.datetime(day.year, day.month, d)).number_format = TH_DATE
            ws.cell(r, 5).number_format = "0.00%"
            for j in range(1, 10):
                ws.cell(r, j).font, ws.cell(r, j).border, ws.cell(r, j).alignment = F, BOX, C
        tr = 6 + nd
        put(ws, f"A{tr}", "รวม/เฉลี่ย", FB, C, GREY)
        for colL in "BCD":
            put(ws, f"{colL}{tr}", f"=SUM({colL}6:{colL}{tr - 1})", FB, C, GREY)
        put(ws, f"E{tr}", f"=IF(B{tr}=0,\"-\",C{tr}/B{tr})", FB, C, GREY, fmt="0.00%")
        for colL in "FGH":
            put(ws, f"{colL}{tr}", f"=SUM({colL}6:{colL}{tr - 1})", FB, C, GREY)
        put(ws, f"I{tr}", None, FB, C, GREY)
        box(ws, f"A5:I{tr}")
        for j, w in enumerate([17, 13, 10, 10, 12, 14, 12, 12, 10], 1):
            ws.column_dimensions[get_column_letter(j)].width = w
        ws.freeze_panes = "A6"
        ws.page_setup.paperSize = 9; ws.page_setup.fitToWidth = 1; ws.page_setup.fitToHeight = 1
        ws.sheet_properties.pageSetUpPr.fitToPage = True
    nd = (dt.date(day.year + (day.month == 12), day.month % 12 + 1, 1) - dt.timedelta(days=1)).day
    for d in range(1, nd + 1):   # วันที่แบบ พ.ศ. + สูตรดึงจากหน้าวันที่ (ว่างถ้ายังไม่ประมวลผล)
        r = 5 + d
        ws.cell(r, 1).value = th_short(dt.date(day.year, day.month, d))
        q = f"'วันที่ {d}'!"
        ok = f"IFERROR({q}$P$1,0)=1"
        f = {2: f"{q}$P$3", 3: f"{q}$P$4", 4: f"{q}$P$5", 6: f"{q}$P$6", 7: f"{q}$P$7", 8: f"{q}$P$2"}
        for j, ref in f.items():
            ws.cell(r, j).value = f'=IF({ok},{ref},"")'
        ws.cell(r, 5).value = f'=IF(AND({ok},N(B{r})>0),C{r}/B{r},"")'
        ws.cell(r, 5).number_format = "0.00%"
    last = 5 + nd
    if not len(list(ws.conditional_formatting)):
        ws.conditional_formatting.add(f"D6:D{last}", CellIsRule(operator="greaterThan", formula=["0"], fill=RED))
        ws.conditional_formatting.add(f"E6:E{last}", FormulaRule(formula=[f'AND(E6<>"",E6>=0.98)'], fill=GREEN))
        ws.conditional_formatting.add(f"E6:E{last}", FormulaRule(formula=[f'AND(E6<>"",E6<0.95)'], fill=RED))
    tr = last + 1
    ws[f"E{tr}"].value = f'=IF(N(B{tr})=0,"-",C{tr}/B{tr})'
    ws[f"B{tr}"].value = f'=SUM(B6:B{last})'
    ws[f"H{tr}"].value = f'=SUM(H6:H{last})'
    ws[f"F{tr}"].value = f'=SUM(F6:F{last})'
    ws[f"G{tr}"].value = f'=SUM(G6:G{last})'
    ws["A3"].value = "='_ข้อมูลสถานี'!B2"
    ws["A3"].font = F
    return ws


# =====================================================================  MAIN daily processing
def process(path, logo=LOGO):
    day, data = parse_input(path)
    print(f"→ {os.path.basename(path)}  วันที่ {day}  ({len(data)} inverters)")
    wb, st, inv, iss, daily, done = load_overview()
    pid2code = {}
    for s in st:
        for pid in str(s.get("Plant ID (monitoring)") or "").replace(" ", "").split(","):
            if pid: pid2code[pid] = s["รหัส"]
    # new inverters seen in input but not in master → add (ใช้งาน=Y)
    known = {v["Inverter S/N"] for v in inv}
    for sn, rec in sorted(data.items(), key=lambda x: (x[1]["plant_id"], natkey(x[1]["inv_name"]))):
        if sn not in known and rec["plant_id"] in pid2code:
            code = pid2code[rec["plant_id"]]
            sname = next(s["ชื่อสถานี (ใช้ในรายงาน)"] for s in st if s["รหัส"] == code)
            old = "old" in str(rec["inv_name"]).lower()
            nos = [v["NO."] or 0 for v in inv if v["รหัส"] == code]
            inv.append({"รหัส": code, "สถานี": sname, "NO.": None if old else max(nos or [0]) + 1, "Inverter S/N": sn,
                        "ชื่อในระบบ monitoring": rec["inv_name"], "พิกัด (kW)": rec["kw"],
                        "จำนวนสตริง": rec["used"], "ใช้งาน (Y/N)": "N" if "old" in str(rec["inv_name"]).lower() else "Y",
                        "หมายเหตุ": f"เพิ่มอัตโนมัติ {day:%d/%m/%Y} – ตรวจสอบ NO./จำนวนสตริง"})
    by_code = defaultdict(list)
    for v in inv:
        if str(v.get("ใช้งาน (Y/N)") or "Y").upper() != "N":
            by_code[v["รหัส"]].append(v)
    # ---- Google Sheets: ดึงค่าที่ผู้ทำรายงานกรอก (ช่องสีเหลือง) กลับมาก่อน
    gs = None
    if GS.enabled():
        gs = GS.Sync()
        months = {f"{day:%Y-%m}", f"{(day.replace(day=1) - dt.timedelta(days=1)):%Y-%m}"}
        by_key = {r["รหัสปัญหา"]: r for r in iss}
        pulled = 0
        for m in months:
            for code, ssid in list(gs.ids.get(m, {}).items()):
                if code.startswith("_"): continue
                try:
                    fills = gs.read_fills(ssid)
                except Exception as e:
                    print(f"   ! อ่าน Google Sheet {code} ไม่ได้: {e}"); continue
                for key, f in fills.items():
                    it = by_key.get(key)
                    if not it: continue
                    for src, dst in (("status", "สถานะ"), ("owner", "ผู้รับผิดชอบ"), ("fix", "การแก้ไข / หมายเหตุ"),
                                     ("done", "วันที่แก้ไขเสร็จ"), ("check", "ผลการตรวจสอบ")):
                        if f.get(src) not in (None, ""):
                            it[dst] = f[src]
                    pulled += 1
        print(f"   ดึงผลจาก Google Sheets {pulled} รายการ")
    open_by_key = {r["รหัสปัญหา"]: r for r in iss if r.get("สถานะ") not in CLOSED}
    seen_keys, new_count = set(), 0
    payloads = []
    tot = ok = bad = 0
    stations_with_issue = 0
    time_txt = f"{day.day:02d}/{day.month:02d}/{day.year + 543}"
    for s in st:
        code = s["รหัส"]
        invs = sorted(by_code.get(code, []), key=lambda v: (v["NO."] is None, v["NO."] or 0))
        folder, fname = plant_file(s, day)
        fpath = os.path.join(folder, fname)
        rel = f"{day:%Y-%m}/{fname}"
        s["ไฟล์รายงาน"] = rel
        s["จำนวน Inverter"] = len(invs)
        s["จำนวนสตริงรวม"] = sum(v["จำนวนสตริง"] or 0 for v in invs)
        results, day_issues = {}, []
        for v in invs:
            res = evaluate(v, data.get(v["Inverter S/N"]))
            results[v["Inverter S/N"]] = res
            for sn, strg, typ, val in res[4]:
                key = f"{code}|{sn}|{strg if not strg.startswith('ขาด') else 'ขาด'}|{typ}"
                seen_keys.add(key)
                link = f"{rel}#'วันที่ {day.day}'!A1"
                if key in open_by_key:
                    it = open_by_key[key]
                    last = it.get("พบล่าสุด")
                    if not isinstance(last, dt.datetime) or last.date() <= day:
                        it["พบล่าสุด"] = dt.datetime(day.year, day.month, day.day)
                        it["ค่าที่อ่านได้"] = val; it["String"] = strg
                        it["ผลตรวจล่าสุด"] = f"ยังพบ ({day:%d/%m})"
                        it["_link"] = link
                else:
                    new_count += 1
                    it = {"รหัสปัญหา": key, "วันที่พบ": dt.datetime(day.year, day.month, day.day),
                          "พบล่าสุด": dt.datetime(day.year, day.month, day.day), "ระยะ": s["ระยะ"], "รหัส": code,
                          "สถานี": s["ชื่อสถานี (ใช้ในรายงาน)"], "Inverter S/N": sn, "String": strg,
                          "ประเภทปัญหา": typ, "ค่าที่อ่านได้": val, "ผลตรวจล่าสุด": f"พบใหม่ ({day:%d/%m})",
                          "สถานะ": STATUSES[0], "_link": link}
                    iss.append(it); open_by_key[key] = it
                day_issues.append(it)
        # monthly workbook
        if os.path.exists(fpath):
            pwb = openpyxl.load_workbook(fpath)
        else:
            pwb = openpyxl.Workbook(); pwb.remove(pwb.active)
        ensure_info_sheet(pwb, s, invs)
        ms = build_month_sheet(pwb, s, day)
        build_day_sheet(pwb, day, s, invs, results, day_issues, logo, time_txt)
        n = sum(v["จำนวนสตริง"] or 0 for v in invs)
        b = sum(min(results[v["Inverter S/N"]][0], v["จำนวนสตริง"] or 0) for v in invs)
        r = 5 + day.day
        ms.cell(r, 9, "เปิด").hyperlink = f"#'วันที่ {day.day}'!A1"      # ค่าในสรุปเดือนเป็นสูตรดึงจากหน้าวันที่
        ms.cell(r, 9).font = Font(name=FONT, size=16, color="0563C1", underline="single")
        # keep sheet order: สรุปเดือน first, _ข้อมูลสถานี last
        pwb.move_sheet("สรุปเดือน", -pwb.sheetnames.index("สรุปเดือน"))
        pwb.move_sheet("_ข้อมูลสถานี", len(pwb.sheetnames) - 1 - pwb.sheetnames.index("_ข้อมูลสถานี"))
        pwb.active = pwb.sheetnames.index(f"วันที่ {day.day}")
        for w in pwb.worksheets: w.sheet_view.tabSelected = (w.title == f"วันที่ {day.day}")
        pwb.save(fpath)
        dedupe_media(fpath)
        tot += n; ok += n - b; bad += b
        stations_with_issue += bool(day_issues)
        if gs:
            payloads.append((s, [dict(sn=v["Inverter S/N"], n=v["จำนวนสตริง"] or 0, bad=results[v["Inverter S/N"]][0],
                                      lst=results[v["Inverter S/N"]][1], status=results[v["Inverter S/N"]][2],
                                      sym=results[v["Inverter S/N"]][3]) for v in invs], day_issues))
    # issues not seen today
    for key, it in open_by_key.items():
        if key not in seen_keys and it.get("พบล่าสุด") and it["พบล่าสุด"].date() < day:
            it["ผลตรวจล่าสุด"] = f"ไม่พบแล้ว ({day:%d/%m}) – รอยืนยันปิดงาน"
    daily = [d for d in daily if not (isinstance(d["วันที่"], dt.datetime) and d["วันที่"].date() == day)]
    daily.append({"วันที่": dt.datetime(day.year, day.month, day.day), "สถานีที่มีข้อมูล": len({pid2code.get(v["plant_id"]) for v in data.values()} - {None}),
                  "สตริงทั้งหมด": tot, "สตริงปกติ": ok, "สตริงผิดปกติ": bad,
                  "ความพร้อม (%)": round(ok / tot * 100, 2) if tot else None, "สถานีที่มีปัญหา": stations_with_issue,
                  "ปัญหาใหม่": new_count, "ปัญหาเปิดอยู่": sum(1 for r in iss if r.get("สถานะ") not in CLOSED)})
    daily.sort(key=lambda d: d["วันที่"])
    base = os.path.basename(path)
    if base not in done: done.append(base)
    asof = max(d["วันที่"] for d in daily).date()
    # ---- Google Sheets: สร้างหน้า "วันที่ D" ของทุกสถานี + ลิงก์กลับเข้า Overview
    if gs:
        month = f"{day:%Y-%m}"
        print(f"   ส่งขึ้น Google Sheets {len(payloads)} สถานี ...")
        for k, (s, inv_rows, day_issues) in enumerate(payloads, 1):
            code = s["รหัส"]
            start = s.get("วันที่เริ่มให้บริการ")
            if isinstance(start, dt.datetime): start = start.date()
            head = {"name": s["ชื่อสถานี (ใช้ในรายงาน)"], "contract": s.get("อายุสัญญา") or "-",
                    "start": th_date(start) if isinstance(start, dt.date) else (start or "-"),
                    "kwp": f"{s['กำลังติดตั้ง (kWp)']:,.2f} kWp" if s.get("กำลังติดตั้ง (kWp)") else "-",
                    "date_long": th_long(day)}
            rows = [dict(sn=it["Inverter S/N"], str=it["String"], typ=SHORT_TYPE.get(it["ประเภทปัญหา"], it["ประเภทปัญหา"]),
                         val=it["ค่าที่อ่านได้"], key=it["รหัสปัญหา"], check=it.get("ผลการตรวจสอบ"),
                         fix=it.get("การแก้ไข / หมายเหตุ"), status=it.get("สถานะ"), owner=it.get("ผู้รับผิดชอบ"),
                         done=it.get("วันที่แก้ไขเสร็จ")) for it in day_issues]
            try:
                ssid = gs.station_sheet(month, code, f"{code}_{safe(head['name'])}_{month}")
                gid = gs.write_day(ssid, day, head, inv_rows, rows, time_txt)
            except Exception as e:
                print(f"   ! {code} ส่งไม่สำเร็จ: {e}"); continue
            s["ไฟล์รายงาน"] = gs.url(ssid)
            for it in day_issues:
                it["_link"] = gs.url(ssid, gid)
            if k % 25 == 0: print(f"     {k}/{len(payloads)}")
        gs.save()
    # restore hyperlinks for existing rows that kept old link
    for r in iss:
        if not r.get("_link") and r.get("พบล่าสุด"):
            pd_ = r["พบล่าสุด"]
            s = next((x for x in st if x["รหัส"] == r["รหัส"]), None)
            if s:
                r["_link"] = f"{pd_:%Y-%m}/{s['รหัส']}_{safe(s['ชื่อสถานี (ใช้ในรายงาน)'])}.xlsx#'วันที่ {pd_.day}'!A1"
    save_overview(wb, st, inv, iss, daily, done, asof)
    if gs:
        try:
            gs.upload_overview(OVERVIEW)
        except Exception as e:
            print(f"   ! อัปโหลด Overview ไม่สำเร็จ: {e}")
    print(f"   สตริง {tot:,} | ปกติ {ok:,} | ผิดปกติ {bad:,} | ความพร้อม {ok / tot * 100:.2f}% | ปัญหาใหม่ {new_count} | สถานีมีปัญหา {stations_with_issue}")


def main():
    args = sys.argv[1:]
    if args:
        files = args
    else:
        _, _, _, _, _, done = load_overview()
        files = sorted(f for f in glob.glob(os.path.join(INPUT_DIR, "*.xlsx"))
                       if not os.path.basename(f).startswith("~$") and os.path.basename(f) not in done)
        if not files:
            print("ไม่มีไฟล์ใหม่ใน _Input"); return
    for f in files:
        process(f)


if __name__ == "__main__":
    main()
