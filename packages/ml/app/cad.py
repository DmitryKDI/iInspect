"""Чертежи DWG/DXF (ТЗ 11, п.8): отрисовка в PDF и точные измерения.

Сервер при приёме приводит DWG и DXF к одному формату — DXF AC1032 в UTF-8.
Здесь он читается ezdxf (MIT) и отрисовывается в PDF собственным простым
рендером: геометрия — векторными линиями, тексты и размерные числа —
настоящим текстовым слоем. Поэтому весь остальной конвейер работает с
чертежом так же, как с PDF: цитаты находятся на листе, координаты
доказательств нормализуются к [0;1], CV-анализ (`cv.py`) находит размерные
линии и масштаб.

Из самого DXF берутся и точные измерения: у каждого размера САПР хранит
фактическую длину, и надпись, не совпадающая с ней, — сигнал для
инспектора (надпись исправлена без перечерчивания).
"""

from __future__ import annotations

import io
import math
import re
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf

# Лист отрисовки — формат А1 альбомный (ГОСТ 2.301), пунктов. ГЕОМЕТРИЯ/ФОРМАТ.
PAGE_WIDTH_PT = 2384.0
PAGE_HEIGHT_PT = 1684.0
MARGIN_PT = 36.0
# Точность аппроксимации дуг и сплайнов, доля размера чертежа. ГЕОМЕТРИЯ.
FLATTEN_SHARE = 0.0005
# Расхождение надписи размера и фактической длины — сигнал (как в cv.py).
DIMENSION_MISMATCH = 0.05
# Предел объектов на лист: сверх него — видимое состояние «обрезано».
# БЮДЖЕТ времени отрисовки (ТЗ 11, п.8: чертёж за 30 секунд).
MAX_ENTITIES = 200_000
_NUMBER = re.compile(r"-?\d+(?:[.,]\d+)?")
_FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
)


@dataclass
class CadFacts:
    entities: int = 0
    drawn: int = 0
    texts: int = 0
    dimensions: list[dict] = field(default_factory=list)
    mismatches: list[dict] = field(default_factory=list)
    truncated: bool = False
    units: str = ""
    # Объекты, геометрию которых построить нельзя (вырожденная система
    # координат, битый блок). Не роняют лист, но и не пропадают молча.
    skipped: int = 0


def _font() -> str | None:
    return next((path for path in _FONT_CANDIDATES if Path(path).is_file()), None)


def _plain(entity) -> str:
    kind = entity.dxftype()
    if kind == "MTEXT":
        return entity.plain_text().strip()
    if kind in {"TEXT", "ATTRIB", "ATTDEF"}:
        return str(entity.dxf.text or "").strip()
    return ""


def _flatten(entities, stop: int, facts: CadFacts):
    """Все объекты пространства модели, с раскрытием блоков и размеров."""
    count = 0
    stack = list(entities)
    while stack:
        entity = stack.pop()
        kind = entity.dxftype()
        if kind in {"INSERT", "DIMENSION", "LEADER", "MLEADER"}:
            if kind == "DIMENSION":
                yield entity  # сам размер нужен для точной длины
            try:
                parts = list(entity.virtual_entities())
                if not parts and kind == "DIMENSION":
                    # Размер без блока геометрии (так пишут часть САПР):
                    # геометрия строится по определяющим точкам и стилю.
                    entity.override().render()
                    parts = list(entity.virtual_entities())
                stack.extend(parts)
            except Exception:  # noqa: BLE001, S112 — нераскрываемый блок пропускается, а не роняет лист
                if kind != "DIMENSION":  # у размера длина уже взята из самого объекта
                    facts.skipped += 1
                continue
            continue
        count += 1
        if count > stop:
            return
        yield entity


