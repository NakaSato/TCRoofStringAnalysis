"""Live cache mirrored in Redis: round trip, cold start, cooldowns, Redis down, expiry."""

from __future__ import annotations

from datetime import date, datetime, timezone

from app import logging_db
from app.config import settings
from app.services import live_store as ls
from app.services.growatt_live import GrowattLiveService
from solar_core.growatt import GrowattAPIError


class FakeRedis:
    """The few Redis commands the store uses, with expiry on a fake clock."""

    def __init__(self, clock):
        self.data: dict = {}
        self.clock = clock
        self.fail = False

    def _check(self):
        if self.fail:
            raise ConnectionError("redis down")

    def get(self, k):
        self._check()
        v = self.data.get(k)
        if v is None or v[1] <= self.clock():
            return None
        return v[0]

    def set(self, k, v, ex):
        self._check()
        self.data[k] = (v, self.clock() + ex)

    def delete(self, k):
        self._check()
        self.data.pop(k, None)

    def ttl(self, k):
        return self.data[k][1] - self.clock()


class Clock:
    def __init__(self, t=1_800_000_000.0):
        self.t = t

    def __call__(self):
        return self.t


class EnvList:
    def __init__(self):
        self.calls: list = []
        self.fail = False

    def list_env_sensors(self, dl, refresh=False):
        self.calls.append(dl)
        if self.fail:
            raise GrowattAPIError("error_code=10012 rate limited")
        return [{"address": "1", "lost": "0", "lastUpdateTime": "2026-11-13 12:58:00"}]


def _svc(fake, clock, link):
    return GrowattLiveService(client_factory=lambda p: fake, clock=clock, phases=(1,), sensor_ttl_s=300, redis=link)  # type: ignore[arg-type,return-value]


def test_json_round_trip_keeps_datetimes_dates_and_tuples():
    v = (12.5, datetime(2026, 11, 13, 5, 0, tzinfo=timezone.utc), {"rows": [{"d": date(2026, 11, 13), "x": None, "t": (1, "a")}]}, 300.0)
    assert ls.loads(ls.dumps(v)) == v


def test_cold_start_reuses_cache_from_redis_without_calling_growatt():
    clock = Clock()
    redis = FakeRedis(clock)
    fake = EnvList()
    first = _svc(fake, clock, ls.RedisLink(redis, clock))
    first.sensor_status([("DL1", 1)])
    assert fake.calls == ["DL1"]

    # a new process (Cloud Run cold start): empty memory, same Redis
    clock.t += 60
    second = _svc(fake, clock, ls.RedisLink(redis, clock))
    env = second.sensor_status([("DL1", 1)])
    assert fake.calls == ["DL1"]  # served from Redis, not from Growatt
    assert env["data"]["sweep"]["fresh"] == 1 and env["data"]["dataloggers"]["DL1"]["sensors"][0]["address"] == 1


def test_cooldown_survives_a_restart():
    clock = Clock()
    redis = FakeRedis(clock)
    fake = EnvList()
    fake.fail = True
    _svc(fake, clock, ls.RedisLink(redis, clock)).sensor_status([("DL1", 1)])
    assert fake.calls == ["DL1"]
    clock.t += 10
    _svc(fake, clock, ls.RedisLink(redis, clock)).sensor_status([("DL1", 1)])
    assert fake.calls == ["DL1"]  # still cooling down after the restart: Growatt not asked again
    clock.t += 60
    _svc(fake, clock, ls.RedisLink(redis, clock)).sensor_status([("DL1", 1)])
    assert fake.calls == ["DL1", "DL1"]


def test_every_key_expires_and_entries_keep_one_stale_hour():
    clock = Clock()
    redis = FakeRedis(clock)
    _svc(EnvList(), clock, ls.RedisLink(redis, clock)).sensor_status([("DL1", 1)])
    (key,) = [k for k in redis.data if "growatt:" in k]
    assert key.startswith("tcroof:v1:growatt:")
    assert redis.ttl(key) == 300 + ls.STALE_KEEP_S


def test_redis_down_degrades_to_memory_and_retries_later():
    clock = Clock()
    redis = FakeRedis(clock)
    redis.fail = True
    link = ls.RedisLink(redis, clock)
    fake = EnvList()
    svc = _svc(fake, clock, link)
    env = svc.sensor_status([("DL1", 1)])  # no exception
    assert env["data"]["sweep"]["fresh"] == 1 and not link.up
    svc.sensor_status([("DL1", 1)])
    assert fake.calls == ["DL1"]  # memory cache still works
    redis.fail = False
    clock.t += ls.RETRY_S
    assert link.up and link.call(lambda r: r.get("x"), "dflt") is None


def test_value_that_is_not_json_safe_stays_in_memory_only():
    clock = Clock()
    redis = FakeRedis(clock)
    d = ls.cache_map("t", ls.RedisLink(redis, clock), ttl_index=None, fixed_ttl_s=60)
    d["k"] = (1.0, datetime.now(timezone.utc), {"obj": object()})
    assert d.get("k") is not None and redis.data == {}


def test_without_redis_it_is_a_plain_memory_map():
    d = ls.cache_map("t", None, ttl_index=3)
    assert d.get("x") is None and "x" not in d
    d["x"] = (1, 2, 3, 4)
    assert d["x"] == (1, 2, 3, 4) and d.pop("x") == (1, 2, 3, 4) and d.get("x", 5) == 5


def test_redis_url_password_is_redacted(monkeypatch):
    monkeypatch.setattr(settings, "redis_url", "redis://:r3disPassw0rdXYZ@10.128.0.5:6379/0")
    out = logging_db.redact("connect redis://:r3disPassw0rdXYZ@10.128.0.5:6379/0 failed; pw r3disPassw0rdXYZ") or ""
    assert "r3disPassw0rd" not in out and out.count("***") == 2
