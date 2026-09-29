"""Стадия документации по графе шифра основной надписи (Г.107).

Зачем это в продукте, а не в скрипте прогона: какой файл считать проектной
документацией, а какой рабочей, до сих пор решал человек, перечисляя файлы
руками. Ровно так из прогона молча выпал самый толстый том комплекта —
акцент на определённые тома жил не в коде, а в ПОРЯДКЕ РАБОТЫ.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.classification import (  # noqa: E402
    STAGE_AS_BUILT,
    STAGE_DESIGN,
    STAGE_WORKING,
    StageResult,
    _stage_from_shifr,
)


def test_stage_is_read_from_the_shifr_not_from_the_file_name():
    """Обозначение стадии стоит в шифре перед маркой комплекта. Имя файла
    даёт поднадзорное лицо, графу — сам документ, поэтому источник один."""
    assert _stage_from_shifr("П-ИОС5.4.2-СТ") == STAGE_DESIGN
    assert _stage_from_shifr("РД-СП") == STAGE_WORKING
    assert _stage_from_shifr("ИД-01") == STAGE_AS_BUILT
    print("OK: стадия читается из графы шифра")


def test_unknown_shifr_gives_nothing_rather_than_a_guess():
    """Неизвестное обозначение — не повод подставить правдоподобное
    (раздел 0, п.7): пусто и видно, что не прочиталось."""
    assert _stage_from_shifr("XZ-12") is None
    assert _stage_from_shifr("") is None
    print("OK: незнакомое обозначение не превращается в догадку")


def test_stage_is_inherited_inside_one_volume_and_marked_as_inherited():
    """Том бывает разбит на файлы, и штамп читается не во всех: часть тома
    может быть целиком занята подшитым материалом без основной надписи.
    Файлы одного тома узнаются по общей шифровой части имени. Наследование
    обязано быть помечено: «прочитано здесь» и «взято у соседа» —
    разные по надёжности утверждения (Г.10).
    """
    import app.classification as classification

    calls = {}

    def fake_stage(path, name="", scan_pages=0):
        calls[name] = True
        if name.endswith("часть-2.pdf"):
            return StageResult(None, "none", "штамп не прочитан")
        return StageResult(STAGE_WORKING, "stamp", "шифр со стр.1")

    original = classification.document_stage
    classification.document_stage = fake_stage
    try:
        result = classification.stages_for_set([
            ("/nowhere/шифр-комплекта часть-1.pdf", "шифр-комплекта часть-1.pdf"),
            ("/nowhere/шифр-комплекта часть-2.pdf", "шифр-комплекта часть-2.pdf"),
        ])
    finally:
        classification.document_stage = original

    second = result["шифр-комплекта часть-2.pdf"]
    assert second.stage == STAGE_WORKING
    assert second.source == "sibling", second.source
    assert result["шифр-комплекта часть-1.pdf"].source == "stamp"
    print("OK: стадия унаследована внутри тома и помечена как унаследованная")


def test_no_inheritance_between_different_volumes():
    """Наследование не должно перетекать между разными томами: общий шифр —
    это условие, а не формальность."""
    import app.classification as classification

    def fake_stage(path, name="", scan_pages=0):
        if name.startswith("второй"):
            return StageResult(None, "none", "штамп не прочитан")
        return StageResult(STAGE_DESIGN, "stamp", "шифр со стр.1")

    original = classification.document_stage
    classification.document_stage = fake_stage
    try:
        result = classification.stages_for_set([
            ("/nowhere/первый-том.pdf", "первый-том.pdf"),
            ("/nowhere/второй-том.pdf", "второй-том.pdf"),
        ])
    finally:
        classification.document_stage = original

    assert result["второй-том.pdf"].stage is None
    assert result["второй-том.pdf"].source == "none"
    print("OK: стадия не перетекает между разными томами")


if __name__ == "__main__":
    test_stage_is_read_from_the_shifr_not_from_the_file_name()
    test_unknown_shifr_gives_nothing_rather_than_a_guess()
    test_stage_is_inherited_inside_one_volume_and_marked_as_inherited()
    test_no_inheritance_between_different_volumes()
    print("ALL PASS")
