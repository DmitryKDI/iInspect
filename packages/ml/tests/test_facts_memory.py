"""ПАМЯТЬ РАЗБОРА и ВЫЖИМКА (Г.114).

Разбор страницы стоил минуты и повторялся при каждом обращении к тому: при
загрузке, при разборе, при сверке, при построении реестра помещений. Здесь
проверяется, что он делается один раз, переживает повторное обращение под
другим именем и что наружу отдаётся сводка, а не всё подряд.
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import facts_store  # noqa: E402
from app.documents import DocumentFacts  # noqa: E402


@pytest.fixture(autouse=True)
def isolated_store(tmp_path, monkeypatch):
    """Своя база на тест: общая база машины разработчика дала бы попадание
    в память там, где тест проверяет её промах."""
    monkeypatch.setenv("FACTS_STORE_DB", str(tmp_path / "facts.db"))
    facts_store._engine = None
    facts_store._Session = None
    yield
    facts_store._engine = None
    facts_store._Session = None


def _pdf(path: Path, text: str = "Помещение 012 венткамера") -> Path:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), text)
    doc.save(str(path))
    doc.close()
    return path


def test_second_call_does_not_parse_again(tmp_path):
    path = _pdf(tmp_path / "том.pdf")
    first = facts_store.facts_for(path, "Том 5.2.1")
    with patch.object(facts_store, "extract_document_facts",
                      side_effect=AssertionError("разбор повторился")) as never:
        second = facts_store.facts_for(path, "Том 5.2.1")
    assert never.call_count == 0
    assert second.pages == first.pages
    assert second.text_facts == first.text_facts
    print("OK: повторное обращение к тому берёт разбор из памяти")


def test_same_content_under_another_name_is_already_parsed(tmp_path):
    """Ключ — отпечаток содержимого, а не имя: тот же том под другим именем
    (второй инспектор, повторная загрузка) уже разобран."""
    first_path = _pdf(tmp_path / "a.pdf")
    second_path = tmp_path / "b.pdf"
    second_path.write_bytes(first_path.read_bytes())

    facts_store.facts_for(first_path, "Том 5.2.1")
    with patch.object(facts_store, "extract_document_facts",
                      side_effect=AssertionError("разбор повторился")):
        again = facts_store.facts_for(second_path, "Тот же том, другое имя")
    assert again.name == "Тот же том, другое имя", "имя берётся из запроса, не из памяти"
    print("OK: то же содержимое под другим именем не разбирается второй раз")


def test_different_content_is_parsed_separately(tmp_path):
    one = facts_store.facts_for(_pdf(tmp_path / "1.pdf", "Помещение 012"), "один")
    two = facts_store.facts_for(_pdf(tmp_path / "2.pdf", "Помещение 034"), "два")
    assert one.text_facts != two.text_facts
    assert facts_store.stats()["documents"] == 2
    print("OK: разные документы разбираются по отдельности")


def test_new_extractor_version_invalidates_memory(tmp_path):
    """Меняется код извлечения — прежние записи не подходят сами.

    Иначе новое поведение проверялось бы на разборе по старым правилам, и
    расхождение выглядело бы как ошибка нового кода (Г.10).
    """
    path = _pdf(tmp_path / "том.pdf")
    facts_store.facts_for(path, "Том")
    with patch.object(facts_store, "FACTS_VERSION", facts_store.FACTS_VERSION + 1):
        assert facts_store.stored(facts_store.digest_of_file(path)) is None
    print("OK: смена версии разборщика обесценивает прежний разбор")


def test_page_keys_come_back_as_numbers(tmp_path):
    """В JSON ключ страницы становится строкой. Вернуться он обязан числом:
    по всему коду страница — число, и разнотипный ключ давал бы промах
    поиска, неотличимый от «на листе ничего нет»."""
    facts = DocumentFacts(name="т", pages=2, text_facts=[{"page": 1, "text": "а"}],
                          room_facts=[], page_kinds={1: "text", 2: "drawing"},
                          sheet_info={2: {"shifr": "", "sheet_no": "3", "sheet_name": "План"}},
                          excluded={2: "каталог поставщика"})
    facts_store.put("digest-1", facts)
    back = facts_store.stored("digest-1")
    assert set(back.page_kinds) == {1, 2}, back.page_kinds
    assert set(back.sheet_info) == {2}, back.sheet_info
    assert set(back.excluded) == {2}, back.excluded
    print("OK: номера страниц возвращаются числами, а не строками")
