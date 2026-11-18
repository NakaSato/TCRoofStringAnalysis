"""Fill one day's sheet of "Monitoring PWA Report.xlsx" (template of sheet 12.11 onwards).

Columns per plant row (row 3+, matched by datalogger SN in column C, plant name as fallback):
    F  weather Status (Normal / loss)  Growatt weather sensor reported at all three checks?
    G/K/O  Status (normal/abnormal)    Firestore daily/{day}/plants/{id}.hourly_kw at 09/13/17 (real Growatt power)
    H/L/P  ค่าแสง                       Growatt sensor irradiance (W/m²), nearest reading within ±10 min
    I/M/Q  สภาพอากาศ                    Growatt: sky class from irradiance vs clear-sky;
                                       no Growatt reading -> Google Maps Weather (modelled; the cell is not marked)
    J/N/R  DATA LOG                    online / offline (plant uploaded data in that hour)

No value is made up: anything without a source is "—".

Local back-fill tool only. The scheduled fill is the worker (backend/app/services/pwa_sheet.py).
Unlike it, this script ignores inverter offline/fault checks: Status is "Normal" whenever power > 0.

Usage (repo root):
    PYTHONPATH=backend uv run --with openpyxl python "Monitoring Report/fill_pwa_report.py" --day 2026-11-12
    ... --sheet 12.11 --out "Monitoring Report/out.xlsx"     (default: <input> (<sheet> filled).xlsx)
"""

from __future__ import annotations

import argparse
import math
import pathlib
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Tuple

import openpyxl
from openpyxl.utils import column_index_from_string, get_column_letter
from sqlalchemy import select

from app.config import settings
from app.db import models as m
from app.db.session import SessionLocal
from app.services import google_weather as gw

HERE = pathlib.Path(__file__).resolve().parent
CHECKS = ((9, "G"), (13, "K"), (17, "O"))  # hour -> first column of its 4-column block
NEAREST = timedelta(minutes=10)
DASH = "—"

# สภาพอากาศ has only these three values
SKY_CLEAR, SKY_CLOUD, SKY_RAIN = "ท้องฟ้าปลอดโปร่ง", "มีเมฆมาก", "ฝนตก"


def col(letter: str, offset: int) -> str:
    return get_column_letter(column_index_from_string(letter) + offset)


# --------------------------------------------------------------------------- sky class from a sensor


def clear_sky_ghi(lat: float, lon: float, t: datetime) -> float:
    """Haurwitz clear-sky GHI (W/m²) at plant-local time t (UTC+7)."""
    doy = t.timetuple().tm_yday
    g = 2 * math.pi / 365 * (doy - 1 + (t.hour - 12) / 24)
    decl = 0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g)
    eqt = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g) - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    solar_min = t.hour * 60 + t.minute + eqt + 4 * lon - 7 * 60
    ha = math.radians(solar_min / 4 - 180)
    la = math.radians(lat)
    cosz = math.sin(la) * math.sin(decl) + math.cos(la) * math.cos(decl) * math.cos(ha)
    return 0.0 if cosz <= 0.01 else 1098 * cosz * math.exp(-0.057 / cosz)


def sky_th(irr: float, cs: float) -> Optional[str]:
    """Clearness (measured ÷ clear-sky) → Thai sky class; None when the sun is too low to judge."""
    if cs < 80:
        return None
    return SKY_CLEAR if irr / cs >= 0.75 else SKY_CLOUD


# --------------------------------------------------------------------------- sources


def firestore_day(day: date) -> Dict[int, dict]:
    import firebase_admin
    from firebase_admin import credentials, firestore

    try:
        app = firebase_admin.get_app("pwa-report")
    except ValueError:
        opts = {"projectId": settings.firebase_project_id} if settings.firebase_project_id else None
        app = firebase_admin.initialize_app(credentials.Certificate(settings.firebase_credentials_file), opts, name="pwa-report")
    client = firestore.client(app)
    return {int(d.id): d.to_dict() for d in client.collection(f"daily/{day.isoformat()}/plants").stream()}


