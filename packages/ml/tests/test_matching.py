import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.matching import DocumentInput, match_page_pairs


def tf(page, text):
    return {"page": page, "text": text}


def test_discipline_gating_prefers_same_code():
    before = [
        DocumentInput("Том 5.4.2 ОВ.pdf", 1, [tf(1, "коридор система отопления калорифер узел учёта")], [], "ОВ"),
        DocumentInput("Раздел АР.pdf", 1, [tf(1, "коридор перегородка стена дверной проём отделка")], [], "АР"),
    ]
    after = [
        DocumentInput("Исполнительный АР план.pdf", 1, [tf(1, "коридор система отопления перегородка стена")], [], "АР"),
        DocumentInput("Акт ОВ2.1.pdf", 1, [tf(1, "коридор калорифер узел учёта тепла")], [], "ОВ"),
    ]
    pairs = match_page_pairs(before, after)
    ov_pair = next(p for p in pairs if before[p.before_file_idx].name == "Том 5.4.2 ОВ.pdf")
    ar_pair = next(p for p in pairs if before[p.before_file_idx].name == "Раздел АР.pdf")
    assert after[ov_pair.after_file_idx].name == "Акт ОВ2.1.pdf", pairs
    assert after[ar_pair.after_file_idx].name == "Исполнительный АР план.pdf", pairs
    assert ov_pair.matched_by == "text"
    print("OK: discipline gating prefers same-code file over stronger raw text overlap")


def test_ungated_when_no_matching_code_on_other_side():
    before = [DocumentInput("Раздел КР.pdf", 1, [tf(1, "уникальные слова для сопоставления фундамент балка")], [], "КР")]
    after = [DocumentInput("Без явного раздела.pdf", 1, [tf(1, "уникальные слова для сопоставления фундамент балка")], [], None)]
    pairs = match_page_pairs(before, after)
    assert len(pairs) == 1 and pairs[0].matched_by == "text"
    print("OK: no code on the other side does not block a good text match")


def test_positional_fallback_flags_discipline_mismatch():
    before = [DocumentInput("Том ОВ.pdf", 1, [tf(1, "калорифер трубопровод вентилятор увлажнитель")], [], "ОВ")]
    after = [DocumentInput("Раздел АР.pdf", 1, [tf(1, "перегородка витраж козырёк парапет")], [], "АР")]
    pairs = match_page_pairs(before, after)
    assert len(pairs) == 1
    assert pairs[0].matched_by == "position"
    assert pairs[0].discipline_mismatch is True
    print("OK: positional fallback correctly flags mismatched known codes")


def test_digit_suffix_ignored_ov21_vs_ov1():
    """«ОВ2.1» и «ОВ1» — один и
    тот же раздел, цифры после кода отбрасываются классификацией, здесь
    просто проверяем, что гейтинг корректно работает при одинаковом коде,
    полученном из разных исходных шифров."""
    before = [DocumentInput("П-ИОС5.4.2.pdf", 1, [tf(1, "нет общих слов вообще совсем")], [], "ОВ")]
    after = [DocumentInput("РД-ОВ1.pdf", 1, [tf(1, "тоже никаких общих слов тут")], [], "ОВ")]
    pairs = match_page_pairs(before, after)
    assert len(pairs) == 1
    assert pairs[0].discipline_mismatch is False
    print("OK: same normalized code (ОВ2.1 vs ОВ1 -> both ОВ) does not trigger mismatch flag")


