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
`pwa_report.build`; a check frozen in SQL `pwa_check_slots` that Firestore lacks comes from SQL. Each check is a snapshot at hh:00 − CHECK_OFFSET_MIN (check_slots.py).
Nothing is made up; no source = "—":
    Status      checks.{hh}.kw + offline / fault           real Growatt power at the slot time
    DATA LOG    checks.{hh}.issues: "INV1 Offline (last data 07:40), INV3 Fault: 117 Relay check
                fail (06:19, ×5)" (every inverter offline / in fault status / with an alarm
                in the hour before hh:00 up to the check, with Growatt's code and text, when the log first reported
                it that day and how many times); inverters reporting but 0 kW = "INV ไม่ผลิตไฟ"
                first; nothing wrong = "—", no data at all = "offline";
                under LOG_MAX (300) characters, cut at a whole entry with "…(+N)"
    Note        "INV ทำงานปกติ ค่าแสง 584 (ฝนตก)" …          (old layout)
    ค่าแสง       checks.{hh}.irradiance_wm2                  Growatt weather sensor
    สภาพอากาศ    one of ท้องฟ้าปลอดโปร่ง / มีเมฆมาก / ฝนตก: checks.{hh}.google (`google_sky`,
                modelled, at the slot time; the cell carries no "(Google)" mark, `sources` in the API does); no Google value -> ท้องฟ้าปลอดโปร่ง /
                มีเมฆมาก from that irradiance vs clear-sky (`sky_th`)
    weather Status  "Normal" (sensor reported at every check so far) / "Abnormal"
    Firmware    the datalogger's own firmware: Growatt's API gives none, so the cell is left blank;
                a "—" or an inverter version an older report wrote there is blanked, a version
                typed by hand is kept

Schedule (worker): `pwa_sheet` at 06:05 creates today's tab; `publish_today` (08:50 / 12:50 /
16:50 / 19:30, each check's history pulled 3 min before) fills the checks published so far.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple
from urllib.parse import quote

from sqlalchemy.orm import Session

from app.config import settings
from app.services import check_slots, pwa_report
from app.services.check_slots import CHECK_HOURS
from solar_core.sun import clear_sky_ghi

log = logging.getLogger(__name__)

WX_NORMAL, WX_ABNORMAL = "Normal", "Abnormal"  # the only two weather Status values
FIRST_ROW = 3  # 1-based
DASH = "—"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
API = "https://sheets.googleapis.com/v4/spreadsheets"

# สภาพอากาศ has only these three values
SKY_CLEAR, SKY_CLOUD, SKY_RAIN = "ท้องฟ้าปลอดโปร่ง", "มีเมฆมาก", "ฝนตก"
GOOGLE_CLEAR = {"CLEAR", "MOSTLY_CLEAR"}
GOOGLE_CLEAR_COVER_PCT = 30  # cloud cover up to this = ท้องฟ้าปลอดโปร่ง, when the condition names no sky


def google_sky(g: Optional[Dict[str, Any]]) -> Optional[str]:
    """Google's conditions as one of the three sky values: raining (`google_weather.is_raining`)
    = ฝนตก; CLEAR / MOSTLY_CLEAR = ท้องฟ้าปลอดโปร่ง; a cloud condition or a mere chance of rain =
    มีเมฆมาก; a condition that names no sky (WINDY) = by Google's cloud cover. None when Google
    gave nothing."""
    if not g:
        return None
    if g.get("raining"):
        return SKY_RAIN
    cond = str(g.get("condition") or "").upper()
    if cond in GOOGLE_CLEAR:
        return SKY_CLEAR
    if "CLOUD" in cond or cond.startswith("CHANCE_OF"):
        return SKY_CLOUD
    cover = g.get("cloud_cover_pct")  # a condition that names no sky (WINDY): Google's cloud cover
    if cover is not None:
        return SKY_CLEAR if cover <= GOOGLE_CLEAR_COVER_PCT else SKY_CLOUD
    return None


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
    return clear_sky_ghi(day, lat, lon, hour * 60 + minute)


def sky_th(irr: float, cs: float) -> Optional[str]:
    """Measured ÷ clear-sky → ท้องฟ้าปลอดโปร่ง (≥ 0.75) or มีเมฆมาก; None when the sun is too
    low to judge. Irradiance alone never says ฝนตก: rain comes from Google only."""
    if cs < 80:
        return None
    return SKY_CLEAR if irr / cs >= 0.75 else SKY_CLOUD


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
        # per-inverter state and fault codes at the check (check_slots `issues`); None = older slot
        "issues": list(c["issues"]) if isinstance(c.get("issues"), list) else None,
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


LOG_MAX = 300  # a DATA LOG cell stays under this many characters


NOT_PRODUCING = "INV ไม่ผลิตไฟ"  # the plant's inverters report, but 0 kW at the check


