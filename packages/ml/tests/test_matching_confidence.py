from app.matching import DocumentInput, match_page_pairs


def tf(page, text):
    return {"page": page, "text": text}


def rf(page, key, name="Помещение"):
    return {"page": page, "key": key, "name": name}


def ef(page, key, name="Установка"):
    return {"page": page, "key": key, "name": name}


def test_weak_text_match_is_marked_for_review():
    before = [DocumentInput(
        "pd.pdf", 1,
        [tf(1, "приточная система воздуховод калорифер вентилятор автоматика")],
        [], "ОВ",
    )]
    after = [DocumentInput(
        "rd.pdf", 1,
        [tf(1, "приточная система насос радиатор коллектор теплообменник")],
        [], "ОВ",
    )]

    pairs = match_page_pairs(before, after)

    assert len(pairs) == 1
    assert pairs[0].matched_by == "review"
    assert pairs[0].needs_review is True
    assert 0.12 <= pairs[0].score < 0.35


def test_shared_room_anchor_promotes_pair_to_confident():
    before = [DocumentInput(
        "pd.pdf", 1,
        [tf(1, "принципиальная схема вентиляции")],
        [rf(1, "267", "МГН")], "ОВ",
    )]
    after = [DocumentInput(
        "rd.pdf", 1,
        [tf(1, "рабочий план второго этажа")],
        [rf(1, "267", "МГН")], "ОВ",
    )]

    pair = match_page_pairs(before, after)[0]

    assert pair.matched_by == "text"
    assert pair.needs_review is False
    assert pair.score >= 0.55


def test_shared_equipment_anchor_promotes_pair_to_confident():
    before = [DocumentInput(
        "pd.pdf", 1,
        [tf(1, "венткамера приточные установки")],
        [], "ОВ", equipment_facts=[ef(1, "П1", "Приточная установка")],
    )]
    after = [DocumentInput(
        "rd.pdf", 1,
        [tf(1, "монтажная схема камеры")],
        [], "ОВ", equipment_facts=[ef(1, "П1", "Приточная установка")],
    )]

    pair = match_page_pairs(before, after)[0]

    assert pair.matched_by == "text"
    assert pair.score >= 0.50
