"""Monitoring PWA Report Google Sheet, filled by the worker through the Google Sheets API.

An alternative to the bound Apps Script (`Monitoring Report/apps-script/Code.gs`, the usual
writer), for when Google blocks unverified scripts. Off unless PWA_SHEET_ID is set. No user signs
in: the worker writes as a service account (FIREBASE_CREDENTIALS_FILE, or
PWA_SHEET_CREDENTIALS_FILE), so the sheet must be shared with that account's client_email as
Editor, and the Sheets API must be enabled in the project. It follows the Apps Script's rules: a
check cell is written only while empty, a check not published yet is skipped, and only the cells
it changes are written, so running both never overwrites what the other wrote.

Sheet: one tab per day named DD.MM. Rows 3+, B = plant name, C = datalogger SN. Columns are found
from the header rows (see `layout`), so both layouts work:
    old: weather Status | per check: Status, Note
    new: weather Status | per check: Status, ค่าแสง, สภาพอากาศ, DATA LOG (Fault log)

Source: the published daily docs (Firestore daily/{day}/plants/{id}) + the plant registry, i.e.
`pwa_report.build`. Each check is a snapshot at hh:00 − CHECK_OFFSET_MIN (check_slots.py).
Nothing is made up; no source = "—":
    Status      checks.{hh}.kw + offline / fault           real Growatt power at the slot time
    DATA LOG    checks.{hh}: "online", "offline", or the faults: offline / fault-status inverters +
                `errors`, the plant's Fault Error log of that day up to the check (Growatt alarm
                log, fault_type "Error"; open or closed)
    Note        "INV ทำงานปกติ ค่าแสง 584 (ฝนตก)" …          (old layout)
    ค่าแสง       checks.{hh}.irradiance_wm2                  Growatt weather sensor
    สภาพอากาศ    checks.{hh}.google.condition + " (Google)"  (modelled, at the slot time);
                no Google value -> sky class from that irradiance vs clear-sky
    weather Status  "Normal" (sensor reported at every check so far) / "Abnormal"
    Firmware    the row's datalogger's inverters' firmware (innerVersion, else fwVersion, ", "-joined),
                written only while empty or "—"

Schedule (worker): `pwa_sheet` at 06:05 creates today's tab; `publish_today` (08:50 / 12:50 /
16:50 / 19:30, each check's history pulled 3 min before) fills the checks published so far.
"""

from __future__ import annotations

import logging
import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple
from urllib.parse import quote

from sqlalchemy.orm import Session

from app.config import settings
from app.services import check_slots, pwa_report
from app.services.check_slots import CHECK_HOURS

log = logging.getLogger(__name__)

WX_NORMAL, WX_ABNORMAL = "Normal", "Abnormal"  # the only two weather Status values
FIRST_ROW = 3  # 1-based
DASH = "—"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
API = "https://sheets.googleapis.com/v4/spreadsheets"

GOOGLE_TH = {
    "CLEAR": "ท้องฟ้าแจ่มใส", "MOSTLY_CLEAR": "ท้องฟ้าโปร่ง", "PARTLY_CLOUDY": "มีเมฆบางส่วน",
    "MOSTLY_CLOUDY": "เมฆมาก", "CLOUDY": "ฟ้าครึ้ม", "CHANCE_OF_SHOWERS": "อาจมีฝน",
    "LIGHT_RAIN": "ฝนตกเล็กน้อย", "RAIN": "ฝนตก", "RAIN_SHOWERS": "ฝนตก",
    "SCATTERED_THUNDERSTORMS": "ฝนฟ้าคะนอง", "THUNDERSTORM": "ฝนฟ้าคะนอง",
    "WINDY": "ลมแรง", "WIND_AND_RAIN": "ฝนตก ลมแรง", "SCATTERED_SHOWERS": "ฝนตกบางพื้นที่",
    "LIGHT_RAIN_SHOWERS": "ฝนตกเล็กน้อย", "HEAVY_RAIN_SHOWERS": "ฝนตกหนัก", "LIGHT_TO_MODERATE_RAIN": "ฝนตก",
    "MODERATE_TO_HEAVY_RAIN": "ฝนตกหนัก", "HEAVY_RAIN": "ฝนตกหนัก", "RAIN_PERIODICALLY_HEAVY": "ฝนตกหนักเป็นช่วง",
    "ISOLATED_THUNDERSTORMS": "ฝนฟ้าคะนองบางพื้นที่", "HEAVY_THUNDERSTORM": "ฝนฟ้าคะนองรุนแรง",
}


