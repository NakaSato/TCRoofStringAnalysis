"""Calendar Team Phase 2 planning maths (solar_core/om_planning.py): occurrences and the round scheduler."""

from datetime import date

import pytest

from solar_core.om_planning import RoundPlant, add_months, in_season, occurrences, round_order, schedule_round


def test_add_months_clamps_and_seasons_wrap():
    assert add_months(date(2027, 1, 31), 1) == date(2027, 2, 28)
    assert add_months(date(2026, 11, 30), 3) == date(2027, 2, 28)
    assert in_season(12, 11, 4) and in_season(4, 11, 4) and not in_season(5, 11, 4)
    assert in_season(6, 3, 8) and not in_season(9, 3, 8) and in_season(9, None, None)


def test_occurrences_season_weekday_and_holidays():
    # every 2 months, Nov–Apr only; 2 Jan 2027 is a Saturday → Monday 4 Jan
    days = occurrences(date(2026, 11, 2), 2, "month", date(2026, 11, 1), date(2027, 12, 31), season_from=11, season_to=4)
    assert days == [date(2026, 11, 2), date(2027, 1, 4), date(2027, 3, 2), date(2027, 11, 2)]
    # a holiday on the shifted day moves it again
    days = occurrences(date(2026, 11, 2), 2, "month", date(2026, 11, 1), date(2027, 2, 1),
                       season_from=11, season_to=4, holidays=[date(2027, 1, 4)])
    assert days == [date(2026, 11, 2), date(2027, 1, 5)]
    # weekly on Wednesdays from a Thursday; the window and ends_on cut it
    days = occurrences(date(2026, 11, 19), 1, "week", date(2026, 11, 1), date(2027, 1, 1), weekday=2, ends_on=date(2026, 12, 9))
    assert days == [date(2026, 11, 25), date(2026, 12, 2), date(2026, 12, 9)]
    # the window starts later: earlier occurrences are left out
    assert occurrences(date(2026, 1, 5), 3, "month", date(2026, 11, 1), date(2027, 2, 1)) == [date(2027, 1, 5)]
    with pytest.raises(ValueError):
        occurrences(date(2026, 1, 5), 0, "month", date(2026, 1, 1), date(2026, 2, 1))


def test_round_order_unknown_first_then_groups():
    ps = [RoundPlant(1, days_since=100, group="A"), RoundPlant(2, days_since=90, group="B"),
          RoundPlant(3, days_since=10, group="A"), RoundPlant(4, days_since=None, group="B")]
    assert [p.plant_id for p in round_order(ps, group=False)] == [4, 1, 2, 3]
    assert [p.plant_id for p in round_order(ps, group=True)] == [4, 2, 1, 3]


def test_schedule_round_shares_days_and_spans_long_jobs():
    ps = [RoundPlant(1, 1.0, 200), RoundPlant(2, None, None), RoundPlant(3, 0.5, 10),
          RoundPlant(4, 0.5, 50), RoundPlant(5, 2.0, 30)]
    fri = date(2026, 11, 20)
    r = schedule_round(ps, fri, 1, group=False)
    got = {s.plant_id: (s.start_day.day, s.end_day.day) for s in r.slots}
    # 2 (unknown) Fri 20, 1 Mon 23, 4 Tue 24 (half), 5 Wed 25–Thu 26 (fresh day), 3 Fri 27
    assert got == {2: (20, 20), 1: (23, 23), 4: (24, 24), 5: (25, 26), 3: (27, 27)}
    assert [s.duration_set for s in r.slots if s.plant_id == 2] == [False]
    r2 = schedule_round(ps, fri, 2, group=False)
    got2 = {s.plant_id: (s.crew, s.start_day.day, s.end_day.day) for s in r2.slots}
    assert got2 == {2: (1, 20, 20), 1: (2, 20, 20), 4: (1, 23, 23), 5: (2, 23, 24), 3: (1, 23, 23)}
    # holidays and the weekend are skipped; Saturday only when asked
    r3 = schedule_round([RoundPlant(1), RoundPlant(2)], date(2026, 12, 4), 1, holidays=[date(2026, 12, 7)])
    assert [s.start_day for s in r3.slots] == [date(2026, 12, 4), date(2026, 12, 8)]
    r4 = schedule_round([RoundPlant(1), RoundPlant(2)], date(2026, 12, 4), 1, weekdays=(0, 1, 2, 3, 4, 5))
    assert [s.start_day for s in r4.slots] == [date(2026, 12, 4), date(2026, 12, 5)]
    # what does not fit the horizon is reported, not dropped silently
    r5 = schedule_round([RoundPlant(i) for i in range(10)], date(2026, 12, 1), 1, horizon_days=7)
    assert len(r5.slots) == 5 and len(r5.unscheduled) == 5
