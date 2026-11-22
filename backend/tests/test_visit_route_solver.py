"""solar_core.visit_route: exact search vs brute force, heuristic quality, windows, edge cases."""

from __future__ import annotations

import itertools
import math
import random
import time

import pytest
from solar_core import visit_route as vr
from solar_core.visit_route import StopSpec, TooManyStops, evaluate, solve

# --- independent reference (does not use the module's own timing code) ----------------------

def _ref_cost(d, stops, order, leave, end_mode):
    node, t, late, drive = 0, leave, 0.0, 0.0
    for j in order:
        s = stops[j - 1]
        arr = t + d[node][j]
        drive += d[node][j]
        start = arr
        if s.window is not None:
            lo, hi = s.window
            start = max(arr, lo)
            late += max(0.0, arr - hi)
        t = start + s.service_min
        node = j
    if end_mode == "return":
        drive += d[node][0]
        t += d[node][0]
    return (late, t, drive)


def _brute(d, stops, leave, end_mode):
    n = len(stops)
    best = None
    for perm in itertools.permutations(range(1, n + 1)):
        c = _ref_cost(d, stops, perm, leave, end_mode)
        if best is None or _lex_less(c, best):
            best = c
    return best


def _lex_less(a, b, eps=1e-9):
    for x, y in zip(a, b):
        if x < y - eps:
            return True
        if x > y + eps:
            return False
    return False


def _instance(rng: random.Random, n: int, windows: bool):
    """Points on a ~60 km square, asymmetric drive minutes, 20–90 min on site."""
    pts = [(rng.uniform(0, 60), rng.uniform(0, 60)) for _ in range(n + 1)]
    d = [[0.0 if i == j else math.dist(pts[i], pts[j]) * 1.4 * rng.uniform(1.0, 1.35) + 3
          for j in range(n + 1)] for i in range(n + 1)]
    stops = []
    for _ in range(n):
        svc = rng.choice([20, 30, 45, 60, 90])
        win = None
        if windows and rng.random() < 0.6:
            lo = rng.uniform(8 * 60, 15 * 60)
            win = (lo, lo + rng.choice([30, 60, 120, 180]))
        stops.append(StopSpec(service_min=svc, window=win))
    return d, stops


def _obj(sol):
    return (sol.late_min, sol.finish_min, sol.drive_min)


# --- exact == brute force ---------------------------------------------------------------------

@pytest.mark.parametrize("end_mode", ["return", "last"])
@pytest.mark.parametrize("windows", [False, True])
def test_exact_matches_brute_force(end_mode, windows):
    rng = random.Random(1000 + windows * 7 + (end_mode == "last"))
    for n in range(2, 9):
        for _ in range(6 if n <= 6 else 3):
            d, stops = _instance(rng, n, windows)
            sol = solve(d, stops, leave_min=8 * 60, end_mode=end_mode)
            assert sol.method == "exact"
            assert sorted(sol.order) == list(range(1, n + 1))
            want = _brute(d, stops, 8 * 60, end_mode)
            assert _obj(sol) == pytest.approx(want, abs=1e-6)
            # the reported times are the times of that order
            assert _obj(sol) == pytest.approx(_ref_cost(d, stops, sol.order, 8 * 60, end_mode), abs=1e-6)


def test_exact_tight_windows_force_lateness():
    # every window closes at 08:10: someone is late whatever the order; least total lateness wins
    rng = random.Random(5)
    for _ in range(5):
        d, _ = _instance(rng, 6, False)
        stops = [StopSpec(30, (470.0, 490.0)) for _ in range(6)]
        sol = solve(d, stops, leave_min=480)
        assert sol.late_min > 0
        assert _obj(sol) == pytest.approx(_brute(d, stops, 480, "return"), abs=1e-6)


# --- heuristic --------------------------------------------------------------------------------

@pytest.mark.parametrize("windows", [False, True])
def test_heuristic_within_5pct_of_exact(windows):
    rng = random.Random(42 + windows)
    for _ in range(8):
        d, stops = _instance(rng, 10, windows)
        p = vr._Problem(d, stops, 480, "return")
        ex = p.cost(vr._exact(p))
        he = p.cost(vr._heuristic(p))
        # route length (finish - leave) plus lateness, heuristic within 5 % of the exact optimum
        assert he[0] + he[1] - 480 <= 1.05 * (ex[0] + ex[1] - 480) + 1e-6


