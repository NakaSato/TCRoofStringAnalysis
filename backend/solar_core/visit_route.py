"""Visit order for one day of site visits (pure, stdlib only).

The matrix holds drive minutes between points: index 0 is the start point, 1..n are the
stops, and it may be asymmetric. Times are minutes after local midnight. A stop reached
before its window opens waits; one reached after it closes is still visited and counts as
late. Orders are ranked by total lateness, then finish time, then total driving.

Up to `MAX_EXACT` stops the search is exact (Held–Karp with Pareto labels), up to
`MAX_STOPS` it is a seeded local search (nearest neighbour starts, 2-opt, Or-opt).
"""

from __future__ import annotations

import math
import random
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

MAX_EXACT = 10  # exact search up to this many stops
MAX_STOPS = 25  # heuristic up to this many; more raises TooManyStops

_EPS = 1e-9  # float noise allowed when comparing objectives
_SEED = 7  # fixed: the heuristic gives the same order for the same input
_RANDOM_STARTS = 12  # randomised nearest-neighbour starts besides the plain ones
_RANDOM_PICK = 3  # a randomised start picks among this many nearest stops

EndMode = Literal["return", "last"]
Method = Literal["exact", "heuristic", "fixed", "trivial"]
_Cost = tuple[float, float, float]  # (late, finish, drive)


class TooManyStops(ValueError):
    """More stops than the solver plans in one day."""


@dataclass(frozen=True)
class StopSpec:
    service_min: float  # time on site
    window: tuple[float, float] | None = None  # allowed arrival, minutes after local midnight (open, close)


@dataclass(frozen=True)
class StopTimes:
    index: int  # matrix index of this stop (1..n)
    leg_drive_min: float  # drive from the previous point (start or previous stop)
    arrive_min: float  # minutes after local midnight
    wait_min: float  # waiting for the window to open (0 if none)
    depart_min: float  # arrive + wait + service
    late_min: float  # arrival after window close (0 when on time / no window)


@dataclass(frozen=True)
class Solution:
    order: list[int]  # matrix indices of the stops in visit order (a permutation of 1..n)
    stops: list[StopTimes]  # same order
    end_leg_drive_min: float | None  # last stop → start when end_mode == "return", else None
    end_arrive_min: float | None  # back at start (return), else None
    finish_min: float  # end_arrive_min (return) or last depart_min (last); leave_min when no stops
    drive_min: float  # total driving, incl. the return leg
    wait_min: float
    late_min: float  # sum of late_min
    method: Method


def _num(value: object, what: str) -> float:
    if value is None or isinstance(value, bool):
        raise ValueError(f"{what} is missing")
    try:
        x = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise ValueError(f"{what} is not a number: {value!r}") from None
    if not math.isfinite(x):
        raise ValueError(f"{what} is not finite: {value!r}")
    return x


class _Problem:
    """Validated input; node 0 = start, nodes 1..n = stops."""

    def __init__(self, duration_min: Sequence[Sequence[float]], stops: Sequence[StopSpec],
                 leave_min: float, end_mode: str) -> None:
        if end_mode not in ("return", "last"):
            raise ValueError(f"end_mode must be 'return' or 'last', not {end_mode!r}")
        n = len(stops)
        if len(duration_min) != n + 1:
            raise ValueError(f"duration matrix has {len(duration_min)} rows, expected {n + 1} (start + {n} stops)")
        d: list[list[float]] = []
        for i, row in enumerate(duration_min):
            if row is None or len(row) != n + 1:
                raise ValueError(f"duration matrix row {i} must have {n + 1} entries")
            out = []
            for j, v in enumerate(row):
                x = _num(v, f"duration [{i}][{j}]")
                if x < 0:
                    raise ValueError(f"duration [{i}][{j}] is negative: {x}")
                out.append(x)
            d.append(out)
        svc = [0.0] * (n + 1)
        wo = [-math.inf] * (n + 1)
        wc = [math.inf] * (n + 1)
        for k, s in enumerate(stops, start=1):
            svc[k] = _num(s.service_min, f"stop {k} service_min")
            if svc[k] < 0:
                raise ValueError(f"stop {k} service_min is negative: {svc[k]}")
            if s.window is not None:
                if len(s.window) != 2:
                    raise ValueError(f"stop {k} window must be (open, close)")
                lo = _num(s.window[0], f"stop {k} window open")
                hi = _num(s.window[1], f"stop {k} window close")
                if lo > hi:
                    raise ValueError(f"stop {k} window opens after it closes: ({lo}, {hi})")
                wo[k], wc[k] = lo, hi
        self.n = n
        self.d = d
        self.svc = svc
        self.wo = wo
        self.wc = wc
        self.leave = _num(leave_min, "leave_min")
        self.ret = end_mode == "return"
        self.has_windows = any(s.window is not None for s in stops)

    def start_state(self) -> tuple[int, float, float, float]:
        return (0, self.leave, 0.0, 0.0)  # (node, depart time, late so far, drive so far)

    def prefix(self, order: Sequence[int]) -> list[tuple[int, float, float, float]]:
        """State after each stop: prefix[k] = after the first k stops of `order`."""
        d, svc, wo, wc = self.d, self.svc, self.wo, self.wc
        node, t, late, drive = self.start_state()
        out = [(node, t, late, drive)]
        for j in order:
            leg = d[node][j]
            arr = t + leg
            drive += leg
            if arr > wc[j]:
                late += arr - wc[j]
            t = (max(arr, wo[j])) + svc[j]
            node = j
            out.append((node, t, late, drive))
        return out

    def tail(self, state: tuple[int, float, float, float], seq: Sequence[int],
             bound: tuple[float, float] | None = None) -> _Cost | None:
        """(late, finish, drive) of visiting `seq` from `state`, then the end leg.

        With `bound` = (late, finish) of a known route, None as soon as this one is
        certainly worse (lateness and time only grow along a route)."""
        d, svc, wo, wc = self.d, self.svc, self.wo, self.wc
        node, t, late, drive = state
        for j in seq:
            leg = d[node][j]
            arr = t + leg
            drive += leg
            if arr > wc[j]:
                late += arr - wc[j]
            t = (max(arr, wo[j])) + svc[j]
            node = j
            if bound is not None and (late > bound[0] + _EPS or (late >= bound[0] - _EPS and t > bound[1] + _EPS)):
                return None
        if self.ret:
            leg = d[node][0]
            drive += leg
            t += leg
        return (late, t, drive)

    def cost(self, order: Sequence[int]) -> _Cost:
        c = self.tail(self.start_state(), order)
        assert c is not None
        return c


