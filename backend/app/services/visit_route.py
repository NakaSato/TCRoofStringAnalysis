"""Site visit route: drive times, visit order and Google Maps links (docs/plans/site-visit-route.md §5).

`/growatt/routes/solve` takes a start point and up to `MAX_STOPS` plants and answers the best
visit order (`solar_core.visit_route`), times per stop, the route line and navigation links.

Drive times come from **Geoapify** (hosted routing on OpenStreetMap data; the answer carries
`ATTRIBUTION`, which its free plan requires near the map):
- `v1/routematrix` gives the duration / distance matrix the order is solved on;
- `v1/routing` (waypoints in visit order) gives the line and per-leg km / minutes; the chosen
  order is then timed on those legs, so the ETAs add up to the legs shown.

Without Geoapify (no key, an error, a timeout, the cooldown after one, or today's credit cap)
every pair is a **straight-line estimate**: great-circle km, and minutes from it with
`ROAD_FACTOR` and `STRAIGHT_LINE_SPEED_KMH` (modelled, never road data; `source:
"straight_line"` with `fallback_reason`). A single pair Geoapify cannot route (null in its
matrix) gets the same estimate; the answer then says `source: "geoapify"` with the count in
`straight_line_pairs`.

Credits: Geoapify's free plan has 3,000 credits a day and does not block past them, so the
backend keeps its own cap (`GEOAPIFY_DAILY_CREDITS`). A call's cost is worked out before it is
made (`matrix_credits`, `routing_credits`); one that would pass the cap is not made. Credits of
answered calls are counted per Bangkok day in `external_api_call_counts` (api `geoapify`; the
`calls` column holds credits, not calls).

Nothing of a solve is stored (root CLAUDE.md rules 1 / 2): the matrix (keyed by the set of
points, so a reorder of the same stops costs nothing) and the route line (keyed by the ordered
waypoints) are cached in memory (`live_store.cache_map`, mirrored in Redis when configured) for
24 h. The API key is a query parameter Geoapify requires: requests (not httpx, which logs every
URL at INFO) carries it, and error messages name only the exception type, never the URL.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from collections import deque
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta
from functools import lru_cache
from typing import Any, Callable, Deque, Dict, List, Optional, Sequence, Tuple
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import requests
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import allowed_plant_ids
from app.config import settings
from app.db.models import GrowattPlant, RouteOffice, User
from app.services import google_weather as gw
from app.services.growatt_common import GrowattNotFound
from app.services.growatt_live.core import PLANT_UTC_OFFSET_H
from app.services.live_store import RedisLink, TieredDict, cache_map, cooldown_map, redis_link
from solar_core.sun import sun_times
from solar_core.visit_route import MAX_STOPS, Solution, StopSpec, TooManyStops, evaluate, solve

log = logging.getLogger(__name__)

PLANT_TZ = ZoneInfo("Asia/Bangkok")
API = "geoapify"  # external_api_call_counts row; `calls` = credits

# Straight-line fallback (modelled). Road distance in Thailand is typically 1.2–1.4 × the
# great-circle distance between two sites; 60 km/h averages highway, town and rural roads for
# a service pickup. Both are estimates: the answer says `source: "straight_line"`.
EARTH_RADIUS_KM = 6371.0088
ROAD_FACTOR = 1.3
STRAIGHT_LINE_SPEED_KMH = 60.0

CACHE_TTL_S = 24 * 3600.0  # matrix and route line (memory / Redis only)
MAPS_MAX_WAYPOINTS = 3  # per Google Maps link: origin + 3 waypoints + destination (phones keep them all)
COORD_DECIMALS = 5  # ~1 m: what Geoapify is asked and the cache keys
MODE = "drive"
COOLDOWN_KEY = "geoapify"
ATTRIBUTION = ["Powered by Geoapify", "© OpenStreetMap contributors"]

# Geoapify pricing (its docs, 22 Nov 2026)
MATRIX_CREDIT_CAP = 10  # matrix = max(S, T) × min(S, T, 10)
ROUTING_FREE_KM = 500.0  # routing = waypoints − 1, +1 per 500 km over 500 km
ROUTING_KM_PER_CREDIT = 500.0

Point = Tuple[float, float]  # (lat, lon)

FALLBACK_REASONS = ("no_key", "error", "cooldown", "budget")


# --------------------------------------------------------------------------- errors


class GeoapifyError(RuntimeError):
    """A Geoapify call failed. `reason` is one of FALLBACK_REASONS; `cooldown` = start one."""

    def __init__(self, message: str, reason: str = "error", cooldown: bool = True):
        super().__init__(message)
        self.reason = reason
        self.cooldown = cooldown


class NoLocation(ValueError):
    """Plants without a usable location in Growatt (null or 0,0): they can't be routed."""

    def __init__(self, plants: List[Dict[str, Any]]):
        super().__init__("no location in Growatt, can't be routed")
        self.plants = plants


