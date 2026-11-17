"""`GrowattLiveService`: the live features (plants, inverters, sensors, snapshot, meter, alarms)."""

from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
import time
from datetime import date, datetime
from functools import lru_cache
from typing import Any, Callable, Dict, Hashable, List, Optional, Sequence, Set, Tuple, Union

from app.config import settings
from app.services.live_store import redis_link
from solar_core.growatt import ENV_FIELDS, GrowattClient, parse_env_records
from app.services.growatt_live.core import (
    ALARM_WORKERS,
    Coords,
    DEFAULT_INTERVAL_S,
    LATE_RETRY_S,
    LIVE_WORKERS,
    LiveCache,
    LiveUnavailable,
    MAX_INTERVAL_S,
    MIN_INTERVAL_S,
    PAST_DAY_ALARM_TTL_S,
    SENSOR_DAY_TTL_S,
    Ttl,
    UPLOAD_GRACE_S,
    _Result,
)
from app.services.growatt_live.rows import (
    SNAPSHOT_CHUNK,
    _alarm_row,
    _datalogger_rows,
    _env_row,
    _env_status_rows,
    _f,
    _latest_row,
    _maxs_rows,
    _meter_row,
    _plant_data_row,
    _record_gap,
)

class GrowattLiveService(LiveCache):
    """TTL cache + single-flight + stale fallback in front of the Growatt client.

    Growatt rate-limits per endpoint *and* per device / plant (error 10012 on a repeat call
    within a few minutes), so cooldowns are tracked per cache key: one refused inverter
    never blocks the others. `max_data` answers each inverter about once per 4-4.5 min
    (measured 2026-11-12; refused calls do not restart the wait), so `device_gap_s` keeps
    successful per-inverter calls at least that far apart.
    """

    def plants(self, coords: Optional[Coords] = None) -> Dict[str, Any]:
        """Realtime plant list from every account, merged. Each account is cached separately,
        so one failing account serves its last value (or is missing) while the others stay fresh.
        The envelope is `stale` when any account is stale or missing; raises only when all fail.
        `coords` = the fleet's plant locations (night mode)."""
        ttl = lambda _data: self._night(self.ttl_s, coords)

        def fn(client: GrowattClient, phase: int) -> list:
            return [
                {
                    "plant_id": int(p["plant_id"]),
                    "phase": phase,
                    "name": p.get("name"),
                    "current_power_w": _f(p.get("current_power")),
                    "total_energy_kwh": _f(p.get("total_energy")),
                    "peak_power_kwp": _f(p.get("peak_power")),
                    "status": p.get("status"),
                }
                for p in client.list_plants(refresh=True)
            ]

        if not self.phases:
            raise LiveUnavailable("no Growatt token configured")
        data: List[Dict[str, Any]] = []
        errors: Dict[str, str] = {}
        walls: List[datetime] = []
        refresh: List[float] = []
        stale = False
        # one account per thread: a cold cache costs the slowest account, not their sum
        with ThreadPoolExecutor(max_workers=len(self.phases)) as pool:
            futures = [
                (phase, pool.submit(self._get, ("plants", phase), lambda c, phase=phase: fn(c, phase), ttl, phase))
                for phase in self.phases
            ]
        for phase, fut in futures:
            key = ("plants", phase)
            try:
                r = fut.result()
            except LiveUnavailable as exc:
                errors[f"phase {phase}"] = str(exc)
                stale = True
                refresh.append(self._refresh_in(key))
                continue
            refresh.append(r.refresh_in)
            data.extend(r.data)
            walls.append(r.wall)
            stale = stale or r.stale
            if r.error:
                errors[f"phase {phase}"] = r.error
        if not walls:
            raise LiveUnavailable("; ".join(f"{k}: {e}" for k, e in errors.items()))
        error = "; ".join(f"{k}: {e}" for k, e in errors.items()) or None
        # oldest account fetch = how fresh the merged list is at worst
        # ask again as soon as any account can change
        return self._envelope(_Result(min(walls), data, stale=stale, error=error, refresh_in=min(refresh)))

    def inverters(self, plant_id: int, phase: Optional[int] = None, coords: Optional[Coords] = None) -> Dict[str, Any]:
        ph = self.resolve_phase(phase)
        ttl = lambda _data: self._night(self.ttl_s, coords)
        r = self._get(("inverters", ph, plant_id), lambda c: c.list_inverters(plant_id, refresh=True), ttl, ph)
        return self._envelope(r)

    def plant_dataloggers(
        self, plant_id: int, phase: Optional[int] = None, coords: Optional[Coords] = None
    ) -> Tuple[Optional[List[Dict[str, Any]]], Optional[str]]:
        """Online state of one plant's dataloggers (`device/datalogger/list`): (rows, error).
        Not persisted. One call per plant, cached `ttl_s` (night-stretched) under
        `("dataloggers", phase, plant_id)`; a refused call serves the last rows (each `stale`).

        It rides on `/live/plants/{id}/latest` and must never fail it: any failure answers
        (None, reason). A plant whose inverters are all silent while its datalogger still
        uploads has an inverter-side problem; a `lost` datalogger explains the silence."""
        try:
            ph = self.resolve_phase(phase)
            ttl = lambda _rows: self._night(self.ttl_s, coords)
            r = self._get(("dataloggers", ph, plant_id), lambda c: _datalogger_rows(c, plant_id), ttl, ph)
        except Exception as exc:  # LiveUnavailable, or a client without the endpoint
            return None, str(exc) or type(exc).__name__
        rows = [{**d, "stale": r.stale, "fetched_at": r.wall.isoformat()} for d in r.data]
        return rows, r.error

    def _latest_ttl(self, row: Optional[Dict[str, Any]]) -> float:
        """Cache one inverter's newest record until its next record should be on Growatt.

        Next record due = record time + measured upload interval + grace. Fetching earlier
        would return the same record; fetching on a fixed timer shows an old record for up to
        a whole TTL after the new one lands. Overdue by less than two intervals (a late
        upload): check every `LATE_RETRY_S`. Silent for longer (offline, evening) or no record
        today: fall back to `latest_ttl_s` instead of polling a quiet device every minute.
        """
        if row is None:
            return self.latest_ttl_s
        try:
            ts = datetime.strptime(row["timestamp"], "%Y-%m-%d %H:%M:%S")
        except (KeyError, TypeError, ValueError):
            return self.latest_ttl_s
        interval = row.get("interval_s")
        if interval is None or not MIN_INTERVAL_S <= interval <= MAX_INTERVAL_S:
            interval = DEFAULT_INTERVAL_S
        left = (ts - self._now_local()).total_seconds() + interval + UPLOAD_GRACE_S
        if left > 0:
            return min(left, interval + UPLOAD_GRACE_S)  # cap: record time ahead of our clock
        if -left < 2 * interval:
            return LATE_RETRY_S
        return self.latest_ttl_s

    def plant_latest(
        self,
        plant_id: int,
        device_sns: Sequence[str],
        day: date,
        phase: Optional[int] = None,
        coords: Optional[Coords] = None,
    ) -> Dict[str, Any]:
        """Newest record per inverter of one plant: power, MPPT and per-string V/I. Not persisted.

        Each inverter is cached separately, until its next record is due (`_latest_ttl`),
        so a refused inverter falls back to its own last value (`stale: true` on that item)
        while the others stay fresh. The envelope is `stale` only when no inverter is fresh.
        """
        ph = self.resolve_phase(phase)
        # never ask before Growatt would answer: >= device_gap_s since the last success
        ttl = lambda row: self._night(max(self.device_gap_s, self._latest_ttl(row)), coords)
        inverters: List[Dict[str, Any]] = []
        errors: Dict[str, str] = {}
        fresh_walls: List[datetime] = []
        all_walls: List[datetime] = []
        refresh: List[float] = []

        def one(sn: str) -> _Result:
            return self._get(("latest", sn, day), lambda c: _latest_row(c, sn, day), ttl, ph, gap_s=self.device_gap_s)

        # Cold cache = one max_data call per inverter: fetch them in parallel (a 17-inverter plant
        # otherwise waits for 17 Growatt round trips in a row). Per-key locks keep it one call per key.
        with ThreadPoolExecutor(max_workers=LIVE_WORKERS) as pool:
            futures = [(sn, pool.submit(one, sn)) for sn in device_sns]

        for sn, fut in futures:
            key = ("latest", sn, day)
            try:
                r = fut.result()
            except LiveUnavailable as exc:
                errors[sn] = str(exc)
                refresh.append(self._refresh_in(key))
                continue
            refresh.append(r.refresh_in)
            all_walls.append(r.wall)
            if r.error:
                errors[sn] = r.error
            if not r.stale:
                fresh_walls.append(r.wall)
            if r.data is not None:  # None = no record today (offline inverter)
                inverters.append({**r.data, "stale": r.stale, "fetched_at": r.wall.isoformat()})

        if not all_walls:
            raise LiveUnavailable("; ".join(f"{sn}: {e}" for sn, e in errors.items()) or "no inverters")
        stale = not fresh_walls
        return self._envelope(
            _Result(
                max(fresh_walls or all_walls),
                {"plant_id": plant_id, "day": day.isoformat(), "inverters": inverters, "errors": errors},
                stale=stale,
                error="; ".join(f"{sn}: {e}" for sn, e in errors.items()) or None,
                refresh_in=min(refresh),  # as soon as any inverter can change
            )
        )

    def plant_weather(
        self,
        plant_id: int,
        sensors: Sequence[Tuple[str, int, Optional[Sequence[str]]]],
        phase: Optional[int] = None,
        coords: Optional[Coords] = None,
    ) -> Dict[str, Any]:
        """Newest weather-sensor record per sensor of one plant (`env_last_data`). Not persisted.

        `sensors` = (datalogger_sn, address, measured fields or None). Fields outside
        `measured` (probes that read only 0 in the stored history) are returned as null.
        Each sensor is cached until its next 5-minute record is due, like `plant_latest`.
        """
        ph = self.resolve_phase(phase)
        ttl = lambda row: self._night(max(self.device_gap_s, self._latest_ttl(row)), coords)
        out: List[Dict[str, Any]] = []
        errors: Dict[str, str] = {}
        fresh_walls: List[datetime] = []
        all_walls: List[datetime] = []
        refresh: List[float] = []
        for dl, addr, measured in sensors:
            key = ("env", dl, addr)
            label = f"{dl}/{addr}"
            try:
                r = self._get(key, self._env_fetch(key, dl, addr), ttl, ph, gap_s=self.device_gap_s)
            except LiveUnavailable as exc:
                errors[label] = str(exc)
                refresh.append(self._refresh_in(key))
                continue
            refresh.append(r.refresh_in)
            all_walls.append(r.wall)
            if r.error:
                errors[label] = r.error
            if not r.stale:
                fresh_walls.append(r.wall)
            if r.data is not None:
                row = dict(r.data)
                if measured is not None:
                    for col in ENV_FIELDS.values():
                        if col not in measured:
                            row[col] = None
                row.pop("raw", None)  # the full record is only for the sensor Info view (`sensor_live`)
                out.append({**row, "stale": r.stale, "fetched_at": r.wall.isoformat()})
        if not all_walls:
            raise LiveUnavailable("; ".join(f"{k}: {e}" for k, e in errors.items()) or "no weather sensors")
        return self._envelope(
            _Result(
                max(fresh_walls or all_walls),
                {"plant_id": plant_id, "sensors": out, "errors": errors},
                stale=not fresh_walls,
                error="; ".join(f"{k}: {e}" for k, e in errors.items()) or None,
                refresh_in=min(refresh),
            )
        )

    def _env_fetch(self, key: Hashable, datalogger_sn: str, address: int) -> Callable[[GrowattClient], Any]:
        """`env_last_data` for one sensor, with `interval_s` measured from the record cached
        before it (memory / Redis only): `env_last_data` returns one record, so the gap between
        two different record times is the sensor's upload rhythm. A refetch of the same record
        keeps the interval already measured; the first record has none (`_latest_ttl` uses
        `DEFAULT_INTERVAL_S`). Gaps outside `MIN_INTERVAL_S`..`MAX_INTERVAL_S` are outages, not
        the rhythm, and are not used."""

        return self._interval_fetch(key, lambda c: _env_row(c, datalogger_sn, address))

    def sensor_status(
        self, dataloggers: Sequence[Tuple[str, Optional[int]]], coords: Optional[Coords] = None
    ) -> Dict[str, Any]:
        """Online state (`lost`, `lastUpdateTime`) of the weather sensors on `dataloggers`
        ((datalogger_sn, plant phase)), from `env_list`. Not persisted.

        One call per datalogger, so the fleet (~231) is swept incrementally: each request refreshes
        at most `sensor_sweep` dataloggers whose entry has expired, never fetched / oldest first,
        and serves the rest from memory. While some are not fresh, `refresh_in_s` is
        `SWEEP_REFRESH_S`, so a polling page converges on the whole fleet in a few minutes and
        then refreshes each datalogger about every `sensor_ttl_s`. A datalogger never fetched is
        absent from `data.dataloggers` (status unknown). The cache is shared by every user.
        """
        if not self.phases:
            raise LiveUnavailable("no Growatt token configured")
        ttl = lambda _rows: self._night(self.sensor_ttl_s, coords)
        sw = self._sweep(
            dict(dataloggers),
            lambda dl: ("envlist", dl),
            lambda dl: (lambda c: _env_status_rows(c, dl)),
            ttl,
            self.sensor_sweep,
            self.sensor_ttl_s,
        )
        out = {
            dl: {"fetched_at": wall.isoformat(), "stale": not fresh, "sensors": data}
            for dl, (wall, data, fresh) in sw.hits.items()
        }
        return self._envelope(
            _Result(
                sw.wall,
                {"dataloggers": out, "errors": sw.errors, "sweep": sw.stats},
                stale=sw.stale,
                error=sw.error,
                refresh_in=sw.refresh,
            )
        )

    def plant_today(self, plants: Sequence[Tuple[int, Optional[int]]], coords: Optional[Coords] = None) -> Dict[str, Any]:
        """Today's energy of each plant in `plants` ((plant_id, phase)) from `plant/data`, the
        only plant-level source of it (`plant/list` has none). Not persisted.

        One call per plant, so the fleet is swept like `sensor_status`: at most
        `plant_today_sweep` expired plants per request, oldest first, the rest from memory;
        each plant is reused for `plant_today_ttl_s` (night-stretched). `data.plants[id]`:
        `today_energy_kwh` is null when the plant's last upload is not from today (judged at
        request time, so a value cached before midnight never counts as today's).
        """
        if not self.phases:
            raise LiveUnavailable("no Growatt token configured")
        ttl = lambda _row: self._night(self.plant_today_ttl_s, coords)
        sw = self._sweep(
            {str(pid): ph for pid, ph in plants},
            lambda pid: ("pdata", pid),
            lambda pid: (lambda c: _plant_data_row(c, int(pid))),
            ttl,
            self.plant_today_sweep,
            self.plant_today_ttl_s,
        )
        today = self._now_local().date().isoformat()
        out: Dict[str, Dict[str, Any]] = {}
        for pid, (wall, row, fresh) in sw.hits.items():
            upd = row.get("last_update_time")
            is_today = bool(upd) and upd[:10] == today
            out[pid] = {
                "fetched_at": wall.isoformat(),
                "stale": not fresh,
                "last_update_time": upd,
                "today_energy_kwh": row.get("today_energy_kwh") if is_today else None,
            }
        return self._envelope(
            _Result(
                sw.wall,
                {"day": today, "plants": out, "errors": sw.errors, "sweep": sw.stats},
                stale=sw.stale,
                error=sw.error,
                refresh_in=sw.refresh,
            )
        )

    def inverter_snapshot(
        self,
        inverters: Sequence[Tuple[str, Optional[int]]],
        wanted: Optional[Set[str]] = None,
        coords: Optional[Coords] = None,
    ) -> Dict[str, Any]:
        """Newest record of every inverter in `inverters` ((serial, plant phase)) from `maxs_data`,
        SNAPSHOT_CHUNK serials per call. Not persisted.

        Each account's serials are cut into fixed sorted chunks, one cache key per chunk, swept
        like `sensor_status` (at most `snapshot_sweep` expired chunks per request, oldest first).
        `wanted` limits the reply (and the chunks swept) to those serials. Each record keeps its own
        time: a silent inverter's newest record can be months old and is served as such;
        `eac_today_kwh` is null unless the record is from today. It does not share `max_data`'s
        per-inverter rate limit, so it never delays `/live/plants/{id}/latest`."""
        if not self.phases:
            raise LiveUnavailable("no Growatt token configured")
        # untagged plants go with the first account; an account without a token keeps its phase,
        # so its chunks fail one by one (reported in `errors`) instead of the whole snapshot
        by_phase: Dict[int, List[str]] = {}
        for sn, ph in inverters:
            by_phase.setdefault(self.phases[0] if ph is None else ph, []).append(sn)
        # chunk id "p<phase>#<n>:<digest>": short for `errors`, and the digest of its serials
        # keeps a cached chunk from being reused for a different set after a registry change
        chunks: Dict[str, Optional[int]] = {}
        members: Dict[str, List[str]] = {}
        for ph, sns in sorted(by_phase.items()):
            sns = sorted(set(sns))
            for k in range(0, len(sns), SNAPSHOT_CHUNK):
                part = sns[k : k + SNAPSHOT_CHUNK]
                if wanted is None or wanted.intersection(part):
                    cid = f"p{ph}#{k // SNAPSHOT_CHUNK + 1}:{hashlib.sha1(','.join(part).encode()).hexdigest()[:10]}"
                    chunks[cid] = ph
                    members[cid] = part
        ttl = lambda _rows: self._night(self.snapshot_ttl_s, coords)
        sw = self._sweep(
            chunks,
            lambda cid: ("maxs", cid),
            lambda cid: (lambda c: _maxs_rows(c, members[cid])),
            ttl,
            self.snapshot_sweep,
            self.snapshot_ttl_s,
        )
        today = self._now_local().date().isoformat()
        out: Dict[str, Dict[str, Any]] = {}
        for _cid, (wall, rows, fresh) in sw.hits.items():
            for sn, row in rows.items():
                if wanted is not None and sn not in wanted:
                    continue
                rec_t = row.get("record_time")
                is_today = bool(rec_t) and str(rec_t)[:10] == today
                out[sn] = {
                    **row,
                    "eac_today_kwh": row.get("eac_today_kwh") if is_today else None,
                    "fetched_at": wall.isoformat(),
                    "stale": not fresh,
                }
        n_inv = sum(1 for sn, _ in inverters if wanted is None or sn in wanted)
        return self._envelope(
            _Result(
                sw.wall,
                {
                    "day": today,
                    "inverters": out,
                    "errors": sw.errors,
                    "sweep": {**sw.stats, "inverters": n_inv, "answered": len(out)},
                },
                stale=sw.stale,
                error=sw.error,
                refresh_in=sw.refresh,
            )
        )

    def sensor_live(
        self,
        datalogger_sn: str,
        address: int,
        phase: Optional[int] = None,
        measured: Optional[Sequence[str]] = None,
        coords: Optional[Coords] = None,
    ) -> Dict[str, Any]:
        """One weather sensor for its Info view: online state from its datalogger's `env_list`
        (the same shared cache as the fleet sweep, refreshed here if expired) and its newest
        `env_last_data` record (the same cache as `plant_weather`, so the two never double the
        calls). Not persisted. Fields outside `measured` are null in `reading`; `raw` is the
        record as Growatt reported it. Raises LiveUnavailable only when both parts fail.
        """
        ph = self.resolve_phase(phase)
        errors: Dict[str, str] = {}

        status_env: Optional[Dict[str, Any]] = None
        try:
            status_env = self.sensor_status([(datalogger_sn, phase)], coords=coords)
        except LiveUnavailable as exc:
            errors["status"] = str(exc)
        entry = status_env["data"]["dataloggers"].get(datalogger_sn) if status_env else None
        if status_env and status_env["data"]["errors"]:
            errors["status"] = "; ".join(status_env["data"]["errors"].values())

        key = ("env", datalogger_sn, address)
        ttl = lambda row: self._night(max(self.device_gap_s, self._latest_ttl(row)), coords)
        reading: Optional[Dict[str, Any]] = None
        raw: Optional[Dict[str, Any]] = None
        r: Optional[_Result] = None
        try:
            r = self._get(key, self._env_fetch(key, datalogger_sn, address), ttl, ph, gap_s=self.device_gap_s)
        except LiveUnavailable as exc:
            errors["reading"] = str(exc)
        if r is not None:
            if r.error:
                errors["reading"] = r.error
            if r.data is not None:
                row = dict(r.data)
                raw = row.pop("raw", None)
                if measured is not None:
                    for col in ENV_FIELDS.values():
                        if col not in measured:
                            row[col] = None
                reading = {**row, "stale": r.stale, "fetched_at": r.wall.isoformat()}

        if r is None and entry is None:
            raise LiveUnavailable("; ".join(f"{k}: {e}" for k, e in errors.items()) or "sensor unavailable")
        refresh = [x for x in (r.refresh_in if r else None, status_env["refresh_in_s"] if status_env else None) if x is not None]
        walls = [w for w in (r.wall if r else None,) if w is not None]
        if entry:
            walls.append(datetime.fromisoformat(entry["fetched_at"]))
        return self._envelope(
            _Result(
                min(walls),
                {
                # this datalogger's `env_list` entry ({fetched_at, stale, sensors}); None = not checked
                "datalogger": entry,
                    "reading": reading,
                    "raw": raw,
                    "errors": errors,
                },
                stale=bool((r is not None and r.stale) or (entry is not None and entry["stale"])),
                error="; ".join(f"{k}: {e}" for k, e in errors.items()) or None,
                refresh_in=min(refresh) if refresh else self.sensor_ttl_s,
            )
        )

    def sensor_today(
        self, datalogger_sn: str, address: int, phase: Optional[int] = None, coords: Optional[Coords] = None
    ) -> Dict[str, Any]:
        """Today's 5-minute records of one weather sensor straight from Growatt (`env_data`, today
        only), so the sensor page's chart is complete between the worker's syncs. Memory / Redis
        only, never written to SQL. Cached `SENSOR_DAY_TTL_S` (a new record every 5 min),
        stretched at night.

        `data.series` = [{timestamp (5-min slot, plant-local), <field>: value}], oldest first. As
        in the stored day series, a probe that reads 0 in every record today is not fitted, so it
        is null and missing from `data.measured`.
        """
        ph = self.resolve_phase(phase)
        day = self._now_local().date()
        key = ("envday", datalogger_sn, address, day.isoformat())
        ttl = lambda _rows: self._night(max(self.device_gap_s, SENSOR_DAY_TTL_S), coords)

        def fetch(client: GrowattClient) -> List[Dict[str, Any]]:
            rows = parse_env_records(datalogger_sn, address, client.env_history(datalogger_sn, address, day, day))
            out: Dict[str, Dict[str, Any]] = {}
            for r in sorted(rows, key=lambda r: r["timestamp"]):
                ts: datetime = r["timestamp"]
                if ts.date() != day:
                    continue
                slot = ts.replace(minute=ts.minute - ts.minute % 5, second=0, microsecond=0)
                out[slot.strftime("%Y-%m-%d %H:%M:%S")] = {col: r[col] for col in ENV_FIELDS.values()}  # newest in a slot wins
            return [{"timestamp": t, **v} for t, v in sorted(out.items())]

        r = self._get(key, fetch, ttl, ph, gap_s=self.device_gap_s)
        cols = list(ENV_FIELDS.values())
        measured = [c for c in cols if any((p[c] or 0) != 0 for p in r.data)]
        series = [{"timestamp": p["timestamp"], **{c: (p[c] if c in measured else None) for c in cols}} for p in r.data]
        return self._envelope(
            _Result(
                r.wall,
                {"day": day.isoformat(), "measured": measured, "series": series},
                stale=r.stale,
                error=r.error,
                refresh_in=r.refresh_in,
            )
        )

    def plant_meter(
        self,
        plant_id: int,
        meters: Sequence[Tuple[str, int]],
        phase: Optional[int] = None,
        coords: Optional[Coords] = None,
    ) -> Dict[str, Any]:
        """Newest energy-meter record per meter of one plant (`meter_last_data`). Not persisted.

        Cached per meter like `plant_weather` (until its next record is due, never sooner than
        `device_gap_s`, night-stretched). `active_power_w` is signed grid power at the meter
        (+ import / − export, as `growatt_meter`). `data.grid` sums the meters, only when every
        meter has a record (a partial sum would understate import); else its values are null.
        """
        ph = self.resolve_phase(phase)
        ttl = lambda row: self._night(max(self.device_gap_s, self._latest_ttl(row)), coords)
        out: List[Dict[str, Any]] = []
        errors: Dict[str, str] = {}
        fresh_walls: List[datetime] = []
        all_walls: List[datetime] = []
        refresh: List[float] = []
        for dl, addr in meters:
            key = ("meter", dl, addr)
            label = f"{dl}/{addr}"
            try:
                r = self._get(key, self._interval_fetch(key, lambda c, dl=dl, addr=addr: _meter_row(c, dl, addr)), ttl, ph, gap_s=self.device_gap_s)
            except LiveUnavailable as exc:
                errors[label] = str(exc)
                refresh.append(self._refresh_in(key))
                continue
            refresh.append(r.refresh_in)
            all_walls.append(r.wall)
            if r.error:
                errors[label] = r.error
            if not r.stale:
                fresh_walls.append(r.wall)
            if r.data is not None:
                out.append({**r.data, "stale": r.stale, "fetched_at": r.wall.isoformat()})
        if not all_walls:
            raise LiveUnavailable("; ".join(f"{k}: {e}" for k, e in errors.items()) or "no energy meters")
        powers = [m["active_power_w"] for m in out]
        whole = len(out) == len(meters) and all(p is not None for p in powers)
        kw = sum(powers) / 1000.0 if whole else None  # type: ignore[arg-type]
        grid = {
            "timestamp": max(m["timestamp"] for m in out) if out else None,
            "grid_power_kw": round(kw, 2) if kw is not None else None,
            "grid_import_kw": round(max(kw, 0.0), 2) if kw is not None else None,
            "grid_export_kw": round(max(-kw, 0.0), 2) if kw is not None else None,
        }
        return self._envelope(
            _Result(
                max(fresh_walls or all_walls),
                {"plant_id": plant_id, "meters": out, "grid": grid, "errors": errors},
                stale=not fresh_walls,
                error="; ".join(f"{k}: {e}" for k, e in errors.items()) or None,
                refresh_in=min(refresh),
            )
        )

    def _interval_fetch(self, key: Hashable, row_fn: Callable[[GrowattClient], Optional[Dict[str, Any]]]) -> Callable[[GrowattClient], Any]:
        """`row_fn` with `interval_s` measured from the record cached before it (see `_env_fetch`)."""

        def fetch(client: GrowattClient) -> Optional[Dict[str, Any]]:
            row = row_fn(client)
            hit = self._cache.get(key)
            prev = hit[2] if hit else None
            if row is not None and isinstance(prev, dict):
                row["interval_s"] = _record_gap(prev, row)
            return row

        return fetch

    def plant_alarms(
        self,
        plant_id: int,
        device_sns: Sequence[str],
        days: Sequence[date],
        phase: Optional[int] = None,
        coords: Optional[Coords] = None,
    ) -> Dict[str, Any]:
        """Growatt alarm / fault log of one plant's inverters over `days` (`device/max/alarm_data`
        answers one inverter-day per call). Newest alarm first.

        Held in memory like every live value (never written to SQL or Firestore). Each
        inverter-day is cached separately: a past day cannot change, so it is kept
        `PAST_DAY_ALARM_TTL_S`; today's log is refreshed every `ttl_s` (stretched at night).
        Calls run in a small thread pool; per-key locks keep them single-flight.
        """
        ph = self.resolve_phase(phase)
        today = self._now_local().date()
        keys = [(sn, d) for d in sorted(set(days)) for sn in device_sns]

        def one(sn: str, d: date) -> _Result:
            ttl: Ttl = PAST_DAY_ALARM_TTL_S if d < today else (lambda _x: self._night(self.ttl_s, coords))
            return self._get(
                ("alarms", sn, d), lambda c: [_alarm_row(sn, a) for a in c.max_alarms(sn, d)], ttl, ph
            )

        results: Dict[Tuple[str, date], Union[_Result, LiveUnavailable]] = {}
        with ThreadPoolExecutor(max_workers=ALARM_WORKERS) as pool:
            futures = {pool.submit(one, sn, d): (sn, d) for sn, d in keys}
            for fut, k in futures.items():
                try:
                    results[k] = fut.result()
                except LiveUnavailable as exc:
                    results[k] = exc

        alarms: List[Dict[str, Any]] = []
        errors: Dict[str, str] = {}
        fresh_walls: List[datetime] = []
        all_walls: List[datetime] = []
        refresh: List[float] = []
        for (sn, d), r in results.items():
            label = f"{sn} {d.isoformat()}"
            if isinstance(r, LiveUnavailable):
                errors[label] = str(r)
                refresh.append(self._refresh_in(("alarms", sn, d)))
                continue
            refresh.append(r.refresh_in)
            all_walls.append(r.wall)
            if r.error:
                errors[label] = r.error
            if not r.stale:
                fresh_walls.append(r.wall)
            alarms.extend(r.data)
        if not all_walls:
            raise LiveUnavailable("; ".join(f"{k}: {e}" for k, e in errors.items()) or "no inverters")
        alarms.sort(key=lambda a: a["start_time"] or "", reverse=True)
        ds = sorted(set(days))
        return self._envelope(
            _Result(
                min(all_walls),
                {
                    "plant_id": plant_id,
                    "from": ds[0].isoformat(),
                    "to": ds[-1].isoformat(),
                    "alarms": alarms,
                    "errors": errors,
                },
                stale=not fresh_walls,
                error="; ".join(f"{k}: {e}" for k, e in errors.items()) or None,
                refresh_in=min(refresh),
            )
        )


