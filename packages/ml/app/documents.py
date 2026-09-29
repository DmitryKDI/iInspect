"""Извлечение постраничного текста, штампа и реестра помещений из PDF для
diff и сопоставления листов.

Порт извлечения текста из nadzor-browser/app.js (readPageItems/extractFileFacts)
на PyMuPDF. Разбор реестра помещений — rooms.py, основная надпись — stamp.py,
отсев прайсов поставщика — material.py (у каждого свой докстринг).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

from .balance_box import extract_balance_facts
from .classification import PAGE_KIND_DRAWING, classify_page_kind, open_pdf
from .cv import measure_page, summary_line
from .equipment import extract_equipment_facts
from .local_ocr import OcrConfig, load_config, quality, recognize_page
from .material import non_project_reason
from .rooms import extract_room_facts
from .stamp import read_stamp


def _int_env(name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(lo, min(hi, value))


# Сколько чертёжных листов документа разрешено распознать графическим OCR.
# Бюджет вычислений локального OCR, а не граница истины: лист, до которого
# обработка не дошла, помечается пропущенным, а не прочитанным.
GRAPHIC_OCR_PAGE_BUDGET = _int_env("INSPECTOR_GRAPHIC_OCR_PAGE_BUDGET", 40, 0, 400)


@dataclass
class DocumentFacts:
    name: str
    pages: int
    text_facts: list[dict]  # [{page, text}]
    room_facts: list[dict]  # [{page, key, name, area?}]
    page_kinds: dict[int, str] = field(default_factory=dict)  # {page: 'drawing'|'text'}
    # [{page, key, name, parent?, qty?}] — позиции ведомости оборудования (Г.20)
    equipment_facts: list[dict] = field(default_factory=list)
    # [{page, room_key, system_code?, приток_м3ч?, вытяжка_м3ч?}] — баланс-рамка
    # у номера помещения (Г.30, п.1); на реальных CAD-листах почти всегда
    # пуст текстовым путём (см. balance_box.py) — пусто здесь не значит
    # «нет рамки на листе», значит «текстовый путь её не нашёл» (Г.10).
    balance_facts: list[dict] = field(default_factory=list)
    # {page: {shifr, sheet_no, sheet_name}} — основная надпись, если читается текстом
    sheet_info: dict[int, dict] = field(default_factory=dict)
    # {page: причина} — лист исключён из сравнения как непроектный материал.
    # Видимое состояние, а не молчаливый пропуск: пользователь должен понимать,
    # почему по этому листу нет находок.
    excluded: dict[int, str] = field(default_factory=dict)
    # OCR запускается на листах без текстового слоя и на чертёжных листах,
    # чей текст не дал ни одного пригодного для сопоставления факта. Состояние
    # и ошибки хранятся рядом с результатом, чтобы сбой движка распознавания не
    # выглядел как доказанное отсутствие текста (Г.10).
    ocr_status: str = "not_required"
    ocr_pages_total: int = 0
    ocr_pages_done: list[int] = field(default_factory=list)
    ocr_text_pages: list[int] = field(default_factory=list)
    ocr_errors: dict[int, str] = field(default_factory=dict)
    # Качество каждой распознанной страницы: OK / LOW_QUALITY / ABSTAIN.
    ocr_quality: dict[int, str] = field(default_factory=dict)
    # Чертёжные листы, которым нужен графический OCR: текст листа есть, но
    # сопоставлять по нему нечего. Список заполняется независимо от того,
    # настроен ли сервис, иначе «не настроено» и «не нужно» стали бы
    # неразличимы (Г.10).
    ocr_graphic_candidates: list[int] = field(default_factory=list)
    # Из них действительно распознанные. Это отдельный способ получения
    # результата, и в происхождении гипотезы он обязан быть назван.
    ocr_graphic_pages: list[int] = field(default_factory=list)
    # И те, до которых не дошёл бюджет: лист, который не смотрели, не
    # является листом без графики.
    ocr_graphic_skipped: list[int] = field(default_factory=list)
    # CV-анализ чертёжных листов (ТЗ 9.1, п.3): масштаб по размерным линиям,
    # число линий, расхождения надписи и графики — {page: PageMeasurement}.
    measurements: dict[int, dict] = field(default_factory=dict)


def _collect_page_facts(text: str, page_no: int, room_facts: list[dict],
                        equipment_facts: list[dict], balance_facts: list[dict]) -> int:
    """Разобрать текст страницы в факты и сказать, сколько их вышло.

    Число возвращается не ради статистики: ноль фактов на чертёжном листе —
    это и есть признак того, что текстовый путь по нему не сработал.
    """
    page_room_facts = extract_room_facts(text)
    for fact in page_room_facts:
        room_facts.append({"page": page_no, **fact})
    page_room_keys = {fact["key"] for fact in page_room_facts}
    page_equipment = list(extract_equipment_facts(text, room_keys=page_room_keys))
    for fact in page_equipment:
        equipment_facts.append({"page": page_no, **fact})
    page_balance = list(extract_balance_facts(text, room_keys=page_room_keys))
    for fact in page_balance:
        balance_facts.append({"page": page_no, **fact})
    return len(page_room_facts) + len(page_equipment) + len(page_balance)


def extract_document_facts(pdf_path: str, name: str) -> DocumentFacts:
    doc = open_pdf(pdf_path)
    try:
        text_facts = []
        room_facts = []
        equipment_facts = []
        balance_facts = []
        page_kinds = {}
        sheet_info = {}
        excluded = {}
        ocr_config: OcrConfig | None = load_config()
        ocr_pages_total = 0
        ocr_pages_done = []
        ocr_text_pages = []
        ocr_errors = {}
        ocr_quality: dict[int, str] = {}
        graphic_candidates: list[int] = []
        graphic_done: list[int] = []
        graphic_skipped: list[int] = []
        measurements: dict[int, dict] = {}
        for i in range(doc.page_count):
            page = doc[i]
            page_no = i + 1
            text = page.get_text("text").strip()
            page_kinds[page_no] = classify_page_kind(page)

            if not text:
                ocr_pages_total += 1
                if ocr_config is not None:
                    ocr = recognize_page(page, ocr_config)
                    ocr_quality[page_no] = quality(ocr)
                    if ocr.error:
                        ocr_errors[page_no] = ocr.error
                    else:
                        ocr_pages_done.append(page_no)
                        text = ocr.text
                        if text:
                            ocr_text_pages.append(page_no)

            reason = non_project_reason(text) if text else None
            if reason:
                excluded[page_no] = reason
                continue  # ни текста, ни помещений: материал не участвует в сравнении

            page_fact_total = 0
            if text:
                text_facts.append({"page": page_no, "text": text})
                page_fact_total = _collect_page_facts(
                    text, page_no, room_facts, equipment_facts, balance_facts)

            # Чертёжный лист, чей текст не дал НИ ОДНОГО пригодного для
            # сопоставления факта, графикой не поделился: основная надпись
            # читается текстом, а подписи внутри поля чертежа переведены в
            # кривые (Г.8, Г.59). Признак структурный — «фактов нет», — а не
            # порог по числу символов: сколько весит штамп, зависит от
            # формата листа, а не от того, прочитан ли сам чертёж.
            #
            # Цена ошибки односторонняя и выбрана сознательно: схема, у
            # которой фактов нет по существу, уйдёт в OCR напрасно и
            # потратит бюджет. Обратная ошибка дороже — нераспознанный лист
            # выглядит прочитанным.
            #
            # Лист, уже прошедший распознавание как бестекстовый, второй раз
            # не распознаётся: это был бы тот же вызов за те же деньги.
            already_recognized = page_no in ocr_pages_done or page_no in ocr_errors
            if (text and not already_recognized
                    and page_kinds[page_no] == PAGE_KIND_DRAWING and not page_fact_total):
                graphic_candidates.append(page_no)
                if ocr_config is None:
                    pass  # состояние назовёт ocr_status ниже
                elif len(graphic_done) >= GRAPHIC_OCR_PAGE_BUDGET:
                    graphic_skipped.append(page_no)
                else:
                    ocr = recognize_page(page, ocr_config)
                    ocr_quality[page_no] = quality(ocr)
                    if ocr.error:
                        ocr_errors[page_no] = ocr.error
                    elif ocr.text:
                        # Распознанное ДОПОЛНЯЕТ текст листа, а не заменяет:
                        # штамп прочитан текстовым путём и остаётся
                        # доказательством с координатами, а графика приходит
                        # другим способом и должна быть отличима от него.
                        graphic_done.append(page_no)
                        ocr_pages_done.append(page_no)
                        ocr_text_pages.append(page_no)
                        text_facts[-1]["text"] = f"{text}\n{ocr.text}"
                        _collect_page_facts(ocr.text, page_no, room_facts,
                                            equipment_facts, balance_facts)

            if page_kinds[page_no] == PAGE_KIND_DRAWING:
                measured = measure_page(page)
                measurements[page_no] = measured.to_dict()
                if text_facts and text_facts[-1]["page"] == page_no:
                    text_facts[-1]["text"] = f"{text_facts[-1]['text']}\n{summary_line(measured)}"

            stamp = read_stamp(page)
            if not stamp.is_empty():
                sheet_info[page_no] = {"shifr": stamp.shifr, "sheet_no": stamp.sheet_no,
                                       "sheet_name": stamp.sheet_name}
        # Порядок важен: сначала то, что помешало прочитать, и только потом
        # «готово». Иначе один распознанный лист прикрывал бы собой и сбой
        # сервиса, и листы, до которых не дошёл бюджет (Г.10).
        if not ocr_pages_total and not graphic_candidates:
            ocr_status = "not_required"
        elif ocr_config is None:
            ocr_status = "not_configured"
        elif ocr_errors:
            ocr_status = "error"
        elif graphic_skipped:
            ocr_status = "budget_exhausted"
        else:
            ocr_status = "done"
        return DocumentFacts(name=name, pages=doc.page_count, text_facts=text_facts,
                              room_facts=room_facts, page_kinds=page_kinds,
                              equipment_facts=equipment_facts, balance_facts=balance_facts,
                              sheet_info=sheet_info, excluded=excluded,
                              ocr_status=ocr_status, ocr_pages_total=ocr_pages_total,
                              ocr_pages_done=ocr_pages_done, ocr_text_pages=ocr_text_pages,
                              ocr_errors=ocr_errors, ocr_quality=ocr_quality,
                              ocr_graphic_candidates=graphic_candidates,
                              ocr_graphic_pages=graphic_done,
                              ocr_graphic_skipped=graphic_skipped,
                              measurements=measurements)
    finally:
        doc.close()
