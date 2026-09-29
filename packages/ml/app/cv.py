"""CV-анализ чертежей PDF (ТЗ 9.1, п.3): масштаб по размерной линии,
распознавание линий, измерение расстояний.

Векторный лист (экспорт из САПР) читается напрямую: отрезки — из графики
PDF, размерные числа — из текстового слоя с координатами. Размерная линия —
отрезок, у середины которого стоит число и который параллелен направлению
надписи. Отношение числа к длине отрезка на листе даёт масштаб; согласие
нескольких размерных линий — уверенность в нём. Получив масштаб, лист
измеряется: любой отрезок переводится в миллиметры натуры.

Отсюда же проверяемый факт: размерная надпись, которая не совпадает с
длиной своей линии в масштабе листа, — надпись, исправленная без
перечерчивания. Это не нарушение, а сигнал для инспектора.

Растровый лист (скан) обрабатывается OpenCV: границы Кэнни и вероятностное
преобразование Хафа дают отрезки; масштаб без текстового слоя с
координатами не определяется — это видимое состояние, а не ноль.

Знание о разделе здесь не используется: механика одна для любого чертежа.
"""

from __future__ import annotations

import math
import re
import statistics
from dataclasses import asdict, dataclass, field

import pymupdf

# Размер в миллиметрах: целое от 2 до 6 цифр (ГОСТ 21.101 — размеры на
# чертежах в мм без единицы). ПРАВИЛО ФОРМАТА.
_DIMENSION_RE = re.compile(r"^\d{2,6}$")
# Отрезок короче этого (пункты PDF) — штриховка, засечка или символ, а не
# размерная линия и не конструкция. ГЕОМЕТРИЯ/ФОРМАТ: 1 пт ≈ 0,35 мм листа.
MIN_SEGMENT_PT = 6.0
# Насколько далеко от середины отрезка может стоять его число, в высотах
# строки: надпись над размерной линией по ГОСТ 2.307. ГЕОМЕТРИЯ/ФОРМАТ.
LABEL_DISTANCE_LINES = 2.5
# Допуск параллельности надписи и отрезка, градусы. ГЕОМЕТРИЯ/ФОРМАТ.
ANGLE_TOLERANCE_DEG = 5.0
# Масштабы, согласные с медианой в пределах этой доли, считаются одним
# масштабом листа. ПРАВИЛО ЯЗЫКА измерений: точность простановки размеров.
SCALE_AGREEMENT = 0.05
# Расхождение надписи и графики больше этой доли — сигнал инспектору.
DIMENSION_MISMATCH = 0.05
# Сколько отрезков хранить в результате: для измерений нужны длинные,
# короткие — штриховка. БЮДЖЕТ объёма ответа.
MAX_REPORTED_SEGMENTS = 40
# Разрешение растра для OpenCV, точек на дюйм. БЮДЖЕТ времени (ТЗ 11, п.8).
RASTER_DPI = 100


@dataclass
class Segment:
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def length(self) -> float:
        return math.hypot(self.x1 - self.x0, self.y1 - self.y0)

    @property
    def angle(self) -> float:
        return math.degrees(math.atan2(self.y1 - self.y0, self.x1 - self.x0)) % 180

    @property
    def middle(self) -> tuple[float, float]:
        return (self.x0 + self.x1) / 2, (self.y0 + self.y1) / 2


@dataclass
class PageMeasurement:
    method: str  # vector | raster | none
    segments: int = 0
    scale_mm_per_pt: float | None = None
    scale_support: int = 0
    dimensions: list[dict] = field(default_factory=list)
    mismatches: list[dict] = field(default_factory=list)
    longest: list[dict] = field(default_factory=list)
    note: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def vector_segments(page: pymupdf.Page) -> list[Segment]:
    """Отрезки графики листа в координатах видимой области (с учётом поворота)."""
    matrix = page.rotation_matrix
    found: list[Segment] = []
    for drawing in page.get_drawings():
        for item in drawing.get("items", []):
            if item[0] == "l":
                start, end = item[1] * matrix, item[2] * matrix
                segment = Segment(start.x, start.y, end.x, end.y)
                if segment.length >= MIN_SEGMENT_PT:
                    found.append(segment)
            elif item[0] == "re":
                rect = item[1] * matrix
                for a, b in (
                    (rect.tl, rect.tr),
                    (rect.tr, rect.br),
                    (rect.br, rect.bl),
                    (rect.bl, rect.tl),
                ):
                    segment = Segment(a.x, a.y, b.x, b.y)
                    if segment.length >= MIN_SEGMENT_PT:
                        found.append(segment)
    return found


def _labels(page: pymupdf.Page) -> list[tuple[float, pymupdf.Rect, str, float]]:
    """Числа-размеры с рамкой и направлением строки."""
    matrix = page.rotation_matrix
    labels = []
    for block in page.get_text("rawdict").get("blocks", []):
        for line in block.get("lines", []):
            direction = line.get("dir", (1, 0))
            angle = math.degrees(math.atan2(direction[1], direction[0])) % 180
            text = "".join(
                char["c"] for span in line.get("spans", []) for char in span.get("chars", [])
            )
            token = text.strip().replace(" ", "")
            if _DIMENSION_RE.match(token):
                rect = pymupdf.Rect(line["bbox"]) * matrix
                labels.append((float(token), rect, token, angle))
    return labels


