import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.requirement_registry import (
    Requirement,
    extract_coded_requirements,
    extract_general_requirements,
    extract_predicate_requirements,
    extract_requirements,
    match_requirement_rooms_by_name,
    render_general_requirements_summary,
    render_requirements_summary,
)


def test_coded_item_extracts_rooms_and_code():
    """Реальная форма из пояснительной записки: тире-пункт списка систем
    противодымной защиты."""
    text_facts = [{"page": 16, "text": (
        "предусматриваются:\n"
        "- из поэтажных коридоров, пом. 108, 201 (ВД1);\n"
        "- из поэтажных коридоров, пом. 139, 227, 309 (ВД2);\n"
    )}]
    reqs = extract_coded_requirements(text_facts)
    assert len(reqs) == 2
    assert reqs[0] == Requirement(rooms=["108", "201"], page=16,
                                   sentence="- из поэтажных коридоров, пом. 108, 201 (ВД1);",
                                   code="ВД1")
    assert reqs[1].code == "ВД2" and reqs[1].rooms == ["139", "227", "309"]
    print("OK: тире-пункты с кодом системы разобраны по отдельности")


def test_coded_item_merges_multiple_pom_runs_in_one_item():
    """Один пункт списка может содержать несколько «пом. ...» через «и» —
    оба набора номеров относятся к одному коду системы (наблюдение с
    реального файла: пункт ВД5)."""
    text_facts = [{"page": 16, "text": (
        "- из поэтажных коридоров, пом. 138, 219, 304 и рекреация, пом. 275 (ВД5);\n"
    )}]
    reqs = extract_coded_requirements(text_facts)
    assert len(reqs) == 1
    assert reqs[0].code == "ВД5"
    assert reqs[0].rooms == ["138", "219", "304", "275"]
    print("OK: несколько «пом.» внутри одного пункта объединены под одним кодом")


def test_coded_item_does_not_span_into_next_list_entry():
    """Тире внутри обычного текста (дефис в слове, «не-» и т.п.) не должен
    становиться ложной границей пункта, из-за которой поиск кода уедет в
    следующий пункт списка и захватит чужие номера помещений — это была
    реальная ошибка первой версии регулярки (см. историю сессии): без
    требования «тире в начале строки» «- ... (КОД);» подхватывал номера
    из совершенно не связанного предложения несколькими абзацами раньше."""
    text_facts = [{"page": 10, "text": (
        "В помещениях для МГН (пом. 267, 270) предусмотрена система "
        "подогрева полов, совмещенная с системой радиаторного отопления.\n"
        "Далее по тексту, без всякого списка.\n"
        "- из поэтажных коридоров, пом. 108, 201 (ВД1);\n"
    )}]
    reqs = extract_coded_requirements(text_facts)
    assert len(reqs) == 1
    assert reqs[0].rooms == ["108", "201"]
    print("OK: посторонний текст перед пунктом списка не даёт ложного склеивания")


def test_ignores_dash_item_without_room_reference():
    text_facts = [{"page": 5, "text": "- вентилятор канальный, 1 шт. (В14);\n"}]
    assert extract_coded_requirements(text_facts) == []
    print("OK: пункт списка без «пом.» не создаёт запись реестра")


def test_predicate_requirement_found_with_perfective_verb():
    """Реальное предложение (нарушение №2): «предусмотрена» — совершенный
    вид, корень «предусмотр-»."""
    text_facts = [{"page": 10, "text": (
        "Приборы должны быть выполнены в травмобезопасном исполнении. "
        "В помещениях раздевальных, санузлов и душевых для МГН "
        "(пом. 267, 270, 271, 272) предусмотрена система подогрева полов "
        "(теплые полы) совмещенная с системой радиаторного отопления. "
        "Регулирование температуры пола осуществляется регуляторами."
    )}]
    reqs = extract_predicate_requirements(text_facts)
    assert len(reqs) == 1
    assert reqs[0].rooms == ["267", "270", "271", "272"]
    assert reqs[0].code is None
    assert "подогрева полов" in reqs[0].sentence
    assert "Регулирование" not in reqs[0].sentence
    print("OK: требование без кода найдено, предложение обрезано по границе")


