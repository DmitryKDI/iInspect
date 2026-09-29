import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.material import non_project_reason


def test_supplier_catalog_page_is_excluded():
    """Реальный случай: 427 из 576 текстовых страниц тома РД — единая
    подборка коммерческих предложений поставщика на 419 страниц. Её числа
    (масса, потери давления, цена) засоряют реестр помещений."""
    reason = non_project_reason("Потери давления, Па\nСтраница 5 из 419\nМасса, кг 1270")
    assert reason and "419" in reason, reason
    print("OK: страница каталога поставщика опознана как непроектный материал")


def test_commercial_offer_is_excluded():
    reason = non_project_reason('ООО "КОРФ"\nПредложение № KR22-064369/3\nГарантийный срок')
    assert reason, "коммерческое предложение должно отсеиваться"
    print("OK: коммерческое предложение опознано")


def test_normal_project_document_is_kept():
    """Нумерация «Страница 2 из 5» — обычный проектный документ, не каталог:
    порог знаменателя existence именно для этого."""
    assert non_project_reason("Общие данные\nСтраница 2 из 5") is None
    assert non_project_reason("АКТ ОСВИДЕТЕЛЬСТВОВАНИЯ СКРЫТЫХ РАБОТ № 51") is None
    assert non_project_reason("Экспликация помещений 1 этажа\n101 Тамбур 8.6") is None
    print("OK: проектные документы не отсеиваются")


def test_price_table_page_without_footer_is_excluded():
    """Реальный сбой прогона Г.28: внутренняя страница того же каталога без
    колонтитула «Страница N из M» и без маркерных фраз — только построчные
    цены и подытог «Итого по …» — проходила мимо обоих прежних фильтров и
    выдавалась за обычный чертёж (топ-пара по скору в 13-м прогоне —
    случайно оказалась именно такой страницей)."""
    text = (
        "17\nВнутренний блок настенный KF-IW-28\nШТ\n2,00\n63 056,10\n126 112,20\n"
        "18\nНаружный блок KF-OH-500B\nШТ\n2,00\n1 543 181,40\n3 086 362,80\n"
        "19\nРефнет KF-REF-01\nШТ\n8,00\n7 272,60\n58 180,80\n"
        "Итого по Оборудование\n5 098 706,70\nИтого по К2\n5 098 706,70"
    )
    reason = non_project_reason(text)
    assert reason and "смет" in reason, reason
    print("OK: страница сметы без колонтитула отсеяна по количеству цен и подытогу")


def test_equipment_register_without_prices_is_kept():
    """Ведомость оборудования (Г.20) — количество, не цена — не должна
    отсеиваться этим же правилом просто из-за подытоговой строки."""
    text = "14\nВентилятор канальный ВК-100\n2 шт.\n15\nКлапан обратный КО-100\n1 шт.\nИтого по разделу: 3 позиции"
    assert non_project_reason(text) is None
    print("OK: ведомость оборудования без цен не задета новым правилом")


if __name__ == "__main__":
    test_supplier_catalog_page_is_excluded()
    test_commercial_offer_is_excluded()
    test_normal_project_document_is_kept()
    test_price_table_page_without_footer_is_excluded()
    test_equipment_register_without_prices_is_kept()
    print("ALL PASS")