def test_every_page_covered_when_after_side_much_larger():
    """ПД содержит 177 страниц, а РД/ИД — 712 страниц в двух файлах.
    Раньше позиционный резерв
    ограничивался min(177, 712)=177 парами, и ~535 листов РД оставались
    вообще без пары и без визуальной проверки."""
    before = [DocumentInput("pd.pdf", 177, [], [], "ОВ")]
    after = [
        DocumentInput("rd_small.pdf", 36, [], [], "ОВ"),
        DocumentInput("rd_big.pdf", 676, [], [], "ОВ"),
    ]
    # Пустые text_facts -> текстового сопоставления не будет вообще (нет
    # токенов), всё уйдёт в позиционный резерв — воспроизводит худший случай.
    pairs = match_page_pairs(before, after)

    after_pages_covered = {(p.after_file_idx, p.after_page) for p in pairs}
    expected_after_pages = {(0, p) for p in range(1, 37)} | {(1, p) for p in range(1, 677)}
    missing = expected_after_pages - after_pages_covered
    assert not missing, f"{len(missing)} after-pages got no pair at all (the exact bug this fixes): {sorted(missing)[:5]}..."
    assert len(pairs) == 712, f"expected 712 pairs (one per after-page), got {len(pairs)}"
    print(f"OK: all {len(after_pages_covered)} after-side pages covered (before: only 177 of 712 were)")


def test_drawing_and_text_pages_never_cross_paired():
    """Даже если у чертежа и текстового приложения совпадает лексика (общие
    слова раздела), сравнивать их визуально бессмысленно — это разные типы
    листов. Каждая сторона должна остаться внутри своего пула."""
    before = [DocumentInput(
        "pd.pdf", 2,
        [{"page": 1, "text": "система отопления вентиляция калорифер узел учёта"},
         {"page": 2, "text": "система отопления вентиляция калорифер узел учёта"}],
        [], "ОВ",
        page_kinds={1: "drawing", 2: "text"},
    )]
    after = [DocumentInput(
        "rd.pdf", 2,
        [{"page": 1, "text": "система отопления вентиляция калорифер узел учёта"},
         {"page": 2, "text": "система отопления вентиляция калорифер узел учёта"}],
        [], "ОВ",
        page_kinds={1: "drawing", 2: "text"},
    )]
    pairs = match_page_pairs(before, after)
    assert len(pairs) == 2, pairs
    for p in pairs:
        # чертёж (p1) должен остаться сопоставлен с чертежом, текст (p2) с текстом
        assert p.before_page == p.after_page == (1 if p.page_kind == "drawing" else 2), p
    print("OK: drawing and text pages never cross-paired even with identical vocabulary")


def rf(page, key, name):
    return {"page": page, "key": key, "name": name}


def test_shared_room_number_wins_over_stronger_generic_word_overlap():
    """Реальный случай на Nadzor_Sample: страница с десятками общих, но
    неспецифичных слов (заголовки штампа, названия систем) набирала балл
    Jaccard выше, чем страница, где буквально совпадает то самое помещение,
    где находится нарушение — и нарушение терялось. Номер помещения обязан
    перевешивать общую лексику."""
    before = [DocumentInput(
        "pd.pdf", 1,
        [tf(1, "воздухозаборная шахта форкамера венткамера дренажный приямок принципиальная схема")],
        [rf(1, "012", "Венткамера"), rf(1, "012.1", "Форкамера")],
        "ОВ",
    )]
    after = [
        DocumentInput(
            "rd_generic.pdf", 1,
            # Много общих слов оформления листа, но ни одного общего помещения.
            [tf(1, "воздухозаборная шахта дренажный приямок принципиальная схема система теплоснабжения приточных установок")],
            [rf(1, "301", "Кабинет")],
            "ОВ",
        ),
        DocumentInput(
            "rd_room_match.pdf", 1,
            [tf(1, "техническое подполье итп")],
            [rf(1, "012", "Венткамера")],
            "ОВ",
        ),
    ]
    pairs = match_page_pairs(before, after)
    assert len(pairs) == 1
    assert after[pairs[0].after_file_idx].name == "rd_room_match.pdf", pairs
    print("OK: a shared room number outweighs stronger overlap of generic sheet-boilerplate words")


