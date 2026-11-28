"""Parity fixtures for the Rust port of backend/solar_core (crate tcroof-core).

Run from the repo root:

    PYTHONPATH=backend uv run python rust/crates/solar-core/tests/fixtures/gen.py

It calls the Python functions (the behavioural oracle) over a broad, deterministic set of
inputs and writes one JSON file per module next to this script. The Rust tests in
rust/crates/solar-core/tests/ load them and assert the same results. Non-finite floats are
written as the strings "nan", "inf" and "-inf" (JSON has no such numbers).
"""

from __future__ import annotations

import json
import math
import random
from datetime import date, timedelta
from pathlib import Path

from solar_core import om_planning as om
from solar_core import sun
from solar_core import visit_route as vr

HERE = Path(__file__).resolve().parent


def f(x):
    """A float for JSON: non-finite values as strings."""
    if x is None:
        return None
    x = float(x)
    if math.isnan(x):
        return "nan"
    if math.isinf(x):
        return "inf" if x > 0 else "-inf"
    return x


def dt(x):
    return x.strftime("%Y-%m-%dT%H:%M:%S.%f")


def write(name, data):
    path = HERE / name
    path.write_text(json.dumps(data, indent=None, separators=(",", ":"), allow_nan=False) + "\n")
    print(f"{name}: {', '.join(f'{k} {len(v)}' for k, v in data.items())}")


# --------------------------------------------------------------------------------- sun

def gen_sun():
    rng = random.Random(20261127)
    days = [date(2024, 1, 1), date(2024, 2, 29), date(2024, 3, 20), date(2024, 6, 21), date(2024, 9, 22),
            date(2024, 12, 21), date(2024, 12, 31), date(2026, 11, 12), date(2026, 11, 10), date(2026, 11, 20),
            date(2027, 1, 1), date(2027, 7, 15), date(2000, 2, 29), date(1999, 12, 31)]
    days += [date(2020, 1, 1) + timedelta(days=rng.randrange(0, 365 * 10)) for _ in range(30)]
    lats = [-89.9, -80.0, -66.6, -45.0, -23.44, -0.5, 0.0, 5.6, 13.75, 13.7563, 18.79, 20.4, 45.0, 60.0,
            66.56, 70.0, 78.2, 89.9]
    lons = [-179.9, -120.0, -0.1, 0.0, 98.98, 100.5, 100.5018, 105.6, 151.2, 180.0]
    offsets = [7.0, 0.0, -5.0, 5.5, 5.75, -3.5, 12.75, 14.0, 9.5]
    sun_times = []
    for d in days:
        for lat in lats:
            lon = rng.choice(lons)
            off = rng.choice(offsets)
            r = sun.sun_times(d, lat, lon, off)
            sun_times.append({
                "day": d.isoformat(), "lat": lat, "lon": lon, "utc_offset_h": off,
                "result": None if r is None else [dt(r[0]), dt(r[1])],
            })
    # random coordinates too (both random lat and lon)
    for _ in range(400):
        d = date(2015, 1, 1) + timedelta(days=rng.randrange(0, 365 * 15))
        lat = round(rng.uniform(-90, 90), rng.choice([0, 2, 4, 6]))
        lon = round(rng.uniform(-180, 180), rng.choice([0, 2, 4, 6]))
        off = rng.choice(offsets + [round(lon / 15, 2)])
        r = sun.sun_times(d, lat, lon, off)
        sun_times.append({
            "day": d.isoformat(), "lat": lat, "lon": lon, "utc_offset_h": off,
            "result": None if r is None else [dt(r[0]), dt(r[1])],
        })

    clear_sky = []
    minutes = [0, 1, 180, 359.5, 360, 375.25, 420, 482.5, 600, 717.5, 720, 722.5, 900, 1020, 1062.5, 1080,
               1200, 1439, 1440]
    for d in days[:20]:
        for lat in (13.75, 18.79, 7.0, -33.9, 51.5, 69.6):
            for m in minutes:
                lon = rng.choice(lons)
                off = rng.choice(offsets)
                clear_sky.append({"day": d.isoformat(), "lat": lat, "lon": lon, "minute_of_day": m,
                                  "utc_offset_h": off, "ghi": f(sun.clear_sky_ghi(d, lat, lon, m, off))})
    # the default offset (7.0) and Bangkok every 2.5 min of one day
    for i in range(0, 577):
        m = i * 2.5
        clear_sky.append({"day": "2026-11-10", "lat": 13.75, "lon": 100.5, "minute_of_day": m,
                          "utc_offset_h": None, "ghi": f(sun.clear_sky_ghi(date(2026, 11, 10), 13.75, 100.5, m))})
    for _ in range(600):
        d = date(2015, 1, 1) + timedelta(days=rng.randrange(0, 365 * 15))
        lat, lon = rng.uniform(-60, 60), rng.uniform(-180, 180)
        m = round(rng.uniform(0, 1440), rng.choice([0, 1, 3]))
        off = rng.choice(offsets)
        clear_sky.append({"day": d.isoformat(), "lat": lat, "lon": lon, "minute_of_day": m,
                          "utc_offset_h": off, "ghi": f(sun.clear_sky_ghi(d, lat, lon, m, off))})
    write("sun.json", {"sun_times": sun_times, "clear_sky_ghi": clear_sky})