def sheet_name(day: date) -> str:
    return day.strftime("%d.%m")


def published_hours(now: datetime) -> List[int]:
    """Check hours whose snapshot time (hh:00 − CHECK_OFFSET_MIN, plant-local `now`) has passed.
    Whether a check is also published in full is said by the data (`checks_ready`)."""
    local = now.replace(tzinfo=None)
    return [h for h in CHECK_HOURS if local >= check_slots.slot_time(local.date(), h)]


# --------------------------------------------------------------------------- layout


@dataclass
class Block:
    hour: int
    status: int  # 1-based columns; 0 = not in this layout
    note: int = 0
    irr: int = 0
    wx: int = 0
    log: int = 0
    kw: int = 0  # optional "kW" column: plant power at the check
    inv: int = 0  # optional "INV online" column: "2/3"


@dataclass
class Layout:
    weather: int
    blocks: List[Block]
    first: int
    last: int
    yield_kwh: int = 0  # optional "Yield (kWh)" column in row 1: energy so far that day
    firmware: int = 0  # optional "Firmware" column in row 1 (outside first..last): by datalogger SN


def _cell(rows: Sequence[Sequence[Any]], r: int, c: int) -> Any:
    """0-based row/col into a ragged grid; missing = ''."""
    if r < len(rows) and c < len(rows[r]):
        v = rows[r][c]
        return "" if v is None else v
    return ""


def layout(rows: Sequence[Sequence[Any]], title: str = "") -> Layout:
    """Column map from header rows 1–2. Each "Status" in row 2 after "weather Status" starts the next check block.

    Optional columns, filled when the sheet has them: per check "kW" (or กำลังผลิต) and
    "INV online"; per plant "Yield" (or พลังงาน) in row 1."""
    width = max((len(r) for r in rows[:2]), default=0)
    r1 = [str(_cell(rows, 0, k)) for k in range(width)]
    r2 = [str(_cell(rows, 1, k)).strip() for k in range(width)]
    weather = next((k + 1 for k, v in enumerate(r1) if re.search(r"weather\s*status", v, re.I)), 0)
    if not weather:
        raise ValueError(f'Sheet {title}: no "weather Status" header in row 1')
    starts = [k + 1 for k, v in enumerate(r2) if k + 1 > weather and re.match(r"status", v, re.I)]
    if len(starts) < len(CHECK_HOURS):
        raise ValueError(f'Sheet {title}: expected {len(CHECK_HOURS)} "Status" columns in row 2')
    blocks = []
    for k, hour in enumerate(CHECK_HOURS):
        frm = starts[k]
        to = starts[k + 1] - 1 if k + 1 < len(starts) else min(width, frm + len(CELL_COLUMNS) - 1)
        b = Block(hour, frm)
        for col in range(frm + 1, to + 1):
            v = r2[col - 1]
            if re.match(r"note", v, re.I):
                b.note = col
            elif "ค่าแสง" in v:
                b.irr = col
            elif "สภาพอากาศ" in v:
                b.wx = col
            elif re.search(r"data\s*log", v, re.I):
                b.log = col
            elif re.match(r"kw\b", v, re.I) or "กำลังผลิต" in v:
                b.kw = col
            elif re.search(r"inv\s*online", v, re.I):
                b.inv = col
        blocks.append(b)
    yield_kwh = next((k + 1 for k, v in enumerate(r1) if re.search(r"yield", v, re.I) or "พลังงาน" in v), 0)
    cols = [weather, yield_kwh] + [c for b in blocks for c in (b.status, b.note, b.irr, b.wx, b.log, b.kw, b.inv) if c]
    cols = [c for c in cols if c]
    firmware = next((k + 1 for k, v in enumerate(r1) if re.search(r"firmware", v, re.I)), 0)
    return Layout(weather, blocks, min(cols), max(cols), yield_kwh, firmware)


# --------------------------------------------------------------------------- cell values


def clear_sky(lat: float, lon: float, day: date, hour: int, minute: int = 0) -> float:
    """Haurwitz clear-sky GHI (W/m²) at Bangkok wall-clock `day hour:minute` for a plant at lat/lon."""
    doy = day.timetuple().tm_yday
    g = 2 * math.pi / 365 * (doy - 1 + (hour - 12) / 24)
    decl = (0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g)
            + 0.000907 * math.sin(2 * g))
    eqt = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
                    - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    solar_min = hour * 60 + minute + eqt + 4 * lon - 420
    ha = math.radians(solar_min / 4 - 180)
    la = math.radians(lat)
    cosz = math.sin(la) * math.sin(decl) + math.cos(la) * math.cos(decl) * math.cos(ha)
    return 0.0 if cosz <= 0.01 else 1098 * cosz * math.exp(-0.057 / cosz)


