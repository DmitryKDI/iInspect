import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.diffing import find_text_differences, strip_leading_list_marker


def test_strip_leading_list_marker():
    cases = [
        ("10 Воздухонагреватель канальный", "Воздухонагреватель канальный"),
        ("4) Датчик температуры воздуха", "Датчик температуры воздуха"),
        ("Помещение без номера в начале", "Помещение без номера в начале"),
        ("123. Труба стальная оцинкованная", "Труба стальная оцинкованная"),
    ]
    for src, expect in cases:
        assert strip_leading_list_marker(src) == expect, src
    print("OK: list marker stripping matches JS behavior")


def test_list_position_change_is_not_a_discrepancy():
    before = [{"page": 1, "text": "10 Воздухонагреватель канальный водяной установлен по проекту", "file": "pd"}]
    after = [{"page": 1, "text": "4 Воздухонагреватель канальный водяной установлен по проекту", "file": "rd"}]
    diffs = find_text_differences(before, after)
    assert diffs == [], f"expected no diff (only list position changed), got {diffs}"
    print("OK: pure list-position renumbering produces zero false-positive discrepancies")


def test_real_value_change_is_still_detected():
    before = [{"page": 1, "text": "Площадь помещения по проекту составляет двадцать четыре целых пять кв м", "file": "pd"}]
    after = [{"page": 1, "text": "Площадь помещения по проекту составляет девятнадцать целых восемь кв м", "file": "rd"}]
    diffs = find_text_differences(before, after)
    assert len(diffs) == 1, diffs
    print("OK: a genuine value change is still detected")


if __name__ == "__main__":
    test_strip_leading_list_marker()
    test_list_position_change_is_not_a_discrepancy()
    test_real_value_change_is_still_detected()
    print("ALL PASS")
