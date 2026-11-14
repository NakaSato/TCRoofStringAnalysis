"""AI Assistant: read-only tools (scope, computed values), the streamed tool loop with a fake
provider, limits, and metering. No test calls the network."""

from __future__ import annotations

import json
from datetime import date, datetime, timezone
from types import SimpleNamespace
from typing import Any, Dict, List

import anthropic
import httpx2
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.db.models import AiUsage, GrowattPlant, User, UserPlantAssignment
from app.db.seed import ensure_seeded
from app.db.session import Base, build_engine, get_db, get_session_factory
from app.logging_db import redact
from app.main import create_app
from app.services.assistant import client as ai_client
from app.services.assistant.loop import ChatMessage, trim_history
from app.services.assistant.tools import ToolContext, run_tool, tool_definitions

from tests.test_growatt_routes import PLANT, _seed_growatt

TODAY = date(2026, 11, 12)
OTHER = 222  # a second plant with no readings at all


# ---------------------------------------------------------------------------------------------
# Fake Messages API


def _text(t: str) -> Any:
    return SimpleNamespace(type="text", text=t)


def _tool_use(id_: str, name: str, inp: Dict[str, Any]) -> Any:
    return SimpleNamespace(type="tool_use", id=id_, name=name, input=inp)


def _msg(content: List[Any], stop: str, inp: int = 100, out: int = 20, cached: int = 0) -> Any:
    usage = SimpleNamespace(
        input_tokens=inp, output_tokens=out, cache_read_input_tokens=0, cache_creation_input_tokens=0,
        prompt_tokens_details={"cached_tokens": cached},
    )
    return SimpleNamespace(content=content, stop_reason=stop, usage=usage)


class _Stream:
    def __init__(self, final: Any):
        self.final = final

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        for b in self.final.content:
            if b.type == "text":
                yield SimpleNamespace(type="content_block_delta", delta=SimpleNamespace(type="text_delta", text=b.text))

    def get_final_message(self):
        return self.final


class FakeClient:
    """Plays back scripted responses; records every request."""

    def __init__(self, script: List[Any]):
        self.script = list(script)
        self.requests: List[Dict[str, Any]] = []
        self.messages = self

    def stream(self, **kw: Any) -> _Stream:
        self.requests.append(json.loads(json.dumps(kw, default=str)))
        nxt = self.script.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return _Stream(nxt)


# ---------------------------------------------------------------------------------------------
# Fixtures


@pytest.fixture()
def env(tmp_path, monkeypatch):
    engine = build_engine(f"sqlite:///{tmp_path / 'assistant.db'}")
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)
    Base.metadata.create_all(bind=engine)
    with Session() as s:
        ensure_seeded(s)
        _seed_growatt(s)
        s.add(GrowattPlant(plant_id=OTHER, name="Other Plant", peak_power_kwp=10.0))
        s.commit()

    monkeypatch.setattr(settings, "ai_api_key", "test-ai-key-0123456789")
    monkeypatch.setattr(settings, "ai_model", "test-model")
    app = create_app()

    def _db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_session_factory] = lambda: Session
    c = TestClient(app)

    def login(name: str, pw: str) -> Dict[str, str]:
        tok = c.post("/api/auth/login", json={"username": name, "password": pw}).json()["access_token"]
        return {"Authorization": f"Bearer {tok}"}

    yield SimpleNamespace(client=c, Session=Session, login=login)
    ai_client.set_client(None)


def _events(resp) -> List[tuple]:
    out, ev = [], None
    for line in resp.text.splitlines():
        if line.startswith("event:"):
            ev = line[7:]
        elif line.startswith("data:"):
            out.append((ev, json.loads(line[5:])))
    return out


def _ctx(Session, allowed=None) -> ToolContext:
    return ToolContext(session_factory=Session, allowed=allowed, today=TODAY)


# ---------------------------------------------------------------------------------------------
# Tools


def test_tool_definitions_are_sorted_and_closed():
    defs = tool_definitions()
    assert [d["name"] for d in defs] == sorted(d["name"] for d in defs)
    assert all(d["input_schema"]["additionalProperties"] is False for d in defs)


def test_fleet_ranking_computes_specific_yield_and_keeps_no_data_plants_unranked(env):
    text, err = run_tool("fleet_ranking", {"day": "2026-11-11"}, _ctx(env.Session))
    assert not err
    r = json.loads(text)
    assert r["day"] == "2026-11-11" and r["metric"] == "specific_yield_kwh_kwp"
    [top] = r["ranking"]
    # last eac_today per inverter: 5.9 + 4.0 kWh (not the 99 kWh carried past midnight) on 20 kWp
    # = 0.495 kWh/kWp, computed by the server (rounded to 2 places), not left to the model
    assert top["plant_id"] == PLANT and top["yield_kwh"] == pytest.approx(9.9) and top["specific_yield_kwh_kwp"] == pytest.approx(0.49)
    assert top["rank"] == 1
    assert r["plants_without_data"] == 1 and r["plants_without_data_sample"][0]["plant_id"] == OTHER
    assert r["data_until"] == "2026-11-11 10:59"


