"""Воркер очереди (ТЗ 1.5): разбор файла, проверка комплекта, инкрементальный
пересчёт (ТЗ 9.2), остановка по флагу и ответ «повтор не поможет».

Файлы приходят не с сервера, а из подменённого получателя — проверяется
механика воркера, а не сеть.
"""
import hashlib
import io
import json
from pathlib import Path

import pymupdf
import pytest
from app import contracts, kv, sources, worker

ROOT = Path(__file__).resolve().parents[3]
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def _parameters() -> list[dict]:
    return json.loads((ROOT / "data/parameter_catalog_v1_1.json").read_text("utf-8"))["parameters"]


def _pdf(text: str) -> bytes:
    document = pymupdf.open()
    page = document.new_page()
    page.insert_font(fontname="dejavu", fontfile=FONT)
    page.insert_text((72, 72), text, fontname="dejavu", fontsize=11)
    return document.tobytes()


class Files:
    """Хранилище сервера в памяти: отпечаток → содержимое."""

    def __init__(self) -> None:
        self.data: dict[str, bytes] = {}

    def add(self, data: bytes) -> str:
        digest = hashlib.sha256(data).hexdigest()
        self.data[digest] = data
        return digest

    def __call__(self, digest: str) -> bytes:
        if digest not in self.data:
            raise contracts.PermanentError("файл не найден в хранилище сервера")
        return self.data[digest]


@pytest.fixture
def files():
    store = Files()
    sources.use(store)
    yield store
    sources.use(None)


def _ref(files: Files, data: bytes, *, id_: int, stage: str, fmt: str = "PDF",
         derived: bytes | None = None, code: str = "") -> dict:
    return {"id": id_, "name": f"doc-{id_}.{fmt.lower()}", "sha256": files.add(data),
            "source_format": fmt, "derived_sha256": files.add(derived) if derived else None,
            "derived_format": "DXF" if derived else None, "pages": 1,
            "metadata": {"stage": stage, "object_id": "OBJ", "document_code": code or f"C-{stage}-{id_}",
                         "revision": "1", "approval_status": "APPROVED",
                         "approval_date": "2026-01-01", "file_id": f"F-{id_}"}}


def _parse_task(document: dict) -> dict:
    fields = {k: document[k] for k in ("id", "name", "sha256", "source_format",
                                       "derived_sha256", "derived_format")}
    return {"task_id": "t-parse", "kind": "parse", "attempt": 1, "document": fields}


def test_parse_pdf_caches_facts_by_hash(files):
    document = _ref(files, _pdf("Пояснительная записка. Площадь застройки 1200 м²"), id_=1, stage="PD")
    answer = worker.handle(_parse_task(document), lambda *_: None)
    assert answer["status"] == "ok", answer
    assert answer["payload"]["pages"] == 1
    assert kv.store().keys("facts:*"), "разбор сохранён в кэше по отпечатку файла"
    print("OK: разбор PDF, кэш по SHA-256")


def test_parse_docx_is_converted_to_pdf(files):
    from docx import Document

    stream = io.BytesIO()
    word = Document()
    word.add_paragraph("Акт освидетельствования скрытых работ")
    word.save(stream)
    document = _ref(files, stream.getvalue(), id_=2, stage="ID", fmt="DOCX")
    answer = worker.handle(_parse_task(document), lambda *_: None)
    assert answer["status"] == "ok", answer
    from app import facts_store
    facts = facts_store.stored(document["sha256"])
    assert "освидетельствования" in facts.text_facts[0]["text"]
    print("OK: DOCX приведён к PDF и разобран")


def test_parse_drawing_renders_derived_dxf_with_dimension_facts(files):
    import ezdxf
    from ezdxf import units

    drawing = ezdxf.new("R2018", setup=True)
    drawing.units = units.MM
    space = drawing.modelspace()
    space.add_lwpolyline([(0, 0), (6000, 0), (6000, 3000), (0, 3000)], close=True)
    dimension = space.add_linear_dim(base=(0, -500), p1=(0, 0), p2=(3000, 0), text="3500",
                                     override={"dimlfac": 1})
    dimension.render()
    space.add_text("План этажа", dxfattribs={"height": 250, "insert": (0, 3500)})
    stream = io.StringIO()
    drawing.write(stream)
    dxf = stream.getvalue().encode("utf-8")
    document = _ref(files, b"AC1032 original dwg bytes", id_=3, stage="RD", fmt="DWG", derived=dxf)

    answer = worker.handle(_parse_task(document), lambda *_: None)
    assert answer["status"] == "ok", answer
    cad = answer["payload"]["cad"]
    assert cad["dimensions"] >= 1 and cad["mismatches"], "надпись 3500 при длине 3000 — сигнал"
    from app import facts_store
    text = facts_store.stored(document["sha256"]).text_facts[0]["text"]
    assert "План этажа" in text and "[CAD]" in text
    print("OK: чертёж DWG/DXF разобран через производный DXF, размеры сверены с геометрией")


def test_missing_file_is_a_permanent_error(files):
    task = _parse_task({"id": 9, "name": "x.pdf", "sha256": "0" * 64, "source_format": "PDF",
                        "derived_sha256": None, "derived_format": None})
    answer = worker.handle(task, lambda *_: None)
    assert answer["status"] == "error" and answer["permanent"] is True
    assert worker.handle({"task_id": "x", "kind": "strange"}, lambda *_: None)["permanent"]
    print("OK: повтор не поможет — сервер не тратит на это попытки")


