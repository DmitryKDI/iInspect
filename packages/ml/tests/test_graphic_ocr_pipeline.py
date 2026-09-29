"""Чертёж читается локальным OCR, а не только зрением модели.

Техническое задание требует отдельного конвейера для графики: определить
графические страницы, получить изображение, распознать его, извлечь
обозначения и подписи и только потом связать найденное с требованием и
листом. Распознавание локальное: внешние OCR-сервисы в зачётном прогоне
недопустимы.

Что мешало. OCR запускался по условию «на странице совсем нет текста». На
реальном CAD-экспорте это условие у чертежа почти никогда не выполняется:
основная надпись остаётся текстом, а подписи внутри поля чертежа переведены
в кривые (Г.8, Г.59). Такой лист выглядел прочитанным — `text` непустой, —
и графика не читалась НИКОГДА: живой путь отдавал её зрению модели, а
распознавание в нём не участвовало вовсе.

Признак здесь структурный, а не пороговый: чертёжный лист, текст которого
не дал ни одного пригодного для сопоставления факта, графикой не
поделился. Сколько таких листов распознавать — бюджет, а не граница истины.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pymupdf

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import documents, local_ocr  # noqa: E402

CYRILLIC_TTF = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
CONFIG = local_ocr.OcrConfig(language="rus")


def _pdf(path: Path, pages: list[tuple[str, bool]]) -> str:
    """pages: [(текст листа, чертёжный ли он)]."""
    doc = pymupdf.open()
    font = pymupdf.Font(fontfile=CYRILLIC_TTF)
    for text, drawing in pages:
        # Формат длинной стороны и решает, чертёжный лист или текстовый:
        # A2 в пунктах против A4. Геометрия, а не лексика документа.
        page = doc.new_page(width=1190, height=1684) if drawing else doc.new_page()
        page.insert_font(fontname="F0", fontbuffer=font.buffer)
        if text:
            page.insert_textbox(pymupdf.Rect(36, 36, 500, 700), text,
                                fontname="F0", fontsize=9)
    doc.save(str(path))
    doc.close()
    return str(path)


def _run(path, monkeypatch, *, recognized="", error="", configured=True, budget=None):
    seen = []

    def fake_recognize(page, config):
        seen.append(page.number + 1)
        return local_ocr.OcrResult(text=recognized, error=error)

    monkeypatch.setattr(documents, "load_config", lambda: CONFIG if configured else None)
    monkeypatch.setattr(documents, "recognize_page", fake_recognize)
    if budget is not None:
        monkeypatch.setattr(documents, "GRAPHIC_OCR_PAGE_BUDGET", budget)
    return documents.extract_document_facts(path, "комплект"), seen


def test_drawing_with_stamp_only_text_is_recognized(tmp_path, monkeypatch):
    """Штамп читается, поле чертежа — нет. Раньше лист считался прочитанным."""
    path = _pdf(tmp_path / "рд.pdf", [("Лист 1 Стадия Р Листов 12", True)])

    facts, seen = _run(path, monkeypatch, recognized="Помещение 101 установка В1")

    assert seen == [1], "чертёжный лист без извлечённых фактов не ушёл в OCR"
    assert facts.ocr_graphic_pages == [1]
    assert "установка В1" in facts.text_facts[0]["text"]


def test_prose_page_is_not_recognized(tmp_path, monkeypatch):
    """Текстовый лист с прозой читается текстом — тратить OCR не на что."""
    path = _pdf(tmp_path / "пд.pdf", [(
        "Помещение 101 оборудуется приточной установкой. "
        "Расход воздуха принят по расчёту. Помещение 102 — вытяжной.", False)])

    _, seen = _run(path, monkeypatch, recognized="не должно понадобиться")

    assert seen == [], "OCR потрачен на лист, который и так прочитан"


def test_drawing_whose_text_gave_facts_is_not_recognized(tmp_path, monkeypatch):
    """Признак структурный: факты извлеклись — значит текст листа работает."""
    path = _pdf(tmp_path / "рд.pdf",
                [("101  Кабинет  24,5\n102  Коридор  18,0", True)])

    facts, seen = _run(path, monkeypatch, recognized="не должно понадобиться")

    assert facts.room_facts, "фикстура обязана давать факты, иначе тест пуст"
    assert seen == []


def test_graphic_ocr_source_is_distinguishable_from_textless_ocr(tmp_path, monkeypatch):
    """Способ получения результата обязан быть виден (происхождение по ТЗ)."""
    path = _pdf(tmp_path / "рд.pdf", [("", True), ("Лист 2 Стадия Р", True)])

    facts, seen = _run(path, monkeypatch, recognized="Распознано")

    assert seen == [1, 2], "лист не должен распознаваться дважды"
    assert facts.ocr_pages_done == [1, 2]
    assert facts.ocr_graphic_pages == [2], "лист без текста и лист в кривых — разные случаи"


def test_budget_exhaustion_is_named_not_silent(tmp_path, monkeypatch):
    """Лист, до которого не дошёл бюджет, не выглядит прочитанным (Г.10)."""
    path = _pdf(tmp_path / "рд.pdf", [("Лист 1 Стадия Р", True),
                                      ("Лист 2 Стадия Р", True)])

    facts, seen = _run(path, monkeypatch, recognized="Распознано", budget=1)

    assert seen == [1]
    assert facts.ocr_graphic_skipped == [2]
    assert facts.ocr_status == "budget_exhausted"


def test_recognition_failure_does_not_erase_the_existing_text(tmp_path, monkeypatch):
    """Сбой сервиса — не пустой лист: прежний текст остаётся, ошибка видна."""
    path = _pdf(tmp_path / "рд.pdf", [("Лист 1 Стадия Р", True)])

    facts, _ = _run(path, monkeypatch, error="HTTP 429")

    assert facts.ocr_status == "error"
    assert facts.ocr_errors[1] == "HTTP 429"
    assert facts.ocr_graphic_pages == []
    assert "Лист 1" in facts.text_facts[0]["text"], "текст листа потерян из-за сбоя"


def test_without_configuration_the_gap_is_named(tmp_path, monkeypatch):
    """«OCR не настроен» — состояние, а не молчаливое «графики нет»."""
    path = _pdf(tmp_path / "рд.pdf", [("Лист 1 Стадия Р", True)])

    facts, seen = _run(path, monkeypatch, configured=False)

    assert seen == []
    assert facts.ocr_status == "not_configured"
    assert facts.ocr_graphic_candidates == [1]
