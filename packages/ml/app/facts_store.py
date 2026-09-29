"""ПАМЯТЬ РАЗБОРА — извлечённые из документа факты, посчитанные один раз.

Зачем. Разбор страницы — это чтение PDF, разбор текстового слоя, реестры
помещений и оборудования, чтение штампа. На томе в сотни листов это минуты.
Раньше всё это считалось заново при каждом обращении: при загрузке, при
разборе ПД, при сверке, при построении реестра помещений РД — четыре раза
одна и та же работа над одним и тем же файлом. Здесь она делается один раз
и сохраняется.

Что это даёт сверке чертежей. Отличие на листе ищется не по картинке
целиком, а по разобранным частям листа: номера помещений, позиции
оборудования, баланс-рамки, штамп, вид листа. Когда эти части лежат
готовыми, сравнение двух комплектов — это сопоставление списков, а не
повторный разбор гигабайтов. Модели уходит не «вот два чертежа, найди
разницу», а короткий список того, что на них различается.

Ключ — отпечаток СОДЕРЖИМОГО (тот же SHA-256, что в `file_store`), а не имя
и не путь: тот же том, загруженный второй раз или под другим именем, уже
разобран. Вместе с отпечатком в ключ входит версия разборщика: меняется
код извлечения — прежние записи перестают подходить сами, без ручной
чистки и без риска отдать разбор по старым правилам (Г.10).

Хранилище — Redis (ТЗ 9.1, п.5: «результаты парсинга сохраняются в Redis по
хешу файла»), значения зашифрованы (`kv`). Разбор переживает удаление
оригинала по сроку хранения: он производный и восстановим.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from . import kv
from .documents import DocumentFacts, extract_document_facts
from .local_ocr import is_configured as ocr_is_configured

# Версия разборщика. Поднимается при ЛЮБОМ изменении того, что и как
# извлекается из страницы: иначе сохранённый разбор молча отдавался бы по
# старым правилам, и новое поведение проверялось бы на старых данных (Г.10).
# 5 — хранилище перенесено в Redis, добавлены CV-измерения и разбор чертежей.
FACTS_VERSION = 5

_CHUNK = 1024 * 1024


def _key(digest: str) -> str:
    return f"facts:{FACTS_VERSION}:{digest}"


def digest_of_file(path: str | Path) -> str:
    """Отпечаток файла, посчитанный кусками (том в сотни мегабайт не держим в памяти)."""
    sha = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(_CHUNK):
            sha.update(chunk)
    return sha.hexdigest()


def _to_payload(facts: DocumentFacts) -> dict:
    return {
        "name": facts.name, "pages": facts.pages,
        "text_facts": facts.text_facts, "room_facts": facts.room_facts,
        "page_kinds": facts.page_kinds, "equipment_facts": facts.equipment_facts,
        "balance_facts": facts.balance_facts, "sheet_info": facts.sheet_info,
        "excluded": facts.excluded, "ocr_status": facts.ocr_status,
        "ocr_pages_total": facts.ocr_pages_total, "ocr_pages_done": facts.ocr_pages_done,
        "ocr_text_pages": facts.ocr_text_pages, "ocr_errors": facts.ocr_errors,
        "ocr_quality": facts.ocr_quality, "measurements": facts.measurements,
    }


def _from_payload(name: str, raw: dict) -> DocumentFacts:
    # Ключи страниц в JSON становятся строками. Возвращаем целые: по всему
    # коду страница — число, и разнотипные ключи давали бы промах поиска,
    # который выглядит как «на листе ничего не найдено».
    return DocumentFacts(
        name=name,
        pages=int(raw.get("pages") or 0),
        text_facts=raw.get("text_facts", []),
        room_facts=raw.get("room_facts", []),
        page_kinds={int(k): v for k, v in raw.get("page_kinds", {}).items()},
        equipment_facts=raw.get("equipment_facts", []),
        balance_facts=raw.get("balance_facts", []),
        sheet_info={int(k): v for k, v in raw.get("sheet_info", {}).items()},
        excluded={int(k): v for k, v in raw.get("excluded", {}).items()},
        ocr_status=str(raw.get("ocr_status") or "not_required"),
        ocr_pages_total=int(raw.get("ocr_pages_total") or 0),
        ocr_pages_done=[int(v) for v in raw.get("ocr_pages_done", [])],
        ocr_text_pages=[int(v) for v in raw.get("ocr_text_pages", [])],
        ocr_errors={int(k): str(v) for k, v in raw.get("ocr_errors", {}).items()},
        ocr_quality={int(k): str(v) for k, v in raw.get("ocr_quality", {}).items()},
        measurements={int(k): v for k, v in raw.get("measurements", {}).items()},
    )


def stored(digest: str, *, touch: bool = True) -> DocumentFacts | None:
    """Готовый разбор по отпечатку, или None."""
    raw = kv.store().get_json(_key(digest))
    return None if raw is None else _from_payload(str(raw.get("name") or ""), raw)


def put(digest: str, facts: DocumentFacts, *, replace: bool = False) -> None:
    """Сохранить разбор. Повторная запись того же ключа не ошибка."""
    if not replace and kv.store().get_bytes(_key(digest)) is not None:
        return
    kv.store().set_json(_key(digest), _to_payload(facts))


def facts_for(path: str | Path, name: str, digest: str | None = None) -> DocumentFacts:
    """Разбор документа: из кэша, а если его там нет — посчитать и сохранить.

    `digest` передаётся, если он уже посчитан: считать отпечаток второй раз незачем.
    """
    key = digest or digest_of_file(path)
    remembered = stored(key)
    should_refresh_ocr = (
        remembered is not None
        and remembered.ocr_status == "not_configured"
        and ocr_is_configured()
    )
    if remembered is not None and not should_refresh_ocr:
        # Имя берётся из запроса, а не из памяти: один и тот же файл может
        # быть загружен под разными именами.
        remembered.name = name
        return remembered
    facts = extract_document_facts(str(path), name)
    put(key, facts, replace=should_refresh_ocr)
    return facts


def forget(digest: str) -> None:
    kv.store().delete(_key(digest))


def stats() -> dict:
    keys = kv.store().keys(f"facts:{FACTS_VERSION}:*")
    return {"documents": len(keys), "version": FACTS_VERSION, "backend": kv.store().backend}


def dumps(facts: DocumentFacts) -> str:
    return json.dumps(_to_payload(facts), ensure_ascii=False)