def sky_th(irr: float, cs: float) -> Optional[str]:
    """Measured ÷ clear-sky → Thai sky class; None when the sun is too low to judge."""
    if cs < 80:
        return None
    k = irr / cs
    if k >= 0.75:
        return "แดดดี"
    if k >= 0.45:
        return "มีเมฆบางส่วน"
    if k >= 0.2:
        return "เมฆมาก"
    return "ฟ้าครึ้ม/ฝน"


def _check(c: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(c, dict):
        return None
    return {
        "inverters": c.get("inverters") or 0,
        "offline": list(c.get("offline") or []),
        "fault": list(c.get("fault") or []),
        "alarms": list(c.get("alarms") or []),
        # the day's Fault Error log up to the check (check slots since 15.11); None = older slot
        "errors": list(c["errors"]) if isinstance(c.get("errors"), list) else None,
    }


def note(kw: Optional[float], c: Optional[Dict[str, Any]], irr: Optional[int], has_sensor: bool, rain: bool) -> str:
    parts: List[str] = []
    if c and c["alarms"]:
        parts.append("(" + ", ".join(c["alarms"]) + ")")
    all_offline = len(c["offline"]) >= c["inverters"] if c else kw is None
    if kw is None or all_offline:
        parts.append("INV Offline")
    else:
        bad = [f"{x} Offline" for x in c["offline"]] + [f"{x} Fault" for x in c["fault"]] if c else []
        parts.append(" ".join(bad) if bad else "INV ทำงานปกติ" if kw > 0 else "INV ไม่ผลิตไฟ")
        if irr is not None:
            parts.append(f"ค่าแสง {irr}")
        elif has_sensor:
            parts.append("Weather offline")
    if rain:
        parts.append("(ฝนตก)")
    return " ".join(parts)


def data_log(kw: Optional[float], c: Optional[Dict[str, Any]]) -> str:
    """DATA LOG (Fault log): offline inverters, inverters in fault status, then the plant's Fault
    Error log of the day up to the check (`errors`; older slots: the alarms open at the check)."""
    if kw is None or (c and len(c["offline"]) >= c["inverters"]):
        return "offline" + (": " + ", ".join(c["errors"]) if c and c["errors"] else "")
    if not c:
        return "online"
    log = c["errors"] if c["errors"] is not None else c["alarms"]
    faults = [f"{x} Offline" for x in c["offline"]] + [f"{x} Fault" for x in c["fault"]] + log
    return ", ".join(faults) if faults else "online"


# Order of each check's values in `plant_cells` (and in the API's /cells response)
CELL_COLUMNS = ("status", "note", "irr", "wx", "log", "kw", "inv")


def plant_cells(
    day: date,
    doc: Dict[str, Any],
    info: Dict[str, Any],
    hours: Sequence[int],
    ready: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """The sheet's values for one plant: `checks` {"09": [status, note, irr, wx, log, kw, inv]}
    (CELL_COLUMNS), `weather_status` ("Normal" / "Abnormal"), `weather_detail` and `yield_kwh`.
    `doc` = the published daily doc ({} = not published), `info` = registry {name, latitude,
    longitude}, `ready` = check hours published in full ("09", ...; None = all, for days published
    before check slots). A check not ready is "—" in every column, for every plant: the sheet's
    readiness gate. `sources` says where each check's sky class came from ("growatt" / "google" /
    None). Nothing is made up; no source = "—".

    A check slot (check_slots.py) carries its own `kw`, `irradiance_wm2` and `google`, all at the
    slot time (08:50 for "09"). Older docs fall back to `hourly_kw[hh]`, `weather.slots` and
    `google_weather.slots`."""
    hourly = doc.get("hourly_kw") or []
    weather = doc.get("weather") or {}
    has_sensor = bool(weather.get("has_sensor"))
    sensor_slots = weather.get("slots") or {}
    google_slots = (doc.get("google_weather") or {}).get("slots") or {}
    checks = doc.get("checks") or {}
    out: Dict[str, Any] = {"checks": {}, "sources": {}}
    sensor_hit: List[Tuple[int, bool]] = []
    for hour in hours:
        hh = f"{hour:02d}"
        if ready is not None and hh not in ready:
            out["checks"][hh] = [DASH] * len(CELL_COLUMNS)
            out["sources"][hh] = None
            continue
        raw = checks.get(hh)
        c = _check(raw)
        at_h, at_m = hour, 0
        if isinstance(raw, dict) and "kw" in raw:  # check slot
            kw = raw.get("kw")
            irr_v = raw.get("irradiance_wm2")
            g = raw.get("google")
            if isinstance(raw.get("at"), str) and re.fullmatch(r"\d{2}:\d{2}", raw["at"]):
                at_h, at_m = int(raw["at"][:2]), int(raw["at"][3:])
        else:
            kw = hourly[hour] if hour < len(hourly) else None
            irr_v = (sensor_slots.get(hh) or {}).get("irradiance_wm2")
            g = google_slots.get(hh)
        irr = round(irr_v) if irr_v is not None else None
        sensor_hit.append((hour, irr is not None))
        rain = bool(g and g.get("raining"))

        ok = kw is not None and kw > 0 and not (c and (c["offline"] or c["fault"]))
        status = DASH if kw is None and not c else "normal" if ok else "abnormal"

        sky = None
        if irr is not None and info.get("latitude") is not None and info.get("longitude") is not None:
            sky = sky_th(irr, clear_sky(info["latitude"], info["longitude"], day, at_h, at_m))
        # สภาพอากาศ = Google (modelled, labelled); the sensor's sky class only when Google has none
        wx, src = DASH, None
        if g and g.get("condition"):
            text = GOOGLE_TH.get(g["condition"]) or g["condition"]
            wx, src = text + (" (ฝนตก)" if rain and "ฝน" not in text else "") + " (Google)", "google"
        elif sky:
            wx, src = sky + (" (ฝนตก)" if rain else ""), "growatt"

        inv = f"{c['inverters'] - len(c['offline'])}/{c['inverters']}" if c and c["inverters"] else DASH
        out["checks"][hh] = [
            status,
            note(kw, c, irr, has_sensor, rain),
            DASH if irr is None else irr,
            wx,
            data_log(kw, c),
            DASH if kw is None else round(kw, 1),
            inv,
        ]
        out["sources"][hh] = src

    if not doc:
        detail = DASH
    elif not has_sensor:
        detail = "ไม่มีเซนเซอร์"
    elif not sensor_hit:
        detail = DASH  # no check published yet
    elif all(hit for _, hit in sensor_hit):
        detail = "normal"
    else:
        detail = "loss (" + ", ".join(f"{h:02d}:00" for h, hit in sensor_hit if not hit) + ")"
    # only two values in the sheet: Normal = the sensor reported at every check so far
    out["weather_status"] = WX_NORMAL if detail == "normal" else WX_ABNORMAL
    out["weather_detail"] = detail
    y = doc.get("yield_kwh")
    out["yield_kwh"] = DASH if y is None else round(y, 1)
    return out


def match_plant(sn: str, name: str, loggers: Dict[str, str], names: Dict[str, str]) -> Optional[str]:
    """Plant of a sheet row: datalogger SN first, then a unique plant-name match (the datalogger
    was replaced since the sheet was made)."""
    pid = loggers.get(sn)
    if pid:
        return pid
    hits = [p for p, n in names.items() if name and name in str(n or "")] if name else []
    return hits[0] if len(hits) == 1 else None


@dataclass
class FillStats:
    rows: int = 0
    normal: int = 0
    abnormal: int = 0
    no_power: int = 0
    wx_growatt: int = 0
    wx_google: int = 0
    unmatched: int = 0
    written: int = 0  # check cells written (they were empty)
    kept: int = 0  # check cells left as they were (already filled)
    published_plants: int = 0
    firmware: int = 0  # Firmware cells written with a version
    hours: List[int] = field(default_factory=list)
    skipped_hours: List[int] = field(default_factory=list)  # not published yet: nothing written


def _empty(v: Any) -> bool:
    return v is None or v == ""


def fill_rows(
    day: date,
    lay: Layout,
    rows: List[List[Any]],
    data: Dict[str, Any],
    hours: Optional[Sequence[int]] = None,
) -> FillStats:
    """Fills `rows` (the sheet's values, 0-based, header rows included) in place for the check
    blocks in `hours` (default all). Same rules as the Apps Script (Code.gs):

    - a check cell is written only while it is empty, so the first published value stays;
    - a check not published yet (`data["checks_ready"]`, or every plant "—") is skipped;
    - weather Status ("Normal" / "Abnormal") and Yield are kept up to date;
    - Firmware (by the row's datalogger SN, `data["firmware"]`) is written only while empty or "—";
      an SN without a version gets "—". Without the map the column is left as it is;
    - cells of other checks are left as they are."""
    blocks = [b for b in lay.blocks if hours is None or b.hour in hours]
    by_plant: Dict[str, Any] = data.get("days") or {}
    plant_info: Dict[str, Any] = data.get("plants") or {}
    ready = data.get("checks_ready")
    names = {p: d.get("name") for p, d in plant_info.items()}
    firmware: Optional[Dict[str, str]] = data.get("firmware")
    stats = FillStats(published_plants=len(by_plant))
    asked = [b.hour for b in blocks]
    cells_of = {pid: plant_cells(day, by_plant.get(pid) or {}, info, asked, ready=ready) for pid, info in plant_info.items()}
    live = [
        b for b in blocks
        if any(any(v != DASH for v in c["checks"][f"{b.hour:02d}"]) for c in cells_of.values())
    ]
    stats.hours = [b.hour for b in live]
    stats.skipped_hours = [b.hour for b in blocks if b not in live]

    for i in range(FIRST_ROW - 1, len(rows)):
        row = rows[i]

        def put(col: int, v: Any) -> None:
            if not col:
                return
            while len(row) < col:
                row.append("")
            row[col - 1] = v

        sn = str(_cell(rows, i, 2)).strip()
        if not sn:
            continue
        if lay.firmware and firmware is not None and str(_cell(rows, i, lay.firmware - 1)).strip() in ("", DASH):
            v = firmware.get(sn)
            put(lay.firmware, v or DASH)
            stats.firmware += 1 if v else 0
        pid = match_plant(sn, str(_cell(rows, i, 1)).strip(), data.get("loggers") or {}, names)
        if not pid:
            stats.unmatched += 1
            put(lay.weather, WX_ABNORMAL)
            continue
        stats.rows += 1
        cells = cells_of[pid]
        for b in live:
            hh = f"{b.hour:02d}"
            vals = dict(zip(CELL_COLUMNS, cells["checks"][hh]))
            for col in CELL_COLUMNS:
                c = getattr(b, col)
                if not c:
                    continue
                if _empty(_cell(rows, i, c - 1)):
                    put(c, vals[col])
                    stats.written += 1
                else:
                    stats.kept += 1
            if vals["kw"] == DASH:
                stats.no_power += 1
            elif vals["status"] == "normal":
                stats.normal += 1
            else:
                stats.abnormal += 1
            if cells["sources"][hh] == "growatt":
                stats.wx_growatt += 1
            elif cells["sources"][hh] == "google":
                stats.wx_google += 1
        put(lay.weather, cells["weather_status"])
        put(lay.yield_kwh, cells["yield_kwh"])
    return stats


# --------------------------------------------------------------------------- Sheets API


def col_letter(n: int) -> str:
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _a1(title: str, rng: str = "") -> str:
    t = "'" + title.replace("'", "''") + "'"
    return f"{t}!{rng}" if rng else t


class SheetsClient:
    """Minimal Sheets API v4 client (service account)."""

    def __init__(self, spreadsheet_id: str, session: Any = None):
        self.id = spreadsheet_id
        self._session = session

    @property
    def session(self) -> Any:
        if self._session is None:
            from google.auth.transport.requests import AuthorizedSession

            path = settings.pwa_sheet_credentials_file or settings.firebase_credentials_file
            if path:
                from google.oauth2 import service_account

                creds = service_account.Credentials.from_service_account_file(path, scopes=SCOPES)
            else:
                import google.auth

                creds, _ = google.auth.default(scopes=SCOPES)
            self._session = AuthorizedSession(creds)
        return self._session

    def _call(self, method: str, path: str, **kw: Any) -> Dict[str, Any]:
        r = self.session.request(method, f"{API}/{self.id}{path}", timeout=60, **kw)
        if r.status_code == 403 or r.status_code == 404:
            raise PermissionError(
                f"Sheets API {r.status_code}: share the sheet with the service account as Editor "
                f"and enable sheets.googleapis.com ({r.text[:300]})"
            )
        r.raise_for_status()
        return r.json() if r.content else {}

    def sheets(self) -> List[Dict[str, Any]]:
        """[{sheetId, title, index}] in tab order."""
        meta = self._call("GET", "", params={"fields": "sheets.properties(sheetId,title,index)"})
        return sorted((s["properties"] for s in meta.get("sheets", [])), key=lambda p: p.get("index", 0))

    def values(self, title: str) -> List[List[Any]]:
        res = self._call("GET", f"/values/{quote(_a1(title), safe='')}", params={"valueRenderOption": "UNFORMATTED_VALUE"})
        return res.get("values", [])

    def duplicate(self, source_id: int, title: str, index: int) -> None:
        body = {"requests": [{"duplicateSheet": {"sourceSheetId": source_id, "insertSheetIndex": index, "newSheetName": title}}]}
        self._call("POST", ":batchUpdate", json=body)

    def clear(self, rng: str) -> None:
        self._call("POST", f"/values/{quote(rng, safe='')}:clear", json={})

    def write(self, rng: str, rows: List[List[Any]]) -> None:
        self._call("PUT", f"/values/{quote(rng, safe='')}", params={"valueInputOption": "RAW"},
                   json={"range": rng, "majorDimension": "ROWS", "values": rows})

    def write_cells(self, cells: List[Tuple[str, Any]]) -> None:
        """One call: each (A1 cell, value). Only these cells are touched."""
        if cells:
            self._call("POST", "/values:batchUpdate", json={
                "valueInputOption": "RAW",
                "data": [{"range": rng, "majorDimension": "ROWS", "values": [[v]]} for rng, v in cells],
            })


DAY_TAB = re.compile(r"^\d{2}\.\d{2}")


def ensure_day_sheet(client: SheetsClient, day: date) -> bool:
    """Creates the DD.MM tab as a copy of the newest DD.MM tab with its check columns cleared.
    Returns True when it was created (no-op if it exists)."""
    name = sheet_name(day)
    tabs = client.sheets()
    if any(t["title"] == name for t in tabs):
        return False
    tpl = [t for t in tabs if DAY_TAB.match(t["title"])]
    if not tpl:
        raise ValueError("No DD.MM template sheet to copy")
    client.duplicate(tpl[-1]["sheetId"], name, len(tabs))
    rows = client.values(name)
    lay = layout(rows, name)
    if len(rows) >= FIRST_ROW:
        client.clear(_a1(name, f"{col_letter(lay.first)}{FIRST_ROW}:{col_letter(lay.last)}{len(rows)}"))
    return True


def fill_day(
    db: Session,
    day: date,
    hours: Optional[Sequence[int]] = None,
    client: Optional[SheetsClient] = None,
    day_docs: Optional[pwa_report.DayDocs] = None,
) -> Dict[str, Any]:
    """Fills `day`'s tab (created if missing) for the checks in `hours` (default all)."""
    client = client or SheetsClient(settings.pwa_sheet_id)
    created = ensure_day_sheet(client, day)
    name = sheet_name(day)
    out: Dict[str, Any] = {"sheet": name, "created": created, "hours": list(hours) if hours is not None else list(CHECK_HOURS)}
    if hours is not None and not hours:
        return out
    # straight from Firestore: the worker fills right after publishing, a cached copy could be older
    data = pwa_report.build(db, day, day_docs or pwa_report.firestore_day_docs)
    if not data["days"]:
        out["skipped"] = f"no published data for {day.isoformat()}"
        return out
    rows = client.values(name)
    if len(rows) < FIRST_ROW:
        out["skipped"] = "no plant rows"
        return out
    lay = layout(rows, name)
    before = [list(r) for r in rows]
    stats = fill_rows(day, lay, rows, data, hours)
    # only the cells this fill changed: a cell someone else (the Apps Script) wrote since the read
    # above is never overwritten by a stale copy of the whole block
    cols = list(range(lay.first, lay.last + 1))
    if lay.firmware and lay.firmware not in cols:
        cols.append(lay.firmware)
    changed = [
        (_a1(name, f"{col_letter(c)}{i + 1}"), _cell(rows, i, c - 1))
        for i in range(FIRST_ROW - 1, len(rows))
        for c in cols
        if _cell(rows, i, c - 1) != _cell(before, i, c - 1)
    ]
    client.write_cells(changed)
    out.update(stats.__dict__)
    out["cells_written"] = len(changed)
    log.info("PWA sheet %s: %s", name, out)
    return out


def run_for_now(db: Session, now: datetime, fill: Callable[..., Dict[str, Any]] = fill_day) -> Optional[Dict[str, Any]]:
    """Today's tab with the checks published so far; None when PWA_SHEET_ID is not set."""
    if not settings.pwa_sheet_id:
        return None
    return fill(db, now.date(), published_hours(now))
