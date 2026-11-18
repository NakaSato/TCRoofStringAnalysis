"""สร้าง batch requests (Google Sheets API) ของหน้า 'วันที่ X' 1 สถานี
ใช้ได้ทั้งกับ Claude connector และ Google Sheets API (spreadsheets.batchUpdate) โดยตรง"""
import json

def rgb(h): return {"rgbColor": {"red": int(h[0:2], 16) / 255, "green": int(h[2:4], 16) / 255, "blue": int(h[4:6], 16) / 255}}
BLUE, GREY, ORANGE, RED, YEL, GRN, FILL, FILLH = 'B4C6E7', 'EDEDED', 'F7CAAC', 'F8CBAD', 'FFEB9C', 'C6EFCE', 'FFF9E5', 'FFD966'
FONT = 'Sarabun'
STATUSES = ["รอดำเนินการ", "กำลังแก้ไข", "แก้ไขแล้ว", "ปิดงาน"]
CHECKS = ["ยืนยันมีปัญหา", "ปกติ (แจ้งเตือนผิด)", "เงา/เมฆ/สภาพอากาศ", "รอเข้าพื้นที่"]


def build(sid, title, st, invs, issues, time_txt, new_sheet=True, index=0):
    R = []
    rng = lambda r0, r1, c0, c1: {"sheetId": sid, "startRowIndex": r0, "endRowIndex": r1, "startColumnIndex": c0, "endColumnIndex": c1}

    def val(v):
        if v is None: return {}
        if isinstance(v, str) and v.startswith('='): return {"userEnteredValue": {"formulaValue": v}}
        if isinstance(v, (int, float)): return {"userEnteredValue": {"numberValue": v}}
        if hasattr(v, 'toordinal'):  # date → serial number (แสดงเป็น dd/mm/yyyy)
            return {"userEnteredValue": {"numberValue": v.toordinal() - 693594}}
        return {"userEnteredValue": {"stringValue": v}}

    def put(r, c, vals):
        R.append({"updateCells": {"start": {"sheetId": sid, "rowIndex": r, "columnIndex": c},
                                  "rows": [{"values": [val(v) for v in vals]}], "fields": "userEnteredValue"}})

    def fmt(r0, r1, c0, c1, bold=None, size=None, bg=None, h=None, num=None):
        uf, fl = {}, []
        if bold is not None or size is not None:
            uf["textFormat"] = {}
            if bold is not None: uf["textFormat"]["bold"] = bold; fl.append("userEnteredFormat.textFormat.bold")
            if size is not None: uf["textFormat"]["fontSize"] = size; fl.append("userEnteredFormat.textFormat.fontSize")
        if bg: uf["backgroundColorStyle"] = rgb(bg); fl.append("userEnteredFormat.backgroundColorStyle")
        if h: uf["horizontalAlignment"] = h; fl.append("userEnteredFormat.horizontalAlignment")
        if num: uf["numberFormat"] = num; fl.append("userEnteredFormat.numberFormat")
        R.append({"repeatCell": {"range": rng(r0, r1, c0, c1), "cell": {"userEnteredFormat": uf}, "fields": ",".join(fl)}})

    def merge(r0, r1, c0, c1): R.append({"mergeCells": {"range": rng(r0, r1, c0, c1), "mergeType": "MERGE_ALL"}})

    def border(r0, r1, c0, c1):
        m, t = {"style": "SOLID_MEDIUM"}, {"style": "SOLID"}
        R.append({"updateBorders": {"range": rng(r0, r1, c0, c1), "top": m, "bottom": m, "left": m, "right": m,
                                    "innerHorizontal": t, "innerVertical": t}})

    def cf(r0, r1, c0, c1, ctype, values, color):
        R.append({"addConditionalFormatRule": {"rule": {"ranges": [rng(r0, r1, c0, c1)], "booleanRule": {
            "condition": {"type": ctype, "values": [{"userEnteredValue": v} for v in values]},
            "format": {"backgroundColorStyle": rgb(color)}}}}})

    props = {"sheetId": sid, "title": title, "index": index,
             "gridProperties": {"rowCount": 60, "columnCount": 14, "hideGridlines": True}}
    if new_sheet:
        R.append({"addSheet": {"properties": props}})
    else:
        R.append({"updateSheetProperties": {"properties": props,
                                            "fields": "title,index,gridProperties.rowCount,gridProperties.columnCount,gridProperties.hideGridlines"}})
    # ค่าเริ่มต้นทั้งหน้า: Sarabun 14, กึ่งกลาง, ตัดบรรทัด
    R.append({"repeatCell": {"range": rng(0, 60, 0, 14), "cell": {"userEnteredFormat": {
        "textFormat": {"fontFamily": FONT, "fontSize": 14}, "horizontalAlignment": "CENTER",
        "verticalAlignment": "MIDDLE", "wrapStrategy": "WRAP"}},
        "fields": "userEnteredFormat.textFormat,userEnteredFormat.horizontalAlignment,userEnteredFormat.verticalAlignment,userEnteredFormat.wrapStrategy"}})
    for c0, c1, px in [(0, 2, 12), (2, 3, 60), (3, 4, 150), (4, 7, 80), (7, 8, 130), (8, 9, 150), (9, 10, 190),
                       (10, 11, 115), (11, 12, 120), (12, 13, 125), (13, 14, 12)]:
        R.append({"updateDimensionProperties": {"range": {"sheetId": sid, "dimension": "COLUMNS", "startIndex": c0, "endIndex": c1},
                                                "properties": {"pixelSize": px}, "fields": "pixelSize"}})
    R.append({"updateDimensionProperties": {"range": {"sheetId": sid, "dimension": "COLUMNS", "startIndex": 13, "endIndex": 14},
                                            "properties": {"hiddenByUser": True}, "fields": "hiddenByUser"}})  # คอลัมน์ N = รหัสปัญหา (ใช้จับคู่)
    R.append({"updateDimensionProperties": {"range": {"sheetId": sid, "dimension": "ROWS", "startIndex": 0, "endIndex": 60},
                                            "properties": {"pixelSize": 28}, "fields": "pixelSize"}})

    # ---- หัวรายงาน
    put(1, 2, ["รายงานความพร้อมระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ประจำวัน"]); merge(1, 3, 2, 13); fmt(1, 2, 2, 3, bold=True, size=20)
    put(3, 2, [f"สรุปผลความพร้อมระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ประจำวันที่  {st['date_long']}"]); merge(3, 4, 2, 13); fmt(3, 4, 2, 3, bold=True, size=15)

    # ---- ข้อมูลโครงการ
    labels = ["ชื่อโครงการ", None, "ชื่อสถานี", "อายุสัญญา", "วันที่เริ่มให้บริการ", "กำลังติดตั้ง"]
    values = ["โครงการจัดการพลังงานไฟฟ้าจากระบบผลิตไฟฟ้าพลังงานแสงอาทิตย์ที่ติดตั้งบนหลังคา (Solar Rooftop)",
              "การประปาส่วนภูมิภาค", st['name'], st['contract'], st['start'], st['kwp']]
    for k in range(6):
        r = 5 + k
        put(r, 2, [labels[k], None, values[k]]); merge(r, r + 1, 4, 13)
    merge(5, 7, 2, 4)
    for r in range(7, 11): merge(r, r + 1, 2, 4)
    fmt(5, 11, 2, 4, bold=True, bg=GREY, h="LEFT"); fmt(5, 11, 4, 13, h="LEFT"); fmt(7, 8, 4, 5, bold=True)
    border(5, 11, 2, 13)

    # ---- ตาราง Inverter (หัว 2 ชั้น)
    H = 12
    put(H, 2, ["NO.", "Inverter S/N", "จำนวนสตริง", None, None, "สตริงที่มีปัญหา", "เวลาที่พบปัญหา", "สถานะ Inverter", "อาการ"])
    put(H + 1, 4, ["ทั้งหมด", "ปกติ", "ผิดปกติ"])
    for c in (2, 3, 7, 8, 9): merge(H, H + 2, c, c + 1)
    merge(H, H + 2, 10, 13); merge(H, H + 1, 4, 7)
    fmt(H, H + 2, 2, 13, bold=True, bg=BLUE)
    r0 = H + 2
    for k, v in enumerate(invs):
        r, rr = r0 + k, r0 + k + 1
        put(r, 2, [k + 1, v['sn'], v['n'], f"=E{rr}-G{rr}", v['bad'], v['lst'] or "-",
                   time_txt if v['bad'] else "-", v['status'], v['sym'] or "ปกติ"])
        merge(r, r + 1, 10, 13)
        if v['bad']: fmt(r, r + 1, 6, 7, bold=True, bg=RED)
        if v['status'] in ('Fault', 'ไม่พบในข้อมูล'): fmt(r, r + 1, 9, 10, bg=RED)
    fmt(r0, r0 + len(invs), 10, 11, size=13, h="LEFT")
    tr, t1 = r0 + len(invs), r0 + len(invs) + 1
    put(tr, 2, ["รวม", None] + [f"=SUM({c}{r0 + 1}:{c}{tr})" for c in "EFG"] + ["ความพร้อม", f'=IF(E{t1}=0,"-",F{t1}/E{t1})'])
    merge(tr, tr + 1, 2, 4); merge(tr, tr + 1, 10, 13)
    fmt(tr, tr + 1, 2, 13, bold=True, bg=GREY); fmt(tr, tr + 1, 8, 9, num={"type": "PERCENT", "pattern": "0.00%"})
    border(H, tr + 1, 2, 13)
    cf(tr, tr + 1, 8, 9, "NUMBER_GREATER_THAN_EQ", ["0.98"], GRN)
    cf(tr, tr + 1, 8, 9, "NUMBER_BETWEEN", ["0.95", "0.97999"], YEL)
    cf(tr, tr + 1, 8, 9, "NUMBER_LESS", ["0.95"], RED)

    # ---- รายงานการแก้ไข (ผู้ทำรายงานกรอกเฉพาะช่องสีเหลือง)
    S = tr + 2
    put(S, 2, ["รายงานการแก้ไข   (ผู้ทำรายงานกรอกเฉพาะช่องสีเหลือง)"]); merge(S, S + 1, 2, 13)
    fmt(S, S + 1, 2, 13, bold=True, size=15, bg=ORANGE, h="LEFT")
    hh = S + 1
    put(hh, 2, ["ลำดับ", "Inverter S/N", "String", "อาการ", None, "ค่าที่อ่านได้", "ผลการตรวจสอบ", "การแก้ไข", "สถานะ", "ผู้รับผิดชอบ", "วันที่แก้ไขเสร็จ"])
    merge(hh, hh + 1, 5, 7)
    fmt(hh, hh + 1, 2, 8, bold=True, bg=BLUE); fmt(hh, hh + 1, 8, 13, bold=True, bg=FILLH)
    first = hh + 1
    if not issues:
        put(first, 2, ["ไม่พบปัญหา – ระบบทำงานปกติ"]); merge(first, first + 1, 2, 13); last = first
    else:
        for k, it in enumerate(issues):
            r = first + k
            put(r, 2, [k + 1, it['sn'], it['str'], it['typ'], None, it['val'], it.get('check'), it.get('fix'),
                       it.get('status') or STATUSES[0], it.get('owner'), it.get('done'), it.get('key')])
            merge(r, r + 1, 5, 7)
        last = first + len(issues) - 1
        fmt(first, last + 1, 5, 6, size=13, h="LEFT")
        fmt(first, last + 1, 8, 13, size=13, bg=FILL); fmt(first, last + 1, 9, 10, h="LEFT")
        fmt(first, last + 1, 12, 13, num={"type": "DATE", "pattern": "dd/mm/yyyy"})
        for c, lst in [(8, CHECKS), (10, STATUSES)]:
            R.append({"setDataValidation": {"range": rng(first, last + 1, c, c + 1), "rule": {
                "condition": {"type": "ONE_OF_LIST", "values": [{"userEnteredValue": v} for v in lst]},
                "strict": True, "showCustomUi": True}}})
        R.append({"setDataValidation": {"range": rng(first, last + 1, 12, 13),
                                        "rule": {"condition": {"type": "DATE_IS_VALID"}, "strict": True}}})
        for v, c in zip(STATUSES, (RED, YEL, GRN, GREY)):
            cf(first, last + 1, 10, 11, "TEXT_EQ", [v], c)
    border(S, last + 1, 2, 13)

    # ---- ป้องกันทั้งหน้า ยกเว้นช่องกรอก (เตือนอย่างเดียว)
    R.append({"addProtectedRange": {"protectedRange": {
        "range": {"sheetId": sid}, "unprotectedRanges": [rng(first, last + 1, 8, 13)] if issues else [],
        "description": "ข้อมูลจากระบบ – กรอกเฉพาะช่องสีเหลือง", "warningOnly": True}}})

    # ---- ลงนาม
    G = last + 3
    for c0, c1, lab in [(2, 7, "ผู้จัดทำรายงาน"), (8, 13, "ผู้ตรวจสอบ")]:
        for k, t in enumerate(["ลงชื่อ ..............................................",
                               "(..............................................)", lab, "วันที่ ......../......../........"]):
            put(G + k, c0, [t]); merge(G + k, G + k + 1, c0, c1)
        fmt(G + 2, G + 3, c0, c0 + 1, bold=True)
    return R


