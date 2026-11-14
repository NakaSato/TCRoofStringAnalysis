"""The Messages-API client for the AI Assistant: one per process.

Qwen Cloud's Anthropic-compatible endpoint by default (`AI_BASE_URL`); an empty base URL uses
Anthropic itself. Only the core Messages API is used (system, messages, tools, streaming), which
both providers support.
"""

from __future__ import annotations

import threading
from typing import Any, Optional

import anthropic

from app.config import settings

_lock = threading.Lock()
_client: Optional[Any] = None


def enabled() -> bool:
    return bool(settings.ai_api_key.strip())


def get_client() -> Any:
    """The shared client. Tests replace it with `set_client`."""
    global _client
    with _lock:
        if _client is None:
            _client = anthropic.Anthropic(
                api_key=settings.ai_api_key,
                base_url=settings.ai_base_url or None,
                max_retries=2,
                timeout=anthropic.Timeout(settings.ai_turn_timeout_s, connect=10.0),
            )
        return _client


def set_client(client: Any) -> None:
    global _client
    with _lock:
        _client = client
