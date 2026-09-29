"""Отрисовка чертежа DXF (ТЗ 11, п.8): объект с неразрешимой геометрией не
роняет лист, а считается пропущенным и называется в тексте листа."""
import io

import ezdxf
import pymupdf
from app import cad
from ezdxf import bbox, units


def _dxf() -> bytes:
    drawing = ezdxf.new("R2018", setup=True)
    drawing.units = units.MM
    space = drawing.modelspace()
    space.add_lwpolyline([(0, 0), (6000, 0), (6000, 3000), (0, 3000)], close=True)
    space.add_linear_dim(base=(0, -500), p1=(0, 0), p2=(3000, 0), text="3500",
                         override={"dimlfac": 1}).render()
    space.add_circle((1000, 1000), 200)
    space.add_text("План этажа", dxfattribs={"height": 250, "insert": (0, 3500)})
    stream = io.StringIO()
    drawing.write(stream)
    return stream.getvalue().encode("utf-8")


def test_broken_geometry_is_counted_not_fatal(monkeypatch):
    real = bbox.extents

    def extents(entities, **kwargs):
        entities = list(entities)
        if any(entity.dxftype() in {"DIMENSION", "CIRCLE"} for entity in entities):
            raise ZeroDivisionError("вырожденная система координат")
        return real(entities, **kwargs)

    monkeypatch.setattr(bbox, "extents", extents)
    pdf, facts = cad.render(_dxf())
    assert facts.skipped == 1, "круг пропущен, размер дал границы определяющими точками"
    assert facts.mismatches and facts.mismatches[0]["label"] == "3500"
    text = pymupdf.open(stream=pdf)[0].get_text()
    assert "План этажа" in text
    assert "неразрешимой геометрией: 1" in cad.summary_line(facts)
