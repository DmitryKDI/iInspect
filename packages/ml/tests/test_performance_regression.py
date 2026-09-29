"""Регрессии ускоренного LLM-конвейера без внешних запросов."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.requirement_llm_extract import (
    DEFAULT_REQUIREMENT_CHUNK_CHARS,
    _chunk_text_facts,
)


def test_default_requirement_batch_is_enlarged():
    assert DEFAULT_REQUIREMENT_CHUNK_CHARS >= 18_000


def test_chunker_packs_pages_but_never_mixes_documents():
    facts = [
        {"page": 1, "text": "a" * 8_000, "document": "pd-a.pdf", "section": "ОВ"},
        {"page": 2, "text": "b" * 8_000, "document": "pd-a.pdf", "section": "ОВ"},
        {"page": 1, "text": "c" * 2_000, "document": "pd-b.pdf", "section": "АР"},
    ]
    chunks = _chunk_text_facts(facts, 18_000)

    assert len(chunks) == 2
    assert [f["page"] for f in chunks[0]] == [1, 2]
    assert {f["document"] for f in chunks[0]} == {"pd-a.pdf"}
    assert {f["document"] for f in chunks[1]} == {"pd-b.pdf"}
