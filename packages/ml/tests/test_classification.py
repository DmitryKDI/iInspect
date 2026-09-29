import sys
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.classification import (
    _section_number_code,
    classify_document,
    open_pdf,
    scan_text_for_discipline_codes,
)


def test_filename_signal_matches_js():
    cases = {
        "V0_00-05-04-02-07_Том 5.4.2 ОВ (1).pdf": "ОВ",
        "V0_00-05-04-01-09_Том 5.4.1.pdf": None,
        "АОСР №1-ОВ2.1 от 20.12.2024 Отопление.pdf": "ОВ",
        "АОСР №1_ОВ. от 07.04.2025.pdf": "ОВ",
        "просто обычный текст без кода.pdf": None,
        # Г.79 — реальный найденный файл: раздел 8 по ПП№87 маркирован
        # составным кодом «ООС»+номер тома, не буквенным «ОС» (ГОСТ Р
        # 21.1101) — до фикса вообще не классифицировался.
        "V0_00-08-00-04-09_Том ООС8.4.pdf": "ООС",
        "V0_00-08-00-03-01.Том ООС8.3.pdf": "ООС",
    }
    for name, expect in cases.items():
        codes = scan_text_for_discipline_codes(name)
        found = None
        counts: dict[str, int] = {}
        for c in codes:
            counts[c] = counts.get(c, 0) + 3
        if counts:
            found = max(counts.items(), key=lambda kv: kv[1])
            found = found[0] if found[1] >= 3 else None
        assert found == expect, f"{name}: got {found}, expected {expect}"
    print("OK: filename signal matches JS logic")


def test_scan_finds_codes_added_from_real_composition_registry():
    """Г.63 — реальные шифры из «Состава документации» этого объекта
    (ОБЪ/000000/1-РД-ОВ1, стр.10-12), найденные не текстовым угадыванием, а
    самим `composition_registry.py` (Г.62): наружные/внутренние сети,
    тепловой пункт, слаботочка, вертикальный транспорт — раньше не
    входили в DISCIPLINE_CODES вообще."""
    cases = {
        "ОБЪ/000000/1-РД-ВВ": "ВВ",
        "ОБЪ/000000/1-РД-ИТП.УУТЭ": "ИТП",
        "ОБЪ/000000/1-РД-СКУД": "СКУД",
        "ОБЪ/000000/1-РД-ВТ": "ВТ",
        "ОБЪ/000000/1-РД-АУПТ": "АУПТ",
    }
    for text, expect in cases.items():
        codes = scan_text_for_discipline_codes(text)
        assert expect in codes, f"{text}: {codes} не содержит {expect}"
    print("OK: реальные коды разделов из Состава документации распознаются")


def test_section_number_fallback_for_files_without_letter_code():
    """Г.80 — реальная находка: два тома того же комплекта («8.1», «8.2»)
    не несут буквенного кода в имени файла ВООБЩЕ (в отличие от соседних
    «ООС8.3»/«ООС8.4») — раньше не классифицировались никак. Номер
    раздела ПП№87 (второе число маркировки) даёт код однозначно для
    разделов, не делящихся на подсистемы внутри себя."""
    cases = {
        "V0_00-08-00-01-04_Том 8.1.pdf": "ООС",
        "V0_00-08-00-02-03_том 8.2.pdf": "ООС",
        "V0_00-03-00-01-20_Том 3.РЕД.pdf": "АР",
        # Раздел 5 (инженерное оборудование) сознательно НЕ входит в
        # таблицу — делится на подсистемы (ОВ/ВК/ЭОМ/...) с разными
        # кодами, номер раздела один их не различает (Г.21/Г.63).
        "V0_00-05-04-01-09_Том 5.4.1.pdf": None,
        "просто обычный текст без кода.pdf": None,
    }
    for name, expect in cases.items():
        assert _section_number_code(name) == expect, name
    print("OK: номер раздела ПП№87 в маркировке файла даёт код там, где буквенного кода нет")


def test_section_number_requires_tom_to_reject_unrelated_numeric_markings():
    """Без привязки к
    слову «Том» рядом регулярка ловила ЛЮБУЮ постороннюю 5-групповую
    цифровую последовательность где угодно в имени файла (номер договора,
    номер акта) — синтетический пример реально давал
    ложное «ПБ» до фикса. Все подтверждённые реальные файлы несут
    маркировку непосредственно перед словом «Том»/«том» — это часть самой
    схемы именования по ПП№87, не совпадение."""
    cases = {
        # Реальный ложный срабатывание из отчёта аудита — маркировка есть,
        # но это номер договора, не раздел документации, слова «Том» рядом нет.
        "Договор 01-09-00-12-31 от 2026.pdf": None,
        # 6 цифровых групп вместо 5 — регулярка требует «Том» сразу после
        # 5-й группы, здесь между ними ещё одна группа — правильно не берёт
        # первые 5 наугад (не гадать, Г.11).
        "V0_00-08-00-01-04-02_Том 8.7.pdf": None,
        # Подтверждённые реальные схемы по-прежнему работают после ужесточения.
        "V0_00-08-00-01-04_Том 8.1.pdf": "ООС",
        "V0_00-08-00-03-01.Том ООС8.3.pdf": "ООС",
    }
    for name, expect in cases.items():
        assert _section_number_code(name) == expect, name
    print("OK: требование слова «Том» рядом с маркировкой убирает ложные срабатывания на постороннем номере")


