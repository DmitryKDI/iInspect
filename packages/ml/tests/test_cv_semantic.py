"""CV-анализ чертежей (ТЗ 9.1, п.3) и семантические якоря (ТЗ 9.1, п.2).

Чертёж строится в памяти: отрезки и размерные числа над ними. Масштаб —
по согласию двух размерных линий; надпись, не совпадающая с длиной своей
линии в этом масштабе, — сигнал. Семантическая близость меняет порядок
страниц, но не отсеивает их; без модели — видимое состояние, а не ноль.
"""
import numpy as np
import pymupdf
from app import cv, official_pipeline, semantic

FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def _drawing(labels: list[tuple[float, float, float, str]]) -> pymupdf.Page:
    document = pymupdf.open()
    page = document.new_page(width=842, height=595)
    page.insert_font(fontname="dejavu", fontfile=FONT)
    for x, y, length, label in labels:
        page.draw_line((x, y), (x + length, y), width=0.5)
        page.insert_text((x + length / 2 - 12, y - 3), label, fontname="dejavu", fontsize=8)
    return page


def test_scale_from_two_dimension_lines_and_mismatch_signal():
    # 100 пт = 3000 мм и 200 пт = 6000 мм → 30 мм на пункт; третья надпись врёт.
    page = _drawing([(50, 100, 100, "3000"), (50, 200, 200, "6000"), (50, 300, 100, "4500")])
    measured = cv.measure_page(page)
    assert measured.method == "vector"
    assert abs(measured.scale_mm_per_pt - 30) < 0.5 and measured.scale_support == 2
    assert [item["label"] for item in measured.mismatches] == ["4500"]
    assert "не совпадает с графикой" in cv.summary_line(measured)


def test_single_dimension_line_is_an_observation_not_a_scale():
    measured = cv.measure_page(_drawing([(50, 100, 100, "3000")]))
    assert measured.scale_mm_per_pt is None
    assert "масштаб не определён" in measured.note


class FakeEncoder:
    name = "fake"

    def encode(self, texts):
        # Вектор «смысла»: есть ли корень «кров» — достаточно для порядка.
        return np.array([[1.0, 0.0] if "кров" in text.casefold() else [0.0, 1.0]
                         for text in texts], dtype=np.float32)


def test_semantic_closeness_reorders_pages_without_dropping_any():
    facts = {1: [{"page": 1, "text": "Общие данные"}, {"page": 2, "text": "Кровельное покрытие"}]}
    parameter = [{"name": "Кровля: утеплитель", "section": "АР"}]
    semantic.use(FakeEncoder())
    ranked = official_pipeline._relevant_facts(parameter, facts, {1: "d" * 64})
    assert [fact["page"] for fact in ranked[1]] == [2, 1]
    semantic.use(None, "нет модели")
    fallback = official_pipeline._relevant_facts(parameter, facts, {1: "d" * 64})
    assert sorted(fact["page"] for fact in fallback[1]) == [1, 2]
    assert semantic.status().available is False and semantic.status().reason == "нет модели"
