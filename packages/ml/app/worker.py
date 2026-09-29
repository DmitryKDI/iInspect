"""Воркер ML-модулей: задачи разбора и проверки из очереди RabbitMQ (ТЗ 1.5).

Сервер ставит задачу — воркер отвечает результатом в `inspector.results`.
Сообщение подтверждается только после публикации ответа: упавший воркер
не теряет задачу, брокер отдаст её другому. Повторы по сбою и срок задачи
считает сервер (ТЗ 9.1: не более двух повторов, затем уведомление
администратора), поэтому здесь ошибка не глотается и не повторяется, а
возвращается ответом с признаком «повтор не поможет» для повреждённых файлов.

Две задачи:

- `parse` — разбор одного файла: страницы, OCR, CV-измерения чертежей,
  раздел тома. Результат кэшируется в Redis по SHA-256 (ТЗ 9.1, п.5):
  повторная проверка того же тома его не разбирает;
- `inspect` — проверка комплекта по матрице, переданной сервером, с
  инкрементальным пересчётом (ТЗ 9.2) и свободным поиском гипотез (ТЗ 9.5).
  Ход проверки публикуется в `inspector.progress`, остановка читается из
  Redis на безопасных точках.
"""

from __future__ import annotations

import copy
import datetime as dt
import json
import logging
from collections.abc import Callable

from . import cad, facts_store, kv, sources, suspicions
from .classification import classify_document
from .contracts import (
    QUEUE_INSPECT,
    QUEUE_PARSE,
    QUEUE_PROGRESS,
    QUEUE_RESULTS,
    QUEUES,
    PermanentError,
    cancel_key,
    error,
    ok,
    progress,
)
from .llm import LlmConfig, check_llm_reachable, local_config, model_configured
from .official_pipeline import (
    parameters_with_new_data,
    run_official_analysis,
    select_current_documents,
)

log = logging.getLogger("inspector.ml.worker")
Publish = Callable[[str, dict], None]


# --- разбор файла ---------------------------------------------------------------


def _vision(config: LlmConfig):
    if not model_configured(config):
        return None
    from .vision import make_llm_stamp_classifier

    return make_llm_stamp_classifier(config)


def parse(task: dict, config: LlmConfig | None = None) -> dict:
    """Разбор файла; результат — метаданные разбора для карточки файла."""
    document = task["document"]
    config = config or local_config()
    with sources.workspace() as folder:
        source = sources.materialize(document, folder)
        facts = facts_store.facts_for(source.file_path, source.name, digest=source.digest)
        if source.cad is not None:
            line = cad.summary_line(source.cad)
            if facts.text_facts and line not in facts.text_facts[0]["text"]:
                # Точные размеры чертежа — часть текста листа: модель видит
                # их рядом с цитатами, как и CV-измерения PDF.
                facts.text_facts[0]["text"] += f"\n{line}"
                facts_store.put(source.digest, facts, replace=True)
        classification = classify_document(
            source.file_path, source.name, vision_stamp_fn=_vision(config)
        )
    quality = facts.ocr_quality or {}
    payload = {
        "pages": facts.pages,
        "discipline_code": classification.discipline_code,
        "classification_source": classification.source,
        "classification_error": classification.vision_error,
        "ocr_status": facts.ocr_status,
        "ocr_quality": {
            "low_quality_pages": sorted(p for p, v in quality.items() if v == "LOW_QUALITY"),
            "abstain_pages": sorted(p for p, v in quality.items() if v == "ABSTAIN"),
        },
        "drawing_pages": sorted(p for p, kind in facts.page_kinds.items() if kind == "drawing"),
        "measured_pages": sorted(facts.measurements),
    }
    if source.cad is not None:
        payload["cad"] = {
            "entities": source.cad.entities,
            "texts": source.cad.texts,
            "dimensions": len(source.cad.dimensions),
            "mismatches": source.cad.mismatches[:50],
            "truncated": source.cad.truncated,
        }
    return payload


# --- инкрементальный пересчёт (ТЗ 9.2) ------------------------------------------


def _selection(documents) -> dict[str, list[int]]:
    selected, _ = select_current_documents(documents)
    return {stage: sorted(doc.id for doc in docs) for stage, docs in selected.items()}


def reuse_previous(previous: dict | None, documents, matrix_version: str) -> dict | None:
    """Прежний результат, если дозагрузка не изменила состав актуальных редакций.

    Каждый параметр читает все три стадии, поэтому затронутые параметры
    определяются составом АКТУАЛЬНЫХ редакций. Неполный прежний прогон не
    переиспользуется: неполноту нельзя унаследовать как готовый ответ.
    """
    result = (previous or {}).get("result")
    if not result or (result.get("coverage") or {}).get("not_run"):
        return None
    if result.get("matrix_version") != matrix_version:
        return None
    before = (result.get("document_selection") or {}).get("selected") or {}
    if {k: sorted(v) for k, v in before.items()} != _selection(documents):
        return None
    reused = copy.deepcopy(result)
    reused["incremental"] = {
        "reused_from_version": previous.get("version"),
        "reason": "дозагрузка не изменила состав актуальных редакций",
    }
    return reused


