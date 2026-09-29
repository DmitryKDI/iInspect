"""Тесты для composition_registry.py — комплектность по «Составу
документации» (Приложение Г.17).

Про происхождение входных данных в этом файле (важно, Г.11):

  * Тесты с пометкой **СИНТЕТИКА** используют таблицу, которую написал
    автор теста по общей структуре «обозначение → наименование →
    разработчик». Шифр объекта в них заведомо ненастоящий
    («ТЕСТ/000000/9-...»), чтобы синтетику нельзя было принять за
    выписку из реального комплекта.
  * Тесты с пометкой **ТЕКСТ (обезличен)** содержат дословную (сокращённую
    по числу строк, но не переписанную) выдержку `page.get_text("text")`
    из файлов образцового комплекта `образцовом комплекте`, с указанием файла и
    страницы. Это то, на чём регулярки модуля реально проверены.
  * Тест `test_real_pdf_*` читает сам PDF, если он доступен в этой среде,
    и пропускается, если файлов нет (они не в репозитории).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.composition_registry import (
    CompositionEntry,
    SuppliedDocument,
    check_completeness,
    extract_composition_entries,
    find_document_references,
    match_supplied,
    render_completeness_report,
)

# ---------------------------------------------------------------------------
# СИНТЕТИКА: страница «Состав рабочей документации», написанная автором теста
# по общей структуре таблицы. Раскладка строк (обозначение / наименование /
# разработчик — каждый на своей строке) повторяет то, как PyMuPDF отдаёт
# табличную страницу, см. rooms.py/equipment.py.
# ---------------------------------------------------------------------------
SYNTH_COMPOSITION_PAGE = """ТЕСТ/000000/9-РД-СП
Изм.
Кол.
Лист
Подпись
Дата
ГИП
Иванов
Состав рабочей документации
Стадия
Лист
Листов
Р
1
ВЕДОМОСТЬ ОСНОВНЫХ КОМПЛЕКТОВ РАБОЧИХ ЧЕРТЕЖЕЙ
Обозначение
Наименование
Разработчик
ТЕСТ/000000/9-РД-ГП
Генеральный план
ООО «Синтетика»
ТЕСТ/000000/9-РД-АР1
Архитектурные решения. План первого
этажа
ООО «Синтетика»
ТЕСТ/000000/9-РД-ВК
Внутренние сети водоотведения
ООО «Синтетика»
ТЕСТ/000000/9-РД-ИТП.УУТЭ
Индивидуальный тепловой пункт. Узел
учета тепловой энергии
"""

SYNTH_CONTINUATION_PAGE = """ТЕСТ/000000/9-РД-СП
Лист
2
Изм.
Кол.
Лист
Подпись
Дата
ТЕСТ/000000/9-РД-ОВ1
Общеобменная вентиляция
ООО «Синтетика»
ТЕСТ/000000/9-РД-ЭОМ
Силовое оборудование
ООО «Синтетика»
"""


def tf(page: int, text: str) -> dict:
    return {"page": page, "text": text}


def entry(designation: str, name: str = "имя", page: int = 1) -> CompositionEntry:
    return CompositionEntry(designation=designation, name=name, developer=None, page=page)


# ---------------------------------------------------------------------------
# Разбор таблицы «Состав документации»
# ---------------------------------------------------------------------------

def test_parses_designation_name_developer():
    """СИНТЕТИКА: базовая строка ведомости — три столбца по одной строке."""
    entries = extract_composition_entries([tf(10, SYNTH_COMPOSITION_PAGE)])
    by_designation = {e.designation: e for e in entries}
    gp = by_designation["ТЕСТ/000000/9-РД-ГП"]
    assert gp.name == "Генеральный план"
    assert gp.developer == "ООО «Синтетика»"
    assert gp.page == 10
    print("OK: строка «обозначение → наименование → разработчик» разобрана целиком")


def test_name_wrapped_across_two_lines_is_joined():
    """СИНТЕТИКА: длинное наименование переносится на вторую строку —
    реальный случай («Архитектурные решения. План первого / этажа»)."""
    entries = extract_composition_entries([tf(10, SYNTH_COMPOSITION_PAGE)])
    ar = {e.designation: e for e in entries}["ТЕСТ/000000/9-РД-АР1"]
    assert ar.name == "Архитектурные решения. План первого этажа"
    print("OK: наименование, разорванное переносом строки, собрано в одно")


def test_row_without_developer_is_still_an_entry():
    """СИНТЕТИКА: у части строк столбец «Разработчик» пуст — строка от
    этого не перестаёт быть предусмотренным комплектом."""
    entries = extract_composition_entries([tf(10, SYNTH_COMPOSITION_PAGE)])
    uute = {e.designation: e for e in entries}["ТЕСТ/000000/9-РД-ИТП.УУТЭ"]
    assert uute.developer is None
    assert uute.name.startswith("Индивидуальный тепловой пункт")
    print("OK: пустой «Разработчик» не выбрасывает строку ведомости")


def test_own_designation_of_the_sheet_is_not_a_row():
    """Обозначение самого листа «Состав документации» стоит в его штампе и
    по форме неотличимо от строки таблицы — но комплектом не является."""
    entries = extract_composition_entries([tf(10, SYNTH_COMPOSITION_PAGE)])
    assert "ТЕСТ/000000/9-РД-СП" not in {e.designation for e in entries}
    print("OK: обозначение самого листа ведомости не попадает в её строки")


def test_continuation_page_is_parsed_by_sheet_designation():
    """Ведомость длиннее одной страницы; на второй странице заголовка уже
    нет — она опознаётся по шифру ведомости в штампе."""
    entries = extract_composition_entries(
        [tf(10, SYNTH_COMPOSITION_PAGE), tf(11, SYNTH_CONTINUATION_PAGE)])
    designations = {e.designation for e in entries}
    assert "ТЕСТ/000000/9-РД-ОВ1" in designations
    assert "ТЕСТ/000000/9-РД-ЭОМ" in designations
    print("OK: продолжение ведомости на следующей странице разобрано")


def test_page_without_composition_marker_is_not_parsed():
    """Обычная страница с шифром в штампе — не ведомость: разбор гейтится
    по заголовку/шифру ведомости, а не по «похоже на таблицу» (иначе в
    реестр комплектов попадёт содержание тома и колонтитулы)."""
    page = "ТЕСТ/000000/9-РД-ОВ1\nПлан первого этажа\nООО «Синтетика»\n"
    assert extract_composition_entries([tf(3, page)]) == []
    print("OK: страница без признака ведомости не разбирается как ведомость")


def test_third_party_designation_with_lowercase_and_space_is_parsed():
    """СИНТЕТИКА по мотивам реальной формы (Г.67, «Школа-600», ведомость
    РД — сама выдержка не приводится дословно, Г.12): одна позиция реальной
    ведомости шла под чужой схемой обозначений стороннего субподрядчика —
    не тройка «ОРГ/000000/1», а пять "/"-сегментов, с пробелом и строчными
    буквами внутри первого сегмента. До Г.67 это не проходило
    `_DESIGNATION_RE` вообще (только заглавные буквы/цифры, без пробела) —
    строка ведомости молча терялась."""
    page = SYNTH_COMPOSITION_PAGE + "Орг 11-1-1/РД/ГП/ДОУ/11/111-РД-СКТВ\nСистема коллективного приёма телевидения\nООО «Прочее»\n"
    entries = extract_composition_entries([tf(10, page)])
    by_designation = {e.designation: e for e in entries}
    assert "Орг 11-1-1/РД/ГП/ДОУ/11/111-РД-СКТВ" in by_designation
    assert by_designation["Орг 11-1-1/РД/ГП/ДОУ/11/111-РД-СКТВ"].name.startswith("Система коллективного")
    print("OK: обозначение стороннего субподрядчика (строчные буквы, пробел, 5 сегментов) разобрано")


def test_designation_cut_by_pdf_line_wrap_is_not_registered_truncated():
    """Г.67 (второй заход) — реальная регрессия, найденная проверкой на
    «Школа-600»: PDF переносит длинное обозначение субподрядчика посреди
    строки («...11/111-» / перенос / «РД-СКТВ»), а расширенный символьный
    класс сегмента (Г.67, п.3) принимал усечённый фрагмент «...11/111-»
    САМ ПО СЕБЕ за полное обозначение — строка регистрировалась с
    ОБРЕЗАННЫМ значением (без хвоста «РД-СКТВ»), то есть неверными
    данными вместо честного пропуска. Негативный лукбихайнд на «не
    заканчивается пробелом/точкой/дефисом» исправляет это: усечённый
    фрагмент больше не проходит как самостоятельное обозначение.

    Честная граница: это НЕ склеивает перенесённую строку обратно в одно
    целое обозначение (нужна отдельная работа со сшиванием PDF-переносов,
    больше реальных примеров) — просто не выдаёт заведомо неверные
    (обрезанные) данные вместо честного «не нашли»."""
    page = SYNTH_COMPOSITION_PAGE + "Орг 11-1-1/РД/ГП/ДОУ/11/111-\nРД-СКТВ\nСистема коллективного приёма телевидения\nООО «Прочее»\n"
    entries = extract_composition_entries([tf(10, page)])
    designations = {e.designation for e in entries}
    assert "Орг 11-1-1/РД/ГП/ДОУ/11/111-" not in designations
    assert not any(d.endswith("695-") for d in designations)
    print("OK: усечённый переносом строки фрагмент не регистрируется как обозначение")


def test_normative_code_is_not_a_composition_entry():
    """Г.17, второй абзац: коды норм (СП/ГОСТ/СНиП) — явно вне охвата
    этого модуля, поэтому строка вида «СП 60.13330.2020» не должна
    попадать в реестр комплектов, даже стоя на странице ведомости."""
    page = SYNTH_COMPOSITION_PAGE + "СП 60.13330.2020\nОтопление, вентиляция\n"
    designations = {e.designation for e in extract_composition_entries([tf(10, page)])}
    assert not [d for d in designations if d.startswith("СП ")]
    print("OK: нормативный код не заводится как предусмотренный комплект")


# ---------------------------------------------------------------------------
# Текстовые ссылки на другие комплекты
# ---------------------------------------------------------------------------

def test_reference_v_chasti():
    """ТЕКСТ (обезличен): «V0_00-05-04-02-07_Том 5.4.2 ОВ (1).pdf», стр.14 —
    дословно «Мероприятия по водоподготовке холодной воды см. в части ВК.»"""
    text = ("Мероприятия по водоподготовке холодной воды см. в части ВК. "
            "Для снижения обеззараживания воздуха")
    refs = find_document_references([tf(14, text)], doc="ПД ОВ")
    assert [r.mark for r in refs] == ["ВК"]
    assert refs[0].page == 14 and refs[0].doc == "ПД ОВ"
    print("OK: ссылка «см. в части ВК» распознана")


def test_reference_v_chasti_with_compound_mark():
    """ТЕКСТ (обезличен): тот же файл, стр.71 — дословно «...расположены в
    проектируемом ИТП и рассмотрены в части ИТП-УУТЭ данного проекта.»
    Это ровно тот вид ссылки, ради которого написано правило Г.17."""
    text = ("Приборы учета используемой тепловой энергии расположены в "
            "проектируемом ИТП и рассмотрены в части ИТП-УУТЭ данного проекта.")
    refs = find_document_references([tf(71, text)])
    assert [r.mark for r in refs] == ["ИТП-УУТЭ"]
    print("OK: составная марка «ИТП-УУТЭ» в ссылке распознана целиком")


def test_reference_see_part_on_drawing():
    """ТЕКСТ (обезличен): тот же файл, стр.94 (лист схемы) — дословный
    фрагмент «СтК1 см. часть ВК Сифон с разрывом струи»."""
    refs = find_document_references([tf(94, "СтК1 см. часть ВК Сифон с разрывом струи")])
    assert [r.mark for r in refs] == ["ВК"]
    print("OK: ссылка «см. часть ВК» на чертеже распознана")


def test_supplier_catalog_noise_is_not_a_reference():
    """ТЕКСТ (обезличен): «ОБЪ-000000-1-РД-ОВ1 ... -1-100.pdf» и том ПД —
    фраза «см. техническую подборку и КП» встречается в подборке
    поставщика десятками раз. «КП» — двухбуквенный токен, по форме
    неотличимый от марки комплекта: если триггером считать голое «см.»,
    он даёт вал ложных ссылок. Проверяем, что не даёт."""
    text = ("Приточная установка в комплекте с узлами регулирования, "
            "см. техническую подборку и КП")
    assert find_document_references([tf(105, text)]) == []
    print("OK: «см. техническую подборку и КП» не считается ссылкой на комплект")


def test_equipment_nameplate_rating_is_not_a_designation_reference():
    """Г.67 — реальный класс ложного срабатывания, замеченный на полном
    комплекте «Школа-600» в спецификациях оборудования (сама выдержка не
    приводится дословно, Г.12): паспортные данные вида «220V/1PH/50HZ» по
    форме (X/Y/Z, заглавные буквы и цифры) неотличимы от обозначения
    комплекта для старой регулярки. Реальные обозначения всегда начинаются
    с буквенного кода (АНО, ТЕСТ...), паспортные рейтинги — всегда с
    числа, поэтому это и есть отличающий признак."""
    text = "Насос дренажный, 220V/1PH/50HZ, IP68, подключение по месту."
    assert find_document_references([tf(103, text)]) == []
    print("OK: паспортный рейтинг оборудования не считается ссылкой на обозначение")


def test_reference_by_full_designation_in_prose():
    """СИНТЕТИКА: проза может ссылаться не маркой, а полным обозначением."""
    text = "Узел учета выполнен по ТЕСТ/000000/9-РД-ИТП.УУТЭ."
    refs = find_document_references([tf(7, text)])
    assert [r.mark for r in refs] == ["ТЕСТ/000000/9-РД-ИТП.УУТЭ"]
    assert refs[0].kind == "обозначение"
    print("OK: ссылка полным обозначением распознана")


def test_reference_by_volume_number():
    """Пример из формулировки самого правила Г.17: «см. том 5.4.2».
    На реальном титуле «ОБЪ/000000/1-П-ИОС5.4.2 Том 5.4.2» видно, что
    номер тома — это хвост обозначения, приклеенный к коду раздела."""
    refs = find_document_references([tf(2, "Подробнее см. том 5.4.2 данного проекта.")])
    assert [(r.mark, r.kind) for r in refs] == [("5.4.2", "том")]
    print("OK: ссылка «см. том 5.4.2» распознана как ссылка на том")


# ---------------------------------------------------------------------------
# Сопоставление обозначения ведомости с фактически переданным файлом
# ---------------------------------------------------------------------------

def test_supplied_matched_by_filename_with_other_separators():
    """СЛУЧАЙ (обезличен) (форма имён в образцовом комплекте): в ведомости
    обозначение через косые — «ОБЪ/000000/1-РД-ОВ1», а файл на диске
    называется «ОБЪ-000000-1-РД-ОВ1 изм. 4_в1 (1)-1-100.pdf». Это один и
    тот же комплект, различаются только разделители и хвост имени."""
    entries = [entry("ОБЪ/000000/1-РД-ОВ1")]
    supplied = [SuppliedDocument("ОБЪ-000000-1-РД-ОВ1 изм. 4_в1 (1)-1-100.pdf")]
    assert match_supplied(entries, supplied) == {
        "ОБЪ/000000/1-РД-ОВ1": ["ОБЪ-000000-1-РД-ОВ1 изм. 4_в1 (1)-1-100.pdf"]}
    print("OK: файл сопоставлен с обозначением несмотря на другие разделители")


def test_one_designation_supplied_several_files():
    """СЛУЧАЙ (обезличен): один комплект РД-ОВ1 передан двумя файлами
    («-1-100» и «-101-676») — оба должны числиться за одним обозначением,
    а не вытеснять друг друга."""
    entries = [entry("ОБЪ/000000/1-РД-ОВ1")]
    supplied = [
        SuppliedDocument("ОБЪ-000000-1-РД-ОВ1 изм. 4_в1 (1)-1-100.pdf"),
        SuppliedDocument("ОБЪ-000000-1-РД-ОВ1 изм. 4_в1 (1)-101-676.pdf"),
    ]
    assert len(match_supplied(entries, supplied)["ОБЪ/000000/1-РД-ОВ1"]) == 2
    print("OK: две части одного комплекта числятся за одним обозначением")


def test_shorter_designation_is_not_satisfied_by_longer_one():
    """СЛУЧАЙ (обезличен): в ведомости есть и «...-РД-КР» (Котлован), и
    «...-РД-КР.2» (Наружное ограждение). Файл КР.2 не закрывает КР —
    иначе один переданный подкомплект молча «закрывал» бы соседний."""
    entries = [entry("ОБЪ/000000/1-РД-КР"), entry("ОБЪ/000000/1-РД-КР.2")]
    supplied = [SuppliedDocument("ОБЪ-000000-1-РД-КР.2 изм. 1.pdf")]
    matched = match_supplied(entries, supplied)
    assert "ОБЪ/000000/1-РД-КР.2" in matched
    assert "ОБЪ/000000/1-РД-КР" not in matched
    print("OK: более длинное обозначение не засчитывается за более короткое")


def test_supplied_matched_by_stamp_shifr_tail():
    """Имя файла может ничего не говорить о шифре («V0_00-05-04-02-07_Том
    5.4.2 ОВ (1).pdf»), но stamp.read_stamp даёт хвост шифра со штампа
    («РД-ОВ1») — этого достаточно для сопоставления."""
    entries = [entry("ОБЪ/000000/1-РД-ОВ1")]
    supplied = [SuppliedDocument("скан_без_имени.pdf", shifrs=("РД-ОВ1",))]
    assert "ОБЪ/000000/1-РД-ОВ1" in match_supplied(entries, supplied)
    print("OK: сопоставление по хвосту шифра из штампа работает")


def test_unrelated_file_is_not_matched():
    entries = [entry("ОБЪ/000000/1-РД-ОВ1")]
    assert match_supplied(entries, [SuppliedDocument("Перечень нарушений.pdf")]) == {}
    print("OK: посторонний файл не приписывается обозначению из ведомости")


# ---------------------------------------------------------------------------
# Три категории комплектности (Г.9, уровнем выше — на документах)
# ---------------------------------------------------------------------------

def test_referenced_listed_and_not_supplied_is_a_finding():
    """Ядро правила Г.17: на комплект ссылается проза, комплект есть в
    ведомости, файла среди переданных нет → «предусмотренный документ не
    передан»."""
    entries = [entry("ТЕСТ/000000/9-РД-ИТП.УУТЭ", "Узел учета тепловой энергии")]
    refs = find_document_references([tf(71, "Рассмотрены в части ИТП-УУТЭ данного проекта.")])
    result = check_completeness(entries, refs, [SuppliedDocument("ТЕСТ-000000-9-РД-ОВ1.pdf")])
    assert len(result.findings) == 1
    finding = result.findings[0]
    assert finding.designation == "ТЕСТ/000000/9-РД-ИТП.УУТЭ"
    assert finding.finding_type == "not_supplied"
    assert "не передан" in finding.detail
    assert finding.reference.page == 71
    print("OK: упомянутый и предусмотренный, но не переданный комплект — находка")


def test_referenced_listed_and_supplied_is_not_a_finding():
    entries = [entry("ТЕСТ/000000/9-РД-ВК", "Внутренние сети водоотведения")]
    refs = find_document_references([tf(14, "Мероприятия по водоподготовке см. в части ВК.")])
    result = check_completeness(entries, refs, [SuppliedDocument("ТЕСТ-000000-9-РД-ВК.pdf")])
    assert result.findings == []
    assert result.referenced_and_supplied == ["ТЕСТ/000000/9-РД-ВК"]
    print("OK: упомянутый комплект, который передан, находкой не считается")


def test_reference_outside_the_table_is_not_a_finding():
    """Третья категория: ссылка есть, но такого обозначения в ведомости
    нет — судить не о чем (правило Г.17 требует именно совпадения с
    ведомостью). Не молча выбрасывается, а видимо перечисляется (Г.10)."""
    entries = [entry("ТЕСТ/000000/9-РД-ВК", "Внутренние сети водоотведения")]
    refs = find_document_references([tf(20, "Оборудование см. в части ТХ.")])
    result = check_completeness(entries, refs, [])
    assert result.findings == []
    assert [r.mark for r in result.referenced_not_listed] == ["ТХ"]
    print("OK: ссылка вне ведомости — видимое «судить не о чем», не находка")


def test_listed_but_never_referenced_is_not_a_finding():
    """Ведомость перечисляет ВЕСЬ проект, а на сравнение всегда передают
    его срез (здесь — только ОВ). Непереданный комплект, на который никто
    не ссылался, — не находка, а информационный остаток: иначе каждый
    прогон по одному разделу давал бы полсотни «нарушений»."""
    entries = [entry("ТЕСТ/000000/9-РД-ГП", "Генеральный план"),
               entry("ТЕСТ/000000/9-РД-ОВ1", "Общеобменная вентиляция")]
    result = check_completeness(entries, [], [SuppliedDocument("ТЕСТ-000000-9-РД-ОВ1.pdf")])
    assert result.findings == []
    assert result.listed_not_referenced_not_supplied == ["ТЕСТ/000000/9-РД-ГП"]
    print("OK: непереданный, но и не упомянутый комплект не выдаётся за нарушение")


def test_repeated_references_give_one_finding():
    """Одна и та же марка встречается в прозе много раз (на реальном
    комплекте «см. часть ВК» стоит на каждом листе схемы) — находка по
    комплекту должна быть одна, с числом упоминаний."""
    entries = [entry("ТЕСТ/000000/9-РД-ВК", "Внутренние сети водоотведения")]
    refs = find_document_references([tf(94, "СтК1 см. часть ВК Сифон"),
                                     tf(95, "СтК1 см. часть ВК Сифон"),
                                     tf(96, "СтК1 см. часть ВК Сифон")])
    assert len(refs) == 3
    result = check_completeness(entries, refs, [])
    assert len(result.findings) == 1
    assert result.findings[0].reference_count == 3
    print("OK: повторные упоминания дают одну находку с числом упоминаний")


def test_render_report_contains_all_three_categories():
    entries = [entry("ТЕСТ/000000/9-РД-ВК", "Внутренние сети водоотведения"),
               entry("ТЕСТ/000000/9-РД-ИТП.УУТЭ", "Узел учета"),
               entry("ТЕСТ/000000/9-РД-ГП", "Генеральный план")]
    refs = find_document_references([
        tf(14, "Мероприятия по водоподготовке см. в части ВК."),
        tf(71, "Рассмотрены в части ИТП-УУТЭ данного проекта."),
        tf(20, "Оборудование см. в части ТХ."),
    ])
    result = check_completeness(entries, refs, [SuppliedDocument("ТЕСТ-000000-9-РД-ВК.pdf")])
    report = render_completeness_report(result)
    assert "Комплектность" in report
    assert "не передан" in report
    assert "ИТП.УУТЭ" in report
    assert "ТХ" in report          # ссылка вне ведомости — видимо в отчёте
    assert "ГП" in report          # информационный остаток — тоже видим
    print("OK: отчёт показывает все три категории, ничего не теряя молча")


# ---------------------------------------------------------------------------
# ТЕКСТ (обезличен): дословная выдержка из образцового комплекта
# ---------------------------------------------------------------------------

# Дословно `page.get_text("text")`, файл
# «ОБЪ-000000-1-РД-ОВ1 изм. 4_в1 (1)-1-100.pdf», стр.10 — сокращено по числу
# строк таблицы (после «...-РД-АР1» в оригинале идут ещё ~40 строк до конца
# стр.12), сами строки не переписаны.
REAL_COMPOSITION_PAGE_10 = """