def _better(a: _Cost, b: _Cost) -> bool:
    """a strictly better than b: less late, then earlier finish, then less driving."""
    for x, y in zip(a, b):
        if x < y - _EPS:
            return True
        if x > y + _EPS:
            return False
    return False


def _times(p: _Problem, order: Sequence[int], method: Method) -> Solution:
    d, svc, wo, wc = p.d, p.svc, p.wo, p.wc
    node, t = 0, p.leave
    drive = wait_tot = late_tot = 0.0
    stops = []
    for j in order:
        leg = d[node][j]
        arr = t + leg
        wait = wo[j] - arr if arr < wo[j] else 0.0
        late = arr - wc[j] if arr > wc[j] else 0.0
        t = arr + wait + svc[j]
        stops.append(StopTimes(index=j, leg_drive_min=leg, arrive_min=arr, wait_min=wait, depart_min=t, late_min=late))
        drive += leg
        wait_tot += wait
        late_tot += late
        node = j
    end_leg = end_arrive = None
    if p.ret:
        end_leg = d[node][0] if order else 0.0
        end_arrive = t + end_leg
        drive += end_leg
        t = end_arrive
    return Solution(order=list(order), stops=stops, end_leg_drive_min=end_leg, end_arrive_min=end_arrive,
                    finish_min=t, drive_min=drive, wait_min=wait_tot, late_min=late_tot, method=method)


def _check_order(p: _Problem, order: Sequence[int]) -> list[int]:
    out = [int(i) for i in order]
    if sorted(out) != list(range(1, p.n + 1)):
        raise ValueError(f"order must be a permutation of 1..{p.n}, got {list(order)!r}")
    return out


# --- exact: Held–Karp over (visited set, last stop) with Pareto labels ----------------------
#
# A label is (late, depart time, drive, node, parent label). From a given state the rest of
# the route adds the same driving whatever the label, and its lateness and finish time never
# decrease when it starts later. So a label no better in all three than another label of the
# same state can never complete to a better route and is dropped. Without windows every
# state keeps one label (time = leave + drive + service), i.e. plain Held–Karp.

def _insert(labels: list[tuple], new: tuple) -> None:
    late, t, drive = new[0], new[1], new[2]
    for o in labels:
        if o[0] <= late and o[1] <= t and o[2] <= drive:
            return
    labels[:] = [o for o in labels if not (late <= o[0] and t <= o[1] and drive <= o[2])]
    labels.append(new)


def _exact(p: _Problem) -> list[int]:
    n = p.n
    d, svc, wo, wc = p.d, p.svc, p.wo, p.wc
    full = (1 << n) - 1
    table: list[list[list[tuple]] | None] = [None] * (full + 1)

    def extend(lab: tuple, j: int) -> tuple:
        late, t, drive, node = lab[0], lab[1], lab[2], lab[3]
        leg = d[node][j]
        arr = t + leg
        if arr > wc[j]:
            late += arr - wc[j]
        return (late, (max(arr, wo[j])) + svc[j], drive + leg, j, lab)

    root = (0.0, p.leave, 0.0, 0, None)
    for k in range(n):
        row = table[1 << k] = [[] for _ in range(n)]
        row[k].append(extend(root, k + 1))
    for mask in range(1, full):
        row = table[mask]
        if row is None:
            continue
        for k in range(n):
            for lab in row[k]:
                for m in range(n):
                    bit = 1 << m
                    if mask & bit:
                        continue
                    nxt = table[mask | bit]
                    if nxt is None:
                        nxt = table[mask | bit] = [[] for _ in range(n)]
                    _insert(nxt[m], extend(lab, m + 1))
        table[mask] = None  # every label still needed is reachable from its children
    best: tuple | None = None
    best_cost: _Cost | None = None
    last_row = table[full]
    assert last_row is not None
    for k in range(n):
        for lab in last_row[k]:
            back = d[k + 1][0] if p.ret else 0.0
            c = (lab[0], lab[1] + back, lab[2] + back)
            if best_cost is None or _better(c, best_cost):
                best, best_cost = lab, c
    order = []
    while best is not None and best[3] != 0:
        order.append(best[3])
        best = best[4]
    return order[::-1]