def test_predicate_requirement_found_with_imperfective_verb():
    """Реальное предложение: «предусматривается» — несовершенный вид,
    корень «предусматр-» (другая гласная — не то же слово, что выше)."""
    text_facts = [{"page": 11, "text": (
        "Освещённость должна составлять не менее 75%. "
        "В помещении горячего цеха (пом. 189) в не рабочее время "
        "предусматривается поддержание температуры внутреннего воздуха "
        "равной +12 С. Разводка труб выполняется скрыто."
    )}]
    reqs = extract_predicate_requirements(text_facts)
    assert len(reqs) == 1
    assert reqs[0].rooms == ["189"]
    print("OK: несовершенный вид глагола-предиката тоже распознаётся")


def test_room_reference_without_predicate_is_not_a_requirement():
    """Реальный случай той же формы «(пом. N)», но БЕЗ глагола-требования —
    это указание места объекта, не требование к помещению (наблюдение с
    реального файла: «... установлена в подвале здания (пом. 007).»)."""
    text_facts = [{"page": 13, "text": (
        "Установка П20 установлена в подвале здания (пом. 007). "
        "В помещении ИТП устанавливается приточная установка П19."
    )}]
    assert extract_predicate_requirements(text_facts) == []
    print("OK: место без глагола-предиката требования не даёт ложной находки")


def test_table_legend_caption_is_not_a_requirement():
    """Реальный случай: подпись легенды на схеме («Отопление ... (пом. 167)»)
    — не предложение и не требование, глагола нет."""
    text_facts = [{"page": 20, "text": "Отопление многосветного пространства (пом. 167)"}]
    assert extract_predicate_requirements(text_facts) == []
    print("OK: подпись легенды без предиката отфильтрована")


def test_extract_requirements_combines_both_forms():
    text_facts = [{"page": 16, "text": "- из поэтажных коридоров, пом. 108, 201 (ВД1);\n"}]
    text_facts2 = [{"page": 10, "text": (
        "Общие указания. В помещениях для МГН (пом. 267, 270) "
        "предусмотрена система подогрева полов."
    )}]
    combined = text_facts + text_facts2
    reqs = extract_requirements(combined)
    codes = {r.code for r in reqs}
    assert "ВД1" in codes
    assert any(r.code is None for r in reqs)
    print("OK: обе формы объединяются в общий реестр")



def test_render_requirements_summary_lists_every_requirement_with_page_and_rooms():
    reqs = [
        Requirement(rooms=["108", "201"], page=12, sentence="...(ВД1);", code="ВД1"),
        Requirement(rooms=["270"], page=21, sentence="В помещении 270 предусмотрен тёплый пол.", code=None),
    ]
    text = render_requirements_summary(reqs)
    assert "извлечено: 2" in text
    assert "стр.12" in text and "[ВД1]" in text and "108, 201" in text
    assert "стр.21" in text and "270" in text
    assert "предусмотрен тёплый пол" in text
    assert "[ВД1]" not in text.split("стр.21")[1].split("\n")[0]


def test_render_requirements_summary_handles_empty_list():
    text = render_requirements_summary([])
    assert "извлечено: 0" in text


# --------------------------------------------------------------------------
# Форма 3 (Г.47) — общий каталог, без привязки к «(пом. N)»
# --------------------------------------------------------------------------

def test_general_requirements_catch_sentence_without_room_paren():
    """Реальное наблюдение (Г.47): требования по зонам без номера в
    скобках («актовый зал», не «пом. N») и без корня «предусмотр-» —
    форма 2 их не видит вообще."""
    text_facts = [{"page": 9, "text": (
        "Все применяемые приборы должны быть выполнены в травмобезопасном "
        "исполнении. Экраны должны быть выполнены из материалов, не "
        "оказывающих вредного воздействия на человека."
    )}]
    reqs = extract_general_requirements(text_facts)
    assert len(reqs) == 2
    assert all(r.rooms == [] for r in reqs)
    assert "травмобезопасном" in reqs[0].sentence
    print("OK: форма 3 ловит требования без номера помещения и без корня «предусмотр-»")


