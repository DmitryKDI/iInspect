"""Распознавание страниц выполняется на машине, а не во внешнем сервисе.

Официальный прогон идёт в закрытом контуре без Интернета, и внешние OCR-API
в зачётном запуске недопустимы: документы и их фрагменты нельзя передавать
наружу. Поэтому OCR выполняет Tesseract внутри образа через PyMuPDF.

Эти тесты гоняют НАСТОЯЩЕЕ распознавание, а не подменённый ответ: смысл
локального движка в том, что он действительно читает страницу, и проверять
это заглушкой было бы бессмысленно. Если Tesseract не
установлен, тесты распознавания пропускаются с явной причиной, а тест
состояния «движка нет» работает всегда.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import documents, local_ocr  # noqa: E402

CYRILLIC_TTF = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
needs_engine = pytest.mark.skipif(
    local_ocr.load_config() is None,
    reason="Tesseract с русским языком не установлен в этом окружении")


def _image_only_page(text: str):
    """Страница, на которой текст есть ТОЛЬКО картинкой — как у скана.

    Текст рисуется, растеризуется и вставляется изображением: текстового
    слоя у страницы нет, прочитать её можно только распознаванием.
    """
    src = pymupdf.open()
    drawn = src.new_page(width=600, height=300)
    drawn.insert_font(fontname="F0", fontfile=CYRILLIC_TTF)
    drawn.insert_text((40, 120), text, fontname="F0", fontsize=26)
    png = drawn.get_pixmap(dpi=200).tobytes("png")
    doc = pymupdf.open()
    page = doc.new_page(width=600, height=300)
    page.insert_image(page.rect, stream=png)
    return doc, page


@needs_engine
def test_russian_text_is_read_from_an_image():
    doc, page = _image_only_page("Помещение 101 установка П1")
    try:
        assert page.get_text().strip() == "", "у страницы не должно быть текстового слоя"
        result = local_ocr.recognize_page(page, local_ocr.load_config())
    finally:
        doc.close()

    assert not result.error
    assert "Помещение 101" in result.text
    print("OK: русский текст распознан с изображения локально")


@needs_engine
def test_recognized_quote_gets_coordinates_on_the_sheet():
    """Цитата из распознанного текста получает место на листе.

    Каждое доказательство обязано вести к месту на листе. Локальный слой
    распознавания сохраняет координаты цитаты из скана.
    """
    doc, page = _image_only_page("Помещение 101 установка П1")
    try:
        result = local_ocr.recognize_page(page, local_ocr.load_config())
        boxes = page.search_for("Помещение 101", textpage=result.textpage)
    finally:
        doc.close()

    assert boxes, "координаты распознанной цитаты не найдены"
    print("OK: распознанная цитата получает координаты на листе")


def test_missing_engine_is_a_named_state_not_empty_text(tmp_path, monkeypatch):
    """«Движка нет» — состояние, а не молчаливое «на странице пусто» (Г.10)."""
    doc = pymupdf.open()
    doc.new_page(width=300, height=200)
    pdf = tmp_path / "скан.pdf"
    doc.save(pdf)
    doc.close()
    monkeypatch.setattr(documents, "load_config", lambda: None)

    facts = documents.extract_document_facts(str(pdf), "скан")

    assert facts.ocr_status == "not_configured"
    assert facts.ocr_pages_total == 1
    print("OK: отсутствие движка распознавания названо, а не выдано за пустую страницу")


def test_recognition_failure_is_reported_not_swallowed(monkeypatch):
    """Сбой движка — ошибка со словами, а не пустая строка."""
    doc = pymupdf.open()
    page = doc.new_page(width=300, height=200)

    def broken(*args, **kwargs):
        raise RuntimeError("tesseract упал")

    monkeypatch.setattr(pymupdf.Page, "get_textpage_ocr", broken)
    try:
        result = local_ocr.recognize_page(page, local_ocr.OcrConfig(language="rus"))
    finally:
        doc.close()

    assert result.text == ""
    assert "tesseract упал" in result.error
    print("OK: сбой распознавания виден ошибкой, а не пустым текстом")


def test_no_network_is_used():
    """Модуль распознавания не умеет ходить в сеть вообще."""
    source = Path(local_ocr.__file__).read_text(encoding="utf-8")
    for forbidden in ("httpx", "requests", "urllib", "http://", "https://"):
        assert forbidden not in source, f"в локальном OCR найдено {forbidden!r}"
    print("OK: модуль распознавания не содержит сетевых вызовов")


def test_quality_distinguishes_abstain_low_and_ok():
    """ТЗ 9.1: нечитаемое — ABSTAIN или LOW_QUALITY, а не пустота."""
    q = local_ocr.quality
    assert q(local_ocr.OcrResult(text="", error="сбой")) == "ABSTAIN"
    assert q(local_ocr.OcrResult(text="   ")) == "ABSTAIN"
    assert q(local_ocr.OcrResult(text="|| -- ,. 1 2 ~~ a")) == "LOW_QUALITY"
    assert q(local_ocr.OcrResult(text="Помещение 101")) == "OK"
    assert q(local_ocr.OcrResult(text="Room 12")) == "OK"


def test_failed_recognition_is_recorded_as_abstain(tmp_path, monkeypatch):
    doc = pymupdf.open()
    doc.new_page(width=300, height=200)
    pdf = tmp_path / "скан.pdf"
    doc.save(pdf)
    doc.close()
    monkeypatch.setattr(documents, "load_config", lambda: local_ocr.OcrConfig())
    monkeypatch.setattr(documents, "recognize_page",
                        lambda page, config: local_ocr.OcrResult(error="движок упал"))

    facts = documents.extract_document_facts(str(pdf), "скан")

    assert facts.ocr_quality == {1: "ABSTAIN"}
    assert facts.ocr_status == "error"
