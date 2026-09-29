"""Источник доказательства сохраняется при сбоях загрузки и OCR."""
from types import SimpleNamespace

import pytest
from app import lean_analysis_runtime as runtime
from app.llm import LlmConfig
from app.stateful_investigator import InvestigatorResult, _ref_map


def _facts(text="Распознанное требование.", **kwargs):
    return SimpleNamespace(
        pages=1, text_facts=[{"page": 1, "text": text}], room_facts=[],
        page_kinds={}, equipment_facts=[], balance_facts=[], **kwargs,
    )


def _inputs(monkeypatch, tmp_path):
    paths = [tmp_path / name for name in ("broken.pdf", "pd.pdf", "rd.pdf")]
    for path in paths:
        path.touch()

    def load(path, name):
        if name == "broken.pdf":
            raise ValueError("повреждённый PDF")
        return _facts()

    monkeypatch.setattr(runtime, "facts_for", load)
    return [str(path) for path in paths]


def test_skipped_pdf_does_not_shift_rendering_source(monkeypatch, tmp_path):
    broken, pd, rd = _inputs(monkeypatch, tmp_path)
    seen = {}

    def investigate(before, after, before_paths, after_paths, requirements, config):
        seen.update(_ref_map(before, after, before_paths, after_paths))
        return InvestigatorResult(diagnostics={"finished": True, "self_reviewed": True})

    monkeypatch.setattr(runtime, "run_stateful_investigator", investigate)
    monkeypatch.setattr(runtime, "extract_requirements_llm", lambda *args, **kwargs: [])
    result = runtime.run_lean_analysis(
        [broken, pd], [rd], llm_config=LlmConfig(),
    )
    assert seen["PD0:P1"]["path"] == pd
    assert seen["PD0:P1"]["document"].name == "pd.pdf"
    assert result["valid"] is False
    assert result["skipped_files"]
    print("OK: повреждённый PDF не подменяет источник следующего документа")


def test_extraction_uses_loaded_ocr_facts(monkeypatch, tmp_path):
    _, pd, rd = _inputs(monkeypatch, tmp_path)
    seen = []
    monkeypatch.setattr(runtime, "extract_requirements", lambda facts: seen.extend(facts) or [])
    runtime.run_lean_analysis([pd], [rd], before_names=["Проект.pdf"])
    assert seen[0]["text"] == "Распознанное требование."
    assert seen[0]["document"] == "Проект.pdf"
    assert seen[0]["page"] == 1
    print("OK: извлечение использует распознанный текст и исходное имя документа")


@pytest.mark.parametrize("diagnostics", [
    {"finished": False, "turn_budget_exhausted": True},
    {"finished": True, "self_reviewed": True, "errors": ["ошибка модели"]},
    {"finished": True, "self_reviewed": True, "verifier_errors": 1},
    {"finished": True, "self_reviewed": True, "tool_failures": ["не прочитан лист"]},
    {"finished": True, "self_reviewed": False},
])
def test_incomplete_investigation_is_not_valid(monkeypatch, tmp_path, diagnostics):
    _, pd, rd = _inputs(monkeypatch, tmp_path)
    monkeypatch.setattr(runtime, "extract_requirements_llm", lambda *args, **kwargs: [])
    monkeypatch.setattr(runtime, "run_stateful_investigator", lambda *args:
                        InvestigatorResult(diagnostics=diagnostics))
    result = runtime.run_lean_analysis(
        [pd], [rd], llm_config=LlmConfig(),
    )
    assert result["valid"] is False
    assert result["reason"]
    assert result["pair_vision"]["coverage"]["status"] == "incomplete"
    print("OK: частичная или ошибочная проверка не объявляется действительным прогоном")


def test_completed_investigation_remains_valid(monkeypatch, tmp_path):
    _, pd, rd = _inputs(monkeypatch, tmp_path)
    monkeypatch.setattr(runtime, "extract_requirements_llm", lambda *args, **kwargs: [])
    monkeypatch.setattr(runtime, "run_stateful_investigator", lambda *args:
                        InvestigatorResult(diagnostics={"finished": True, "self_reviewed": True}))
    result = runtime.run_lean_analysis(
        [pd], [rd], llm_config=LlmConfig(),
    )
    assert result["valid"] is True
    print("OK: завершённый без ошибок прогон остаётся действительным")


def test_mismatched_documents_and_paths_fail_before_rendering():
    with pytest.raises(ValueError, match="источник"):
        _ref_map([SimpleNamespace(pages=1)], [], [], [])
    print("OK: неполное соответствие документов и путей не замалчивается")


@pytest.mark.parametrize("failure", ["ocr", "extraction", "investigator", "no_key"])
def test_failed_stage_cannot_be_hidden_by_empty_findings(monkeypatch, tmp_path, failure):
    _, pd, rd = _inputs(monkeypatch, tmp_path)
    if failure == "ocr":
        monkeypatch.setattr(runtime, "facts_for", lambda *args: _facts(ocr_status="error"))

    def extract(*args, **kwargs):
        if failure == "extraction":
            kwargs["on_chunk_error"](1, ValueError("цитата не подтверждена"))
        return []

    def investigate(*args):
        if failure == "investigator":
            raise ConnectionError("провайдер недоступен")
        return InvestigatorResult(diagnostics={"finished": True, "self_reviewed": True})

    monkeypatch.setattr(runtime, "extract_requirements_llm", extract)
    monkeypatch.setattr(runtime, "run_stateful_investigator", investigate)
    config = None if failure == "no_key" else LlmConfig()
    result = runtime.run_lean_analysis([pd], [rd], llm_config=config)
    assert result["valid"] is False
    assert result["reason"]
    assert result["not_run"] or result["llm"]["call_failures"]
    print("OK: пустые находки не скрывают сбой или невыполненную проверку")