def _issue_text(issue: Dict[str, Any]) -> str:
    """"INV3 Fault: 117 Relay check fail (06:19, ×5) / 203": code and Growatt's own text, either
    may be missing, then when the alarm log first reported it that day and, when more than once,
    how many times up to the check. An offline inverter: "INV2 Offline (last data 07:40)", or
    "(no data today)"; a slot frozen before `last` existed: "INV2 Offline"."""
    parts = []
    for it in issue.get("items") or []:
        text = " ".join(str(v).strip() for v in (it.get("code"), it.get("message")) if v not in (None, ""))
        if not text:
            continue
        count = it.get("count") or 0
        when = [str(it["since"])] if it.get("since") else []
        if count > 1:
            when.append(f"×{count}")
        if when:
            text += " (" + ", ".join(when) + ")"
        if text not in parts:
            parts.append(text)
    head = f"{issue.get('inv')} {issue.get('state')}"
    if issue.get("state") == "Offline" and "last" in issue:
        head += f" (last data {issue['last']})" if issue["last"] else " (no data today)"
    return head + (": " + " / ".join(parts) if parts else "")


def _ignored_item(it: Dict[str, Any]) -> bool:
    """A reading's own code in PWA_IGNORE_WARN_CODES (1) with nothing else to it: no text and no
    alarm-log `since`. Slots frozen before that setting existed still carry it ("Alarm: 1")."""
    code = str(it.get("code") or "").strip()
    return code.isdigit() and int(code) in settings.pwa_ignored_warn_codes() and not it.get("message") and not it.get("since")


def _shown_issues(issues: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """`issues` without ignored codes; an Alarm entry left with no item is dropped (Offline /
    Fault entries stay, they are wrong without a code)."""
    out = []
    for i in issues:
        items = [it for it in i.get("items") or [] if not _ignored_item(it)]
        if i.get("state") == "Alarm" and not items:
            continue
        out.append({**i, "items": items})
    return out


def _capped(entries: Sequence[str], limit: int = LOG_MAX) -> str:
    """The entries joined with ", "; over `limit`, cut at a whole entry and end with "…(+N)"
    (N = entries left out)."""
    full = ", ".join(entries)
    if len(full) <= limit:
        return full
    for keep in range(len(entries) - 1, 0, -1):
        text = ", ".join(entries[:keep]) + f", …(+{len(entries) - keep})"
        if len(text) <= limit:
            return text
    tail = f"…(+{len(entries) - 1})" if len(entries) > 1 else "…"
    return entries[0][: limit - len(tail)] + tail  # one entry alone is too long


def data_log(kw: Optional[float], c: Optional[Dict[str, Any]]) -> str:
    """DATA LOG (Fault log): every inverter with something wrong at the check, in INV order:
    "INV1 Offline (last data 07:40), INV3 Fault: 117 Relay check fail (06:19, ×5)" (check_slots
    `issues`). A plant whose inverters report but produce 0 kW starts with "INV ไม่ผลิตไฟ" (the
    reason its Status is abnormal). Nothing wrong = "—"; no data at all = "offline". Slots frozen
    before `issues`: offline / fault inverters and the alarm list they carry."""
    if kw is None or (c and len(c["offline"]) >= c["inverters"]):
        if c and c["issues"] is None and c["errors"]:
            return _capped(["offline: " + c["errors"][0], *c["errors"][1:]])
        return "offline"
    idle = [NOT_PRODUCING] if kw <= 0 else []
    if not c:
        return idle[0] if idle else DASH
    if c["issues"] is not None:
        entries = [_issue_text(i) for i in _shown_issues(c["issues"])]
    else:
        log = c["errors"] if c["errors"] is not None else c["alarms"]
        entries = [f"{x} Offline" for x in c["offline"]] + [f"{x} Fault" for x in c["fault"]] + log
    return _capped(idle + entries) if idle or entries else DASH


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
        # no reading and no inverter to report (no doc, or a plant with no inverters) = "—"
        status = DASH if kw is None and not (c and c["inverters"]) else "Normal" if ok else "Abnormal"

        sky = None
        if irr is not None and info.get("latitude") is not None and info.get("longitude") is not None:
            sky = sky_th(irr, clear_sky(info["latitude"], info["longitude"], day, at_h, at_m))
        # สภาพอากาศ = Google (modelled, labelled); the sensor's sky class only when Google has none
        wx, src = DASH, None
        gsky = google_sky(g)
        if gsky:
            wx, src = gsky, "google"
        elif sky:
            wx, src = sky, "growatt"

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
    - Firmware (by the row's datalogger SN, `data["firmware"]`: the datalogger's own firmware, which
      Growatt's API does not give) is written only while the cell is empty, "—" or holds an inverter
      version an older report put there (`data["dataloggers"][sn]["inverter_firmware"]`); with no
      version the cell is blanked. Anything else (typed by hand) is kept. Without the map the column
      is left as it is;
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
        if lay.firmware and firmware is not None:
            cur = str(_cell(rows, i, lay.firmware - 1)).strip()
            stale = ((data.get("dataloggers") or {}).get(sn) or {}).get("inverter_firmware") or []
            if cur in ("", DASH) or cur in stale:
                v = firmware.get(sn) or ""
                if v != cur:
                    put(lay.firmware, v)
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
            elif vals["status"] == "Normal":
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
