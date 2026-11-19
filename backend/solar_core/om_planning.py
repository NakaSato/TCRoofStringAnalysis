"""Calendar Team planning maths (docs/plans/calendar-team.md §7), pure: no DB, no FastAPI.

- `occurrences`: the days a recurring plan falls on in a window (every N weeks / months from its
  start, inside an optional season that may wrap the year, moved to the plan's weekday or the next
  working day).
- `schedule_round`: spread a cleaning round over working days for a number of crews, longest-
  uncleaned plants first, grouped (e.g. by province) to keep travel short.
"""

from __future__ import annotations

import calendar
import math
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Dict, Iterable, List, Optional, Sequence, Set

WORKDAYS = (0, 1, 2, 3, 4)  # Monday … Friday
MAX_SHIFT_DAYS = 14  # a weekday / working-day shift never moves an occurrence further than this


def add_months(d: date, n: int) -> date:
    """Same day of month `n` months later, clamped to the month's last day (31 Jan + 1 = 28/29 Feb)."""
    m = d.month - 1 + n
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def in_season(month: int, season_from: Optional[int], season_to: Optional[int]) -> bool:
    """`season_from` … `season_to` inclusive; wraps the year when from > to (Nov … Apr). None = all year."""
    if season_from is None or season_to is None:
        return True
    if season_from <= season_to:
        return season_from <= month <= season_to
    return month >= season_from or month <= season_to


def next_working_day(d: date, weekdays: Iterable[int], holidays: Set[date]) -> Optional[date]:
    """`d` or the first later day on one of `weekdays` that is not a holiday (None if none within 14 days)."""
    days = set(weekdays)
    for i in range(MAX_SHIFT_DAYS + 1):
        x = d + timedelta(days=i)
        if x.weekday() in days and x not in holidays:
            return x
    return None


def occurrences(
    starts_on: date,
    every_n: int,
    unit: str,
    window_from: date,
    window_to: date,
    *,
    season_from: Optional[int] = None,
    season_to: Optional[int] = None,
    weekday: Optional[int] = None,
    ends_on: Optional[date] = None,
    holidays: Iterable[date] = (),
) -> List[date]:
    """Days in `window_from` … `window_to` a plan falls on. The k-th nominal day is `starts_on` + k ×
    N weeks / months; one outside the season (by its nominal month) is skipped; it then moves to
    `weekday` (0 = Monday), or with no weekday to the first Monday–Friday, never onto a holiday."""
    if every_n < 1:
        raise ValueError("every_n must be at least 1")
    if unit not in ("week", "month"):
        raise ValueError("unit must be week or month")
    hol = set(holidays)
    days = (weekday,) if weekday is not None else WORKDAYS
    last = min(window_to, ends_on) if ends_on else window_to
    out: List[date] = []
    k = 0
    while True:
        nominal = starts_on + timedelta(weeks=every_n * k) if unit == "week" else add_months(starts_on, every_n * k)
        k += 1
        if nominal > last:
            break
        if not in_season(nominal.month, season_from, season_to):
            continue
        day = next_working_day(nominal, days, hol)
        if day is None or day < window_from or day > last or day < starts_on:
            continue
        if not out or day > out[-1]:
            out.append(day)
    return out


@dataclass
class RoundPlant:
    plant_id: int
    #: crew-days one cleaning takes (om_plant_settings); None = not entered, counted as 1
    crew_days: Optional[float] = None
    #: days since the last recorded cleaning; None = none recorded
    days_since: Optional[int] = None
    group: Optional[str] = None


@dataclass
class RoundSlot:
    plant_id: int
    start_day: date
    end_day: date
    crew: int  # 1-based
    crew_days: float
    duration_set: bool
    working_days: List[date] = field(default_factory=list)


@dataclass
class RoundResult:
    slots: List[RoundSlot]
    unscheduled: List[int]
    order: List[int]


def round_order(plants: Sequence[RoundPlant], group: bool = True) -> List[RoundPlant]:
    """Priority = most days since the last cleaning (none recorded first: unknown is never assumed
    clean). With `group`, plants of a group stay together; groups go in order of their most urgent plant."""
    def key(p: RoundPlant):
        return (0 if p.days_since is None else 1, -(p.days_since or 0), p.plant_id)

    ranked = sorted(plants, key=key)
    if not group:
        return ranked
    groups: Dict[str, List[RoundPlant]] = {}
    first: Dict[str, int] = {}
    for i, p in enumerate(ranked):
        g = p.group or ""
        groups.setdefault(g, []).append(p)
        first.setdefault(g, i)
    return [p for g in sorted(groups, key=lambda g: first[g]) for p in groups[g]]


def working_days(start: date, weekdays: Iterable[int], holidays: Iterable[date], limit_days: int) -> List[date]:
    days, hol = set(weekdays), set(holidays)
    return [d for d in (start + timedelta(days=i) for i in range(limit_days)) if d.weekday() in days and d not in hol]


def schedule_round(
    plants: Sequence[RoundPlant],
    start: date,
    crews: int,
    *,
    weekdays: Iterable[int] = WORKDAYS,
    holidays: Iterable[date] = (),
    group: bool = True,
    horizon_days: int = 120,
) -> RoundResult:
    """Each crew works one plant at a time on working days. A plant of ≤ 1 crew-day shares the
    crew's day with the next while the day has room (two 0.5-day plants = one day); a longer one
    starts on a fresh day and takes ⌈crew-days⌉ working days. The next plant goes to the crew free
    earliest. Plants that don't fit within `horizon_days` are returned in `unscheduled`."""
    if crews < 1:
        raise ValueError("crews must be at least 1")
    days = working_days(start, weekdays, holidays, horizon_days)
    order = round_order(plants, group)
    # per crew: index into `days` of its current day, and the part of that day already used
    pos = [0] * crews
    used = [0.0] * crews
    slots: List[RoundSlot] = []
    unscheduled: List[int] = []
    for p in order:
        need = p.crew_days if p.crew_days and p.crew_days > 0 else 1.0
        best = None
        for c in range(crews):
            i, u = pos[c], used[c]
            if need <= 1 and u + need <= 1 + 1e-9:
                begin = i
            else:
                begin = i + 1 if u > 1e-9 else i
            if best is None or begin < best[1]:
                best = (c, begin)
        assert best is not None
        c, begin = best
        span = 1 if need <= 1 else math.ceil(need - 1e-9)
        if begin + span - 1 >= len(days):
            unscheduled.append(p.plant_id)
            continue
        wd = days[begin:begin + span]
        slots.append(RoundSlot(p.plant_id, wd[0], wd[-1], c + 1, need, p.crew_days is not None, wd))
        if need <= 1:
            used[c] = (used[c] if begin == pos[c] else 0.0) + need
            pos[c] = begin
            if used[c] >= 1 - 1e-9:
                pos[c], used[c] = begin + 1, 0.0
        else:
            pos[c], used[c] = begin + span, 0.0
    return RoundResult(slots, unscheduled, [p.plant_id for p in order])