def test_general_requirements_keep_room_numbers_when_present():
    text_facts = [{"page": 11, "text": (
        "В помещениях раздевальных, санузлов и душевых для МГН "
        "(пом. 267, 270, 271, 272) предусмотрена система подогрева полов."
    )}]
    reqs = extract_general_requirements(text_facts)
    assert len(reqs) == 1
    assert reqs[0].rooms == ["267", "270", "271", "272"]
    print("OK: форма 3 сохраняет номера помещений, если они рядом есть")


def test_general_requirements_catch_perfective_vypolnit_form():
    """Г.56 — реальный пропущенный случай слепого прогона: «выполня\\w*»
    ловит только несовершенный вид («выполняется»), совершенный
    («выполнить», обычная форма технического требования) не ловился вовсе.
    Дословное предложение из ПД (лист 11): требование к материалу
    воздуховодов вытяжных шкафов в лаборантских и кабинетах физики/химии —
    единственная текстовая зацепка для последующей сверки этих помещений
    (номеров в скобках рядом нет, форма 2 это предложение не видит)."""
    text_facts = [{"page": 15, "text": (
        "Воздуховоды от вытяжных шкафов в лаборанских и кабинетах физики и "
        "химии выполнить из коррозионностойких материалов (нержавеющая "
        "сталь, неметаллические покрытия)."
    )}]
    reqs = extract_general_requirements(text_facts)
    assert len(reqs) == 1, reqs
    assert "лаборан" in reqs[0].sentence.lower()
    print("OK: совершенный вид «выполнить» (не только «выполняется») ловится формой 3")


def test_match_requirement_rooms_by_name_finds_real_pd_rooms():
    """Г.57 — реальный случай: требование про воздуховоды вытяжных шкафов
    «в лаборанских и кабинетах физики и химии» не называет ни одного номера
    (иначе это была бы форма 1/2), но должно связаться по ключевым словам
    названия с настоящими помещениями реестра ПД (140/141/147/198)."""
    sentence = ("Воздуховоды от вытяжных шкафов в лаборанских и кабинетах физики и "
               "химии выполнить из коррозионностойких материалов.")
    room_facts = [
        {"key": "140", "name": "Физического эксперимента"},
        {"key": "141", "name": "Биолого-химического практикума"},
        {"key": "147", "name": "Лаборантская тип АВ"},
        {"key": "198", "name": "Лаборантская тип АВ"},
        {"key": "105", "name": "Вестибюль"},
        {"key": "104", "name": "Охрана"},
    ]
    matched = match_requirement_rooms_by_name(sentence, room_facts)
    assert set(matched) == {"140", "141", "147", "198"}, matched
    print("OK: требование про лаборатории физики/химии связано с реальными помещениями ПД по названию")


def test_hint_ranks_instead_of_filtering():
    """Г.108 — подсказка ничего не выбрасывает, она упорядочивает.

    Отсев требует порога, а порога, отделяющего слово предмета тома от
    слова, называющего место, в данных нет: измерено четырьмя способами, ни
    один границы не дал (см. заметку в модуле). Порядок такого выбора не
    требует: помещение, совпавшее по различительному слову, стоит выше
    помещения, совпавшего по слову, которое встречается повсюду. Сколько
    взять из порядка, решает бюджет потребителя.
    """
    sentence = "Вентиляция помещений лаборантских выполняется отдельными системами"
    room_facts = [
        {"key": "012", "name": "Венткамера"},
        {"key": "147", "name": "Лаборантская тип АВ"},
    ]
    # Ничего не потеряно: оба помещения на месте в обоих случаях.
    plain = match_requirement_rooms_by_name(sentence, room_facts)
    assert set(plain) == {"012", "147"}, plain

    weighted = match_requirement_rooms_by_name(
        sentence, room_facts,
        word_weight=lambda w: 0.2 if w.startswith("вент") else 3.0)
    assert weighted == ["147", "012"], weighted
    print("OK: подсказка ранжирует, а не отсеивает — ничего не теряется")