# ------------------------------------------------------------------------- visit route

def _instance(rng, n, windows, *, integer=False, symmetric=False, win_prob=0.6):
    """As backend/tests/test_visit_route_solver.py: points on a ~60 km square, asymmetric
    drive minutes, 20–90 min on site; `integer` rounds minutes (many ties)."""
    pts = [(rng.uniform(0, 60), rng.uniform(0, 60)) for _ in range(n + 1)]
    d = [[0.0 if i == j else math.dist(pts[i], pts[j]) * 1.4 * rng.uniform(1.0, 1.35) + 3
          for j in range(n + 1)] for i in range(n + 1)]
    if symmetric:
        for i in range(n + 1):
            for j in range(i):
                d[i][j] = d[j][i]
    if integer:
        d = [[float(round(x)) for x in row] for row in d]
    stops = []
    for _ in range(n):
        svc = rng.choice([20, 30, 45, 60, 90])
        win = None
        if windows and rng.random() < win_prob:
            lo = rng.uniform(8 * 60, 15 * 60)
            if integer:
                lo = float(round(lo))
            win = (lo, lo + rng.choice([30, 60, 120, 180]))
        stops.append(vr.StopSpec(service_min=svc, window=win))
    return d, stops


def _line(n, gap=10.0):
    return [[abs(i - j) * gap for j in range(n + 1)] for i in range(n + 1)]


def _sol(s: vr.Solution):
    return {
        "order": s.order,
        "stops": [[st.index, f(st.leg_drive_min), f(st.arrive_min), f(st.wait_min), f(st.depart_min),
                   f(st.late_min)] for st in s.stops],
        "end_leg_drive_min": f(s.end_leg_drive_min), "end_arrive_min": f(s.end_arrive_min),
        "finish_min": f(s.finish_min), "drive_min": f(s.drive_min), "wait_min": f(s.wait_min),
        "late_min": f(s.late_min), "method": s.method,
    }


def _case(kind, d, stops, leave, end_mode="return", keep_order=False, order=None):
    case = {
        "kind": kind,
        "matrix": [[f(v) if v is not None else None for v in row] for row in d],
        "stops": [[f(s.service_min), None if s.window is None else [f(s.window[0]), f(s.window[1])]]
                  for s in stops],
        "leave_min": f(leave), "end_mode": end_mode, "keep_order": keep_order, "order": order,
    }
    try:
        if kind == "evaluate":
            sol = vr.evaluate(d, stops, order, leave_min=leave, end_mode=end_mode)
        else:
            sol = vr.solve(d, stops, leave_min=leave, end_mode=end_mode, keep_order=keep_order)
        case["result"] = _sol(sol)
    except vr.TooManyStops:
        case["error"] = "TooManyStops"
    except ValueError:
        case["error"] = "ValueError"
    return case


