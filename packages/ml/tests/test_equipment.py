import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.equipment import extract_equipment_facts


def test_multiline_table_row_pos_name_qty():
    text = "14\nВентилятор канальный ВК-100\n2\n15\nКлапан обратный КО-100\n1"
    by_key = {f["key"]: f for f in extract_equipment_facts(text)}
    assert by_key["14"]["name"] == "Вентилятор канальный ВК-100", by_key
    assert by_key["14"]["qty"] == "2", by_key
    assert by_key["15"]["name"] == "Клапан обратный КО-100", by_key
    assert by_key["15"]["qty"] == "1", by_key
    print("OK: строка «поз / название / кол-во» разобрана в реестр оборудования")


def test_child_positions_carry_parent_key():
    """Комплектующие одной установки («14.1» / «14.2») должны нести ссылку
    на родителя — иначе пропавшую дочернюю позицию нельзя отличить от
    независимой находки при проверке по Г.16."""
    text = "14.1\nАгрегат основной ВЦ4-75\n1\n14.2\nАгрегат резервный ВЦ4-75\n1"
    by_key = {f["key"]: f for f in extract_equipment_facts(text)}
    assert by_key["14.1"]["parent"] == "14", by_key
    assert by_key["14.2"]["parent"] == "14", by_key
    print("OK: дочерние позиции хранят код родительской установки")


def test_qty_with_unit_suffix_parsed():
    text = "3\nВоздуховод гибкий\n5 шт."
    by_key = {f["key"]: f for f in extract_equipment_facts(text)}
    assert by_key["3"]["qty"] == "5", by_key
    print("OK: количество с суффиксом «шт.»/«компл.» разбирается как число")


def test_position_without_name_is_not_registered():
    """Голый код без продолжения (обрывок соседней таблицы, номер оси) не
    должен попадать в реестр — как и в rooms.py, число без названия не факт."""
    text = "14\n\n15\nКлапан обратный КО-100\n1"
    keys = [f["key"] for f in extract_equipment_facts(text)]
    assert "14" not in keys, keys
    assert "15" in keys, keys
    print("OK: позиция без названия не регистрируется как оборудование")


def test_table_header_row_is_skipped_not_registered():
    text = "Поз.\nОбозначение\nНаименование\nКол-во\n14\nВентилятор ВК-100\n2"
    keys = [f["key"] for f in extract_equipment_facts(text)]
    assert keys == ["14"], keys
    print("OK: заголовок столбцов таблицы не превращается в позицию оборудования")


def test_room_key_on_same_page_excludes_equipment_position():
    """Реальный сбой первого слепого прогона Г.20: подавляющее большинство
    "позиций оборудования" оказались повторно разобранными номерами
    помещений с той же страницы. room_keys — сигнал приоритета помещения."""
    text = "101\nТамбур\n1\n102\nВентилятор ВК-100\n2"
    facts = extract_equipment_facts(text, room_keys={"101"})
    keys = [f["key"] for f in facts]
    assert "101" not in keys, keys
    assert "102" in keys, keys
    print("OK: позиция с ключом, уже занятым номером помещения, отсеивается")


def test_stray_header_between_position_and_name_is_skipped():
    """На некоторых листах заголовок столбца повторяется на каждой странице
    прямо между кодом позиции и её названием (перенос таблицы) — это не
    часть названия и не должно портить запись."""
    text = "14\nНаименование\nВентилятор ВК-100\n2"
    by_key = {f["key"]: f for f in extract_equipment_facts(text)}
    assert by_key["14"]["name"] == "Вентилятор ВК-100", by_key
    print("OK: заголовок столбца между кодом и названием пропускается, не портит запись")