def test_classify_document_uses_section_number_when_no_letter_code_in_filename(tmp_path):
    """Сквозная проверка: `classify_document()` реально доходит до
    резервного пути по номеру раздела и возвращает честный источник
    `filename_section_number`, отличимый от прямого буквенного совпадения."""
    pdf_path = tmp_path / "V0_00-08-00-01-04_Том 8.1.pdf"
    doc = pymupdf.open()
    doc.new_page()
    doc.save(str(pdf_path))
    doc.close()

    result = classify_document(str(pdf_path), pdf_path.name)
    assert result.discipline_code == "ООС"
    assert result.source == "filename_section_number"
    print("OK: classify_document находит код раздела по номеру маркировки, когда буквенного кода в имени нет")


def test_title_page_signal():
    """Синтетический случай: титульный лист (без ключевых слов штампа) с
    шифром прямым текстом должен сработать без похода в штамп/vision."""
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page()
    font = pymupdf.Font(fontfile="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    page.insert_font(fontname="F0", fontbuffer=font.buffer)
    page.insert_text((72, 72), "Общество с ограниченной ответственностью", fontname="F0")
    page.insert_text((72, 100), "Шифр проекта: AI-15-2023-АР", fontname="F0")
    page.insert_text((72, 130), "Раздел 3. Архитектурные решения", fontname="F0")
    tmp_path = "/tmp/synthetic_title_page.pdf"
    doc.save(tmp_path)
    doc.close()

    result = classify_document(tmp_path, "безымянный.pdf")
    assert result.discipline_code == "АР", result
    assert result.source == "title_page", result
    print("OK: title page text signal works without vision")


def test_filename_wins_before_opening_pdf_at_all(tmp_path):
    """Имя файла с кодом должно давать результат без сканирования штампа —
    проверяем через файл, которого нет вовсе: открыть его нельзя."""
    pdf_path = tmp_path / "missing.pdf"
    result = classify_document(str(pdf_path), "Раздел АР план.pdf")
    assert result.discipline_code == "АР", result
    assert result.source == "filename", result
    print("OK: filename signal short-circuits before stamp scan")


def _make_pdf(path: Path, owner_pw: str = "", user_pw: str = "") -> None:
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "test page")
    if owner_pw or user_pw:
        doc.save(str(path), encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw=owner_pw, user_pw=user_pw)
    else:
        doc.save(str(path))
    doc.close()


def test_open_pdf_unlocks_owner_password_only_file(tmp_path):
    """Реальный случай на боевых документах: PDF-экспорт из CAD с owner-
    паролем (только запрет копирования/печати, пароль на ОТКРЫТИЕ не задан).
    PyMuPDF отдаёт такой файл как открытый и без явной авторизации — здесь
    просто фиксируем, что open_pdf не ломает этот случай, который и так
    работал, чтобы не откатить его при следующей правке."""
    path = tmp_path / "owner_protected.pdf"
    _make_pdf(path, owner_pw="ownersecret", user_pw="")
    doc = open_pdf(str(path))
    try:
        assert doc.page_count == 1
        assert "test page" in doc[0].get_text()
    finally:
        doc.close()
    print("OK: файл с owner-паролем открывается и читается как обычно")


def test_open_pdf_raises_clear_error_for_user_password_file(tmp_path):
    """Файл, требующий пароль именно на открытие (needs_pass), — снять его
    пустым паролем нельзя; open_pdf должен упасть понятной ошибкой, а не
    отдать документ с недоступными страницами (пустой текст, 0 листов молча)."""
    path = tmp_path / "user_protected.pdf"
    _make_pdf(path, owner_pw="ownersecret", user_pw="realpassword")
    with pytest.raises(ValueError, match="паролем"):
        open_pdf(str(path))
    print("OK: PDF с паролем на открытие — понятная ошибка вместо тихого 0 страниц")


def test_open_pdf_plain_file_unaffected(tmp_path):
    path = tmp_path / "plain.pdf"
    _make_pdf(path)
    doc = open_pdf(str(path))
    try:
        assert doc.page_count == 1
    finally:
        doc.close()
    print("OK: обычный PDF без пароля открывается как раньше")


if __name__ == "__main__":
    test_filename_signal_matches_js()
    test_scan_finds_codes_added_from_real_composition_registry()
    test_title_page_signal()
    print("ALL PASS")