if __name__ == "__main__":
    st = {"name": "สถานีผลิตน้ำบางวาด", "contract": "20 ปี ( 240 เดือน )", "start": "01 เมษายน พ.ศ.2568",
          "kwp": "349.98 kWp", "date_long": "11 พฤศจิกายน พ.ศ. 2569"}
    invs = [dict(sn="EPHNEYN013", n=10, bad=0, lst="", status="Normal", sym=""),
            dict(sn="EPHNEYN004", n=9, bad=0, lst="", status="Normal", sym=""),
            dict(sn="EPHNEYN001", n=7, bad=2, lst="S11, S13", status="Normal", sym="กระแสต่ำ 2 สตริง"),
            dict(sn="EPHNEYN016", n=8, bad=4, lst="S1, S2, ขาด 2", status="Normal", sym="กระแสต่ำ 2 สตริง · สตริงน้อยกว่าทะเบียน 2")]
    iss = [dict(sn="EPHNEYN001", str="S11", typ="กระแสต่ำ (LOW)", val="7.9 A"),
           dict(sn="EPHNEYN001", str="S13", typ="กระแสต่ำ (LOW)", val="2.6 A"),
           dict(sn="EPHNEYN016", str="S1", typ="กระแสต่ำ (LOW)", val="10.3 A"),
           dict(sn="EPHNEYN016", str="S2", typ="กระแสต่ำ (LOW)", val="9.1 A"),
           dict(sn="EPHNEYN016", str="ขาด 2", typ="สตริงไม่มีกระแส", val="6/8")]
    R = build(0, "วันที่ 11", st, invs, iss, "11/11/2569", new_sheet=False)
    s = json.dumps(R, ensure_ascii=False, separators=(',', ':'))
    open('/home/claude/gs/req.json', 'w').write(s)
    print(len(R), len(s))
