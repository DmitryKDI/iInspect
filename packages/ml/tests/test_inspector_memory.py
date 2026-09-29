from pathlib import Path

import pytest
from app.inspector_memory import (
    active_lessons,
    add_lesson,
    lessons_prompt,
    master_playbook,
)


def test_master_playbook_persists_and_is_injected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("INSPECTOR_BLIND_BENCHMARK", "0")
    first = "Compare quantity only after matching the same engineering entity."
    second = "Verify every target location independently before closing coverage."

    first_id = add_lesson(first, source_type="synthetic_curriculum")
    second_id = add_lesson(second, source_type="synthetic_curriculum")

    assert first_id != second_id
    assert add_lesson(first, source_type="synthetic_curriculum") == first_id
    assert len(active_lessons(limit=100)) == 2

    body = master_playbook()
    assert first in body
    assert second in body

    prompt = lessons_prompt()
    assert "MASTER PLAYBOOK" in prompt
    assert first in prompt
    assert second in prompt


def test_blind_mode_hides_all_learned_memory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("INSPECTOR_BLIND_BENCHMARK", "0")
    add_lesson(
        "Check connectivity separately from component presence.",
        source_type="synthetic_curriculum",
    )
    assert master_playbook()

    monkeypatch.setenv("INSPECTOR_BLIND_BENCHMARK", "1")
    assert active_lessons(limit=100) == []
    assert master_playbook() == ""
    assert lessons_prompt() == ""


def test_object_specific_lesson_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("INSPECTOR_BLIND_BENCHMARK", "0")
    with pytest.raises(ValueError):
        add_lesson("Check room 267 for a missing element.")
