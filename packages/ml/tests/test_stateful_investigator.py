from __future__ import annotations

from pathlib import Path

import pytest

from app.conversation_llm import _bounded_history
from app.inspector_memory import active_lessons, add_lesson
from app.matching import DocumentInput
from app.stateful_investigator import _effective_turn_budget, _normalize_candidate, _requirement_target_coverage, _search, build_page_catalog


def _doc(name: str, side_text: str, *, room: str = "101") -> DocumentInput:
    return DocumentInput(
        name=name,
        pages=2,
        text_facts=[{"page": 1, "text": side_text + f" помещение {room} установка X"}, {"page": 2, "text": side_text + " схема вентиляции Y"}],
        room_facts=[{"page": 1, "key": room, "name": "техпомещение"}],
        equipment_facts=[{"page": 1, "key": "X", "name": "установка"}],
        page_kinds={1: "drawing", 2: "drawing"},
        discipline_code="ОВ",
    )


def test_catalog_keeps_every_page_and_search_only_ranks():
    catalog = build_page_catalog([_doc("pd", "ПД")], [_doc("rd", "РД")])
    assert [row["ref"] for row in catalog] == ["PD0:P1", "PD0:P2", "RD0:P1", "RD0:P2"]
    matches = _search(catalog, "помещение 101 установка")
    assert matches
    assert all("search_text" not in row for row in matches)


def test_search_uses_hidden_fuller_text_not_only_initial_hint():
    pd = _doc("pd", "ПД")
    rd = _doc("rd", "РД")
    rd.text_facts[1]["text"] = ("обычный текст " * 100) + " уникальныймаркер вентиляция"
    catalog = build_page_catalog([pd], [rd])
    target = next(row for row in catalog if row["ref"] == "RD0:P2")
    assert "уникальныймаркер" not in target["text_hint"]
    assert _search(catalog, "уникальныймаркер")[0]["ref"] == "RD0:P2"


def test_candidate_requires_direct_pd_and_rd_observations():
    ref_map = {"PD0:P1": {"side": "PD"}, "RD0:P1": {"side": "RD"}}
    assert _normalize_candidate({"difference": "A != B", "pd_refs": ["PD0:P1"], "rd_refs": ["RD0:P1"], "pd_observation": "", "rd_observation": "B"}, ref_map) is None
    candidate = _normalize_candidate({"difference": "A != B", "difference_kind": "configuration", "pd_refs": ["PD0:P1"], "rd_refs": ["RD0:P1"], "pd_observation": "A", "rd_observation": "B", "requirement_ids": ["R1"]}, ref_map)
    assert candidate and candidate["difference_kind"] == "configuration"


def test_multi_room_finish_guard_tracks_each_target_independently():
    catalog = build_page_catalog([_doc("pd", "ПД", room="101")], [_doc("rd-a", "РД", room="101"), _doc("rd-b", "РД", room="102")])
    coverage = _requirement_target_coverage([{"id": "R1", "rooms": ["101", "102"]}], catalog, {"RD0:P1"}, [])
    assert coverage["targets_total"] == 2
    assert coverage["targets_visited"] == 1
    assert coverage["targets_blocking_finish"] == 1
    assert coverage["blockers"][0]["target"] == "102"


def test_unlocated_target_must_at_least_be_searched_before_finish():
    catalog = build_page_catalog([_doc("pd", "ПД")], [_doc("rd", "РД")])
    req_payload = [{"id": "R1", "rooms": ["999"]}]
    assert _requirement_target_coverage(req_payload, catalog, set(), [])["targets_blocking_finish"] == 1
    after = _requirement_target_coverage(req_payload, catalog, set(), ["помещение 999 теплый пол"])
    assert after["targets_blocking_finish"] == 0
    assert after["rows"][0]["status"] == "unlocated_after_search"


def test_turn_budget_scales_for_full_projects_and_stays_bounded():
    small = _effective_turn_budget(6, 3)
    medium = _effective_turn_budget(90, 20)
    huge = _effective_turn_budget(10000, 1000)
    assert small >= 24
    assert medium > small
    assert huge >= medium
    assert huge <= 96


def test_history_compaction_keeps_opening_and_newest_turns():
    history = [{"role": "user", "content": "initial"}, {"role": "assistant", "content": "first"}]
    for index in range(20):
        history.append({"role": "user", "content": f"tool-{index}-" + "x" * 100})
        history.append({"role": "assistant", "content": f"answer-{index}"})
    compact = _bounded_history(history, 900)
    assert compact[0]["content"] == "initial"
    assert compact[1]["content"] == "first"
    assert any("COMPACTED" in row["content"] for row in compact)
    assert compact[-1]["content"] == "answer-19"


def test_memory_is_disabled_for_blind_benchmark(monkeypatch, tmp_path: Path):
    add_lesson("Проверяй все зоны многозонного требования.")
    monkeypatch.setenv("INSPECTOR_BLIND_BENCHMARK", "0")
    assert len(active_lessons()) == 1
    monkeypatch.setenv("INSPECTOR_BLIND_BENCHMARK", "1")
    assert active_lessons() == []


def test_memory_rejects_object_specific_lesson(tmp_path: Path):
    with pytest.raises(ValueError):
        add_lesson("На листе 77 проверь помещение 888.")