def gen_visit_route():
    rng = random.Random(4242)
    cases = []
    # exact: every size, with and without windows, both end modes, float and integer matrices
    for n in range(0, 11):
        reps = 6 if n <= 7 else 3
        for windows in (False, True):
            for end_mode in ("return", "last"):
                for integer in (False, True):
                    for _ in range(reps if n >= 2 else 1):
                        d, stops = _instance(rng, n, windows, integer=integer, symmetric=integer and rng.random() < 0.5)
                        leave = rng.choice([420.0, 480.0, 510.5, 600.0])
                        cases.append(_case("solve", d, stops, leave, end_mode))
    # tight windows force lateness (all windows close early)
    for _ in range(6):
        d, _ = _instance(rng, 6, False)
        stops = [vr.StopSpec(30, (470.0, 490.0)) for _ in range(6)]
        cases.append(_case("solve", d, stops, 480.0))
    # ties everywhere: line / zero / constant matrices
    for n in (2, 3, 5, 8, 10, 11, 14, 25):
        for end_mode in ("return", "last"):
            cases.append(_case("solve", _line(n), [vr.StopSpec(10)] * n, 480.0, end_mode))
            cases.append(_case("solve", _line(n, 0.0), [vr.StopSpec(s) for s in range(n)], 600.0, end_mode))
            const = [[0.0 if i == j else 7.0 for j in range(n + 1)] for i in range(n + 1)]
            cases.append(_case("solve", const, [vr.StopSpec(15)] * n, 480.0, end_mode))
            cases.append(_case("solve", const, [vr.StopSpec(15, (500.0, 520.0))] * n, 480.0, end_mode))
    # heuristic: 11..25 stops
    for n in list(range(11, 26)) + [12, 15, 18, 20, 25, 25]:
        for windows in (False, True):
            d, stops = _instance(rng, n, windows, integer=rng.random() < 0.3)
            cases.append(_case("solve", d, stops, 480.0, rng.choice(["return", "last"])))
    # keep_order / evaluate
    for n in (0, 1, 3, 6, 12):
        d, stops = _instance(rng, n, True)
        cases.append(_case("solve", d, stops, 480.0, keep_order=True))
        order = list(range(1, n + 1))
        rng.shuffle(order)
        for end_mode in ("return", "last"):
            cases.append(_case("evaluate", d, stops, 480.0, end_mode, order=order))
    # the hand-checked examples of the Python tests
    d3 = [[0, 15, 25, 40], [20, 0, 12, 30], [25, 14, 0, 18], [35, 28, 20, 0]]
    s3 = [vr.StopSpec(30), vr.StopSpec(45, (540.0, 600.0)), vr.StopSpec(20, (480.0, 560.0))]
    cases.append(_case("evaluate", d3, s3, 480, order=[1, 2, 3]))
    cases.append(_case("solve", d3, s3, 480))
    d2 = [[0, 10, 40], [10, 0, 35], [40, 50, 0]]
    cases.append(_case("solve", d2, [vr.StopSpec(30), vr.StopSpec(30, (480.0, 525.0))], 480))
    d2b = [[0, 5, 10], [60, 0, 5], [5, 60, 0]]
    for close in (515.0, 495.0):
        st = [vr.StopSpec(10), vr.StopSpec(10, (480.0, close))]
        cases.append(_case("solve", d2b, st, 480))
        cases.append(_case("evaluate", d2b, st, 480, order=[1, 2]))
        cases.append(_case("evaluate", d2b, st, 480, order=[2, 1]))
    cases.append(_case("evaluate", _line(1), [vr.StopSpec(30, (540.0, 600.0))], 480, order=[1]))
    cases.append(_case("evaluate", _line(1), [vr.StopSpec(30, (400.0, 470.0))], 480, order=[1]))
    cases.append(_case("solve", [[0]], [], 480))
    cases.append(_case("solve", [[0]], [], 480, "last"))
    cases.append(_case("solve", [[0, 12], [9, 0]], [vr.StopSpec(30)], 480))
    cases.append(_case("solve", [[0, 12], [9, 0]], [vr.StopSpec(30)], 480, "last"))
    # errors
    nan, inf = float("nan"), float("inf")
    cases.append(_case("solve", _line(26), [vr.StopSpec(10)] * 26, 480))
    for d, stops in [
        ([[0, 1], [1, 0]], [vr.StopSpec(10), vr.StopSpec(10)]),
        ([[0, 1, 2], [1, 0], [2, 1, 0]], [vr.StopSpec(10), vr.StopSpec(10)]),
        ([[0, None], [1, 0]], [vr.StopSpec(10)]),
        ([[0, -1], [1, 0]], [vr.StopSpec(10)]),
        ([[0, nan], [1, 0]], [vr.StopSpec(10)]),
        ([[0, inf], [1, 0]], [vr.StopSpec(10)]),
        ([[0, 1], [1, 0]], [vr.StopSpec(-5)]),
        ([[0, 1], [1, 0]], [vr.StopSpec(nan)]),
        ([[0, 1], [1, 0]], [vr.StopSpec(10, (600.0, 540.0))]),
        ([[0, 1], [1, 0]], [vr.StopSpec(10, (nan, 540.0))]),
        ([[0, 1], [1, 0]], [vr.StopSpec(10, (500.0, inf))]),
    ]:
        cases.append(_case("solve", d, stops, 480))
    cases.append(_case("solve", _line(2), [vr.StopSpec(10)] * 2, nan))
    cases.append(_case("solve", _line(2), [vr.StopSpec(10)] * 2, inf))
    cases.append(_case("solve", _line(2), [vr.StopSpec(10)] * 2, 480, "loop"))
    for order in ([1, 1], [0, 1], [1], [1, 2, 3], [2, 1]):
        cases.append(_case("evaluate", _line(2), [vr.StopSpec(10)] * 2, 480, order=order))
    # zero-width windows and windows at -inf/inf edges of time
    cases.append(_case("solve", _line(3), [vr.StopSpec(10, (500.0, 500.0))] * 3, 480))
    cases.append(_case("solve", _line(3, 5.0), [vr.StopSpec(0, (0.0, 0.0)), vr.StopSpec(0), vr.StopSpec(0, (2000.0, 2000.0))], 0.0))

    # internals worth pinning: the seeded nearest-neighbour starts and the full heuristic on
    # small inputs (solve uses the exact search there)
    internals = []
    for n in (2, 3, 5, 8, 10):
        for windows in (False, True):
            d, stops = _instance(rng, n, windows, integer=rng.random() < 0.5)
            p = vr._Problem(d, stops, 480.0, "return")
            r = random.Random(vr._SEED)
            internals.append({
                "matrix": [[f(v) for v in row] for row in d],
                "stops": [[f(s.service_min), None if s.window is None else [f(s.window[0]), f(s.window[1])]]
                          for s in stops],
                "leave_min": 480.0, "end_mode": "return",
                "nearest": vr._nearest(p, None),
                "nearest_random": [vr._nearest(p, r) for _ in range(vr._RANDOM_STARTS)],
                "heuristic": vr._heuristic(p),
                "exact": vr._exact(p),
            })
    # Python's random.Random(7).randrange(k) stream (the heuristic's only random source)
    r = random.Random(7)
    stream = []
    for i in range(500):
        k = (i * 7 + 3) % 3 + 1
        stream.append([k, r.randrange(k)])
    write("visit_route.json", {"cases": cases, "internals": internals, "randrange_seed7": stream})


