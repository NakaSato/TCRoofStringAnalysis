"""One AI Assistant turn: the streamed tool-use loop (docs/plans/ai-assistant.md §4.4).

The browser holds the conversation (plain user/assistant text) and sends it with each question;
nothing of it is stored. Tool rounds happen inside the turn and are not sent back to the browser,
so a follow-up question re-reads data through the tools (cheaper, and no fetched data is kept in
the browser). Only token counts and cost go to `ai_usage`.

`run_chat` yields events `{"event": name, "data": {...}}`:
  text  {text}                          answer text as it streams
  tool  {name, status: running|done|error}
  error {code, message}                 the turn ended early (message is safe to show)
  done  {answer, rounds, tools, usage}  always last, unless the client went away
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, Iterator, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from app.config import settings
from app.logging_db import redact
from app.services.assistant import usage
from app.services.assistant.client import get_client
from app.services.assistant.prompt import SYSTEM_PROMPT
from app.services.assistant.tools import ToolContext, run_tool, tool_definitions

log = logging.getLogger(__name__)

MAX_MESSAGES = 40
MAX_CHARS_TOTAL = 200_000


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=20_000)


class PageContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plant_id: Optional[int] = None
    page: Optional[str] = Field(None, max_length=40)
    day: Optional[date] = None


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    messages: List[ChatMessage] = Field(min_length=1)
    context: Optional[PageContext] = None


def trim_history(messages: List[ChatMessage]) -> List[ChatMessage]:
    """Last MAX_MESSAGES messages within MAX_CHARS_TOTAL, starting with a user message.
    The caller has checked that the last message is the user's."""
    out = list(messages[-MAX_MESSAGES:])
    while len(out) > 1 and (out[0].role != "user" or sum(len(m.content) for m in out) > MAX_CHARS_TOTAL):
        out.pop(0)
    return out


@dataclass
class _Totals:
    rounds: int = 0
    input_tokens: int = 0
    cached_tokens: int = 0
    output_tokens: int = 0

    def add(self, u: Any) -> None:
        if u is None:
            return
        inp = int(getattr(u, "input_tokens", 0) or 0)
        out = int(getattr(u, "output_tokens", 0) or 0)
        read = int(getattr(u, "cache_read_input_tokens", 0) or 0)
        write = int(getattr(u, "cache_creation_input_tokens", 0) or 0)
        if read or write:
            # Anthropic: cache reads/writes are reported outside input_tokens
            self.input_tokens += inp + read + write
            self.cached_tokens += read
        else:
            # Qwen: implicit cache hits are part of the prompt count, reported here
            details = getattr(u, "prompt_tokens_details", None)
            cached = details.get("cached_tokens") if isinstance(details, dict) else getattr(details, "cached_tokens", 0)
            self.input_tokens += inp
            self.cached_tokens += int(cached or 0)
        self.output_tokens += out


@dataclass
class _Turn:
    status: str = "ok"
    answer: List[str] = field(default_factory=list)
    totals: _Totals = field(default_factory=_Totals)


def _blocks(content: List[Any]) -> List[Dict[str, Any]]:
    """Assistant content to send back next round: text and tool_use only, rebuilt explicitly so
    provider-specific extra fields don't travel."""
    out: List[Dict[str, Any]] = []
    for b in content:
        if b.type == "text" and b.text:
            out.append({"type": "text", "text": b.text})
        elif b.type == "tool_use":
            out.append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input})
    return out


def _error(code: str, message: str) -> Dict[str, Any]:
    return {"event": "error", "data": {"code": code, "message": message}}