def test_hint_order_is_stable_when_nothing_distinguishes_the_rooms():
    """Без весов порядок остаётся реестровым: механизм обязан работать и
    там, где взвешивать нечем (пустая база, первый том раздела)."""
    sentence = "Требование касается лаборантских помещений"
    room_facts = [
        {"key": "301", "name": "Лаборантская первая"},
        {"key": "302", "name": "Лаборантская вторая"},
    ]
    assert match_requirement_rooms_by_name(sentence, room_facts) == ["301", "302"]
    print("OK: без весов порядок устойчив и совпадает с порядком реестра")


def test_weight_is_asked_for_every_matched_word_not_for_the_requirement():
    """Вес спрашивается у СЛОВА НАЗВАНИЯ, а не у требования: это делает
    источник веса подменяемым (данные документа, накопленная база) и
    оставляет механизм без собственного словаря."""
    asked = []

    def weight(word):
        asked.append(word)
        return 1.0

    match_requirement_rooms_by_name(
        "Помещения лаборантских и кабинетов",
        [{"key": "301", "name": "Лаборантская тип АВ"}], word_weight=weight)
    assert asked == ["лаборантская"], asked
    print("OK: вес запрашивается у слова названия — источник веса подменяем")


def test_match_requirement_rooms_by_name_no_match_for_unrelated_rooms():
    sentence = "Наружные блоки VRF и сплит систем устанавливаются на кровле здания."
    room_facts = [
        {"key": "140", "name": "Физического эксперимента"},
        {"key": "105", "name": "Вестибюль"},
    ]
    assert match_requirement_rooms_by_name(sentence, room_facts) == []
    print("OK: не связывает требование с помещениями, если ключевых слов нет вовсе")


def test_match_requirement_rooms_by_name_ignores_short_words():
    """Короткие слова (<5 букв) не участвуют в сравнении — «вход» в
    требовании не должен цеплять «входа» в названии помещения, иначе
    служебные короткие слова дадут случайные совпадения повсюду."""
    sentence = "В зоне вход организован через тамбур с доводчиком."
    room_facts = [{"key": "105", "name": "Зона входа"}]
    assert match_requirement_rooms_by_name(sentence, room_facts) == []
    print("OK: слова короче 5 букв не считаются ключевыми и не дают совпадения")


def test_general_requirements_ignore_short_and_long_fragments():
    text_facts = [{"page": 3, "text": (
        "Необходимо. "
        + ("должен быть выполнен по проекту " * 40) + "."
    )}]
    reqs = extract_general_requirements(text_facts, min_len=20, max_len=100)
    assert reqs == []
    print("OK: слишком короткие/длинные фрагменты отсеяны фильтром длины")


def test_general_requirements_do_not_leak_into_cross_check_pipeline():
    """`extract_requirements()` (сверка/эскалация/триангуляция, Г.33/Г.46)
    остаётся только формами 1+2 — форма 3 намеренно широкая и не должна
    попадать в автоматическую сверку без явного вызова."""
    text_facts = [{"page": 9, "text": "Экраны должны быть выполнены из негорючих материалов."}]
    assert extract_requirements(text_facts) == []
    assert len(extract_general_requirements(text_facts)) == 1
    print("OK: форма 3 не подмешивается в extract_requirements() по умолчанию")


def test_render_general_requirements_summary_marks_it_as_not_for_cross_check():
    reqs = [Requirement(rooms=[], page=9, sentence="Экраны должны быть негорючими.")]
    text = render_general_requirements_summary(reqs)
    assert "извлечено: 1" in text
    assert "не для автосверки" in text
    assert "не указаны" not in text  # пустой rooms не печатает "помещения:" вообще
    print("OK: отдельный рендер формы 3 явно помечен как не вход в автосверку")