def test_subsystem_keyword_conflict_breaks_a_room_number_tie():
    """Реальный случай: раздел ОВ по коду один и тот же для вентиляции и
    отопления (ОВ2.1 и ОВ1 — один раздел, см. classification.py), а
    техническое подполье физически общее для обеих систем, поэтому номера
    помещений сами по себе не отличают вентиляционный лист от теплового.
    Ключевые слова подсистемы должны разрешать этот перевес — иначе лист
    'вентиляция' может уйти в сравнение с листом по отоплению."""
    before = [DocumentInput(
        "pd.pdf", 1,
        [tf(1, "венткамера форкамера приточная установка вентилятор воздуховод")],
        [rf(1, "012", "Венткамера")],
        "ОВ",
    )]
    after = [
        DocumentInput(
            "rd_heating.pdf", 1,
            [tf(1, "отопление радиатор стояк отопления теплоснабжение элеватор отопительный прибор")],
            [rf(1, "012", "Венткамера")],  # то же техническое помещение, другая система
            "ОВ",
        ),
        DocumentInput(
            "rd_ventilation.pdf", 1,
            [tf(1, "вентиляция воздуховод приточная вытяжная система калорифер")],
            [rf(1, "012", "Венткамера")],
            "ОВ",
        ),
    ]
    pairs = match_page_pairs(before, after)
    assert len(pairs) == 1
    assert after[pairs[0].after_file_idx].name == "rd_ventilation.pdf", pairs
    print("OK: matching subsystem vocabulary breaks a room-number tie between heating and ventilation volumes")


def test_subsystem_keyword_heuristic_does_not_apply_outside_ov():
    """Явление «два тома одной подсистемы с общими номерами помещений»
    специфично для раздела ОВ (см. subsystem.py) — на другом разделе те же
    слова могут встретиться случайно (текстовое примечание, соседнее
    помещение) и не должны штрафовать иначе лучшую пару по номеру
    помещения."""
    before = [DocumentInput(
        "pd.pdf", 1,
        [tf(1, "отопление радиатор стояк отопления теплоснабжение элеватор")],
        [rf(1, "012", "Техническое помещение")],
        "КР",
    )]
    after = [DocumentInput(
        "rd.pdf", 1,
        [tf(1, "вентиляция воздуховод приточная вытяжная калорифер")],
        [rf(1, "012", "Техническое помещение")],
        "КР",
    )]
    pairs = match_page_pairs(before, after)
    assert len(pairs) == 1
    assert pairs[0].matched_by == "text", "совпадение номера помещения не должно штрафоваться вне ОВ"
    print("OK: subsystem_lean heuristic is inert outside the ОВ discipline")


def test_page_kind_gating_even_when_one_side_has_no_text_pages():
    """Если у ПД нет текстовых листов вообще (только чертежи), а у РД есть и
    то, и другое — текстовые листы РД просто не с чем сравнивать, и они не
    должны утянуть на себя чертёжные листы ПД (не должно быть кросс-пар)."""
    before = [DocumentInput("pd.pdf", 1, [{"page": 1, "text": "план этажа калорифер"}], [], "ОВ",
                             page_kinds={1: "drawing"})]
    after = [DocumentInput("rd.pdf", 2,
                            [{"page": 1, "text": "план этажа калорифер"},
                             {"page": 2, "text": "содержание тома акт приложение"}],
                            [], "ОВ", page_kinds={1: "drawing", 2: "text"})]
    pairs = match_page_pairs(before, after)
    assert len(pairs) == 1, pairs
    assert pairs[0].page_kind == "drawing"
    assert pairs[0].before_page == 1 and pairs[0].after_page == 1
    print("OK: after-side text page with no before-side counterpart is left unpaired, not cross-matched to a drawing")


if __name__ == "__main__":
    test_discipline_gating_prefers_same_code()
    test_ungated_when_no_matching_code_on_other_side()
    test_positional_fallback_flags_discipline_mismatch()
    test_digit_suffix_ignored_ov21_vs_ov1()
    test_every_page_covered_when_after_side_much_larger()
    test_shared_room_number_wins_over_stronger_generic_word_overlap()
    test_subsystem_keyword_conflict_breaks_a_room_number_tie()
    test_drawing_and_text_pages_never_cross_paired()
    test_page_kind_gating_even_when_one_side_has_no_text_pages()
    print("ALL PASS")
