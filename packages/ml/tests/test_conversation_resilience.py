from __future__ import annotations

import json

from app import conversation_llm


class DummyConfig:
    pass


def test_transient_provider_error_is_retried(monkeypatch):
    calls = {"n": 0}

    def fake_call(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError(10054, "connection reset by peer")
        return {"action": "search", "query": "ОВ", "reason": "ok"}

    monkeypatch.setattr(conversation_llm, "call_llm_json", fake_call)
    monkeypatch.setattr(conversation_llm.time, "sleep", lambda *_: None)
    result = conversation_llm.call_conversation_json(
        DummyConfig(), "system", [], "current", operation="text_verify"
    )
    assert calls["n"] == 2
    assert result["action"] == "search"


def test_navigation_guard_forces_visual_inspection(monkeypatch):
    history = []
    for action in ("search", "read_text", "search", "read_text"):
        history.append({"role": "user", "content": "tool result RD0:P2 PD0:P1"})
        history.append({"role": "assistant", "content": json.dumps({"action": action})})

    monkeypatch.setattr(
        conversation_llm,
        "call_llm_json",
        lambda *args, **kwargs: {"action": "search", "query": "again", "reason": "again"},
    )
    result = conversation_llm.call_conversation_json(
        DummyConfig(),
        "system",
        history,
        "TOOL RESULT refs RD0:P2 PD0:P1",
        operation="text_verify",
    )
    assert result["action"] == "inspect_pages"
    assert result["refs"] == ["RD0:P2", "PD0:P1"]