def affected_codes(
    previous: dict | None, documents, parameters: list[dict], matrix_version: str
) -> set[str] | None:
    """Параметры для пересчёта; None — пересчитать всё.

    Пересчитываются параметры, для которых в новых документах есть данные,
    и те, чья прежняя проверка неполна или ссылается на редакцию, которая
    перестала быть актуальной. Остальные переносятся вместе с решениями.
    """
    result = (previous or {}).get("result")
    if not result or (result.get("coverage") or {}).get("not_run"):
        return None
    if result.get("matrix_version") != matrix_version:
        return None  # матрица изменилась — прежние результаты не по той редакции
    before = {
        int(i)
        for ids in ((result.get("document_selection") or {}).get("selected") or {}).values()
        for i in ids
    }
    after = {i for ids in _selection(documents).values() for i in ids}
    removed = before - after
    added = [document for document in documents if document.id in after - before]
    previous_checks = {item.get("parameter_code"): item for item in result.get("checks") or []}
    codes = parameters_with_new_data(parameters, added)
    for parameter in parameters:
        check = previous_checks.get(parameter["code"])
        if (
            check is None
            or check.get("technical_status") != "completed"
            or check.get("completeness_status") not in {"COMPLETE", "NOT_APPLICABLE"}
            or any(item.get("document_id") in removed for item in check.get("evidence") or [])
        ):
            codes.add(parameter["code"])
    return None if len(codes) >= len(parameters) else codes


def merge_incremental(
    result: dict, previous: dict, codes: set[str], parameters: list[dict], decision_version: int
) -> dict:
    """Новые результаты по затронутым параметрам, прежние — по остальным."""
    fresh = {item["parameter_code"]: item for item in result.get("checks") or []}
    kept = {item.get("parameter_code"): item for item in previous["result"].get("checks") or []}
    checks = []
    for parameter in parameters:
        code = parameter["code"]
        if code in codes and code in fresh:
            # Решения, принятые по прежнему результату, к новому не относятся.
            checks.append({**fresh[code], "decisions_after_version": decision_version})
        elif code in kept:
            checks.append(kept[code])
    completed = sum(item.get("technical_status") == "completed" for item in checks)
    result["checks"] = checks
    result["coverage"] = {
        "total": len(checks),
        "completed": completed,
        "not_run": len(checks) - completed,
    }
    result["incremental"] = {
        "recomputed": sorted(codes),
        "kept": len(checks) - len(codes & fresh.keys()),
        "reason": "пересчитаны параметры, для которых появились новые данные, и параметры "
        "с неполной прежней проверкой; остальные перенесены вместе с решениями",
    }
    return result


# --- свободный поиск (ТЗ 9.5) -----------------------------------------------------


def _rooms(documents, selected: dict[str, list[int]]) -> dict[str, list[dict]]:
    by_id = {document.id: document for document in documents}
    rooms: dict[str, list[dict]] = {}
    for stage, ids in selected.items():
        for document_id in ids:
            document = by_id.get(document_id)
            if document is None:
                continue
            facts = facts_store.facts_for(document.file_path, document.name, digest=document.digest)
            rooms.setdefault(stage, []).extend(
                {
                    "key": item["key"],
                    "name": item.get("name") or "",
                    "page": item.get("page"),
                    "document_id": document_id,
                }
                for item in facts.room_facts
                if item.get("key") and item.get("name")
            )
    return rooms


def free_search(task: dict, documents, result: dict) -> dict:
    """Гипотезы вне матрицы. Сбой виден отдельным состоянием, не как «гипотез нет»."""
    inputs = task.get("free_search") or {}
    try:
        selected = (result.get("document_selection") or {}).get("selected") or {}
        checks = result.get("checks") or []
        codes = {
            document.id: str(document.source_metadata.get("document_code") or "")
            for document in documents
        }
        found = suspicions.discover(
            checks,
            rules=inputs.get("rules") or [],
            norms=inputs.get("norms") or [],
            rooms=_rooms(documents, selected),
            history=inputs.get("history") or {},
            document_codes=codes,
            today=dt.date.today(),
        )
    except Exception as exc:  # noqa: BLE001 — сбой виден в результате
        return {"status": "error", "reason": f"свободный поиск не выполнен: {exc}", "items": []}
    by_code = {check.get("parameter_code"): check for check in checks}
    for item in found:
        item["evidence"] = list(
            (by_code.get(item.get("parameter_code") or "") or {}).get("evidence") or []
        )
    return {"status": "completed", "reason": "", "items": found}