def run_chat(
    history: List[ChatMessage],
    context_text: str,
    tctx: ToolContext,
    user_id: int,
) -> Iterator[Dict[str, Any]]:
    """Run one turn and yield its events. `history` ends with the user's question."""
    import anthropic  # the SDK takes ~0.5 s to import: loaded on the first question, not at API start

    client = get_client()
    tools = tool_definitions()
    extra: Dict[str, Any] = {} if settings.ai_thinking else {"thinking": {"type": "disabled"}}
    msgs: List[Dict[str, Any]] = [{"role": m.role, "content": m.content} for m in history]
    msgs[-1] = {
        "role": "user",
        "content": [{"type": "text", "text": context_text}, {"type": "text", "text": history[-1].content}],
    }
    turn = _Turn()
    t0 = time.monotonic()
    deadline = t0 + settings.ai_turn_timeout_s
    finished = False
    try:
        for rnd in range(1, settings.ai_max_tool_rounds + 1):
            if time.monotonic() > deadline:
                turn.status = "timeout"
                yield _error("timeout", "The assistant took too long. Try a narrower question.")
                break
            with client.messages.stream(
                model=settings.ai_model,
                max_tokens=settings.ai_max_tokens,
                system=SYSTEM_PROMPT,
                tools=tools,
                messages=msgs,
                **extra,
            ) as stream:
                for ev in stream:
                    if ev.type == "content_block_delta" and getattr(ev.delta, "type", None) == "text_delta":
                        turn.answer.append(ev.delta.text)
                        yield {"event": "text", "data": {"text": ev.delta.text}}
                final = stream.get_final_message()
            turn.totals.rounds = rnd
            turn.totals.add(final.usage)
            tool_uses = [b for b in final.content if b.type == "tool_use"]

            if final.stop_reason == "tool_use" and tool_uses:
                if rnd == settings.ai_max_tool_rounds:
                    turn.status = "error"
                    yield _error("too_many_steps", "The question needed too many data lookups. Try a narrower question.")
                    break
                msgs.append({"role": "assistant", "content": _blocks(final.content)})
                results: List[Dict[str, Any]] = []
                for tu in tool_uses:
                    yield {"event": "tool", "data": {"name": tu.name, "status": "running"}}
                    text, is_error = run_tool(tu.name, tu.input, tctx)
                    yield {"event": "tool", "data": {"name": tu.name, "status": "error" if is_error else "done"}}
                    res: Dict[str, Any] = {"type": "tool_result", "tool_use_id": tu.id, "content": text}
                    if is_error:
                        res["is_error"] = True
                    results.append(res)
                msgs.append({"role": "user", "content": results})  # all results in one message
                continue

            if final.stop_reason == "max_tokens":
                yield _error("truncated", "The answer was cut off at the length limit.")
            elif final.stop_reason not in ("end_turn", "stop_sequence", None):
                turn.status = "refused"
                yield _error("refused", "The assistant can't answer that question.")
            break
        finished = True
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as exc:
        turn.status = "error"
        log.error("assistant: provider rejected the API key (%s)", type(exc).__name__)
        yield _error("not_configured", "The AI service is not configured correctly. Contact an admin.")
        finished = True
    except anthropic.RateLimitError:
        turn.status = "error"
        log.warning("assistant: provider rate limit")
        yield _error("busy", "The AI service is busy. Try again in a minute.")
        finished = True
    except anthropic.APIStatusError as exc:
        turn.status = "error"
        log.warning("assistant: provider HTTP %s: %s", exc.status_code, (redact(str(exc)) or "")[:300])
        yield _error("provider_error", "The AI service returned an error. Try again.")
        finished = True
    except anthropic.APIConnectionError as exc:
        turn.status = "error"
        log.warning("assistant: provider unreachable (%s)", type(exc).__name__)
        yield _error("unreachable", "Can't reach the AI service. Try again.")
        finished = True
    finally:
        if not finished and turn.status == "ok":
            turn.status = "cancelled"  # client went away mid-stream, or an unexpected error
        _record(turn, tctx, user_id, t0)

    tot = turn.totals
    yield {
        "event": "done",
        "data": {
            "answer": "".join(turn.answer),
            "status": turn.status,
            "rounds": tot.rounds,
            "tools": list(tctx.calls),
            "usage": {"input_tokens": tot.input_tokens, "cached_tokens": tot.cached_tokens, "output_tokens": tot.output_tokens},
        },
    }


def _record(turn: _Turn, tctx: ToolContext, user_id: int, t0: float) -> None:
    tot = turn.totals
    cost = usage.cost_usd(tot.input_tokens, tot.cached_tokens, tot.output_tokens)
    ms = int((time.monotonic() - t0) * 1000)
    try:
        with tctx.session_factory() as db:
            usage.record(
                db,
                user_id=user_id,
                model=settings.ai_model,
                rounds=tot.rounds,
                tools=list(tctx.calls),
                input_tokens=tot.input_tokens,
                cached_tokens=tot.cached_tokens,
                output_tokens=tot.output_tokens,
                cost_usd=cost,
                status=turn.status,
                duration_ms=ms,
            )
    except Exception:  # noqa: BLE001 - metering must not break the answer
        log.exception("assistant: could not record usage")
    log.info(
        "assistant turn user=%s status=%s rounds=%d tools=%s in=%d cached=%d out=%d cost_usd=%.5f ms=%d",
        user_id, turn.status, tot.rounds, ",".join(tctx.calls) or "-", tot.input_tokens, tot.cached_tokens,
        tot.output_tokens, cost, ms,
    )