def test_render_general_requirements_summary_dedupes_repeated_sentence():
    """Г.67 — реальная жалоба: одна и та же шаблонная фраза повторяется
    дословно на разных страницах/томах и раньше печаталась отдельной
    строкой на каждое совпадение. Теперь одна строка со списком всех
    страниц, где она встретилась."""
    reqs = [
        Requirement(rooms=[], page=21, sentence="Работы выполнять в соответствии с ПУЭ."),
        Requirement(rooms=[], page=45, sentence="работы выполнять в соответствии с ПУЭ."),
    ]
    text = render_general_requirements_summary(reqs)
    assert "извлечено: 2 (уникальных формулировок: 1)" in text
    assert "стр.21, 45" in text
    assert text.count("«") == 1  # текст предложения напечатан один раз, не дважды
    assert "повторено 2×" in text
    print("OK: одинаковые по тексту требования с разных страниц сведены в одну строку")


def test_render_general_requirements_summary_marks_norm_reference_only_sentence():
    """Г.67 — мягкая эвристика (не фильтр, Г.10): предложение-голая ссылка
    на норму без другого содержания помечается видимо, а не молча тонет в
    каталоге среди содержательных требований. Реальный текст («V0_00-05-
    04-02-07_Том 5.4.2 ОВ (1).pdf», стр.21): «Работы выполнять в
    соответствии с действующими СНиП 3.05.06-85, ПУЭ.»"""
    reqs = [Requirement(rooms=[], page=21,
                        sentence="Работы выполнять в соответствии с действующими СНиП 3.05.06-85, ПУЭ.")]
    text = render_general_requirements_summary(reqs)
    assert "[только ссылка на норму]" in text
    print("OK: голая ссылка на норму без другого содержания помечена видимо")


def test_render_general_requirements_summary_does_not_mark_real_requirement():
    reqs = [Requirement(rooms=[], page=19,
                        sentence="Воздуховоды вытяжных шкафов выполнить из нержавеющей стали.")]
    text = render_general_requirements_summary(reqs)
    assert "[только ссылка на норму]" not in text
    print("OK: содержательное требование без ссылки на норму не помечается")


if __name__ == "__main__":
    test_coded_item_extracts_rooms_and_code()
    test_coded_item_merges_multiple_pom_runs_in_one_item()
    test_coded_item_does_not_span_into_next_list_entry()
    test_ignores_dash_item_without_room_reference()
    test_predicate_requirement_found_with_perfective_verb()
    test_predicate_requirement_found_with_imperfective_verb()
    test_room_reference_without_predicate_is_not_a_requirement()
    test_table_legend_caption_is_not_a_requirement()
    test_extract_requirements_combines_both_forms()
    test_render_requirements_summary_lists_every_requirement_with_page_and_rooms()
    test_render_requirements_summary_handles_empty_list()
    test_general_requirements_catch_sentence_without_room_paren()
    test_general_requirements_catch_perfective_vypolnit_form()
    test_match_requirement_rooms_by_name_finds_real_pd_rooms()
    test_hint_ranks_instead_of_filtering()
    test_hint_order_is_stable_when_nothing_distinguishes_the_rooms()
    test_weight_is_asked_for_every_matched_word_not_for_the_requirement()
    test_match_requirement_rooms_by_name_no_match_for_unrelated_rooms()
    test_match_requirement_rooms_by_name_ignores_short_words()
    test_general_requirements_keep_room_numbers_when_present()
    test_general_requirements_ignore_short_and_long_fragments()
    test_general_requirements_do_not_leak_into_cross_check_pipeline()
    test_render_general_requirements_summary_marks_it_as_not_for_cross_check()
    test_render_general_requirements_summary_dedupes_repeated_sentence()
    test_render_general_requirements_summary_marks_norm_reference_only_sentence()
    test_render_general_requirements_summary_does_not_mark_real_requirement()
    print("ALL PASS")