def test_heuristic_25_stops_fast_and_deterministic():
    rng = random.Random(9)
    for windows in (False, True):
        d, stops = _instance(rng, 25, windows)
        t0 = time.perf_counter()
        a = solve(d, stops, leave_min=480)
        elapsed = time.perf_counter() - t0
        assert a.method == "heuristic"
        assert sorted(a.order) == list(range(1, 26))
        assert elapsed < 2.0
        b = solve(d, stops, leave_min=480)
        assert a == b
        # no worse than nearest neighbour or the given order
        p = vr._Problem(d, stops, 480, "return")
        for start in (vr._nearest(p, None), list(range(1, 26))):
            assert not vr._better(p.cost(start), _obj(a))


def test_exact_10_stops_fast():
    rng = random.Random(3)
    for windows in (False, True):
        d, stops = _instance(rng, 10, windows)
        t0 = time.perf_counter()
        sol = solve(d, stops, leave_min=480)
        assert time.perf_counter() - t0 < 1.0
        assert sol.method == "exact"


def test_method_by_size():
    rng = random.Random(1)
    d, stops = _instance(rng, 11, False)
    assert solve(d, stops, leave_min=480).method == "heuristic"
    d, stops = _instance(rng, 10, False)
    assert solve(d, stops, leave_min=480).method == "exact"


# --- windows ----------------------------------------------------------------------------------

def _line(n_stops, gap=10.0):
    """Start and stops on a line, `gap` minutes apart, symmetric."""
    return [[abs(i - j) * gap for j in range(n_stops + 1)] for i in range(n_stops + 1)]


def test_wait_when_early():
    d = _line(1)
    sol = evaluate(d, [StopSpec(30, (540.0, 600.0))], [1], leave_min=480)
    s = sol.stops[0]
    assert s.arrive_min == 490 and s.wait_min == 50 and s.late_min == 0 and s.depart_min == 570
    assert sol.wait_min == 50 and sol.finish_min == 580


def test_late_when_after_close():
    d = _line(1)
    sol = evaluate(d, [StopSpec(30, (400.0, 470.0))], [1], leave_min=480)
    s = sol.stops[0]
    assert s.arrive_min == 490 and s.wait_min == 0 and s.late_min == 20 and s.depart_min == 520
    assert sol.late_min == 20


def test_prefers_on_time_over_less_driving():
    # stop 1 is near, stop 2 far; stop 2 must be reached by 08:45. Near-first (1, 2) drives less
    # in total but arrives at 2 too late, so the solver goes to 2 first and drives more.
    d = [[0, 10, 40],
         [10, 0, 35],
         [40, 50, 0]]
    stops = [StopSpec(30), StopSpec(30, (480.0, 525.0))]
    near_first = evaluate(d, stops, [1, 2], leave_min=480)
    far_first = evaluate(d, stops, [2, 1], leave_min=480)
    assert near_first.late_min > 0 and far_first.late_min == 0
    assert far_first.drive_min > near_first.drive_min
    sol = solve(d, stops, leave_min=480)
    assert sol.order == [2, 1] and sol.late_min == 0


def test_lateness_beats_finish_time():
    # asymmetric: 0→1→2→0 finishes earlier but 2 is late; 0→2→1→0 is on time and finishes later
    d = [[0, 5, 10],
         [60, 0, 5],
         [5, 60, 0]]
    stops = [StopSpec(10), StopSpec(10, (480.0, 515.0))]
    a = evaluate(d, stops, [1, 2], leave_min=480)  # 2 at 500 on time, back 515
    b = evaluate(d, stops, [2, 1], leave_min=480)
    assert a.late_min == 0
    sol = solve(d, stops, leave_min=480)
    assert _obj(sol) == pytest.approx(min(_obj(a), _obj(b)))
    # now make 0→1→2 late: window at 2 closes before 500
    stops = [StopSpec(10), StopSpec(10, (480.0, 495.0))]
    a = evaluate(d, stops, [1, 2], leave_min=480)
    b = evaluate(d, stops, [2, 1], leave_min=480)
    assert a.late_min == 5 and b.late_min == 0 and b.finish_min > a.finish_min
    assert solve(d, stops, leave_min=480).order == [2, 1]


# --- times, end modes, options ----------------------------------------------------------------