# --- проверка комплекта -----------------------------------------------------------


class ModelUnavailableError(RuntimeError):
    """Модель не отвечает: проверка не начиналась, повтор может помочь."""


def inspect(
    task: dict,
    publish: Publish,
    config: LlmConfig | None = None,
    analysis: Callable[..., dict] = run_official_analysis,
    preflight: Callable[[LlmConfig], tuple[bool, str]] | None = None,
) -> dict:
    """Проверка комплекта по матрице; результат — протокол для сервера.

    Связь с моделью проверяется ДО проверки: иначе каждый из 132 параметров
    вернулся бы «не выполнено», а процесс выглядел бы завершённым. Отказ
    уходит серверу ошибкой — он повторит задачу и после двух повторов
    уведомит администратора (ТЗ 9.1).
    """
    config = config or local_config()
    process_id = int(task["process_id"])
    parameters = list(task.get("parameters") or [])
    matrix_version = str(task.get("matrix_version") or "")
    previous = task.get("previous")

    def report(stage: str, completed: int, total: int) -> None:
        publish(QUEUE_PROGRESS, progress(process_id, stage, completed, total))

    def cancelled() -> bool:
        return kv.store().flag(cancel_key(process_id))

    with sources.workspace() as folder:
        documents = [sources.materialize(item, folder) for item in task.get("documents") or []]
        reused = reuse_previous(previous, documents, matrix_version)
        if reused is not None:
            return {"model_version": config.resolved_model(), "result": reused}
        if model_configured(config):
            reachable, message = (preflight or check_llm_reachable)(config)
            if not reachable:
                raise ModelUnavailableError(message)
        active = [item for item in parameters if item.get("is_active", True)]
        codes = affected_codes(previous, documents, active, matrix_version)
        result = analysis(
            documents,
            config,
            parameters=parameters,
            matrix_version=matrix_version,
            progress=report,
            cancelled=cancelled,
            codes=codes,
        )
        if codes is not None:
            result = merge_incremental(
                result, previous, codes, active, int(task.get("decision_version") or 0)
            )
        elif previous:
            result["incremental"] = {
                "recomputed": "all",
                "reason": "прежний результат неполон или матрица изменилась — "
                "пересчитаны все параметры",
            }
        result["free_search"] = free_search(task, documents, result)
    return {"model_version": config.resolved_model(), "result": result}


def handle(task: dict, publish: Publish) -> dict:
    """Выполнить задачу и вернуть ответ для `inspector.results`."""
    kind = task.get("kind")
    try:
        if kind == "parse":
            return ok(task, parse(task))
        if kind == "inspect":
            return ok(task, inspect(task, publish))
        return error(task, f"неизвестный вид задачи: {kind}", permanent=True)
    except PermanentError as exc:
        return error(task, str(exc), permanent=True)
    except Exception as exc:  # noqa: BLE001 — сбой уходит серверу: он решает о повторе
        log.exception("задача %s не выполнена", task.get("task_id"))
        return error(task, f"{type(exc).__name__}: {exc}", permanent=False)


# --- RabbitMQ ---------------------------------------------------------------------


def run(url: str) -> None:  # pragma: no cover — живой брокер проверяется на стенде
    """Слушать очереди задач до остановки процесса."""
    import pika

    connection = pika.BlockingConnection(pika.URLParameters(url))
    channel = connection.channel()
    for queue in QUEUES:
        channel.queue_declare(queue=queue, durable=True)
    # Одна задача за раз на процесс: разбор тома и проверка комплекта
    # занимают модель целиком; параллельность — числом реплик воркера.
    channel.basic_qos(prefetch_count=1)

    def publish(queue: str, message: dict) -> None:
        channel.basic_publish(
            "",
            queue,
            json.dumps(message, ensure_ascii=False).encode("utf-8"),
            pika.BasicProperties(delivery_mode=2, content_type="application/json"),
        )

    def on_message(ch, method, _properties, body: bytes) -> None:
        try:
            task = json.loads(body)
        except ValueError:
            ch.basic_nack(method.delivery_tag, requeue=False)  # нечитаемое не зациклить
            return
        publish(QUEUE_RESULTS, handle(task, publish))
        ch.basic_ack(method.delivery_tag)

    channel.basic_consume(QUEUE_PARSE, on_message)
    channel.basic_consume(QUEUE_INSPECT, on_message)
    log.info("воркер слушает %s и %s", QUEUE_PARSE, QUEUE_INSPECT)
    channel.start_consuming()


def main() -> None:  # pragma: no cover
    from . import config, observability

    observability.configure_logging("inspector-ml-worker")
    run(config.amqp_url())


if __name__ == "__main__":  # pragma: no cover
    main()
