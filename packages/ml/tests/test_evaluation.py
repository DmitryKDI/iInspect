"""Оценка по эталонной разметке: метрики листа «Метрики» (ТЗ 14.3)."""
import uuid

from app import evaluation

BOX = [0.10, 0.10, 0.30, 0.20]
FAR = [0.70, 0.70, 0.90, 0.80]


def _check(code: str, status: str, box=BOX) -> dict:
    return {"finding_id": f"{code}:matrix", "parameter_code": code, "finding_status": status,
            "technical_status": "completed", "completeness_status": "COMPLETE",
            "evidence": [{"stage": "PD", "file_id": "F-PD", "page": 3, "bbox": box},
                         {"stage": "RD", "file_id": "F-RD", "page": 5, "bbox": box}]}


def _process(object_id: str, checks: list[dict]) -> dict:
    """Процесс в том виде, в каком его передаёт сервер."""
    snapshot = [{"id": 1, "digest": "a", "metadata": {"file_id": "F-PD", "stage": "PD",
                                                      "document_code": "X-PD", "revision": "1"}},
                {"id": 2, "digest": "b", "metadata": {"file_id": "F-RD", "stage": "RD",
                                                      "document_code": "X-RD", "revision": "2"}}]
    return {"id": 1, "object_id": object_id, "run_state": "completed", "input_snapshot": snapshot,
            "result": {"checks": checks,
                       "document_selection": {"selected": {"PD": [1], "RD": [2]}},
                       "graphic_analysis": {"candidates": []}}}


def _group(object_id: str, code: str, status: str, box=BOX, revision="2") -> dict:
    return {"evidence_group_id": f"EG-{code}", "object_id": object_id, "matrix_code": code,
            "finding_status": status,
            "source_expected_file_id": "F-PD", "source_expected_page": 3,
            "source_expected_bbox_polygon": [box], "source_expected_code": "X-PD",
            "source_expected_revision": "1",
            "source_actual_file_id": "F-RD", "source_actual_page": 5,
            "source_actual_bbox_polygon": [box], "source_actual_code": "X-RD",
            "source_actual_revision": revision}


def test_detection_counts_need_right_parameter_and_right_evidence():
    obj = f"eval-{uuid.uuid4().hex[:6]}"
    pid = _process(obj, [_check("M-001", "CANDIDATE"),              # верно найдено
                         _check("M-002", "CANDIDATE", box=FAR),     # не там на листе
                         _check("M-003", "CANDIDATE"),              # ложное срабатывание
                         _check("M-004", "NEGATIVE_VERIFIED")])     # верно не найдено
    reference = [_group(obj, "M-001", "CONFIRMED_VIOLATION"),
                 _group(obj, "M-002", "CONFIRMED_VIOLATION"),
                 _group(obj, "M-003", "NEGATIVE_VERIFIED"),
                 _group(obj, "M-004", "NEGATIVE_VERIFIED"),
                 _group(obj, "M-005", "CONFIRMED_VIOLATION")]      # пропущено совсем
    report = evaluation.evaluate(reference, [pid])
    assert report["counts"] == {"tp": 1, "fn": 2, "fp": 1, "tn": 1}
    metrics = report["metrics"]
    assert metrics["precision"]["value"] == 0.5 and metrics["recall"]["value"] == round(1 / 3, 4)
    assert metrics["false_positive_rate"]["value"] == 0.5
    assert metrics["precision"]["ci95"][0] < 0.5 < metrics["precision"]["ci95"][1]
    assert metrics["localization"]["size"] == 5
    assert report["passed"] is False and "precision" in report["failed"]
    assert report["coverage"]["abstained"] == 1  # по M-005 сервис ничего не выдал
    print("OK: засчитывается только верный параметр с верным доказательством (IoU)")


def test_linkage_and_missing_metrics_are_not_passed():
    obj = f"eval-{uuid.uuid4().hex[:6]}"
    pid = _process(obj, [_check("M-001", "CANDIDATE")])
    reference = {"groups": [_group(obj, "M-001", "CONFIRMED_VIOLATION"),
                            _group(obj, "M-002", "NEGATIVE_VERIFIED", revision="3")]}
    report = evaluation.evaluate(reference, [pid])
    assert report["metrics"]["document_linkage"]["value"] == 0.5, "неверная редакция не связана"
    assert report["metrics"]["character_accuracy"]["passed"] is None
    assert "character_accuracy" in report["not_computed"] and report["passed"] is False
    print("OK: связка документов по шифру и редакции; непосчитанное не считается пройденным")


def test_key_fields_and_ocr_metrics():
    obj = f"eval-{uuid.uuid4().hex[:6]}"
    pid = _process(obj, [])
    reference = {"groups": [], "key_fields": [
        {"file_id": "F-RD", "field": "code", "value": "X-RD"},
        {"file_id": "F-RD", "field": "revision", "value": "9"},
        {"file_id": "F-RD", "field": "room", "value": "101"}],
        "ocr": [{"file_id": "нет-такого", "page": 1, "text": "Текст листа"}]}
    report = evaluation.evaluate(reference, [pid])
    key = report["metrics"]["key_fields_exact_match"]
    assert key["value"] == round(1 / 3, 4) and key["not_extracted_fields"] == 1
    ocr = report["metrics"]["character_accuracy"]
    assert ocr["value"] == 0 and ocr["coverage"] == 0 and ocr["cer"] == 1
    print("OK: Exact Match ключевых полей и точность распознавания считаются")


def test_wilson_interval_and_sections_from_request():
    assert evaluation.wilson(0, 0) is None
    low, high = evaluation.wilson(9, 10)
    assert low < 0.9 < high <= 1
    obj = f"eval-{uuid.uuid4().hex[:6]}"
    report = evaluation.evaluate([_group(obj, "M-001", "CONFIRMED_VIOLATION")],
                                 [_process(obj, [_check("M-001", "CANDIDATE")])],
                                 [{"code": "M-001", "section": "ПЗ"}])
    assert list(report["by_section"]) == ["ПЗ"], "раздел берётся из матрицы, переданной сервером"
    empty = evaluation.evaluate([], [])
    assert empty["passed"] is False
    print("OK: 95%-й интервал Уилсона; разделы — из матрицы запроса")
