"""Sunrise / sunset from the NOAA solar equations (accuracy about a minute; no dependencies)."""

from __future__ import annotations

import math
from datetime import date, datetime, timedelta
from typing import Optional, Tuple


def sun_times(day: date, lat: float, lon: float, utc_offset_h: float) -> Optional[Tuple[datetime, datetime]]:
    """Naive local (sunrise, sunset) for `day` at `lat`/`lon` (east positive).

    None when the sun does not rise or set that day (polar day / night).
    """
    g = 2 * math.pi / 365 * (day.timetuple().tm_yday - 1)
    eqtime = 229.18 * (
        0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
        - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g)
    )  # minutes
    decl = (
        0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g)
        - 0.006758 * math.cos(2 * g) + 0.000907 * math.sin(2 * g)
        - 0.002697 * math.cos(3 * g) + 0.00148 * math.sin(3 * g)
    )  # radians
    phi = math.radians(lat)
    cos_ha = math.cos(math.radians(90.833)) / (math.cos(phi) * math.cos(decl)) - math.tan(phi) * math.tan(decl)
    if abs(cos_ha) > 1:
        return None
    ha = math.degrees(math.acos(cos_ha))
    midnight = datetime(day.year, day.month, day.day)
    rise_min = 720 - 4 * (lon + ha) - eqtime + utc_offset_h * 60
    set_min = 720 - 4 * (lon - ha) - eqtime + utc_offset_h * 60
    return midnight + timedelta(minutes=rise_min), midnight + timedelta(minutes=set_min)


def clear_sky_ghi(day: date, lat: float, lon: float, minute_of_day: float, utc_offset_h: float = 7.0) -> float:
    """Haurwitz clear-sky GHI (W/m²) at local wall-clock `minute_of_day` (0–1440) for lat/lon.
    Modelled, never measured; 0 when the sun is (nearly) below the horizon."""
    doy = day.timetuple().tm_yday
    g = 2 * math.pi / 365 * (doy - 1 + (minute_of_day / 60.0 - 12) / 24)
    decl = (0.006918 - 0.399912 * math.cos(g) + 0.070257 * math.sin(g) - 0.006758 * math.cos(2 * g)
            + 0.000907 * math.sin(2 * g))
    eqt = 229.18 * (0.000075 + 0.001868 * math.cos(g) - 0.032077 * math.sin(g)
                    - 0.014615 * math.cos(2 * g) - 0.040849 * math.sin(2 * g))
    solar_min = minute_of_day + eqt + 4 * lon - 60 * utc_offset_h
    ha = math.radians(solar_min / 4 - 180)
    la = math.radians(lat)
    cosz = math.sin(la) * math.sin(decl) + math.cos(la) * math.cos(decl) * math.cos(ha)
    return 0.0 if cosz <= 0.01 else 1098 * cosz * math.exp(-0.057 / cosz)