class RateLimited(RuntimeError):
    def __init__(self, retry_after_s: float):
        super().__init__("Too many route solves; try again in a minute.")
        self.retry_after_s = retry_after_s


# --------------------------------------------------------------------------- geometry helpers


def usable_location(lat: Optional[float], lon: Optional[float]) -> bool:
    """A coordinate pair that can be routed: both set, finite, in range and not Growatt's 0,0
    "not set" (the registry's `normalize_coords` already nulls pairs outside Thailand)."""
    if lat is None or lon is None:
        return False
    try:
        la, lo = float(lat), float(lon)
    except (TypeError, ValueError):
        return False
    if not (math.isfinite(la) and math.isfinite(lo)):
        return False
    if la == 0 and lo == 0:
        return False
    return abs(la) <= 90 and abs(lo) <= 180


def rounded(p: Point) -> Point:
    return (round(p[0], COORD_DECIMALS), round(p[1], COORD_DECIMALS))


def haversine_km(a: Point, b: Point) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(min(1.0, math.sqrt(h)))


def straight_line_min(km: float) -> float:
    """Modelled drive minutes for a great-circle distance: km × road factor ÷ average speed."""
    return km * ROAD_FACTOR / STRAIGHT_LINE_SPEED_KMH * 60.0


def _latlon(p: Point) -> str:
    return f"{p[0]:.{COORD_DECIMALS}f},{p[1]:.{COORD_DECIMALS}f}"


def google_maps_links(points: Sequence[Point]) -> List[str]:
    """Navigation links over `points` in driving order, each with at most `MAPS_MAX_WAYPOINTS`
    waypoints between origin and destination; each link starts where the previous one ended."""
    links: List[str] = []
    step = MAPS_MAX_WAYPOINTS + 1  # legs per link
    i = 0
    while i < len(points) - 1:
        chunk = points[i : i + step + 1]
        params = {"api": "1", "origin": _latlon(chunk[0]), "destination": _latlon(chunk[-1])}
        if len(chunk) > 2:
            params["waypoints"] = "|".join(_latlon(p) for p in chunk[1:-1])
        params["travelmode"] = "driving"
        params["dir_action"] = "navigate"
        links.append("https://www.google.com/maps/dir/?" + urlencode(params, safe=","))
        i += step
    return links


def parse_hhmm(text: str) -> float:
    h, m = text.split(":")
    return int(h) * 60 + int(m)


def fmt_hhmm(minutes: Optional[float]) -> Optional[str]:
    """Clock time of minutes after local midnight; past midnight gets "+1" (next day)."""
    if minutes is None:
        return None
    total = int(round(minutes))
    days, rest = divmod(total, 1440)
    out = f"{rest // 60:02d}:{rest % 60:02d}"
    return out + (f"+{days}" if days else "")