# ------------------------------------------------------------------------- om planning

def gen_om_planning():
    rng = random.Random(1188)
    add_months = []
    base = [date(2027, 1, 31), date(2026, 11, 30), date(2024, 2, 29), date(2024, 1, 29), date(2023, 12, 31),
            date(2000, 1, 31), date(1900, 3, 31), date(2026, 8, 31), date(2026, 5, 15)]
    base += [date(2010, 1, 1) + timedelta(days=rng.randrange(0, 365 * 20)) for _ in range(40)]
    for d in base:
        for n in (-25, -13, -12, -11, -1, 0, 1, 2, 3, 11, 12, 13, 24, 25, 100):
            add_months.append({"d": d.isoformat(), "n": n, "result": om.add_months(d, n).isoformat()})

    in_season = []
    for m in range(1, 13):
        for a in [None] + list(range(1, 13)):
            for b in [None] + list(range(1, 13)):
                in_season.append({"month": m, "from": a, "to": b, "result": om.in_season(m, a, b)})

    nwd = []
    for _ in range(300):
        d = date(2026, 1, 1) + timedelta(days=rng.randrange(0, 730))
        wd = sorted(rng.sample(range(7), rng.randrange(0, 4))) if rng.random() < 0.6 else list(om.WORKDAYS)
        hol = sorted({d + timedelta(days=rng.randrange(0, 20)) for _ in range(rng.randrange(0, 12))})
        r = om.next_working_day(d, wd, set(hol))
        nwd.append({"d": d.isoformat(), "weekdays": wd, "holidays": [h.isoformat() for h in hol],
                    "result": None if r is None else r.isoformat()})
    # 15 holidays in a row: nothing within 14 days
    d = date(2026, 12, 1)
    hol = [d + timedelta(days=i) for i in range(15)]
    nwd.append({"d": d.isoformat(), "weekdays": [0, 1, 2, 3, 4, 5, 6], "holidays": [h.isoformat() for h in hol],
                "result": None if om.next_working_day(d, range(7), set(hol)) is None else "?"})

    occ = []

    def occ_case(**kw):
        args = dict(kw)
        hol = args.pop("holidays", [])
        try:
            res = om.occurrences(args["starts_on"], args["every_n"], args["unit"], args["window_from"],
                                 args["window_to"], season_from=args.get("season_from"),
                                 season_to=args.get("season_to"), weekday=args.get("weekday"),
                                 ends_on=args.get("ends_on"), holidays=hol)
            out = {"result": [x.isoformat() for x in res]}
        except ValueError:
            out = {"error": "ValueError"}
        js = {k: (v.isoformat() if isinstance(v, date) else v) for k, v in args.items()}
        js["holidays"] = [h.isoformat() for h in hol]
        js.update(out)
        occ.append(js)

    # the Python tests' cases
    occ_case(starts_on=date(2026, 11, 2), every_n=2, unit="month", window_from=date(2026, 11, 1),
             window_to=date(2027, 12, 31), season_from=11, season_to=4)
    occ_case(starts_on=date(2026, 11, 2), every_n=2, unit="month", window_from=date(2026, 11, 1),
             window_to=date(2027, 2, 1), season_from=11, season_to=4, holidays=[date(2027, 1, 4)])
    occ_case(starts_on=date(2026, 11, 19), every_n=1, unit="week", window_from=date(2026, 11, 1),
             window_to=date(2027, 1, 1), weekday=2, ends_on=date(2026, 12, 9))
    occ_case(starts_on=date(2026, 1, 5), every_n=3, unit="month", window_from=date(2026, 11, 1),
             window_to=date(2027, 2, 1))
    occ_case(starts_on=date(2026, 1, 5), every_n=0, unit="month", window_from=date(2026, 1, 1),
             window_to=date(2026, 2, 1))
    occ_case(starts_on=date(2026, 1, 5), every_n=1, unit="day", window_from=date(2026, 1, 1),
             window_to=date(2026, 2, 1))
    occ_case(starts_on=date(2026, 1, 31), every_n=1, unit="month", window_from=date(2026, 1, 1),
             window_to=date(2026, 12, 31))
    occ_case(starts_on=date(2026, 1, 5), every_n=1, unit="week", window_from=date(2026, 1, 1),
             window_to=date(2026, 3, 1), weekday=6)
    occ_case(starts_on=date(2026, 1, 5), every_n=1, unit="week", window_from=date(2026, 1, 1),
             window_to=date(2026, 3, 1), weekday=7)
    occ_case(starts_on=date(2026, 3, 1), every_n=1, unit="month", window_from=date(2026, 1, 1),
             window_to=date(2026, 3, 1))
    occ_case(starts_on=date(2026, 3, 1), every_n=1, unit="month", window_from=date(2026, 1, 1),
             window_to=date(2026, 12, 31), ends_on=date(2026, 2, 1))
    # a shift that would land after the window end / ends_on
    occ_case(starts_on=date(2026, 2, 28), every_n=1, unit="month", window_from=date(2026, 1, 1),
             window_to=date(2026, 3, 28))
    for _ in range(250):
        starts = date(2025, 6, 1) + timedelta(days=rng.randrange(0, 500))
        wf = starts + timedelta(days=rng.randrange(-200, 200))
        wt = wf + timedelta(days=rng.randrange(-10, 500))
        unit = rng.choice(["week", "month"])
        every_n = rng.choice([1, 1, 2, 3, 4, 6, 12]) if unit == "month" else rng.choice([1, 1, 2, 3, 4, 8, 13])
        kw = dict(starts_on=starts, every_n=every_n, unit=unit, window_from=wf, window_to=wt)
        if rng.random() < 0.4:
            kw["season_from"], kw["season_to"] = rng.randrange(1, 13), rng.randrange(1, 13)
        elif rng.random() < 0.1:
            kw["season_from"] = rng.randrange(1, 13)
        if rng.random() < 0.4:
            kw["weekday"] = rng.randrange(0, 7)
        if rng.random() < 0.3:
            kw["ends_on"] = starts + timedelta(days=rng.randrange(-30, 400))
        if rng.random() < 0.5:
            kw["holidays"] = sorted({wf + timedelta(days=rng.randrange(0, 400)) for _ in range(rng.randrange(1, 40))})
        occ_case(**kw)

    def plant_js(p):
        return {"plant_id": p.plant_id, "crew_days": f(p.crew_days), "days_since": p.days_since, "group": p.group}

    def rand_plants(n):
        groups = [None, "", "A", "B", "Chiang Mai", "Bangkok"]
        out = []
        ids = rng.sample(range(1, 500), n)
        for pid in ids:
            out.append(om.RoundPlant(
                plant_id=pid,
                crew_days=rng.choice([None, None, 0.0, -1.0, 0.25, 0.3, 0.5, 0.5, 0.7, 1.0, 1.0, 1.5, 2.0, 2.5, 3.0,
                                      1.0000000001, 0.9999999999, float("nan")]),
                days_since=rng.choice([None, 0, 10, 10, 30, 90, 90, 200, rng.randrange(0, 400)]),
                group=rng.choice(groups),
            ))
        return out

    round_order = []
    for _ in range(120):
        ps = rand_plants(rng.randrange(0, 15))
        for grp in (True, False):
            round_order.append({"plants": [plant_js(p) for p in ps], "group": grp,
                                "result": [p.plant_id for p in om.round_order(ps, grp)]})

    sched = []

    def sched_case(ps, start, crews, *, weekdays=om.WORKDAYS, holidays=(), group=True, horizon_days=120):
        js = {"plants": [plant_js(p) for p in ps], "start": start.isoformat(), "crews": crews,
              "weekdays": list(weekdays), "holidays": [h.isoformat() for h in holidays], "group": group,
              "horizon_days": horizon_days}
        try:
            r = om.schedule_round(ps, start, crews, weekdays=weekdays, holidays=holidays, group=group,
                                  horizon_days=horizon_days)
            js["result"] = {
                "slots": [{"plant_id": s.plant_id, "start_day": s.start_day.isoformat(),
                           "end_day": s.end_day.isoformat(), "crew": s.crew, "crew_days": f(s.crew_days),
                           "duration_set": s.duration_set,
                           "working_days": [x.isoformat() for x in s.working_days]} for s in r.slots],
                "unscheduled": r.unscheduled, "order": r.order,
            }
        except ValueError:
            js["error"] = "ValueError"
        sched.append(js)

    RP = om.RoundPlant
    ps = [RP(1, 1.0, 200), RP(2, None, None), RP(3, 0.5, 10), RP(4, 0.5, 50), RP(5, 2.0, 30)]
    sched_case(ps, date(2026, 11, 20), 1, group=False)
    sched_case(ps, date(2026, 11, 20), 2, group=False)
    sched_case([RP(1), RP(2)], date(2026, 12, 4), 1, holidays=[date(2026, 12, 7)])
    sched_case([RP(1), RP(2)], date(2026, 12, 4), 1, weekdays=(0, 1, 2, 3, 4, 5))
    sched_case([RP(i) for i in range(10)], date(2026, 12, 1), 1, horizon_days=7)
    sched_case([RP(1)], date(2026, 12, 1), 0)
    sched_case([RP(1)], date(2026, 12, 5), 1, horizon_days=2)  # weekend only: no days
    sched_case([RP(1), RP(2)], date(2026, 12, 1), 1, horizon_days=0)
    sched_case([RP(1), RP(2)], date(2026, 12, 1), 1, horizon_days=-3)
    sched_case([], date(2026, 12, 1), 3)
    sched_case([RP(i, 0.3) for i in range(1, 11)], date(2026, 12, 1), 2)  # 0.3 × 3 = 0.9 (float sums)
    sched_case([RP(i, 0.1) for i in range(1, 25)], date(2026, 12, 1), 1)  # 0.1 × 10 just under 1
    sched_case([RP(i, 1 / 3) for i in range(1, 10)], date(2026, 12, 1), 1)
    for _ in range(200):
        ps = rand_plants(rng.randrange(0, 30))
        start = date(2026, 1, 1) + timedelta(days=rng.randrange(0, 400))
        wd = tuple(sorted(rng.sample(range(7), rng.randrange(1, 8)))) if rng.random() < 0.3 else om.WORKDAYS
        hol = sorted({start + timedelta(days=rng.randrange(0, 60)) for _ in range(rng.randrange(0, 10))})
        sched_case(ps, start, rng.choice([1, 1, 2, 3, 5]), weekdays=wd, holidays=hol, group=rng.random() < 0.6,
                   horizon_days=rng.choice([120, 120, 30, 10, 5]))

    wdays = []
    for _ in range(100):
        start = date(2026, 1, 1) + timedelta(days=rng.randrange(0, 400))
        wd = sorted(rng.sample(range(7), rng.randrange(0, 8)))
        hol = sorted({start + timedelta(days=rng.randrange(-5, 60)) for _ in range(rng.randrange(0, 10))})
        lim = rng.choice([-1, 0, 1, 7, 30, 120])
        wdays.append({"start": start.isoformat(), "weekdays": wd, "holidays": [h.isoformat() for h in hol],
                      "limit_days": lim, "result": [x.isoformat() for x in om.working_days(start, wd, hol, lim)]})

    write("om_planning.json", {"add_months": add_months, "in_season": in_season, "next_working_day": nwd,
                               "occurrences": occ, "working_days": wdays, "round_order": round_order,
                               "schedule_round": sched})


if __name__ == "__main__":
    gen_sun()
    gen_visit_route()
    gen_om_planning()