def test_stamp_signature_block_is_not_registered():
    """Реальный шум слепого прогона по всему комплекту (Г.29): дата в штампе
    («01.23») по форме совпадает с кодом дочерней позиции («\\d{1,2}.\\d{1,2}»),
    а следующая строка — не название оборудования, а поле подписи штампа
    («Н.контр. Петрова», «ГИП Иванов», «Разраб. Сидоров»)."""
    text = "14\nВентилятор ВК-100\n2\n01.23\nН.контр. Петрова"
    keys = [f["key"] for f in extract_equipment_facts(text)]
    assert "01.23" not in keys, keys
    assert "14" in keys, keys
    print("OK: дата+поле подписи штампа не регистрируется как позиция оборудования")


def test_bare_unit_name_is_not_registered():
    """Реальный шум: строка таблицы противопожарных клапанов, где после
    кода стоит голая единица измерения без описания («116 / шт») — не
    название позиции, обрывок соседнего столбца."""
    text = "14\nВентилятор ВК-100\n2\n116\nшт"
    keys = [f["key"] for f in extract_equipment_facts(text)]
    assert "116" not in keys, keys
    assert "14" in keys, keys
    print("OK: голая единица измерения без описания не становится названием позиции")


def test_sheet_title_from_contents_list_is_not_registered():
    """Реальный шум: «Ведомость чертежей»/«Содержание» перечисляет номер
    листа рядом с его названием («11 / Принципиальная схема систем
    противодымной вентиляции») — по форме неотличимо от «код / название»
    ведомости оборудования, но это название ЛИСТА, не оборудования."""
    text = ("14\nВентилятор ВК-100\n2\n"
            "11\nПринципиальная схема систем противодымной вентиляции")
    keys = [f["key"] for f in extract_equipment_facts(text)]
    assert "11" not in keys, keys
    assert "14" in keys, keys
    print("OK: название листа из содержания/ведомости чертежей не становится позицией")


def test_explanatory_note_clause_heading_is_not_registered():
    """Реальный шум: нумерованный пункт пояснительной записки («7.
    Обоснование энергетической эффективности...») по форме — код позиции +
    следующая строка — но это заголовок раздела текста, не оборудование."""
    text = "14\nВентилятор ВК-100\n2\n65\n7. Обоснование энергетической эффективности конструктивных"
    keys = [f["key"] for f in extract_equipment_facts(text)]
    assert "65" not in keys, keys
    assert "14" in keys, keys
    print("OK: заголовок пункта пояснительной записки не становится позицией оборудования")


def test_formula_text_is_not_registered():
    """Реальный шум: расчётная формула из текста, захваченная как «название»
    («Расчетная высота здания ... Hзд = h(2) + ...») — наличие «=» надёжно
    отличает формулу от названия оборудования на этом комплекте."""
    text = "14\nВентилятор ВК-100\n2\n79\nРасчетная высота здания до уровня перекрытия Hзд = h(2) + 10,10 м"
    keys = [f["key"] for f in extract_equipment_facts(text)]
    assert "79" not in keys, keys
    assert "14" in keys, keys
    print("OK: строка с формулой (содержит «=») не становится позицией оборудования")


def test_document_shifr_footer_is_not_registered():
    """Реальный шум: шифр документа повторяется в колонтитуле каждой
    страницы ведомости («ОБЪ/000000/1-П-ВОР.ИОС5.4.2 Формат: А3») — по
    форме код+название, но это не позиция, а колонтитул."""
    text = "14\nВентилятор ВК-100\n2\n27\nОБЪ/000000/1-П-ВОР.ИОС5.4.2 Формат: А3"
    keys = [f["key"] for f in extract_equipment_facts(text)]
    assert "27" not in keys, keys
    assert "14" in keys, keys
    print("OK: повторяющийся в колонтитуле шифр документа не становится позицией")


def test_normative_reference_is_not_registered():
    """Реальный шум: нормативная ссылка, случайно подхваченная как
    «название» позиции («ГОСТ Р 21.1101-2013 «...»»)."""
    text = "14\nВентилятор ВК-100\n2\n16\nГОСТ Р 21.1101-2013 «СПДС. Основные требования»"
    keys = [f["key"] for f in extract_equipment_facts(text)]
    assert "16" not in keys, keys
    assert "14" in keys, keys
    print("OK: нормативная ссылка не становится позицией оборудования")


