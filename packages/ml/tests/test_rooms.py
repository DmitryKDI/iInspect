import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.rooms import extract_room_facts


def test_multiline_table_row_number_name_area_category():
    """Реальная форма 'Экспликации помещений' у PyMuPDF: номер, название и
    площадь почти всегда на отдельных строках (проверено на настоящих
    документах Nadzor_Sample), а не одной строкой, как в packages/documents."""
    text = "144\nЛаборантская тип А\n18.0\nВ3\n147\nЛаборантская тип АВ\n19.6\nВ3"
    by_key = {f["key"]: f for f in extract_room_facts(text)}
    assert by_key["144"]["name"] == "Лаборантская тип А", by_key
    assert by_key["144"]["area"] == "18.0", by_key
    assert by_key["147"]["name"] == "Лаборантская тип АВ", by_key
    assert by_key["147"]["area"] == "19.6", by_key
    print("OK: multi-line экспликация row (number / name / area / category) parsed correctly")


def test_inline_plan_label_number_and_name_on_one_line():
    """Подпись прямо на плане у контура помещения — короче, номер и название
    часто попадают в один текстовый блок PyMuPDF."""
    text = "006.1\nФоркамера\n006\nВенткамера\n002 Коридор"
    facts = extract_room_facts(text)
    keys = {f["key"]: f["name"] for f in facts}
    assert keys["006.1"] == "Форкамера"
    assert keys["006"] == "Венткамера"
    assert keys["002"] == "Коридор"
    print("OK: both multi-line and inline 'number name' forms parsed on the same page")


def test_single_letter_name_rejected_as_noise():
    """Реальный ложный срабатыватель на настоящих документах: марка/ось вида
    '4065\\nА' (обрывок таблицы) не должна попадать в реестр как помещение —
    название из одной буквы никогда не бывает настоящим названием комнаты."""
    text = "4065\nА\n144\nЛаборантская тип А\n18.0"
    facts = extract_room_facts(text)
    keys = [f["key"] for f in facts]
    assert "4065" not in keys, facts
    assert "144" in keys
    print("OK: a bare single-letter continuation is rejected, a real room name is kept")


def test_bare_numbers_without_a_name_produce_no_fact():
    """Номер оси/отметки без кириллического названия следом — не помещение."""
    text = "1\n2\n3\n4500\n1200"
    facts = extract_room_facts(text)
    assert facts == [], facts
    print("OK: standalone numbers with no following room name yield nothing")


def test_group_label_covering_several_rooms():
    """Реальная форма из ПД: «267, 270 / Раздевальная и санузул для МГН» —
    один заголовок на группу однотипных помещений. Раньше такая подпись не
    разбиралась, и все четыре помещения МГН терялись целиком."""
    text = "271, 272\nРаздевальная и\nсанузул для МГН\n267, 270\nРаздевальная и\nсанузул для МГН"
    keys = {f["key"] for f in extract_room_facts(text)}
    assert keys == {"267", "270", "271", "272"}, keys
    print("OK: групповая подпись «267, 270 …» разбирается на отдельные помещения")


def test_lowercase_room_name_is_accepted():
    """В экспликации РД название продолжает групповой заголовок и потому
    идёт со строчной буквы: «140 моделирования и конструирования»."""
    facts = extract_room_facts("140\nмоделирования и конструирования\n50.4")
    assert facts and facts[0]["key"] == "140", facts
    assert facts[0].get("area") == "50.4", facts
    print("OK: название со строчной буквы принимается, площадь сохраняется")


def test_equipment_measurements_are_not_rooms():
    """Реальный источник шума: на 269 страницах паспортов оборудования
    «1270 Масса, кг» и «8000 Сум. дБА» попадали в реестр помещений и
    порождали ложные совпадения при сопоставлении листов."""
    text = ("1270\nМасса, кг\n8000\nСум. дБА На всасывании\n"
            "3200\nМасса, кг\n317.6\nСтепень загрязнения\n1952,0\nПлощадь")
    assert extract_room_facts(text) == [], extract_room_facts(text)
    print("OK: массы, уровни шума и площади не принимаются за помещения")