def test_tools_hide_plants_outside_the_scope(env):
    scoped = _ctx(env.Session, allowed={OTHER})
    text, err = run_tool("plant_overview", {"plant_id": PLANT}, scoped)
    assert err and json.loads(text) == {"error": f"plant {PLANT} not found"}
    text, err = run_tool("list_plants", {}, scoped)
    assert not err and [p["plant_id"] for p in json.loads(text)["plants"]] == [OTHER]
    text, err = run_tool("fleet_ranking", {"day": "2026-11-11"}, scoped)
    assert json.loads(text)["ranking"] == []
    text, err = run_tool("alarms", {"plant_id": PLANT}, scoped)
    assert err


def test_tool_input_is_validated_and_days_are_bounded(env):
    ctx = _ctx(env.Session)
    text, err = run_tool("alarms", {"day": "2026-11-13"}, ctx)
    assert err and "future" in text
    text, err = run_tool("fleet_ranking", {"limit": 500}, ctx)
    assert err and "invalid input" in text
    text, err = run_tool("drop_tables", {}, ctx)
    assert err and "unknown tool" in text
    assert ctx.calls == ["alarms", "fleet_ranking", "drop_tables"]


def test_plant_overview_summary_keeps_nulls(env):
    text, err = run_tool("plant_overview", {"plant_id": PLANT, "day": "2026-11-11"}, _ctx(env.Session))
    assert not err
    r = json.loads(text)
    assert r["day"] == "2026-11-11" and r["kpis"]["yield_kwh"] == pytest.approx(9.9)
    assert r["kpis"]["iec_pr_pct"] is None  # no weather sensor: null, never a default
    assert {i["device_sn"] for i in r["inverters"]} >= {"INVA", "INVB"}


# ---------------------------------------------------------------------------------------------
# Chat route


def test_chat_runs_tools_streams_answer_and_meters_usage(env):
    fake = FakeClient([
        _msg([_text("Checking. "), _tool_use("t1", "fleet_ranking", {"day": "2026-11-11"})], "tool_use", inp=500, out=30),
        _msg([_text("Test Plant: 0.49 kWh/kWp on 2026-11-11.")], "end_turn", inp=900, out=40, cached=400),
    ])
    ai_client.set_client(fake)
    h = env.login("admin", "admin123")
    r = env.client.post(
        "/api/assistant/chat",
        headers=h,
        json={"messages": [{"role": "user", "content": "worst plant?"}], "context": {"plant_id": PLANT, "page": "strings"}},
    )
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    ev = _events(r)
    assert [e for e, _ in ev] == ["text", "tool", "tool", "text", "done"]
    assert ev[1][1] == {"name": "fleet_ranking", "status": "running"} and ev[2][1]["status"] == "done"
    done = ev[-1][1]
    assert done["answer"] == "Checking. Test Plant: 0.49 kWh/kWp on 2026-11-11."
    assert done["status"] == "ok" and done["rounds"] == 2 and done["tools"] == ["fleet_ranking"]
    assert done["usage"] == {"input_tokens": 1400, "cached_tokens": 400, "output_tokens": 70}

    first, second = fake.requests
    assert first["thinking"] == {"type": "disabled"} and first["model"] == "test-model"
    ctx_block, question = first["messages"][-1]["content"]
    assert ctx_block["text"].startswith("<context>") and f'plant on screen: {PLANT} "Test Plant"' in ctx_block["text"]
    assert question == {"type": "text", "text": "worst plant?"}
    # tool round: assistant tool_use, then every result in ONE user message
    assert second["messages"][-2]["content"][-1]["type"] == "tool_use"
    [result] = second["messages"][-1]["content"]
    assert result["type"] == "tool_result" and result["tool_use_id"] == "t1" and "is_error" not in result
    assert json.loads(result["content"])["ranking"][0]["plant_id"] == PLANT
    assert first["system"] == second["system"]  # frozen prefix

    with env.Session() as s:
        [u] = s.scalars(select(AiUsage)).all()
    assert (u.status, u.rounds, u.tools, u.input_tokens, u.cached_tokens, u.output_tokens) == ("ok", 2, ["fleet_ranking"], 1400, 400, 70)
    # cost from the configured prices; cached tokens at the cached price
    expect = (1000 * settings.ai_price_in_per_m + 400 * settings.ai_price_cached_per_m + 70 * settings.ai_price_out_per_m) / 1e6
    assert u.cost_usd == pytest.approx(expect)
    # only bookkeeping columns exist: no prompt / answer / tool-result text is stored
    assert {c.name for c in AiUsage.__table__.columns} == {
        "id", "ts", "user_id", "model", "rounds", "tools", "input_tokens", "cached_tokens", "output_tokens",
        "cost_usd", "status", "duration_ms",
    }

    usage = env.client.get("/api/assistant/usage", headers=h).json()
    assert usage["questions"] == 1 and usage["by_status"] == {"ok": 1}


