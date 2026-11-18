#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ส่งรายงานประจำวันขึ้น Google Sheets (1 ไฟล์ต่อสถานีต่อเดือน, 1 หน้าต่อวัน) และดึงผลที่ผู้ทำรายงานกรอกกลับมา

ตั้งค่าครั้งเดียว (ดู _Tools/ตั้งค่า_Google_Sheets.md):
    _Tools/credentials.json     ← OAuth client (Desktop app) จาก Google Cloud Console
    _Tools/gsheet_config.json   ← {"root_folder_id": "<id ของโฟลเดอร์ใน Drive>"}
รันครั้งแรกจะเปิดเบราว์เซอร์ให้กดอนุญาต แล้วเก็บ token ไว้ที่ _Tools/token.json

โครงสร้างใน Drive:
    <root>/YYYY-MM/<รหัส>_<ชื่อสถานี>_YYYY-MM   (Google Sheet: หน้า "วันที่ 1", "วันที่ 2", ...)
"""
import os, json, time, random, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = os.path.join(HERE, "gsheet_config.json")
CRED = os.path.join(HERE, "credentials.json")
TOKEN = os.path.join(HERE, "token.json")
CACHE = os.path.join(HERE, "gsheet_ids.json")
SCOPES = ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets"]
SHEET_MIME = "application/vnd.google-apps.spreadsheet"
FOLDER_MIME = "application/vnd.google-apps.folder"


def enabled():
    return os.path.exists(CFG) and os.path.exists(CRED)


def _creds():
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    from google_auth_oauthlib.flow import InstalledAppFlow
    c = Credentials.from_authorized_user_file(TOKEN, SCOPES) if os.path.exists(TOKEN) else None
    if not c or not c.valid:
        if c and c.expired and c.refresh_token:
            c.refresh(Request())
        else:
            c = InstalledAppFlow.from_client_secrets_file(CRED, SCOPES).run_local_server(port=0)
        open(TOKEN, "w").write(c.to_json())
    return c


def _serial_to_date(v):
    if isinstance(v, (int, float)) and v > 30000:
        return dt.datetime(1899, 12, 30) + dt.timedelta(days=int(v))
    return v or None


class Sync:
    def __init__(self):
        from googleapiclient.discovery import build as gbuild
        c = _creds()
        self.drive = gbuild("drive", "v3", credentials=c, cache_discovery=False)
        self.sheets = gbuild("sheets", "v4", credentials=c, cache_discovery=False)
        self.root = json.load(open(CFG, encoding="utf-8"))["root_folder_id"]
        self.ids = json.load(open(CACHE, encoding="utf-8")) if os.path.exists(CACHE) else {}

    # ---------- helpers
    def _do(self, req):
        """execute พร้อม retry เมื่อโดนจำกัดอัตรา (429) หรือ server error"""
        from googleapiclient.errors import HttpError
        for n in range(7):
            try:
                return req.execute()
            except HttpError as e:
                if e.resp.status in (429, 500, 502, 503) and n < 6:
                    time.sleep(min(64, 2 ** n) + random.random()); continue
                raise

    def save(self):
        json.dump(self.ids, open(CACHE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    def _find(self, name, parent, mime):
        q = f"name = '{name.replace(chr(39), chr(92) + chr(39))}' and '{parent}' in parents and mimeType = '{mime}' and trashed = false"
        r = self._do(self.drive.files().list(q=q, fields="files(id)", pageSize=1))
        return r["files"][0]["id"] if r.get("files") else None

    def month_folder(self, month):
        m = self.ids.setdefault(month, {})
        if not m.get("_folder"):
            fid = self._find(month, self.root, FOLDER_MIME)
            if not fid:
                fid = self._do(self.drive.files().create(
                    body={"name": month, "mimeType": FOLDER_MIME, "parents": [self.root]}, fields="id"))["id"]
            m["_folder"] = fid
        return m["_folder"]

    def station_sheet(self, month, code, title):
        m = self.ids.setdefault(month, {})
        if not m.get(code):
            folder = self.month_folder(month)
            sid = self._find(title, folder, SHEET_MIME)
            if not sid:
                sid = self._do(self.drive.files().create(
                    body={"name": title, "mimeType": SHEET_MIME, "parents": [folder]}, fields="id"))["id"]
                self._do(self.sheets.spreadsheets().batchUpdate(spreadsheetId=sid, body={"requests": [
                    {"updateSpreadsheetProperties": {"properties": {"locale": "th_TH", "timeZone": "Asia/Bangkok"},
                                                     "fields": "locale,timeZone"}}]}))
            m[code] = sid
            self.save()
        return m[code]

    @staticmethod
    def url(ssid, gid=None):
        return f"https://docs.google.com/spreadsheets/d/{ssid}/edit" + (f"#gid={gid}" if gid is not None else "")

    # ---------- อ่านค่าที่ผู้ทำรายงานกรอก (ช่องสีเหลือง I:M + รหัสปัญหาใน N)
    def read_fills(self, ssid):
        meta = self._do(self.sheets.spreadsheets().get(spreadsheetId=ssid, fields="sheets.properties(title)"))
        tabs = [s["properties"]["title"] for s in meta.get("sheets", []) if s["properties"]["title"].startswith("วันที่ ")]
        tabs.sort(key=lambda t: int(t.split()[1]))
        if not tabs:
            return {}
        r = self._do(self.sheets.spreadsheets().values().batchGet(
            spreadsheetId=ssid, ranges=[f"'{t}'!I1:N60" for t in tabs],
            valueRenderOption="UNFORMATTED_VALUE", dateTimeRenderOption="SERIAL_NUMBER"))
        out = {}
        for vr in r.get("valueRanges", []):           # วันหลังทับวันก่อน
            for row in vr.get("values", []):
                row = list(row) + [None] * (6 - len(row))
                check, fix, status, owner, done, key = row[:6]
                if not key or not str(key).count("|"):
                    continue
                out[str(key)] = {"check": check or None, "fix": fix or None, "status": status or None,
                                 "owner": owner or None, "done": _serial_to_date(done)}
        return out

    # ---------- เขียนหน้า "วันที่ D" (สร้างใหม่ทุกครั้ง)
    def write_day(self, ssid, day, station, invs, issues, time_txt):
        import build_day as BD
        meta = self._do(self.sheets.spreadsheets().get(spreadsheetId=ssid, fields="sheets.properties(sheetId,title)"))
        sheets = {s["properties"]["title"]: s["properties"]["sheetId"] for s in meta.get("sheets", [])}
        title = f"วันที่ {day.day}"
        new_id = int(day.strftime("%Y%m%d"))
        pre = []
        if title in sheets:
            pre.append({"deleteSheet": {"sheetId": sheets[title]}})
            new_id = sheets[title] + 1 if sheets[title] == new_id else new_id
        index = sum(1 for t in sheets if t.startswith("วันที่ ") and t != title and int(t.split()[1]) > day.day)
        reqs = pre + BD.build(new_id, title, station, invs, issues, time_txt, new_sheet=True, index=index)
        default = [sid for t, sid in sheets.items() if t in ("Sheet1", "ชีต1", "แผ่นงาน1")]
        reqs += [{"deleteSheet": {"sheetId": sid}} for sid in default]   # ลบ Sheet1 ที่ติดมากับไฟล์ใหม่
        self._do(self.sheets.spreadsheets().batchUpdate(spreadsheetId=ssid, body={"requests": reqs}))
        return new_id

    # ---------- อัปโหลด Overview ขึ้น Drive เป็น Google Sheet (ไฟล์เดิม ลิงก์เดิม ทุกวัน)
    def upload_overview(self, path, title="00_Overview_รายงานการแก้ไข"):
        from googleapiclient.http import MediaFileUpload
        media = MediaFileUpload(path, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                                resumable=False)
        fid = self.ids.get("_overview") or self._find(title, self.root, SHEET_MIME)
        if fid:
            self._do(self.drive.files().update(fileId=fid, media_body=media))
        else:
            fid = self._do(self.drive.files().create(
                body={"name": title, "mimeType": SHEET_MIME, "parents": [self.root]}, media_body=media, fields="id"))["id"]
        self.ids["_overview"] = fid
        self.save()
        return f"https://docs.google.com/spreadsheets/d/{fid}/edit"