def nearest(readings: List[Tuple[datetime, float]], t: datetime) -> Optional[float]:
    best = min(readings, key=lambda r: abs(r[0] - t), default=None)
    return best[1] if best and abs(best[0] - t) <= NEAREST else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", type=date.fromisoformat, required=True, help="plant-local day, e.g. 2026-11-12")
    ap.add_argument("--sheet", help="sheet name (default DD.MM of --day)")
    ap.add_argument("--book", type=pathlib.Path, default=HERE / "Monitoring PWA Report.xlsx")
    ap.add_argument("--out", type=pathlib.Path)
    a = ap.parse_args()
    sheet = a.sheet or a.day.strftime("%d.%m")
    out = a.out or a.book.with_name(f"{a.book.stem} ({sheet} filled).xlsx")

    fs = firestore_day(a.day)
    d0 = datetime.combine(a.day, datetime.min.time())
    with SessionLocal() as db:
        plants = {p.plant_id: p for p in db.scalars(select(m.GrowattPlant))}
        by_dl: Dict[str, int] = {i.datalogger_sn: i.plant_id for i in db.scalars(select(m.GrowattInverter)) if i.datalogger_sn}
        sensors = list(db.scalars(select(m.GrowattEnvSensor)))
        by_dl.update({s.datalogger_sn: s.plant_id for s in sensors})
        env: Dict[str, List[Tuple[datetime, float]]] = defaultdict(list)
        for r in db.scalars(
            select(m.GrowattEnvReading)
            .where(m.GrowattEnvReading.timestamp >= d0, m.GrowattEnvReading.timestamp < d0 + timedelta(days=1))
            .where(m.GrowattEnvReading.irradiance_wm2.is_not(None))
        ):
            env[r.datalogger_sn].append((r.timestamp, float(r.irradiance_wm2)))
        gwh: Dict[Tuple[str, int], m.GoogleWeatherHourly] = {
            (r.cell_key, r.hour.hour): r
            for r in db.scalars(
                select(m.GoogleWeatherHourly).where(m.GoogleWeatherHourly.hour >= d0, m.GoogleWeatherHourly.hour < d0 + timedelta(days=1))
            )
        }
    dl_of_plant: Dict[int, List[str]] = defaultdict(list)
    for s in sensors:
        dl_of_plant[s.plant_id].append(s.datalogger_sn)

    wb = openpyxl.load_workbook(a.book)
    ws = wb[sheet]
    stats = defaultdict(int)
    for row in range(3, ws.max_row + 1):
        sn = str(ws[f"C{row}"].value or "").strip()
        name = str(ws[f"B{row}"].value or "").strip()
        if not sn:
            continue
        pid = by_dl.get(sn)
        if pid is None and name:  # datalogger replaced: fall back to a unique name match
            hits = [p for p, pl in plants.items() if name in (pl.name or "")]
            pid = hits[0] if len(hits) == 1 else None
        if pid is None:
            stats["unmatched"] += 1
            ws[f"F{row}"] = "ไม่พบในระบบ"
            continue
        plant, doc = plants[pid], fs.get(pid)
        hourly = (doc or {}).get("hourly_kw") or [None] * 24
        sensor_dls = [sn] if sn in env else [d for d in dl_of_plant.get(pid, []) if d in env]
        cell = gw.plant_cell(plant)
        had_sensor = bool(dl_of_plant.get(pid)) or sn in env
        sensor_hits = []

        for hour, c0 in CHECKS:
            t = d0.replace(hour=hour)
            kw = hourly[hour]
            ws[f"{c0}{row}"] = DASH if kw is None else ("Normal" if kw > 0 else "Abnormal")
            vals = [v for v in (nearest(env[d], t) for d in sensor_dls) if v is not None]
            irr = round(sum(vals) / len(vals)) if vals else None
            sensor_hits.append(irr is not None)
            ws[f"{col(c0, 1)}{row}"] = DASH if irr is None else irr

            g = gwh.get((cell[0], hour)) if cell else None
            g_rain = gw.is_raining(g.precip_mm, g.condition) if g else None
            sky = sky_th(irr, clear_sky_ghi(plant.latitude, plant.longitude, t)) if irr is not None and plant.latitude else None
            g_cond = (g.condition or "").upper() if g else ""
            if g_rain:  # rain comes from Google only (modelled)
                wx = SKY_RAIN
                stats["wx_google"] += 1
            elif sky:
                wx = sky
                stats["wx_growatt"] += 1
            elif g_cond in ("CLEAR", "MOSTLY_CLEAR") or "CLOUD" in g_cond or g_cond.startswith("CHANCE_OF"):
                wx = (SKY_CLEAR if g_cond in ("CLEAR", "MOSTLY_CLEAR") else SKY_CLOUD)
                stats["wx_google"] += 1
            else:
                wx = DASH
                stats["wx_none"] += 1
            ws[f"{col(c0, 2)}{row}"] = wx
            ws[f"{col(c0, 3)}{row}"] = "online" if kw is not None else "offline"
            stats["abnormal" if kw is not None and kw <= 0 else "no_power_data" if kw is None else "normal"] += 1

        if not had_sensor:
            ws[f"F{row}"] = "ไม่มีเซนเซอร์"
        elif all(sensor_hits):
            ws[f"F{row}"] = "Normal"
        else:
            missing = ", ".join(f"{h:02d}:00" for (h, _), ok in zip(CHECKS, sensor_hits) if not ok)
            ws[f"F{row}"] = f"loss ({missing})"
        stats["rows"] += 1

    wb.save(out)
    print(f"{sheet}: {dict(stats)} | Firestore plants: {len(fs)} -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
