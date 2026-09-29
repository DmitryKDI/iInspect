"""Модель не может назначить цитате произвольный источник."""
import pytest
from app import requirement_llm_extract as extraction


@pytest.mark.parametrize("page,sentence", [
    (99, "Применить материал А."),
    (None, "Применить материал А."),
    (True, "Применить материал А."),
    (2, "Применить материал А."),
    (1, "Применить материал Б."),
    (1, ""),
])
def test_unsupported_quote_or_page_is_reported_not_reassigned(monkeypatch, page, sentence):
    monkeypatch.setattr(extraction, "call_llm_json", lambda *args, **kwargs: {
        "requirements": [{"page": page, "sentence": sentence, "requirement": "Материал А"}],
    })
    errors = []
    requirements = extraction.extract_requirements_llm(
        [{"page": 1, "text": "Применить материал А.", "document": "pd.pdf"},
         {"page": 2, "text": "Другая страница.", "document": "pd.pdf"}],
        config=None, on_chunk_error=lambda page, error: errors.append((page, error)),
    )
    assert requirements == []
    assert errors and isinstance(errors[0][1], ValueError)
    print("OK: неподтверждённая цитата видна как ошибка и не переносится на другую страницу")


def test_layout_whitespace_is_allowed_but_source_identity_is_preserved(monkeypatch):
    monkeypatch.setattr(extraction, "call_llm_json", lambda *args, **kwargs: {
        "requirements": [{"page": 4, "sentence": "Применить материал А.", "rooms": []}],
    })
    errors = []
    requirements = extraction.extract_requirements_llm(
        [{"page": 4, "text": "Применить\nматериал  А.", "document": "scan.pdf"}],
        config=None, on_chunk_error=lambda *args: errors.append(args),
    )
    assert len(requirements) == 1
    assert requirements[0].document == "scan.pdf"
    assert requirements[0].page == 4
    assert not errors
    print("OK: переносы OCR не меняют содержимое подтверждённой цитаты")


def test_invalid_quote_does_not_discard_supported_quote_in_same_chunk(monkeypatch):
    monkeypatch.setattr(extraction, "call_llm_json", lambda *args, **kwargs: {
        "requirements": [
            {"page": 3, "sentence": "Применить материал Б."},
            {"page": 3, "sentence": "Применить материал А."},
        ],
    })
    errors = []
    requirements = extraction.extract_requirements_llm(
        [{"page": 3, "text": "Применить материал А.", "document": "pd.pdf"}],
        config=None, on_chunk_error=lambda *args: errors.append(args),
    )
    assert [requirement.sentence for requirement in requirements] == ["Применить материал А."]
    assert len(errors) == 1
    print("OK: подтверждённые требования сохранены при ошибочной цитате в той же пачке")