def test_area_with_comma_is_not_a_room_number():
    """«258,1» в экспликации — площадь; настоящий подномер помещения
    пишется через точку («258.1»)."""
    assert extract_room_facts("1952,0\nВенткамера") == []
    assert extract_room_facts("258.1\nВенткамера")[0]["key"] == "258.1"
    print("OK: запятая-разделитель отличает площадь от подномера помещения")


def test_group_header_area_is_not_a_room():
    """Реальный источник шума в экспликации: у заголовка ГРУППЫ помещений
    рядом стоит её суммарная площадь, и она принималась за номер помещения —
    «1254.5 Медицинский блок, вестибюльная группа»."""
    for text in ("1254.5\nМедицинский блок, вестибюльная группа",
                 "1545.8\nОбщешкольная группа помещений",
                 "370.2\nОбщешкольная группа помещений: столовая",
                 "3793.1\nЭОМ",
                 "1200\nДн-8Л Дн-8 СС",
                 "3550\nР я АА",
                 "160\nНедоступно Недоступно"):
        assert extract_room_facts(text) == [], (text, extract_room_facts(text))
    print("OK: итоговые площади групп, марки оборудования и заглушки отсеяны")


def test_real_subrooms_and_four_digit_rooms_survive():
    """Отсев не должен задеть настоящие помещения комплекта."""
    keep = {"006.1": "Форкамера", "012.1": "Форкамера", "258.1": "Кладовая",
            "1001": "Лифт", "001": "ИТП"}
    for key, name in keep.items():
        facts = extract_room_facts(f"{key}\n{name}")
        assert facts and facts[0]["key"] == key, (key, facts)
    assert extract_room_facts("004\nЛестница Л-2")[0]["name"] == "Лестница Л-2"
    print("OK: подномера .1/.2, четырёхзначные номера и «Лестница Л-2» сохранены")


def test_room_with_inclusive_tail_is_kept():
    """Реальный ложный отсев, найденный слепым прогоном: строка экспликации
    «245 Актовый зал на 160 мест, в том числе / эстрада в уровне пола / 313.2»
    отбрасывалась целиком по фразе «в том числе», и помещение 245 молча
    выпадало из реестра — а затем всплывало кандидатом «отсутствует в РД»."""
    facts = extract_room_facts("245\nАктовый зал на 160 мест, в том числе\n313.2")
    assert facts and facts[0]["key"] == "245", facts
    assert facts[0]["name"] == "Актовый зал на 160 мест", facts
    # Площадь «313.2» здесь не извлекается: она неотличима от номера
    # подпомещения 313.2. Помещение при этом сохранено — это и было целью;
    # разбор такой площади требует отдельного признака и здесь не решается.
    print("OK: «, в том числе» отрезается, помещение остаётся в реестре")


def test_real_group_headers_still_rejected():
    """Отмена отсева по «в том числе» не должна вернуть настоящие заголовки."""
    for text in ("1545.8\nОбщешкольная группа помещений",
                 "1254.5\nМедицинский блок, вестибюльная группа"):
        assert extract_room_facts(text) == [], (text, extract_room_facts(text))
    print("OK: настоящие заголовки групп по-прежнему отсеиваются")


if __name__ == "__main__":
    test_multiline_table_row_number_name_area_category()
    test_inline_plan_label_number_and_name_on_one_line()
    test_single_letter_name_rejected_as_noise()
    test_bare_numbers_without_a_name_produce_no_fact()
    test_group_label_covering_several_rooms()
    test_lowercase_room_name_is_accepted()
    test_equipment_measurements_are_not_rooms()
    test_area_with_comma_is_not_a_room_number()
    test_group_header_area_is_not_a_room()
    test_real_subrooms_and_four_digit_rooms_survive()
    test_room_with_inclusive_tail_is_kept()
    test_real_group_headers_still_rejected()
    print("ALL PASS")