def test_engineer_context_never_names_an_unassigned_plant(env):
    fake = FakeClient([_msg([_text("ok")], "end_turn")])
    ai_client.set_client(fake)
    h = env.login("engineer", "engineer123")
    r = env.client.post(
        "/api/assistant/chat", headers=h,
        json={"messages": [{"role": "user", "content": "this plant?"}], "context": {"plant_id": PLANT}},
    )
    assert r.status_code == 200
    ctx_block = fake.requests[0]["messages"][-1]["content"][0]["text"]
    assert "Test Plant" not in ctx_block and str(PLANT) not in ctx_block
    assert env.client.get("/api/assistant/usage", headers=h).status_code == 403


def test_provider_errors_end_the_turn_with_a_safe_message(env):
    req = httpx2.Request("POST", "https://example.invalid/v1/messages")
    err = anthropic.RateLimitError("slow down test-ai-key-0123456789", response=httpx2.Response(429, request=req), body=None)
    ai_client.set_client(FakeClient([err]))
    r = env.client.post("/api/assistant/chat", headers=env.login("admin", "admin123"),
                        json={"messages": [{"role": "user", "content": "hi"}]})
    ev = _events(r)
    assert ev[0] == ("error", {"code": "busy", "message": "The AI service is busy. Try again in a minute."})
    assert ev[-1][0] == "done" and ev[-1][1]["status"] == "error"
    assert "test-ai-key" not in r.text


def test_refusals_before_streaming(env, monkeypatch):
    h = env.login("admin", "admin123")
    body = {"messages": [{"role": "user", "content": "hi"}]}
    ai_client.set_client(FakeClient([]))

    # last message must be the user's
    bad = {"messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]}
    assert env.client.post("/api/assistant/chat", headers=h, json=bad).status_code == 422

    # monthly budget used up
    with env.Session() as s:
        s.add(AiUsage(ts=datetime.now(timezone.utc), user_id=1, model="m", status="ok", cost_usd=settings.ai_monthly_budget_usd))
        s.commit()
    r = env.client.post("/api/assistant/chat", headers=h, json=body)
    assert r.status_code == 429 and "budget" in r.json()["detail"]
    with env.Session() as s:
        s.query(AiUsage).delete()
        s.commit()

    # engineer daily limit (admins are exempt)
    monkeypatch.setattr(settings, "ai_user_daily_questions", 1)
    with env.Session() as s:
        eng = s.scalar(select(User).where(User.username == "engineer"))
        s.add(AiUsage(ts=datetime.now(timezone.utc), user_id=eng.id, model="m", status="ok", cost_usd=0.0))
        s.commit()
    r = env.client.post("/api/assistant/chat", headers=env.login("engineer", "engineer123"), json=body)
    assert r.status_code == 429 and "Daily limit" in r.json()["detail"]

    # role not enabled, then no key configured
    monkeypatch.setattr(settings, "ai_enabled_roles", "admin")
    he = env.login("engineer", "engineer123")
    assert env.client.post("/api/assistant/chat", headers=he, json=body).status_code == 403
    assert env.client.get("/api/assistant/status", headers=he).json()["enabled"] is False
    monkeypatch.setattr(settings, "ai_api_key", "")
    assert env.client.post("/api/assistant/chat", headers=h, json=body).status_code == 503
    assert env.client.get("/api/assistant/status", headers=h).json()["enabled"] is False


def test_assignment_lets_engineer_read_the_plant(env):
    with env.Session() as s:
        eng = s.scalar(select(User).where(User.username == "engineer"))
        s.add(UserPlantAssignment(user_id=eng.id, plant_id=PLANT))
        s.commit()
    fake = FakeClient([
        _msg([_tool_use("t1", "plant_overview", {"plant_id": PLANT, "day": "2026-11-11"})], "tool_use"),
        _msg([_text("done")], "end_turn"),
    ])
    ai_client.set_client(fake)
    r = env.client.post("/api/assistant/chat", headers=env.login("engineer", "engineer123"),
                        json={"messages": [{"role": "user", "content": "overview"}]})
    assert [e for e, _ in _events(r)][-1] == "done"
    [result] = fake.requests[1]["messages"][-1]["content"]
    assert "is_error" not in result and json.loads(result["content"])["plant"]["name"] == "Test Plant"


def test_trim_history_starts_with_user_and_keeps_the_question():
    msgs = [ChatMessage(role="user" if i % 2 == 0 else "assistant", content=f"m{i}") for i in range(45)]
    out = trim_history(msgs)
    assert out[0].role == "user" and out[-1].content == "m44" and len(out) <= 40


def test_ai_key_is_redacted(monkeypatch):
    monkeypatch.setattr(settings, "ai_api_key", "sk-ws-secret-value-123456")
    assert redact("auth failed for sk-ws-secret-value-123456") == "auth failed for ***"