@lru_cache(maxsize=1)
def get_live_service() -> GrowattLiveService:
    accounts = settings.growatt_accounts()  # {phase: token}; tokens never leave the backend
    link = redis_link(settings.redis_url)
    return GrowattLiveService(
        # cached timestamps outlive the process in Redis: a wall clock, not monotonic
        clock=time.time if link else time.monotonic,
        redis=link,
        client_factory=lambda phase: GrowattClient(
            token=accounts[phase], base_url=settings.growatt_base_url, blocked_plant_ids=settings.blocked_plant_ids()
        ),
        ttl_s=settings.growatt_live_ttl_s,
        latest_ttl_s=settings.growatt_live_latest_ttl_s,
        night_ttl_s=settings.growatt_live_night_ttl_s,
        device_gap_s=settings.growatt_live_device_gap_s,
        sensor_ttl_s=settings.sensor_status_ttl_s,
        sensor_sweep=settings.sensor_sweep_per_request,
        plant_today_ttl_s=settings.plant_today_ttl_s,
        plant_today_sweep=settings.plant_today_sweep_per_request,
        snapshot_ttl_s=settings.inverter_snapshot_ttl_s,
        snapshot_sweep=settings.inverter_snapshot_sweep_per_request,
        phases=tuple(accounts),
    )
