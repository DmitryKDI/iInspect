"""Координаты доказательств в долях листа [0;1] и их сравнение (ТЗ 14.3).

Координаты нормируются по видимому листу: с учётом CropBox (PyMuPDF отдаёт
координаты относительно него) и поворота /Rotate. Поиск текста в PyMuPDF
возвращает прямоугольник в неповёрнутой системе страницы, а размер страницы
`page.rect` — в повёрнутой; без приведения рамка на повёрнутом чертеже
оказывалась бы в другом месте листа. Эталонная разметка задаёт bbox «после
учёта CropBox/MediaBox/Rotate», поэтому и сравнение по IoU корректно только
в этой системе.
"""
from __future__ import annotations

from collections.abc import Sequence

import pymupdf


def normalized_bbox(page: pymupdf.Page, rect: pymupdf.Rect) -> list[float]:
    """Прямоугольник, найденный на странице, в долях видимого листа."""
    shown = pymupdf.Rect(rect) * page.rotation_matrix
    shown.normalize()
    width, height = page.rect.width, page.rect.height
    values = [shown.x0 / width, shown.y0 / height, shown.x1 / width, shown.y1 / height]
    return [min(1.0, max(0.0, round(value, 6))) for value in values]


def iou(first: Sequence[float] | None, second: Sequence[float] | None) -> float:
    """Пересечение над объединением двух прямоугольников [x0, y0, x1, y1]."""
    if not first or not second or len(first) != 4 or len(second) != 4:
        return 0.0
    x0, y0 = max(first[0], second[0]), max(first[1], second[1])
    x1, y1 = min(first[2], second[2]), min(first[3], second[3])
    inter = max(0.0, x1 - x0) * max(0.0, y1 - y0)
    area = ((first[2] - first[0]) * (first[3] - first[1])
            + (second[2] - second[0]) * (second[3] - second[1]) - inter)
    return inter / area if area > 0 else 0.0