def _result(selected: dict, checks: list[dict], matrix: str = "1.1") -> dict:
    return {"matrix_version": matrix, "checks": checks,
            "coverage": {"total": len(checks), "completed": len(checks), "not_run": 0},
            "graphic_analysis": {"status": "not_run", "candidates": []},
            "document_selection": {"selected": selected, "problems": {}}}


def _check(parameter: dict, document_id: int) -> dict:
    return {"finding_id": f"{parameter['code']}:matrix", "parameter_code": parameter["code"],
            "technical_status": "completed", "completeness_status": "COMPLETE",
            "finding_status": "CANDIDATE", "section": parameter["section"],
            "evidence": [{"stage": "PD", "document_id": document_id, "page": 1, "bbox": [0, 0, 1, 1]}]}


def _inspect_task(documents: list[dict], previous=None) -> dict:
    return {"task_id": "t-inspect", "kind": "inspect", "attempt": 1, "process_id": 7,
            "object_id": "OBJ", "documents": documents, "parameters": _parameters(),
            "matrix_version": "1.1", "previous": previous, "decision_version": 3,
            "free_search": {"rules": [{"id": 1, "rule_name": "тест", "condition": "M-001 > 0",
                                       "expected": "M-002 > 0", "normative_base": "",
                                       "review_priority": "HIGH"}],
                            "norms": [], "history": {}}}


def test_inspect_reuses_previous_protocol_when_current_revisions_did_not_change(files):
    pd = _ref(files, _pdf("ПД"), id_=1, stage="PD")
    previous = {"version": 1, "result": _result({"PD": [1]}, [])}
    task = _inspect_task([pd], previous)
    answer = worker.inspect(task, lambda *_: None,
                            analysis=lambda *a, **k: pytest.fail("модель не должна вызываться"),
                            preflight=lambda _config: pytest.fail("связь не нужна"))
    assert answer["result"]["incremental"]["reused_from_version"] == 1
    print("OK: дозагрузка без новой актуальной редакции не гоняет модель")


def test_inspect_recomputes_only_parameters_with_new_data(files):
    parameters = _parameters()
    target = parameters[4]
    word = max((w for w in target["name"].split() if len(w) >= 4), key=len)
    pd = _ref(files, _pdf("ПД"), id_=1, stage="PD")
    rd = _ref(files, _pdf(f"Таблица: {word} 12"), id_=2, stage="RD")
    previous = {"version": 1, "result": _result({"PD": [1]}, [_check(p, 1) for p in parameters])}
    seen = {}

    def analysis(documents, config, *, codes=None, **kwargs):
        seen["codes"] = set(codes)
        return _result({"PD": [1], "RD": [2]},
                       [{**_check(p, 1), "explanation": "новый"} for p in parameters if p["code"] in codes])

    answer = worker.inspect(_inspect_task([pd, rd], previous), lambda *_: None, analysis=analysis, preflight=lambda _config: (True, ""))
    result = answer["result"]
    assert target["code"] in seen["codes"] and len(seen["codes"]) < len(parameters)
    fresh = next(c for c in result["checks"] if c["parameter_code"] == target["code"])
    assert fresh["explanation"] == "новый" and fresh["decisions_after_version"] == 3
    assert len(result["checks"]) == len(parameters), "остальные параметры перенесены"
    assert result["free_search"]["status"] == "completed"
    print("OK: пересчитаны только параметры с новыми данными, остальные перенесены")


def test_inspect_reports_progress_and_reads_cancel_flag(files):
    pd = _ref(files, _pdf("ПД"), id_=1, stage="PD")
    published = []
    kv.store().set_flag(contracts.cancel_key(7))

    def analysis(documents, config, *, progress, cancelled, **kwargs):
        progress("Сверка параметров", 1, 2)
        assert cancelled() is True
        return _result({"PD": [1]}, [])

    answer = worker.inspect(_inspect_task([pd]), lambda q, m: published.append((q, m)),
                            analysis=analysis, preflight=lambda _config: (True, ""))
    assert published == [(contracts.QUEUE_PROGRESS, contracts.progress(7, "Сверка параметров", 1, 2))]
    assert answer["model_version"]
    print("OK: ход проверки публикуется, остановка читается из Redis")


def test_workspace_is_removed_after_task(files, tmp_path):
    with sources.workspace() as folder:
        (folder / "x.pdf").write_bytes(b"%PDF-")
        kept = folder
    assert not kept.exists(), "расшифрованные файлы не переживают задачу"


def test_contract_matches_server():
    text = (ROOT / "packages/server/src/queue/contracts.ts").read_text("utf-8")
    for name in ("QUEUE_PARSE", "QUEUE_INSPECT", "QUEUE_RESULTS", "QUEUE_PROGRESS",
                 "CANCEL_KEY_PREFIX"):
        assert f"export const {name} = '{getattr(contracts, name)}'" in text, name
    for field in contracts.INSPECT_FIELDS:
        assert f"  {field}:" in text or field in ("task_id", "kind", "attempt"), field
    print("OK: имена очередей и полей задачи совпадают с сервером")


def test_unreachable_model_is_a_retryable_error_not_an_empty_protocol(files, monkeypatch):
    """Без связи с моделью процесс не выглядит завершённым: сервер повторит
    задачу и после повторов уведомит администратора (ТЗ 9.1)."""
    pd = _ref(files, _pdf("ПД"), id_=1, stage="PD")
    monkeypatch.setattr(worker, "check_llm_reachable", lambda config: (False, "модель не отвечает"))
    answer = worker.handle(_inspect_task([pd]), lambda *_: None)
    assert answer["status"] == "error" and answer["permanent"] is False
    assert "модель не отвечает" in answer["error"]
