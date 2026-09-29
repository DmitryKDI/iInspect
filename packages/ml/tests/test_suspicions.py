"""Свободный поиск гипотез: четыре подхода и структура SUSPICION (ТЗ 9.5)."""
import datetime as dt

import pytest
from app import suspicions


def _check(code: str, actual: str, *, stage_pages=(("PD", 1), ("RD", 2))) -> dict:
    return {
        "finding_id": f"F-{code}", "parameter_code": code,
        "parameter_name": f"Параметр {code}", "priority": "HIGH",
        "technical_status": "completed", "actual_value": actual, "confidence": 0.8,
        "evidence": [{"stage": stage, "document_id": index, "page": page,
                      "bbox": [0, 0, 1, 1]}
                     for index, (stage, page) in enumerate(stage_pages, start=1)],
    }


def _discover(checks, **kwargs):
    base = {"rules": [], "norms": [], "rooms": {}, "history": {},
            "document_codes": {1: "ШИФР-ПД", 2: "ШИФР-РД"}, "today": dt.date(2026, 1, 1)}
    return suspicions.discover(checks, **{**base, **kwargs})


def test_expression_language_parses_and_rejects_errors():
    tree = suspicions.parse_expression('M-001 > 10 and (absent(M-002) or M-003 == "да")')
    assert suspicions.codes_of(tree) == {"M-001", "M-002", "M-003"}
    for broken in ("", "M-001 >", "present(M-001", "M-001 > 10 10", "X > 1"):
        with pytest.raises(ValueError):
            suspicions.parse_expression(broken)
    print("OK: язык правил разбирается, ошибки отклоняются с причиной")


def test_unknown_value_gives_no_conclusion():
    tree = suspicions.parse_expression("M-001 > 10")
    assert suspicions.evaluate(tree, {}) is None
    assert suspicions.evaluate(suspicions.parse_expression("not M-001 > 10"), {}) is None
    print("OK: неизвлечённое значение — не «ложь», а отсутствие вывода")


def test_logical_rule_finds_missing_consequence():
    rule = {"id": 1, "rule_name": "Если A, то B", "condition": "M-001 > 10",
            "expected": "present(M-002)", "normative_base": "норма", "review_priority": "HIGH"}
    found = _discover([_check("M-001", "15"), _check("M-002", "")], rules=[rule])
    assert len(found) == 1
    item = found[0]
    assert item["discovery_method"] == suspicions.LOGICAL
    assert item["finding_status"] == "SUSPICION" and item["inspector_status"] == "PENDING"
    assert item["pd_reference"] == "ШИФР-ПД, стр.1" and item["rd_reference"] == "ШИФР-РД, стр.2"
    for key in ("suspicion_id", "confidence", "description", "review_priority",
                "normative_base"):
        assert key in item
    assert not _discover([_check("M-001", "5")], rules=[rule])
    print("OK: логическое правило даёт гипотезу в структуре ТЗ")


def test_normative_range_respects_effective_dates():
    norm = {"id": 1, "document_number": "НД-1", "section": "п.1", "parameter_name": "M-001",
            "min_value": 2.5, "max_value": None, "effective_from": None, "effective_to": None}
    found = _discover([_check("M-001", "2,4")], norms=[norm])
    assert [item["discovery_method"] for item in found] == [suspicions.NORMATIVE]
    expired = {**norm, "effective_to": dt.date(2020, 1, 1)}
    assert not _discover([_check("M-001", "2,4")], norms=[expired])
    print("OK: нормативный анализ учитывает срок действия нормы")


def test_semantic_dissonance_between_stage_names():
    rooms = {"PD": [{"key": "101", "name": "Техническое помещение", "page": 3,
                     "document_id": 1}],
             "RD": [{"key": "101", "name": "Склад", "page": 7, "document_id": 2},
                    {"key": "102", "name": "Коридор", "page": 7, "document_id": 2}]}
    found = _discover([], rooms=rooms)
    assert len(found) == 1 and found[0]["discovery_method"] == suspicions.SEMANTIC
    same = {"PD": [{"key": "101", "name": "Помещение техническое", "page": 3,
                    "document_id": 1}],
            "RD": [{"key": "101", "name": "Техн. помещение", "page": 7, "document_id": 2}]}
    assert not _discover([], rooms=same)
    print("OK: разные названия одного помещения в ПД и РД — гипотеза")


def test_pattern_needs_enough_history():
    history = {"M-001": [10, 11, 9, 10, 10]}
    found = _discover([_check("M-001", "40")], history=history)
    assert [item["discovery_method"] for item in found] == [suspicions.ML_PATTERN]
    assert not _discover([_check("M-001", "40")], history={"M-001": [10, 11]})
    assert not _discover([_check("M-001", "10.5")], history=history)
    print("OK: аномалия относительно других объектов — только при достаточной истории")


def test_duplicates_are_merged_within_object():
    rule = {"id": 7, "rule_name": "r", "condition": "present(M-001)",
            "expected": "absent(M-001)"}
    found = _discover([_check("M-001", "1")], rules=[rule, rule])
    assert len(found) == 1
    print("OK: одинаковые гипотезы внутри объекта объединяются")