ОБЪ/000000/1-РД-СП


Изм.
Кол.
Лист
№До
к
Подпись
Дата
ГИП
Иванов

01.23
Состав рабочей документации
Стадия
Лист
Листов
Разработал
Петрова

01.23
Р
1


ООО «Проектировщик»
Н.контроль
Иванов

01.23


ВЕДОМОСТЬ ОСНОВНЫХ КОМПЛЕКТОВ РАБОЧИХ ЧЕРТЕЖЕЙ
Обозначение
Наименование
Разработчик
ОБЪ/000000/1-РД-ГП
Генеральный план
ООО «Проектировщик»
ОБЪ/000000/1-РД-АР0
Архитектурные решения. План подвала
ООО «Проектировщик»
ОБЪ/000000/1-РД-АР1
Архитектурные решения. План первого
этажа
ООО «Проектировщик»
"""

# Дословно, тот же файл, стр.11 (продолжение ведомости, заголовка уже нет —
# только шифр ведомости в штампе). Сокращено по числу строк.
REAL_COMPOSITION_PAGE_11 = """

ОБЪ/000000/1-РД-СП
Лис
т

2
Изм.
Кол.
Лист
№До
к
Подпись
Дата

ОБЪ/000000/1-РД-ОВ1
Система общеобменной вентиляции и
кондиционирования воздуха. Пожарное
дымоудаление
ООО «Проектировщик»
ОБЪ/000000/1-РД-ОВ2.1
Отопление и теплоснабжение
ООО «Проектировщик»
ОБЪ/000000/1-РД-ИТП.УУТЭ
Индивидуальный тепловой пункт. Узел
учета тепловой энергии
ООО «Проектировщик»
"""


def test_real_composition_page_is_parsed():
    """ТЕКСТ (обезличен): ведомость из образцового комплекта разбирается,
    штамп ведомости в строки не попадает."""
    entries = extract_composition_entries(
        [tf(10, REAL_COMPOSITION_PAGE_10), tf(11, REAL_COMPOSITION_PAGE_11)])
    by_designation = {e.designation: e for e in entries}
    assert "ОБЪ/000000/1-РД-СП" not in by_designation
    assert by_designation["ОБЪ/000000/1-РД-ГП"].name == "Генеральный план"
    assert by_designation["ОБЪ/000000/1-РД-ГП"].developer == "ООО «Проектировщик»"
    assert (by_designation["ОБЪ/000000/1-РД-АР1"].name
            == "Архитектурные решения. План первого этажа")
    assert (by_designation["ОБЪ/000000/1-РД-ИТП.УУТЭ"].name
            == "Индивидуальный тепловой пункт. Узел учета тепловой энергии")
    print(f"OK: реальная ведомость разобрана, строк: {len(entries)}")


def test_real_end_to_end_uute_is_referenced_listed_and_not_supplied():
    """СКВОЗНОЙ СЛУЧАЙ (обезличен) комплекта образцовом комплекте:
      * проза ПД (стр.71): «...рассмотрены в части ИТП-УУТЭ данного проекта»;
      * ведомость РД (стр.11): «ОБЪ/000000/1-РД-ИТП.УУТЭ ... Узел учета»;
      * среди переданных четырёх файлов комплекта тома ИТП.УУТЭ нет.
    Ровно та находка, которую описывает Г.17."""
    entries = extract_composition_entries([tf(10, REAL_COMPOSITION_PAGE_10),
                                           tf(11, REAL_COMPOSITION_PAGE_11)])
    refs = find_document_references(
        [tf(71, "Приборы учета используемой тепловой энергии расположены в "
                "проектируемом ИТП и рассмотрены в части ИТП-УУТЭ данного проекта.")],
        doc="V0_00-05-04-02-07_Том 5.4.2 ОВ (1).pdf")
    supplied = [
        SuppliedDocument("ОБЪ-000000-1-РД-ОВ1 изм. 4_в1 (1)-1-100.pdf"),
        SuppliedDocument("ОБЪ-000000-1-РД-ОВ1 изм. 4_в1 (1)-101-676.pdf"),
        SuppliedDocument("ОБЪ-000000-1-РД-ОВ2.1_изм. 3_в1.pdf"),
        SuppliedDocument("V0_00-05-04-02-07_Том 5.4.2 ОВ (1).pdf"),
    ]
    result = check_completeness(entries, refs, supplied)
    assert [f.designation for f in result.findings] == ["ОБЪ/000000/1-РД-ИТП.УУТЭ"]
    # переданные комплекты ОВ1/ОВ2.1 из той же ведомости находкой не стали
    assert "ОБЪ/000000/1-РД-ОВ1" in result.supplied
    assert "ОБЪ/000000/1-РД-ОВ2.1" in result.supplied
    print("OK: сквозной реальный случай ИТП.УУТЭ даёт ровно одну находку")


if __name__ == "__main__":
    test_parses_designation_name_developer()
    test_name_wrapped_across_two_lines_is_joined()
    test_row_without_developer_is_still_an_entry()
    test_own_designation_of_the_sheet_is_not_a_row()
    test_continuation_page_is_parsed_by_sheet_designation()
    test_page_without_composition_marker_is_not_parsed()
    test_third_party_designation_with_lowercase_and_space_is_parsed()
    test_designation_cut_by_pdf_line_wrap_is_not_registered_truncated()
    test_normative_code_is_not_a_composition_entry()
    test_equipment_nameplate_rating_is_not_a_designation_reference()
    test_reference_v_chasti()
    test_reference_v_chasti_with_compound_mark()
    test_reference_see_part_on_drawing()
    test_supplier_catalog_noise_is_not_a_reference()
    test_reference_by_full_designation_in_prose()
    test_reference_by_volume_number()
    test_supplied_matched_by_filename_with_other_separators()
    test_one_designation_supplied_several_files()
    test_shorter_designation_is_not_satisfied_by_longer_one()
    test_supplied_matched_by_stamp_shifr_tail()
    test_unrelated_file_is_not_matched()
    test_referenced_listed_and_not_supplied_is_a_finding()
    test_referenced_listed_and_supplied_is_not_a_finding()
    test_reference_outside_the_table_is_not_a_finding()
    test_listed_but_never_referenced_is_not_a_finding()
    test_repeated_references_give_one_finding()
    test_render_report_contains_all_three_categories()
    test_real_composition_page_is_parsed()
    test_real_end_to_end_uute_is_referenced_listed_and_not_supplied()
    print("ALL PASS")