def _r1(v: Optional[float]) -> Optional[float]:
    return None if v is None else round(float(v), 1)


def _num(v: Any) -> Optional[float]:
    if v is None or isinstance(v, bool):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) and f >= 0 else None


# --------------------------------------------------------------------------- credits


def matrix_credits(n_points: int) -> int:
    """Credits of an n × n `routematrix` call."""
    return n_points * min(n_points, MATRIX_CREDIT_CAP) if n_points > 0 else 0


def routing_credits(n_waypoints: int, km: float) -> int:
    """Credits of a `routing` call over `n_waypoints` covering `km`."""
    extra = math.ceil((km - ROUTING_FREE_KM) / ROUTING_KM_PER_CREDIT) if km > ROUTING_FREE_KM else 0
    return max(0, n_waypoints - 1) + extra


def _today() -> date:
    return datetime.now(PLANT_TZ).date()


def credits_today(db: Session) -> int:
    d = _today()
    return gw._calls(db, d, d + timedelta(days=1), API)


def credits_left(db: Session) -> int:
    return max(0, settings.geoapify_daily_credits - credits_today(db))


def record_credits(db: Session, n: int) -> None:
    gw.record_calls(db, API, n, _today())


# --------------------------------------------------------------------------- Geoapify client


class GeoapifyClient:
    """`routematrix` and `routing` (mode drive). Raises GeoapifyError."""

    def __init__(self, api_key: str, base_url: str = "https://api.geoapify.com/", timeout: float = 8.0,
                 session: Optional[requests.Session] = None):
        self._key = api_key
        self._base = base_url.rstrip("/") + "/"
        self._timeout = timeout
        self._http = session or requests.Session()

    def _answer(self, call: Callable[[], requests.Response], what: str) -> Dict[str, Any]:
        try:
            r = call()
        except requests.RequestException as exc:  # the message would carry the URL (and the key)
            raise GeoapifyError(f"Geoapify {what}: {type(exc).__name__}") from None
        try:
            body = r.json()
        except ValueError:
            body = None
        if r.status_code != 200:
            msg = body.get("message") if isinstance(body, dict) else None
            # a request Geoapify refuses as malformed is not an outage: no cooldown for it
            bad_request = r.status_code in (400, 422)
            text = f"Geoapify {what} answered HTTP {r.status_code}" + (f": {str(msg)[:160]}" if msg else "")
            raise GeoapifyError(text, cooldown=not bad_request)
        if not isinstance(body, dict):
            raise GeoapifyError(f"Geoapify {what} answered no JSON")
        return body

    def matrix(self, points: Sequence[Point]) -> Dict[str, Any]:
        """`{time_s, distance_m}`: n × n, None where Geoapify has no route for the pair."""
        locs = [{"location": [p[1], p[0]]} for p in points]
        body = self._answer(
            lambda: self._http.post(
                self._base + "v1/routematrix", params={"apiKey": self._key},
                json={"mode": MODE, "sources": locs, "targets": locs}, timeout=self._timeout,
            ),
            "routematrix",
        )
        rows = body.get("sources_to_targets")
        n = len(points)
        if not isinstance(rows, list) or len(rows) != n:
            raise GeoapifyError("Geoapify routematrix answered no matrix")
        t: List[List[Optional[float]]] = [[None] * n for _ in range(n)]
        d: List[List[Optional[float]]] = [[None] * n for _ in range(n)]
        for i, row in enumerate(rows):
            if not isinstance(row, list):
                raise GeoapifyError("Geoapify routematrix answered no matrix")
            for j, cell in enumerate(row):
                if not isinstance(cell, dict):
                    continue
                si = cell.get("source_index", i)
                ti = cell.get("target_index", j)
                if not (isinstance(si, int) and isinstance(ti, int) and 0 <= si < n and 0 <= ti < n):
                    continue
                t[si][ti] = _num(cell.get("time"))
                d[si][ti] = _num(cell.get("distance"))
        return {"time_s": t, "distance_m": d}

    def route(self, points: Sequence[Point]) -> Dict[str, Any]:
        """`{lines: [[[lon, lat]…] per leg], legs: [[distance_m, time_s]…], distance_m}`."""
        waypoints = "|".join(f"lonlat:{p[1]:.{COORD_DECIMALS}f},{p[0]:.{COORD_DECIMALS}f}" for p in points)
        body = self._answer(
            lambda: self._http.get(
                self._base + "v1/routing",
                params={"waypoints": waypoints, "mode": MODE, "apiKey": self._key},
                timeout=self._timeout,
            ),
            "routing",
        )
        feats = body.get("features")
        if not isinstance(feats, list) or not feats or not isinstance(feats[0], dict):
            raise GeoapifyError("Geoapify routing answered no route", cooldown=False)
        geom = feats[0].get("geometry") or {}
        props = feats[0].get("properties") or {}
        coords = geom.get("coordinates") if isinstance(geom, dict) else None
        if isinstance(geom, dict) and geom.get("type") == "LineString" and isinstance(coords, list):
            coords = [coords]  # a single-leg answer may come as one line
        legs = props.get("legs") if isinstance(props, dict) else None
        if not isinstance(coords, list) or not isinstance(legs, list) or len(legs) != len(points) - 1:
            raise GeoapifyError("Geoapify routing answered no geometry or legs")
        return {
            "lines": coords,
            "legs": [[_num(leg.get("distance")), _num(leg.get("time"))] if isinstance(leg, dict) else [None, None] for leg in legs],
            "distance_m": _num(props.get("distance")),
        }