def _angle_close(a: float, b: float) -> bool:
    delta = abs(a - b) % 180
    return min(delta, 180 - delta) <= ANGLE_TOLERANCE_DEG


def dimension_pairs(segments: list[Segment], labels) -> list[dict]:
    """Размерная линия каждого числа: ближайший параллельный отрезок у середины."""
    pairs = []
    for value, rect, token, angle in labels:
        height = max(min(rect.width, rect.height), 1.0)
        center = ((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2)
        best, best_distance = None, None
        for segment in segments:
            if not _angle_close(segment.angle, angle):
                continue
            if segment.length < max(rect.width, rect.height):
                continue
            mx, my = segment.middle
            distance = math.hypot(mx - center[0], my - center[1])
            if distance <= LABEL_DISTANCE_LINES * height and (
                best_distance is None or distance < best_distance
            ):
                best, best_distance = segment, distance
        if best is not None:
            pairs.append(
                {
                    "value_mm": value,
                    "label": token,
                    "length_pt": round(best.length, 2),
                    "bbox": [
                        round(rect.x0, 1),
                        round(rect.y0, 1),
                        round(rect.x1, 1),
                        round(rect.y1, 1),
                    ],
                }
            )
    return pairs


def page_scale(pairs: list[dict]) -> tuple[float | None, int]:
    """Масштаб листа (мм натуры на пункт листа) и число согласных размерных линий."""
    ratios = [pair["value_mm"] / pair["length_pt"] for pair in pairs if pair["length_pt"] > 0]
    if not ratios:
        return None, 0
    median = statistics.median(ratios)
    agreeing = [ratio for ratio in ratios if abs(ratio - median) <= SCALE_AGREEMENT * median]
    # Масштаб по одной линии — наблюдение, а не масштаб листа: нужна вторая,
    # иначе одна ошибочная надпись задала бы размеры всему чертежу.
    if len(agreeing) < 2:
        return None, len(agreeing)
    return statistics.median(agreeing), len(agreeing)


def measure_vector(page: pymupdf.Page) -> PageMeasurement:
    segments = vector_segments(page)
    pairs = dimension_pairs(segments, _labels(page))
    scale, support = page_scale(pairs)
    result = PageMeasurement(
        method="vector",
        segments=len(segments),
        scale_mm_per_pt=scale,
        scale_support=support,
        dimensions=pairs,
    )
    if scale is None:
        result.note = (
            "масштаб не определён: меньше двух согласных размерных линий"
            if segments
            else "на листе нет векторной графики"
        )
        return result
    for pair in pairs:
        measured = pair["length_pt"] * scale
        if abs(measured - pair["value_mm"]) > DIMENSION_MISMATCH * pair["value_mm"]:
            result.mismatches.append({**pair, "measured_mm": round(measured)})
    for segment in sorted(segments, key=lambda item: item.length, reverse=True)[
        :MAX_REPORTED_SEGMENTS
    ]:
        result.longest.append(
            {
                "length_mm": round(segment.length * scale),
                "from": [round(segment.x0, 1), round(segment.y0, 1)],
                "to": [round(segment.x1, 1), round(segment.y1, 1)],
            }
        )
    return result


def measure_raster(page: pymupdf.Page) -> PageMeasurement:
    """Отрезки скана через OpenCV; масштаб без текстового слоя не определяется."""
    try:
        import cv2
        import numpy as np
    except ImportError:
        return PageMeasurement(
            method="none", note="OpenCV не установлен: растровый лист не измерялся"
        )
    pixmap = page.get_pixmap(dpi=RASTER_DPI, colorspace=pymupdf.csGRAY)
    image = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(pixmap.height, pixmap.width)
    edges = cv2.Canny(image, 50, 150, apertureSize=3)
    min_length = MIN_SEGMENT_PT * RASTER_DPI / 72
    lines = cv2.HoughLinesP(
        edges,
        1,
        math.pi / 180,
        threshold=80,
        minLineLength=min_length * 4,
        maxLineGap=min_length / 2,
    )
    count = 0 if lines is None else len(lines)
    return PageMeasurement(
        method="raster",
        segments=count,
        note="масштаб не определён: у скана нет текстового слоя с координатами размеров",
    )


def measure_page(page: pymupdf.Page) -> PageMeasurement:
    if page.get_drawings():
        return measure_vector(page)
    if page.get_images():
        return measure_raster(page)
    return PageMeasurement(method="none", note="на листе нет графики")


def summary_line(measurement: PageMeasurement) -> str:
    """Строка для текста листа: модель видит измерения рядом с цитатами."""
    if measurement.scale_mm_per_pt is None:
        return f"[CV] линий: {measurement.segments}; {measurement.note}"
    parts = [
        f"[CV] масштаб листа: {measurement.scale_mm_per_pt:.3f} мм натуры на пункт "
        f"(по {measurement.scale_support} размерным линиям); линий: {measurement.segments}"
    ]
    for item in measurement.mismatches[:10]:
        parts.append(
            f"размер «{item['label']}» не совпадает с графикой: по чертежу {item['measured_mm']} мм"
        )
    return "; ".join(parts)
