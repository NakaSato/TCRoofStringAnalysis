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