class GeoapifyRouter:
    """Geoapify with a cooldown after a failure (`cooldown_map`), the daily credit cap, and the
    matrix / route line cached 24 h (`cache_map`, memory / Redis only). `client_factory` None =
    no key."""

    def __init__(
        self,
        client_factory: Optional[Callable[[], GeoapifyClient]],
        cooldown_s: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
        redis: Optional[RedisLink] = None,
    ):
        self._factory = client_factory
        self._client: Optional[GeoapifyClient] = None
        self.cooldown_s = cooldown_s
        self._clock = clock
        self._cooldown_until: TieredDict = cooldown_map("geoapify-cooldown", redis, clock)
        self._cache: TieredDict = cache_map("geoapify", redis, ttl_index=None, fixed_ttl_s=CACHE_TTL_S)
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return self._factory is not None

    def client(self) -> GeoapifyClient:
        if self._client is None:
            assert self._factory is not None
            self._client = self._factory()
        return self._client

    def _cached(self, key: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            hit = self._cache.get(key)
            if hit and self._clock() - hit[0] < CACHE_TTL_S:
                return hit[2]
        return None

    def _fetch(self, db: Session, key: str, cost: int, fn: Callable[[GeoapifyClient], Dict[str, Any]]) -> Tuple[Dict[str, Any], int]:
        """(data, credits spent); a cache hit costs 0. GeoapifyError when not asked or failed."""
        hit = self._cached(key)
        if hit is not None:
            return hit, 0
        if not self.enabled:
            raise GeoapifyError("Geoapify is not configured (GEOAPIFY_API_KEY empty)", "no_key", cooldown=False)
        if self._cooldown_until.get(COOLDOWN_KEY, 0.0) > self._clock():
            raise GeoapifyError("Geoapify cooldown after an error", "cooldown", cooldown=False)
        if cost > credits_left(db):
            raise GeoapifyError(
                f"Geoapify credits for today used up (cap {settings.geoapify_daily_credits}, this call {cost})",
                "budget", cooldown=False,
            )
        try:
            data = fn(self.client())
        except GeoapifyError as exc:
            if exc.cooldown:
                self._cooldown_until[COOLDOWN_KEY] = self._clock() + self.cooldown_s
            log.warning("Geoapify failed, straight-line estimates: %s", exc)
            raise
        with self._lock:
            self._cache[key] = (self._clock(), datetime.now().astimezone().isoformat(), data)
        return data, cost

    def matrix(self, db: Session, points: Sequence[Point]) -> Tuple[Dict[str, Any], int]:
        """Matrix over `points` (rounded, unique, sorted: the cache key is the set of points)."""
        key = "m:" + ";".join(_latlon(p) for p in points)
        data, cost = self._fetch(db, key, matrix_credits(len(points)), lambda c: c.matrix(points))
        if cost:
            record_credits(db, cost)
        return data, cost

    def route(self, db: Session, points: Sequence[Point], est_km: float) -> Tuple[Dict[str, Any], int]:
        """Route line through `points` in order; `est_km` (the matrix's road km) prices it."""
        key = "r:" + ";".join(_latlon(p) for p in points)
        data, cost = self._fetch(db, key, routing_credits(len(points), est_km), lambda c: c.route(points))
        if cost:  # count what the answer's own distance costs
            km = data.get("distance_m")
            cost = routing_credits(len(points), km / 1000.0 if km is not None else est_km)
            record_credits(db, cost)
        return data, cost


def make_client() -> GeoapifyClient:
    return GeoapifyClient(settings.geoapify_api_key, settings.geoapify_base_url, timeout=settings.geoapify_timeout_s)


@lru_cache(maxsize=1)
def get_router() -> GeoapifyRouter:
    """Process-wide router (FastAPI dependency; tests override it with a fake session)."""
    link = redis_link(settings.redis_url)
    return GeoapifyRouter(
        make_client if settings.geoapify_api_key else None,
        cooldown_s=settings.geoapify_cooldown_s,
        clock=time.time if link else time.monotonic,
        redis=link,
    )


# --------------------------------------------------------------------------- rate limit


class SlidingWindowLimiter:
    """At most `limit` calls per `window_s` per key, in process memory (Cloud Run runs one
    instance). Nothing is stored."""

    def __init__(self, window_s: float = 60.0, clock: Callable[[], float] = time.monotonic):
        self.window_s = window_s
        self._clock = clock
        self._hits: Dict[Any, Deque[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: Any, limit: int) -> None:
        """Count one call; RateLimited when `key` already made `limit` calls in the window."""
        if limit <= 0:
            return
        now = self._clock()
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and now - q[0] >= self.window_s:
                q.popleft()
            if len(q) >= limit:
                raise RateLimited(max(1.0, self.window_s - (now - q[0])))
            q.append(now)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


solve_limiter = SlidingWindowLimiter()


# --------------------------------------------------------------------------- matrix


@dataclass
class Matrix:
    minutes: List[List[float]]
    km: List[List[float]]
    straight: List[List[bool]]  # pair is a straight-line estimate
    source: str  # "geoapify" | "straight_line"
    straight_line_pairs: int
    fallback_reason: Optional[str]
    fallback_detail: Optional[str]
    credits: int


def straight_matrix(points: Sequence[Point], reason: str, detail: Optional[str]) -> Matrix:
    n = len(points)
    km = [[0.0 if i == j else haversine_km(points[i], points[j]) for j in range(n)] for i in range(n)]
    minutes = [[straight_line_min(km[i][j]) for j in range(n)] for i in range(n)]
    straight = [[i != j for j in range(n)] for i in range(n)]
    return Matrix(minutes, km, straight, "straight_line", n * (n - 1), reason, detail, 0)


def build_matrix(db: Session, points: Sequence[Point], router: GeoapifyRouter) -> Matrix:
    """Drive matrix over `points` (index 0 = start). Geoapify is asked for the unique points in
    sorted order, so the same stops in another order (or a repeated point) reuse its answer."""
    pts = [rounded(p) for p in points]
    unique = sorted(set(pts))
    pos = {p: k for k, p in enumerate(unique)}
    n = len(pts)
    if len(unique) < 2:  # every point the same place: nothing to drive
        z = [[0.0] * n for _ in range(n)]
        return Matrix(z, [r[:] for r in z], [[False] * n for _ in range(n)], "geoapify", 0, None, None, 0)
    try:
        data, credits = router.matrix(db, unique)
    except GeoapifyError as exc:
        return straight_matrix(pts, exc.reason, str(exc))
    minutes = [[0.0] * n for _ in range(n)]
    km = [[0.0] * n for _ in range(n)]
    straight = [[False] * n for _ in range(n)]
    pairs = 0
    for i in range(n):
        for j in range(n):
            a, b = pos[pts[i]], pos[pts[j]]
            if i == j or a == b:
                continue
            t = _num(data["time_s"][a][b])
            d = _num(data["distance_m"][a][b])
            if t is None or d is None:  # no route for this pair: straight line for it alone
                d_km = haversine_km(pts[i], pts[j])
                minutes[i][j], km[i][j], straight[i][j] = straight_line_min(d_km), d_km, True
                pairs += 1
                continue
            minutes[i][j], km[i][j] = t / 60.0, d / 1000.0
    routed = sum(1 for i in range(n) for j in range(n) if i != j and pos[pts[i]] != pos[pts[j]])
    if pairs and pairs == routed:
        m = straight_matrix(pts, "error", "Geoapify had no route for any pair")
        m.credits = credits
        return m
    return Matrix(minutes, km, straight, "geoapify", pairs, None, None, credits)


# --------------------------------------------------------------------------- solve


@dataclass
class _Place:
    plant_id: Optional[int]
    name: str
    lat: float
    lon: float
    office_id: Optional[int] = None

    @property
    def point(self) -> Point:
        return (self.lat, self.lon)


def _load_plants(db: Session, user: User, ids: Sequence[int]) -> Dict[int, GrowattPlant]:
    """The plants by id; an unknown plant or one outside the user's scope is GrowattNotFound
    (404, like every plant route: ids are not revealed). Plants without a usable location are
    NoLocation (422)."""
    allowed = allowed_plant_ids(db, user)
    for pid in ids:
        if allowed is not None and pid not in allowed:
            raise GrowattNotFound(f"Plant {pid} not found")
    rows = {p.plant_id: p for p in db.scalars(select(GrowattPlant).where(GrowattPlant.plant_id.in_(set(ids))))}
    for pid in ids:
        if pid not in rows:
            raise GrowattNotFound(f"Plant {pid} not found")
    missing = [
        {"plant_id": pid, "name": rows[pid].name}
        for pid in dict.fromkeys(ids)
        if not usable_location(rows[pid].latitude, rows[pid].longitude)
    ]
    if missing:
        raise NoLocation(missing)
    return rows


def _plant_place(p: GrowattPlant) -> _Place:
    """A plant `_load_plants` checked has a usable location."""
    lat, lon = p.latitude, p.longitude
    assert lat is not None and lon is not None
    return _Place(p.plant_id, p.name, float(lat), float(lon))


def _sunset_min(day: date, lat: float, lon: float) -> Optional[float]:
    st = sun_times(day, lat, lon, PLANT_UTC_OFFSET_H)
    if not st:
        return None
    return (st[1] - datetime(day.year, day.month, day.day)).total_seconds() / 60.0


def solve_route(db: Session, user: User, req: Any, router: GeoapifyRouter) -> Dict[str, Any]:
    """Answer of `POST /growatt/routes/solve` for a validated `RouteSolveRequest`."""
    if len(req.stops) > MAX_STOPS:
        raise TooManyStops(f"At most {MAX_STOPS} stops per route ({len(req.stops)} given): split the day.")
    day = req.day or _today()
    leave_min = parse_hhmm(req.leave_at)
    latest_min = parse_hhmm(req.latest_finish)

    office: Optional[RouteOffice] = None
    if req.start.kind == "office":  # saved offices are not plant-scoped (`/routes/offices`)
        office = db.get(RouteOffice, req.start.office_id)
        if office is None:
            raise GrowattNotFound(f"Office {req.start.office_id} not found")
    stop_ids = [s.plant_id for s in req.stops]
    ids = stop_ids + ([req.start.plant_id] if req.start.kind == "plant" else [])
    plants = _load_plants(db, user, ids)

    if req.start.kind == "plant":
        start = _plant_place(plants[req.start.plant_id])
    elif office is not None:
        start = _Place(None, office.name, float(office.lat), float(office.lon), office_id=office.id)
    else:
        start = _Place(None, req.start.label or "Start", float(req.start.lat), float(req.start.lon))
    places = [start] + [_plant_place(plants[pid]) for pid in stop_ids]
    points = [rounded(p.point) for p in places]

    mx = build_matrix(db, points, router)
    specs = [
        StopSpec(
            service_min=float(s.service_min),
            window=(parse_hhmm(s.window.open), parse_hhmm(s.window.close)) if s.window else None,
        )
        for s in req.stops
    ]
    sol = solve(mx.minutes, specs, leave_min=leave_min, end_mode=req.end_mode, keep_order=req.keep_order)

    # route line in visit order (start, stops…, start again for a round trip), one line per leg
    seq = [0] + list(sol.order) + ([0] if req.end_mode == "return" else [])
    path = [points[i] for i in seq]
    pairs = list(zip(seq, seq[1:]))
    leg_km = [mx.km[a][b] for a, b in pairs]
    leg_straight = [mx.straight[a][b] for a, b in pairs]
    lines = [[[points[a][1], points[a][0]], [points[b][1], points[b][0]]] for a, b in pairs]
    geometry_source = "straight_line"
    geometry_reason: Optional[str] = mx.fallback_reason
    credits = mx.credits
    if mx.source == "geoapify" and len(path) >= 2:
        try:
            rt, spent = router.route(db, path, est_km=sum(leg_km))
        except GeoapifyError as exc:
            geometry_reason = exc.reason
        else:
            credits += spent
            lines, geometry_source, geometry_reason = rt["lines"], "geoapify", None
            # time the chosen order on the route's own legs, so ETAs add up to the legs shown
            timed = [row[:] for row in mx.minutes]
            for k, (a, b) in enumerate(pairs):
                dist_m, time_s = rt["legs"][k]
                if time_s is not None and dist_m is not None:
                    timed[a][b] = time_s / 60.0
                    leg_km[k] = dist_m / 1000.0
                    leg_straight[k] = False
            sol = replace(
                evaluate(timed, specs, sol.order, leave_min=leave_min, end_mode=req.end_mode),
                method=sol.method,
            )
    return _answer(req, day, places, mx, sol, leg_km, leg_straight, lines, geometry_source, geometry_reason,
                   credits, db, leave_min, latest_min, path)


def _answer(
    req: Any,
    day: date,
    places: List[_Place],
    mx: Matrix,
    sol: Solution,
    leg_km: List[float],
    leg_straight: List[bool],
    lines: List[Any],
    geometry_source: str,
    geometry_reason: Optional[str],
    credits: int,
    db: Session,
    leave_min: float,
    latest_min: float,
    path: List[Point],
) -> Dict[str, Any]:
    stops_out: List[Dict[str, Any]] = []
    for k, st in enumerate(sol.stops):
        place = places[st.index]
        spec = req.stops[st.index - 1]
        sunset = _sunset_min(day, place.lat, place.lon)
        stops_out.append({
            "seq": k + 1,
            "plant_id": place.plant_id,
            "name": place.name,
            "lat": place.lat,
            "lon": place.lon,
            "service_min": float(spec.service_min),
            "window": {"open": spec.window.open, "close": spec.window.close} if spec.window else None,
            "eta": fmt_hhmm(st.arrive_min),
            "eta_min": _r1(st.arrive_min),
            "wait_min": _r1(st.wait_min),
            "etd": fmt_hhmm(st.depart_min),
            "etd_min": _r1(st.depart_min),
            "late_min": _r1(st.late_min),
            "sunset": fmt_hhmm(sunset),
            # the work on site ends after sunset / after the latest finish
            "after_sunset": None if sunset is None else st.depart_min > sunset,
            "after_latest": st.depart_min > latest_min,
            "leg_km": _r1(leg_km[k]),
            "leg_min": _r1(st.leg_drive_min),
            "leg_source": "straight_line" if leg_straight[k] else "geoapify",
        })

    return_leg = None
    if req.end_mode == "return" and sol.end_arrive_min is not None:
        return_leg = {
            "leg_km": _r1(leg_km[-1]),
            "leg_min": _r1(sol.end_leg_drive_min),
            "eta": fmt_hhmm(sol.end_arrive_min),
            "eta_min": _r1(sol.end_arrive_min),
            "after_latest": sol.end_arrive_min > latest_min,
            "leg_source": "straight_line" if leg_straight[-1] else "geoapify",
        }

    start = places[0]
    any_straight = (mx.source == "straight_line" or mx.straight_line_pairs > 0 or any(leg_straight)
                    or geometry_source == "straight_line")
    labels = {
        "drive": "road estimate (Geoapify, OpenStreetMap)" if mx.source == "geoapify" else "straight line, not road (modelled)",
    }
    if mx.source == "geoapify" and mx.straight_line_pairs:
        labels["straight_line_pairs"] = "pairs Geoapify could not route are straight-line estimates (modelled)"
    if geometry_source == "straight_line":
        labels["geometry"] = "straight segments between the points, not the road"
    used = mx.source == "geoapify" or geometry_source == "geoapify"
    return {
        "day": day.isoformat(),
        "end_mode": req.end_mode,
        "keep_order": bool(req.keep_order),
        "start": {"kind": req.start.kind, "plant_id": start.plant_id, "office_id": start.office_id,
                  "name": start.name, "lat": start.lat, "lon": start.lon},
        "stops": stops_out,
        "return_leg": return_leg,
        "totals": {
            "stops": len(stops_out),
            "drive_km": _r1(sum(leg_km)),
            "drive_min": _r1(sol.drive_min),
            "wait_min": _r1(sol.wait_min),
            "service_min": _r1(sum(float(s.service_min) for s in req.stops)),
            "late_min": _r1(sol.late_min),
            "leave_at": fmt_hhmm(leave_min),
            "finish": fmt_hhmm(sol.finish_min),
            "finish_min": _r1(sol.finish_min),
            "after_latest": sol.finish_min > latest_min,
        },
        "latest_finish": fmt_hhmm(latest_min),
        "method": sol.method,
        "source": mx.source,
        "fallback_reason": mx.fallback_reason,
        "fallback_detail": mx.fallback_detail,
        "straight_line_pairs": mx.straight_line_pairs,
        "estimate": (
            {"road_factor": ROAD_FACTOR, "speed_kmh": STRAIGHT_LINE_SPEED_KMH,
             "basis": "great-circle km; minutes = km × road factor ÷ average speed (modelled)"}
            if any_straight else None
        ),
        "geometry": {"type": "MultiLineString", "coordinates": lines},
        "geometry_source": geometry_source,
        "geometry_fallback_reason": geometry_reason if geometry_source == "straight_line" else None,
        "credits_used": credits,
        "credits_today": credits_today(db),
        "credits_daily_cap": settings.geoapify_daily_credits,
        "attribution": list(ATTRIBUTION) if used else [],
        "google_maps_links": google_maps_links(path),
        "labels": labels,
    }