# --- heuristic: seeded starts + 2-opt / Or-opt on the real objective -------------------------

def _nearest(p: _Problem, rng: random.Random | None) -> list[int]:
    """Greedy by earliest possible start of service; with `rng`, a random pick among the nearest few."""
    d, wo = p.d, p.wo
    left = list(range(1, p.n + 1))
    node, t = 0, p.leave
    order = []
    while left:
        ranked = sorted(left, key=lambda j: (max(t + d[node][j], wo[j]), j))
        j = ranked[rng.randrange(min(_RANDOM_PICK, len(ranked)))] if rng is not None else ranked[0]
        order.append(j)
        left.remove(j)
        arr = t + d[node][j]
        t = max(arr, wo[j]) + p.svc[j]
        node = j
    return order


def _improve(p: _Problem, order: list[int]) -> tuple[list[int], _Cost]:
    """First-improvement local search (Or-opt segments of 1–3, forward and reversed, then 2-opt)
    until a full pass finds nothing better. Every move is costed in full from the first changed
    position, so asymmetric legs, waits and windows are exact."""
    n = len(order)
    cur = list(order)
    cost = p.cost(cur)
    pref = p.prefix(cur)
    improved = True
    while improved:
        improved = False
        for seg_len in (1, 2, 3):
            for i in range(n - seg_len + 1):
                seg = cur[i:i + seg_len]
                rest = cur[:i] + cur[i + seg_len:]
                for k in range(len(rest) + 1):
                    for piece in ((seg, seg[::-1]) if seg_len > 1 else (seg,)):
                        if k == i and piece is seg:
                            continue
                        cand = rest[:k] + piece + rest[k:]
                        s = min(i, k)
                        c = p.tail(pref[s], cand[s:], (cost[0], cost[1]))
                        if c is not None and _better(c, cost):
                            cur, cost = cand, c
                            pref = p.prefix(cur)
                            seg = cur[i:i + seg_len]
                            rest = cur[:i] + cur[i + seg_len:]
                            improved = True
                            break
        for i in range(n - 1):
            for j in range(i + 1, n):
                cand = cur[:i] + cur[i:j + 1][::-1] + cur[j + 1:]
                c = p.tail(pref[i], cand[i:], (cost[0], cost[1]))
                if c is not None and _better(c, cost):
                    cur, cost = cand, c
                    pref = p.prefix(cur)
                    improved = True
    return cur, cost


def _heuristic(p: _Problem) -> list[int]:
    rng = random.Random(_SEED)
    starts = [_nearest(p, None), list(range(1, p.n + 1))]
    if p.has_windows:
        starts.append(sorted(range(1, p.n + 1), key=lambda j: (p.wc[j], p.wo[j], j)))
    starts += [_nearest(p, rng) for _ in range(_RANDOM_STARTS)]
    seen: set[tuple[int, ...]] = set()
    best: list[int] | None = None
    best_cost: _Cost | None = None
    for s in starts:
        if tuple(s) in seen:
            continue
        seen.add(tuple(s))
        o, c = _improve(p, s)
        if best_cost is None or _better(c, best_cost):
            best, best_cost = o, c
    assert best is not None
    return best


# --- public ---------------------------------------------------------------------------------

def evaluate(duration_min: Sequence[Sequence[float]], stops: Sequence[StopSpec], order: Sequence[int], *,
             leave_min: float, end_mode: EndMode = "return") -> Solution:
    """Times of visiting the stops in `order` (matrix indices 1..n), leaving the start at `leave_min`."""
    p = _Problem(duration_min, stops, leave_min, end_mode)
    return _times(p, _check_order(p, order), "fixed")


def solve(duration_min: Sequence[Sequence[float]], stops: Sequence[StopSpec], *, leave_min: float,
          end_mode: EndMode = "return", keep_order: bool = False) -> Solution:
    """Best visit order: least total lateness, then earliest finish, then least driving.

    `end_mode` "return" drives back to the start; "last" ends at the last stop's departure.
    `keep_order` only times the stops as given. More than `MAX_STOPS` raises TooManyStops."""
    p = _Problem(duration_min, stops, leave_min, end_mode)
    n = p.n
    if n > MAX_STOPS:
        raise TooManyStops(f"{n} stops is more than {MAX_STOPS} for one route; split the day into several routes")
    if keep_order:
        return _times(p, list(range(1, n + 1)), "fixed")
    if n <= 1:
        return _times(p, list(range(1, n + 1)), "trivial")
    if n <= MAX_EXACT:
        return _times(p, _exact(p), "exact")
    return _times(p, _heuristic(p), "heuristic")
