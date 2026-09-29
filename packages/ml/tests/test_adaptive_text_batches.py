"""Размер текстовой пачки подстраивается под поведение провайдера.

Техническое задание требует адаптивного размера текстовых пачек наравне с
ограниченной параллельностью и соблюдением `Retry-After`. Размер был
фиксированным числом: одна и та же пачка уходила и когда провайдер отвечал
свободно, и когда он уже отбивался кодом 429.

Направление подстройки несимметрично намеренно. Сужение немедленное: отказ
уже случился, и следующая попытка не должна повторять его тем же объёмом.
Расширение только после серии успехов: один удачный ответ ещё не значит,
что провайдер разгрузился.

Длина пачки не влияет на то, ЧТО считается найденным: она меняет, сколько
текста уходит за один вызов, а привязка цитат к страницам живёт внутри
пачки и от её длины не зависит.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import llm_runtime  # noqa: E402
from app.llm_runtime import AdaptiveTextBatch  # noqa: E402


def test_starts_at_the_requested_size():
    assert AdaptiveTextBatch(6000).chars() == 6000


def test_refusal_narrows_the_batch_at_once():
    """Отказ уже случился: повторять его тем же объёмом незачем."""
    batch = AdaptiveTextBatch(6000)

    batch.refused()

    assert batch.chars() < 6000


def test_a_single_success_does_not_widen_the_batch():
    """Один удачный ответ не доказывает, что провайдер разгрузился."""
    batch = AdaptiveTextBatch(6000)
    batch.refused()
    narrowed = batch.chars()

    batch.succeeded()

    assert batch.chars() == narrowed


def test_a_streak_of_successes_restores_the_batch():
    batch = AdaptiveTextBatch(6000)
    batch.refused()
    narrowed = batch.chars()

    for _ in range(64):
        batch.succeeded()

    assert batch.chars() > narrowed


def test_the_batch_never_exceeds_the_requested_size():
    """Потолок задаёт вызывающий: у него свои причины для этого числа."""
    batch = AdaptiveTextBatch(6000)

    for _ in range(200):
        batch.succeeded()

    assert batch.chars() == 6000


def test_the_batch_never_collapses_to_nothing():
    """Пачка нулевой длины остановила бы разбор вовсе."""
    batch = AdaptiveTextBatch(6000)

    for _ in range(200):
        batch.refused()

    assert batch.chars() >= 1


def test_narrowing_is_visible_in_metrics():
    """Сужение — наблюдаемое событие прогона, а не тихая подстройка (Г.10)."""
    with llm_runtime.measure_run("тест") as metrics:
        AdaptiveTextBatch(6000).refused()

    assert metrics.snapshot().get("text_batch_narrowed") == 1


def test_extraction_narrows_after_a_refused_chunk(monkeypatch):
    """Подстройщик не декоративный: отказ извлечения действительно сужает."""
    from app import requirement_llm_extract as extract

    monkeypatch.setattr(
        extract, "call_llm_json",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("провайдер отказал")))
    facts = [{"page": n, "text": "Предусмотрено решение. " * 40} for n in range(1, 6)]

    with llm_runtime.measure_run("тест"):
        before = llm_runtime.text_batch_for(6000).chars()
        extract.extract_requirements_llm(facts, object(), max_chars_per_call=6000)
        after = llm_runtime.text_batch_for(6000).chars()

    assert before == 6000
    assert after < before


def test_the_narrowing_of_one_run_does_not_reach_the_next(monkeypatch):
    """Отказ — обстоятельство прогона, а не свойство инструмента.

    Общий на весь процесс подстройщик молча менял бы нарезку следующего, ни
    с чем не связанного документа.
    """
    from app import requirement_llm_extract as extract

    monkeypatch.setattr(
        extract, "call_llm_json",
        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("провайдер отказал")))
    facts = [{"page": n, "text": "Предусмотрено решение. " * 40} for n in range(1, 6)]

    with llm_runtime.measure_run("первый"):
        extract.extract_requirements_llm(facts, object(), max_chars_per_call=6000)
    with llm_runtime.measure_run("второй"):
        assert llm_runtime.text_batch_for(6000).chars() == 6000
