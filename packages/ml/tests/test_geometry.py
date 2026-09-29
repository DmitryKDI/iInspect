"""Координаты доказательств в долях видимого листа и IoU (ТЗ 14.3)."""
import pymupdf
from app.geometry import iou, normalized_bbox


def _page(rotation: int = 0, crop: pymupdf.Rect | None = None) -> pymupdf.Page:
    doc = pymupdf.open()
    page = doc.new_page(width=600, height=400)
    page.insert_text((50, 100), "HELLO")
    if crop is not None:
        page.set_cropbox(crop)
    page.set_rotation(rotation)
    return page


def test_rotated_page_box_lands_where_the_text_is_shown():
    plain = _page()
    straight = normalized_bbox(plain, plain.search_for("HELLO")[0])
    rotated = _page(90)
    turned = normalized_bbox(rotated, rotated.search_for("HELLO")[0])
    # Поворот на 90° по часовой: левый верхний угол текста уходит к правому краю.
    assert turned[0] > 0.5 and straight[0] < 0.5
    rendered = rotated.get_pixmap(dpi=36)
    x = int((turned[0] + turned[2]) / 2 * rendered.width)
    y = int((turned[1] + turned[3]) / 2 * rendered.height)
    patch = [rendered.pixel(min(rendered.width - 1, x + dx), min(rendered.height - 1, y + dy))
             for dx in range(-3, 4) for dy in range(-3, 4)]
    assert any(sum(pixel) < 600 for pixel in patch), "в рамке нет текста на отрисованном листе"
    print("OK: на повёрнутом листе рамка стоит там, где текст виден")


def test_cropbox_is_the_reference_frame():
    page = _page(crop=pymupdf.Rect(20, 20, 500, 300))
    box = normalized_bbox(page, page.search_for("HELLO")[0])
    assert 0 < box[0] < box[2] <= 1 and 0 < box[1] < box[3] <= 1
    assert abs(box[0] - 30 / 480) < 0.01
    print("OK: доли считаются от видимой области (CropBox)")


def test_iou():
    assert iou([0, 0, 1, 1], [0, 0, 1, 1]) == 1
    assert iou([0, 0, 0.5, 0.5], [0.5, 0.5, 1, 1]) == 0
    assert abs(iou([0, 0, 0.5, 1], [0.25, 0, 0.75, 1]) - 1 / 3) < 1e-9
    assert iou(None, [0, 0, 1, 1]) == 0
    print("OK: IoU считается по долям листа")