def test_hand_checked_three_stops():
    # leave 08:00; asymmetric legs; stop 2 opens 09:00
    d = [[0, 15, 25, 40],
         [20, 0, 12, 30],
         [25, 14, 0, 18],
         [35, 28, 20, 0]]
    stops = [StopSpec(30), StopSpec(45, (540.0, 600.0)), StopSpec(20, (480.0, 560.0))]
    sol = evaluate(d, stops, [1, 2, 3], leave_min=480)
    got = [(s.index, s.leg_drive_min, s.arrive_min, s.wait_min, s.depart_min, s.late_min) for s in sol.stops]
    assert got == [
        (1, 15, 495, 0, 525, 0),   # 08:15 arrive, 30 on site
        (2, 12, 537, 3, 585, 0),   # 08:57 arrive, wait 3 for 09:00, 45 on site
        (3, 18, 603, 0, 623, 43),  # 10:03 arrive, window closed 09:20 → 43 late
    ]
    assert sol.end_leg_drive_min == 35 and sol.end_arrive_min == 658 and sol.finish_min == 658
    assert sol.drive_min == 15 + 12 + 18 + 35 and sol.wait_min == 3 and sol.late_min == 43
    assert sol.method == "fixed"
    best = solve(d, stops, leave_min=480)
    assert best.late_min == 0  # e.g. 3 first (08:25), then 1, then 2
    assert _obj(best) == pytest.approx(_brute(d, stops, 480, "return"))


def test_service_times_add_up():
    d = _line(4, gap=0.0)
    stops = [StopSpec(s) for s in (10, 20, 30, 40)]
    for end_mode in ("return", "last"):
        sol = solve(d, stops, leave_min=600, end_mode=end_mode)
        assert sol.finish_min == 700 and sol.drive_min == 0


def test_end_mode_last_has_no_return_leg():
    d = _line(3)
    stops = [StopSpec(10)] * 3
    ret = solve(d, stops, leave_min=480)
    last = solve(d, stops, leave_min=480, end_mode="last")
    assert last.end_leg_drive_min is None and last.end_arrive_min is None
    assert last.finish_min == last.stops[-1].depart_min
    assert last.order == [1, 2, 3] and last.drive_min == 30
    assert ret.end_leg_drive_min is not None and ret.finish_min == ret.end_arrive_min
    assert ret.drive_min == 60


def test_keep_order():
    rng = random.Random(4)
    d, stops = _instance(rng, 6, True)
    sol = solve(d, stops, leave_min=480, keep_order=True)
    assert sol.order == [1, 2, 3, 4, 5, 6] and sol.method == "fixed"
    assert sol == evaluate(d, stops, [1, 2, 3, 4, 5, 6], leave_min=480)


def test_trivial_cases():
    none = solve([[0]], [], leave_min=480)
    assert none.method == "trivial" and none.order == [] and none.stops == []
    assert none.finish_min == 480 and none.drive_min == 0
    none_last = solve([[0]], [], leave_min=480, end_mode="last")
    assert none_last.finish_min == 480 and none_last.end_leg_drive_min is None
    one = solve([[0, 12], [9, 0]], [StopSpec(30)], leave_min=480)
    assert one.method == "trivial" and one.order == [1]
    assert one.stops[0].arrive_min == 492 and one.finish_min == 492 + 30 + 9 and one.drive_min == 21


def test_too_many_stops():
    n = 26
    d = _line(n)
    with pytest.raises(TooManyStops, match="split the day"):
        solve(d, [StopSpec(10)] * n, leave_min=480)
    assert issubclass(TooManyStops, ValueError)
    assert vr.MAX_STOPS == 25 and vr.MAX_EXACT == 10


@pytest.mark.parametrize("d, stops", [
    ([[0, 1], [1, 0]], [StopSpec(10), StopSpec(10)]),                 # matrix too small
    ([[0, 1, 2], [1, 0], [2, 1, 0]], [StopSpec(10), StopSpec(10)]),   # ragged row
    ([[0, None], [1, 0]], [StopSpec(10)]),                            # unroutable pair
    ([[0, -1], [1, 0]], [StopSpec(10)]),                              # negative
    ([[0, float("nan")], [1, 0]], [StopSpec(10)]),                    # NaN
    ([[0, float("inf")], [1, 0]], [StopSpec(10)]),                    # inf
    ([[0, 1], [1, 0]], [StopSpec(-5)]),                               # negative service
    ([[0, 1], [1, 0]], [StopSpec(10, (600.0, 540.0))]),               # window open > close
])
def test_bad_input(d, stops):
    with pytest.raises(ValueError):
        solve(d, stops, leave_min=480)


def test_bad_order_and_end_mode():
    d = _line(2)
    stops = [StopSpec(10), StopSpec(10)]
    with pytest.raises(ValueError):
        evaluate(d, stops, [1, 1], leave_min=480)
    with pytest.raises(ValueError):
        evaluate(d, stops, [0, 1], leave_min=480)
    with pytest.raises(ValueError):
        solve(d, stops, leave_min=480, end_mode="loop")  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        solve(d, stops, leave_min=float("nan"))
