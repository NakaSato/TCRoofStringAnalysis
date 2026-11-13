"""`/growatt/live/plants/today`: today's energy per plant from `plant/data`, swept, memory only."""

from __future__ import annotations

from datetime import datetime

from app.services.growatt_live import GrowattLiveService, get_live_service
from solar_core.growatt import GrowattAPIError

from tests.test_growatt_routes import PLANT, client  # noqa: F401  (fixture)

NOW = datetime(2026, 11, 14, 11, 0)


class _PlantData:
    def __init__(self, answers=None):
        self.calls: list = []
        self.fail: dict = {}
        self.answers = answers or {}

    def plant_data(self, plant_id):
        self.calls.append(plant_id)
        if plant_id in self.fail:
            raise self.fail[plant_id]
        return self.answers.get(plant_id, {"today_energy": "12.5", "last_update_time": "2026-11-14 10:55:00"})


class _Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def _svc(fake, clock, now=NOW, **kw):
    return GrowattLiveService(
        client_factory=lambda phase: fake,  # type: ignore[arg-type,return-value]
        clock=clock,
        phases=(1, 2),
        now_local=lambda: now,
        plant_today_ttl_s=300,
        **kw,
    )


def test_sweep_refreshes_at_most_n_plants_per_request():
    fake, clock = _PlantData(), _Clock()
    svc = _svc(fake, clock, plant_today_sweep=10)
    plants = [(i, 1 + i % 2) for i in range(25)]

    env = svc.plant_today(plants)
    assert len(fake.calls) == 10 and env["refresh_in_s"] == 15
    assert env["data"]["sweep"] == {"fresh": 10, "checked": 10, "total": 25, "oldest_age_s": 0}
    clock.t += 15
    svc.plant_today(plants)
    clock.t += 15
    env = svc.plant_today(plants)
    assert sorted(fake.calls) == list(range(25))  # each plant once
    assert env["refresh_in_s"] == 270
    assert env["data"]["day"] == "2026-11-14"
    assert env["data"]["plants"]["0"]["today_energy_kwh"] == 12.5
    svc.plant_today(plants)
    assert len(fake.calls) == 25  # all fresh: memory only


def test_upload_not_from_today_has_no_today_energy():
    fake, clock = _PlantData({7: {"today_energy": "40.1", "last_update_time": "2026-11-13 18:10:00"}, 8: {"today_energy": "3"}}), _Clock()
    env = _svc(fake, clock).plant_today([(7, 1), (8, 1)])
    assert env["data"]["plants"]["7"]["today_energy_kwh"] is None  # yesterday's total, not today's
    assert env["data"]["plants"]["7"]["last_update_time"] == "2026-11-13 18:10:00"
    assert env["data"]["plants"]["8"]["today_energy_kwh"] is None  # no upload time: unknown


def test_failed_plant_is_reported_and_cooled_down():
    fake, clock = _PlantData(), _Clock()
    fake.fail[2] = GrowattAPIError("rate limited", error_code=10012)
    svc = _svc(fake, clock, cooldown_s=60)
    env = svc.plant_today([(1, 1), (2, 1)])
    assert set(env["data"]["plants"]) == {"1"} and "2" in env["data"]["errors"]
    clock.t += 30
    svc.plant_today([(1, 1), (2, 1)])
    assert fake.calls.count(2) == 1  # not retried during its cooldown


def test_route_filters_to_assigned_plants_and_writes_nothing(client):  # noqa: F811
    fake, clock = _PlantData(), _Clock()
    svc = _svc(fake, clock)
    client.app_ref.dependency_overrides[get_live_service] = lambda: svc

    before = client.get("/api/growatt/plants").json()
    env = client.get("/api/growatt/live/plants/today").json()
    assert env["source"] == "live" and env["data"]["plants"][str(PLANT)]["today_energy_kwh"] == 12.5
    assert client.get("/api/growatt/plants").json() == before  # realtime values never reach the DB

    # an engineer with no plants assigned sweeps nothing
    tok = client.post("/api/auth/login", json={"username": "engineer", "password": "engineer123"}).json()["access_token"]
    env = client.get("/api/growatt/live/plants/today", headers={"Authorization": f"Bearer {tok}"}).json()
    assert env["data"]["plants"] == {} and env["data"]["sweep"]["total"] == 0
    assert fake.calls == [PLANT]


