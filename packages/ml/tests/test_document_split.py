"""Разрезание тома по весу: ни один лист не теряется, нумерация исходная (Г.109)."""
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pymupdf  # noqa: E402

from app.document_split import (  # noqa: E402
    DocumentPart,
    needs_split,
    part_for_page,
    split_pdf,
)


def _document(pages: int, filler: int = 0) -> str:
    """Документ с разным весом страниц: ровно тот случай, ради которого счёт
    идёт по байтам, а не по числу страниц."""
    doc = pymupdf.open()
    for index in range(pages):
        page = doc.new_page()
        page.insert_text((72, 72), f"Лист {index + 1}", fontname="helv", fontsize=12)
        for row in range(filler):
            page.draw_line((10, 100 + row % 600), (580, 120 + row % 600))
    path = Path(tempfile.mkdtemp()) / "том.pdf"
    doc.save(str(path))
    doc.close()
    return str(path)


def test_every_page_survives_and_parts_do_not_overlap():
    """Главное свойство: части в сумме дают исходный документ страница в
    страницу. «Почти все страницы» здесь означает молча потерянный лист."""
    path = _document(40, filler=400)
    parts = split_pdf(path, max_bytes=20_000)
    assert len(parts) > 1, "документ не разрезался — тест ничего не проверяет"
    assert sum(p.pages for p in parts) == 40
    covered = [n for p in parts for n in range(p.first_page, p.last_page + 1)]
    assert covered == list(range(1, 41)), "части перекрываются или есть пропуск"
    print(f"OK: {len(parts)} частей покрывают все 40 листов без пропусков")


def test_page_number_stays_the_original_one():
    """Инспектор не должен видеть нумерацию частей: лист N остаётся листом N,
    в какой бы части он ни оказался — иначе ссылка «смотреть лист N» врёт."""
    path = _document(30, filler=400)
    parts = split_pdf(path, max_bytes=20_000)
    for original in (1, 7, 15, 30):
        found = part_for_page(parts, original)
        assert found is not None, original
        index, inside = found
        assert parts[index].original_page(inside) == original
    print("OK: номер листа переводится обратно в исходный без потерь")


def test_light_document_is_returned_whole():
    """Документ легче бюджета — одна часть: вызывающему не нужно знать,
    резали его или нет."""
    path = _document(3)
    parts = split_pdf(path, max_bytes=50 * 1024 * 1024)
    assert len(parts) == 1 and parts[0].first_page == 1 and parts[0].pages == 3
    assert needs_split(path, max_bytes=50 * 1024 * 1024) is False
    print("OK: лёгкий документ возвращается одной частью")


def test_page_heavier_than_the_budget_is_not_lost():
    """Страница тяжелее бюджета целиком не отбрасывается и не режется: она
    становится частью на одну страницу. Потерять лист хуже, чем превысить
    бюджет, и превышение видно по размеру части."""
    path = _document(4, filler=3000)
    parts = split_pdf(path, max_bytes=1024)
    assert sum(p.pages for p in parts) == 4
    assert all(p.pages >= 1 for p in parts)
    print("OK: страница тяжелее бюджета сохраняется отдельной частью")


def test_single_page_document_is_one_part():
    """Нижняя граница: один лист — одна часть с первой страницей 1.
    (Документ вовсе без страниц проверить нечем: PyMuPDF отказывается такой
    сохранять, и код на этот случай просто возвращает пустой список.)"""
    path = _document(1)
    parts = split_pdf(path, max_bytes=1024)
    assert len(parts) == 1 and parts[0].first_page == 1 and parts[0].pages == 1
    print("OK: документ из одного листа — одна часть")


def test_part_knows_its_own_range():
    part = DocumentPart(data=b"", first_page=101, pages=20)
    assert part.last_page == 120
    assert part.original_page(1) == 101 and part.original_page(20) == 120
    print("OK: часть знает свой диапазон в исходной нумерации")


if __name__ == "__main__":
    test_every_page_survives_and_parts_do_not_overlap()
    test_page_number_stays_the_original_one()
    test_light_document_is_returned_whole()
    test_page_heavier_than_the_budget_is_not_lost()
    test_single_page_document_is_one_part()
    test_part_knows_its_own_range()
    print("ALL PASS")
