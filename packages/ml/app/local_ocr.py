"""Распознавание страниц без текстового слоя — локально, Tesseract через PyMuPDF.

Официальный прогон конкурса идёт в закрытом контуре без Интернета, и внешние
OCR-сервисы в зачётном запуске недопустимы: документы и их фрагменты нельзя
передавать наружу. Поэтому распознавание выполняет Tesseract, установленный в
образ, а вызывается он через PyMuPDF — той же библиотекой, которой документ
уже читается. Новой зависимости в Python это не добавляет.

Результат распознавания сохраняется как текстовый слой страницы: по нему
`page.search_for(..., textpage=...)` находит координаты цитаты так же, как у
обычного текста. Требование «каждое доказательство ведёт к месту на листе»
распространяется и на сканы.

Отсутствие движка и сбой распознавания — явные состояния: вызывающий код не
вправе превращать их в «на странице ничего нет» (Г.10).
"""
from __future__ import annotations

import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

import pymupdf

# Языки распознавания в обозначениях Tesseract. Русский — язык документации,
# английский нужен марками оборудования и обозначениями на латинице.
OCR_LANGUAGE = os.environ.get("INSPECTOR_OCR_LANGUAGE", "rus+eng")
# Разрешение растеризации для распознавания, точек на дюйм. Свойство формата:
# мелкие подписи чертежа при меньшем разрешении распознаются хуже, а больше
# этого — дольше без выигрыша в качестве.
OCR_DPI = 300
# Сколько букв подряд делают фрагмент словом. Свойство языка, а не
# наблюдение о документах: короче — это уже отдельные символы, которые
# распознавание выдаёт и на шуме (печать, линии, штриховка).
MIN_WORD_LETTERS = 3

QUALITY_OK, QUALITY_LOW, QUALITY_ABSTAIN = "OK", "LOW_QUALITY", "ABSTAIN"
_WORD_RE = re.compile(rf"[^\W\d_]{{{MIN_WORD_LETTERS},}}")


@dataclass
class OcrConfig:
    language: str = OCR_LANGUAGE
    dpi: int = OCR_DPI


@dataclass
class OcrResult:
    text: str = ""
    error: str = ""
    # Слой распознанного текста с координатами. Нужен тем, кто ищет место
    # цитаты на листе; вне страницы, на которой получен, смысла не имеет.
    textpage: object | None = None


def _tessdata_dir() -> Path | None:
    configured = os.environ.get("TESSDATA_PREFIX")
    if configured:
        return Path(configured)
    try:
        found = pymupdf.get_tessdata()
    except Exception:  # noqa: BLE001 — «не найдено» здесь штатный ответ, а не сбой
        return None
    return Path(found) if found else None


def load_config() -> OcrConfig | None:
    """Настройка распознавания, если движок и языки действительно на месте.

    Проверяется не только наличие программы, но и файлы каждого языка:
    Tesseract без русского словаря «распознаёт» кириллицу набором латиницы, и
    такой результат хуже честного «движок не настроен».
    """
    if shutil.which("tesseract") is None:
        return None
    tessdata = _tessdata_dir()
    if tessdata is None:
        return None
    languages = [part for part in OCR_LANGUAGE.split("+") if part]
    if not all((tessdata / f"{lang}.traineddata").is_file() for lang in languages):
        return None
    return OcrConfig()


def is_configured() -> bool:
    return load_config() is not None


def quality(result: OcrResult) -> str:
    """Качество распознанной страницы (ТЗ 9.1, п.1).

    ABSTAIN — распознавание не дало ничего или упало: страницу прочитать не
    удалось, и это сказано прямо. LOW_QUALITY — символы есть, но ни одного
    слова: так выглядят рукопись, печать поверх текста, мелкая графика.
    Такая страница не молчит и не выдаётся за прочитанную (Г.10).
    """
    if result.error or not result.text.strip():
        return QUALITY_ABSTAIN
    return QUALITY_OK if _WORD_RE.search(result.text) else QUALITY_LOW


def recognize_page(page, config: OcrConfig | None = None) -> OcrResult:
    """Распознать страницу целиком и вернуть текст вместе со слоем координат."""
    cfg = config or load_config()
    if cfg is None:
        return OcrResult(error="движок распознавания Tesseract не установлен")
    try:
        textpage = page.get_textpage_ocr(language=cfg.language, dpi=cfg.dpi, full=True)
        text = page.get_text(textpage=textpage).strip()
    except Exception as exc:  # noqa: BLE001 — сбой обязан стать видимой ошибкой
        return OcrResult(error=f"распознавание не выполнено: {type(exc).__name__}: {exc}")
    return OcrResult(text=text, textpage=textpage)