def render(dxf: bytes) -> tuple[bytes, CadFacts]:
    """DXF → PDF с текстовым слоем и факты размеров."""
    import ezdxf
    from ezdxf import bbox
    from ezdxf import path as ezpath

    try:
        document = ezdxf.read(io.StringIO(dxf.decode("utf-8", errors="replace")))
    except Exception as exc:  # noqa: BLE001 — повреждённый DXF — причина, а не трассировка
        raise ValueError(f"DXF не читается: {type(exc).__name__}: {exc}") from exc
    space = document.modelspace()
    facts = CadFacts(units=str(document.header.get("$INSUNITS", "")))
    extents = bbox.BoundingBox()
    for entity in space:
        try:
            extents.extend(bbox.extents([entity], fast=True))
        except Exception:  # noqa: BLE001 — объект считается пропущенным, а не роняет лист
            # Размер с битым блоком геометрии всё равно даёт границы
            # определяющими точками; иной объект — пропущенный.
            points = []
            if entity.dxftype() == "DIMENSION":
                points = [entity.dxf.get(name) for name in ("defpoint", "defpoint2", "defpoint3")]
                points = [point for point in points if point is not None]
            if points:
                extents.extend(points)
            else:
                facts.skipped += 1
    pdf = pymupdf.open()
    page = pdf.new_page(width=PAGE_WIDTH_PT, height=PAGE_HEIGHT_PT)
    if not extents.has_data:
        return pdf.tobytes(), facts
    width = max(extents.size.x, 1e-9)
    height = max(extents.size.y, 1e-9)
    scale = min((PAGE_WIDTH_PT - 2 * MARGIN_PT) / width, (PAGE_HEIGHT_PT - 2 * MARGIN_PT) / height)
    origin_x, origin_y = extents.extmin.x, extents.extmax.y

    def to_page(x: float, y: float) -> pymupdf.Point:
        # Ось Y САПР смотрит вверх, у листа PDF — вниз.
        return pymupdf.Point(MARGIN_PT + (x - origin_x) * scale, MARGIN_PT + (origin_y - y) * scale)

    font = _font()
    if font:
        page.insert_font(fontname="dejavu", fontfile=font)
    shape = page.new_shape()
    distance = max(width, height) * FLATTEN_SHARE
    facts.entities = len(space)
    for entity in _flatten(space, MAX_ENTITIES, facts):
        kind = entity.dxftype()
        if kind == "DIMENSION":
            try:
                measured = float(entity.get_measurement())
            except Exception:  # noqa: BLE001, S112 — угловой или повреждённый размер без длины
                continue
            label = str(entity.dxf.get("text", "") or "").strip()
            number = _NUMBER.search(label.replace(" ", "")) if label and label != "<>" else None
            record = {"measured": round(measured, 3), "label": label or "<>"}
            facts.dimensions.append(record)
            if number:
                written = float(number.group().replace(",", "."))
                if measured and abs(written - measured) > DIMENSION_MISMATCH * abs(measured):
                    facts.mismatches.append({**record, "written": written})
            continue
        text = _plain(entity)
        if text:
            insert = entity.dxf.get("insert")
            size = float(entity.dxf.get("char_height" if kind == "MTEXT" else "height", 2.5) or 2.5)
            if insert is not None:
                point = to_page(insert.x, insert.y)
                fontsize = max(size * scale, 1.0)
                rotation = float(entity.dxf.get("rotation", 0.0) or 0.0)
                for index, line in enumerate(text.splitlines() or [text]):
                    offset = pymupdf.Point(point.x, point.y + index * fontsize * 1.2)
                    page.insert_text(
                        offset,
                        line,
                        fontsize=fontsize,
                        fontname="dejavu" if font else "helv",
                        morph=(point, pymupdf.Matrix(-rotation)) if rotation else None,
                    )
                facts.texts += 1
                facts.drawn += 1
            continue
        try:
            outline = ezpath.make_path(entity)
        except Exception:  # noqa: BLE001, S112 — объект без геометрии (например, точка стиля)
            continue
        points = [to_page(vertex.x, vertex.y) for vertex in outline.flattening(distance)]
        if len(points) >= 2:
            shape.draw_polyline(points)
            facts.drawn += 1
    facts.truncated = facts.drawn >= MAX_ENTITIES
    shape.finish(color=(0, 0, 0), width=0.3)
    shape.commit()
    return pdf.tobytes(deflate=True), facts


def summary_line(facts: CadFacts) -> str:
    parts = [
        f"[CAD] объектов: {facts.entities}, текстов: {facts.texts}, "
        f"размеров: {len(facts.dimensions)}"
    ]
    for item in facts.mismatches[:10]:
        parts.append(
            f"размер «{item['label']}» не совпадает с геометрией: фактически {item['measured']}"
        )
    if facts.truncated:
        parts.append(f"отрисовано не более {MAX_ENTITIES} объектов")
    if facts.skipped:
        parts.append(f"не отрисовано объектов с неразрешимой геометрией: {facts.skipped}")
    return "; ".join(parts)


def measurement_length(value: float) -> str:
    return f"{value:.0f}" if math.isclose(value, round(value)) else f"{value:.2f}"