def test_table_filler_dash_is_not_registered():
    """Реальный шум: строка-заполнитель таблицы («-//-») без какого-либо
    текста — обрывок соседнего столбца, не название."""
    text = "14\nВентилятор ВК-100\n2\n538\n-//- -//-"
    keys = [f["key"] for f in extract_equipment_facts(text)]
    assert "538" not in keys, keys
    assert "14" in keys, keys
    print("OK: строка-заполнитель таблицы не становится позицией оборудования")


def test_elevation_mark_with_fire_rating_is_not_registered():
    """Реальный шум слепого прогона на образцовом комплекте (Г.52-53): отметка
    уровня из штампа разреза («-2.950») с пределом огнестойкости рядом
    («EI30») по форме совпадает с «код / название», но это подпись сечения,
    не оборудование."""
    text = "14\nВентилятор ВК-100\n2\n012\n-2.950 EI30"
    keys = [f["key"] for f in extract_equipment_facts(text)]
    assert "012" not in keys, keys
    assert "14" in keys, keys
    print("OK: отметка уровня с пределом огнестойкости не становится позицией оборудования")


def test_bare_fire_rating_is_not_registered():
    """Тот же класс шума без числовой отметки — голое «EI30» рядом с
    условным номером (реальный случай: «006\\nEI30 №»)."""
    text = "14\nВентилятор ВК-100\n2\n006\nEI30 №"
    keys = [f["key"] for f in extract_equipment_facts(text)]
    assert "006" not in keys, keys
    assert "14" in keys, keys
    print("OK: голый предел огнестойкости не становится позицией оборудования")


def test_organization_name_is_not_registered():
    """Реальный шум: наименование организации из штампа с формой
    собственности («ООО «Проектировщик»») после даты, прочитанной как код дочерней
    позиции («08.24»)."""
    text = "14\nВентилятор ВК-100\n2\n08.24\nООО «Проектировщик» Лист Листов"
    keys = [f["key"] for f in extract_equipment_facts(text)]
    assert "08.24" not in keys, keys
    assert "14" in keys, keys
    print("OK: наименование организации не становится позицией оборудования")


def test_composition_document_title_is_not_registered():
    """Реальный шум: заголовок документа «Состав рабочей документации»
    (Г.17) после даты, прочитанной как код дочерней позиции («01.23»)."""
    text = "14\nВентилятор ВК-100\n2\n01.23\nСостав рабочей документации Стадия"
    keys = [f["key"] for f in extract_equipment_facts(text)]
    assert "01.23" not in keys, keys
    assert "14" in keys, keys
    print("OK: заголовок «Состав ... документации» не становится позицией оборудования")


if __name__ == "__main__":
    test_multiline_table_row_pos_name_qty()
    test_child_positions_carry_parent_key()
    test_qty_with_unit_suffix_parsed()
    test_position_without_name_is_not_registered()
    test_room_key_on_same_page_excludes_equipment_position()
    test_table_header_row_is_skipped_not_registered()
    test_stray_header_between_position_and_name_is_skipped()
    test_stamp_signature_block_is_not_registered()
    test_bare_unit_name_is_not_registered()
    test_sheet_title_from_contents_list_is_not_registered()
    test_explanatory_note_clause_heading_is_not_registered()
    test_formula_text_is_not_registered()
    test_document_shifr_footer_is_not_registered()
    test_normative_reference_is_not_registered()
    test_table_filler_dash_is_not_registered()
    test_elevation_mark_with_fire_rating_is_not_registered()
    test_bare_fire_rating_is_not_registered()
    test_organization_name_is_not_registered()
    test_composition_document_title_is_not_registered()
    print("ALL PASS")
