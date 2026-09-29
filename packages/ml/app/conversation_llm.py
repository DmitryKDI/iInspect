"""Stateful conversation wrapper for the investigator runtime.

The wrapper keeps a bounded transcript, retries transient provider/network
failures without losing session state, and prevents long navigation-only loops
from starving the visual evidence path.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time
from typing import Iterable

from .llm import LlmConfig, call_llm_json


def _int_env(name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(lo, min(hi, value))


HISTORY_MAX_CHARS = _int_env("INSPECTOR_INVESTIGATOR_HISTORY_CHARS", 70000, 20000, 180000)
CONVERSATION_RETRIES = _int_env("INSPECTOR_INVESTIGATOR_CALL_RETRIES", 3, 1, 5)
NAV_ONLY_LIMIT = _int_env("INSPECTOR_INVESTIGATOR_NAV_ONLY_LIMIT", 4, 2, 8)
_REF_RE = re.compile(r"\b(?:PD|RD)\d+:P\d+\b", re.IGNORECASE)


def _bounded_history(history: list[dict], max_chars: int) -> list[dict]:
    if max_chars <= 0:
        return []
    total = sum(len(str(item.get("content") or "")) for item in history)
    if total <= max_chars:
        return list(history)
    head = history[:2]
    head_chars = sum(len(str(item.get("content") or "")) for item in head)
    marker = {
        "role": "user",
        "content": (
            "[OLDER INVESTIGATION TURNS COMPACTED. The current SESSION NOTE and "
            "recent tool/model turns are authoritative for inspected refs, coverage, "
            "confirmed and pending candidates.]"
        ),
    }
    available = max(0, max_chars - head_chars - len(marker["content"]) - 200)
    tail: list[dict] = []
    used = 0
    for item in reversed(history[2:]):
        size = len(str(item.get("content") or ""))
        if tail and used + size > available:
            break
        if not tail and size > available:
            clipped = dict(item)
            clipped["content"] = str(item.get("content") or "")[-available:] if available else ""
            if clipped["content"]:
                tail.append(clipped)
            break
        tail.append(item)
        used += size
    tail.reverse()
    return head + [marker] + tail


def _clean_history(history: Iterable[dict] | None) -> list[dict]:
    out: list[dict] = []
    for item in history or []:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        content = str(item.get("content") or "").strip()
        if role in {"user", "assistant"} and content:
            out.append({"role": role, "content": content})
    return _bounded_history(out, HISTORY_MAX_CHARS)


def _history_text(history: list[dict]) -> str:
    if not history:
        return ""
    lines = ["<INVESTIGATION_HISTORY>"]
    for item in history:
        role = "INSPECTOR" if item["role"] == "assistant" else "TOOL_OR_USER"
        lines.append(f"[{role}]\n{item['content']}")
    lines.append("</INVESTIGATION_HISTORY>")
    return "\n".join(lines)


def _assistant_action(item: dict) -> str:
    if item.get("role") != "assistant":
        return ""
    try:
        payload = json.loads(str(item.get("content") or ""))
    except (TypeError, ValueError, json.JSONDecodeError):
        return ""
    return str(payload.get("action") or "").strip().casefold() if isinstance(payload, dict) else ""


def _nav_only_streak(history: list[dict]) -> int:
    streak = 0
    for item in reversed(history):
        action = _assistant_action(item)
        if not action:
            continue
        if action in {"search", "read_text"}:
            streak += 1
            continue
        break
    return streak


def _refs_from_current_turn(user_text: str, limit: int = 4) -> list[str]:
    out: list[str] = []
    for match in _REF_RE.findall(user_text):
        ref = match.upper()
        if ref not in out:
            out.append(ref)
        if len(out) >= limit:
            break
    return out


def _is_transient(exc: Exception) -> bool:
    name = type(exc).__name__.casefold()
    text = f"{type(exc).__name__}: {exc}".casefold()
    markers = (
        "readerror", "connecterror", "connectionerror", "timeout", "remoteprotocolerror",
        "connection reset", "connection aborted", "forcibly closed", "10054", "temporarily unavailable",
        "broken pipe", "server disconnected",
    )
    return any(marker in name or marker in text for marker in markers)


def _call_with_retry(
    config: LlmConfig,
    system_prompt: str,
    combined: str,
    *,
    images: list[str],
    timeout: float,
    operation: str,
    digest: str,
) -> dict:
    last: Exception | None = None
    for attempt in range(1, CONVERSATION_RETRIES + 1):
        try:
            result = call_llm_json(
                config,
                system_prompt,
                combined,
                images=images,
                timeout=timeout,
                operation=operation,
                source_digest=digest,
                prompt_version="stateful-investigator-conversation-v3",
                use_cache=False,
            )
            return result if isinstance(result, dict) else {}
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt >= CONVERSATION_RETRIES or not _is_transient(exc):
                raise
            time.sleep(min(4.0, 1.25 * attempt))
    if last is not None:
        raise last
    return {}


def call_conversation_json(
    config: LlmConfig,
    system_prompt: str,
    history: list[dict],
    user_text: str,
    *,
    images: list[str] | None = None,
    timeout: float = 180.0,
    operation: str = "vision",
) -> dict:
    clean = _clean_history(history)
    conversation = _history_text(clean)
    nav_streak = _nav_only_streak(clean)
    guard = ""
    if nav_streak >= NAV_ONLY_LIMIT:
        guard = (
            "\n<RUNTIME_POLICY>Navigation-only streak reached its limit. "
            "The next useful step must gather visual evidence with inspect_pages or zoom. "
            "Do not answer search/read_text again unless visual rendering failed.</RUNTIME_POLICY>"
        )
    combined = (
        (conversation + "\n\n" if conversation else "")
        + "<CURRENT_TURN>\n"
        + user_text
        + guard
        + "\n</CURRENT_TURN>"
    )
    digest = hashlib.sha256(combined.encode("utf-8")).hexdigest()
    result = _call_with_retry(
        config,
        system_prompt,
        combined,
        images=list(images or []),
        timeout=timeout,
        operation=operation,
        digest=digest,
    )

    # Blind-safe deterministic guard: after repeated navigation, if the model
    # still asks for another navigation-only action, inspect the refs already
    # surfaced by the current tool result. This does not invent pairing or
    # findings; it only converts navigation candidates into visual evidence.
    action = str(result.get("action") or "").strip().casefold()
    if nav_streak >= NAV_ONLY_LIMIT and action in {"search", "read_text"}:
        refs = _refs_from_current_turn(user_text)
        if refs:
            return {
                "action": "inspect_pages",
                "refs": refs,
                "reason": "runtime navigation guard: obtain visual evidence after repeated search/read_text",
            }
    return result


def append_turn(history: list[dict], user_text: str, assistant_json: dict) -> None:
    history.append({"role": "user", "content": user_text})
    history.append({
        "role": "assistant",
        "content": json.dumps(assistant_json, ensure_ascii=False, separators=(",", ":")),
    })
