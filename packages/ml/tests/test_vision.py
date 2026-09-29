import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.llm import LlmConfig
from app.vision import compare_text_pair


class _FakeResponse:
    def __init__(self, payload, status_code=200, headers=None):
        self._payload = payload
        self.status_code = status_code
        self.headers = headers or {}
        self.text = ""

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def _answer(text: str) -> dict:
    """Ответ локального сервера модели (Chat Completions-совместимый протокол)."""
    return {"choices": [{"message": {"content": text}, "finish_reason": "stop"}]}


def test_compare_text_pair_sends_text_not_images():
    """Текстовые (не чертёжные) листы сравниваются по тексту — ни одного
    image-блока в запросе быть не должно, это отдельный, более дешёвый путь."""
    captured = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["json"] = json
        return _FakeResponse(
            _answer(
                '{"significant": [{"label": "A-1", "change": "Класс бетона B25 вместо B30"}],'
                ' "noise_note": "", "checked_total": 1, "significant_total": 1}')
        )

    config = LlmConfig(model="test-model")
    with patch("app.llm.httpx.post", side_effect=fake_post):
        result = compare_text_pair(
            "Класс бетона по проекту B30", "Класс бетона по факту B25",
            config, context="раздел КР, акт освидетельствования",
        )

    assert result["significant"][0]["change"] == "Класс бетона B25 вместо B30"
    content = captured["json"]["messages"][1]["content"]
    assert isinstance(content, str), "без картинок сообщение — просто текст, без блоков изображений"
    assert "B30" in content and "B25" in content
    assert "раздел КР" in content
    print("OK: text-kind comparison sends no image blocks, both page texts and context in the text block")


def test_known_violations_reach_the_prompt_filtered_by_kind_and_discipline(tmp_path, monkeypatch):
    """Известные нарушения из data/known_violations.json подставляются в
    системный промпт — это единственный способ, которым они влияют на анализ
    (весов модели мы не трогаем). Фильтрация обязательна: примеры для
    чертежей не должны попадать в текстовый промпт и наоборот, иначе модель
    ищет вытяжную вентиляцию в акте освидетельствования.

    Фикстура — синтетические примеры, не содержимое настоящего
    data/known_violations.json: реальный файл сейчас (Приложение Г.24)
    намеренно содержит только универсальные ('*') примеры без привязки к
    разделу, поэтому проверять фильтр по discipline на нём нельзя — тест
    должен быть независим от того, какие разделы там реально заведены."""
    import json

    import app.vision as vision_module

    fixture = tmp_path / "known_violations.json"
    fixture.write_text(json.dumps({"examples": [
        {"discipline": "ОВ", "applies_to": "drawing", "what": "Пример чертежа раздела ОВ",
         "how_to_spot": "маркер-drawing-ov", "severity": "критично"},
        {"discipline": "*", "applies_to": "text", "what": "Пример текста, общий для всех разделов",
         "how_to_spot": "маркер-text-any", "severity": "критично"},
    ]}), encoding="utf-8")
    monkeypatch.setattr(vision_module, "KNOWN_VIOLATIONS_PATH", fixture)

    from app.vision import known_violations_block, load_known_violations, vision_system_prompt

    assert load_known_violations(), "файл примеров должен читаться, иначе промпт молча остаётся общим"

    drawing_ov = known_violations_block("drawing", "ОВ")
    assert "маркер-drawing-ov" in drawing_ov, drawing_ov
    assert "маркер-text-any" not in drawing_ov, "текстовый пример утёк в чертёжный блок"

    text_any = known_violations_block("text", "КР")
    assert "маркер-text-any" in text_any, text_any
    assert "маркер-drawing-ov" not in text_any, "чертёжный пример утёк в текстовый блок"

    # Раздел ЭОМ: специфичных для ОВ примеров быть не должно, общие ('*') — должны.
    drawing_eom = known_violations_block("drawing", "ЭОМ")
    assert "маркер-drawing-ov" not in drawing_eom, "пример раздела ОВ показан для ЭОМ"

    prompt = vision_system_prompt("ОВ")
    assert "маркер-drawing-ov" in prompt
    # Фигурные скобки JSON-шаблона не должны пострадать от .format()
    assert '{"significant"' in prompt, "формат ответа сломан подстановкой примеров"
    print("OK: примеры нарушений попадают в промпт с фильтром по типу листа и разделу")


def test_missing_known_violations_file_does_not_break_prompt(monkeypatch):
    """Отсутствие файла примеров не должно ронять анализ — промпт просто
    остаётся общим, как был до их появления."""
    import app.vision as vision_module
    monkeypatch.setattr(vision_module, "KNOWN_VIOLATIONS_PATH", Path("/nonexistent/known_violations.json"))

    assert vision_module.load_known_violations() == []
    prompt = vision_module.vision_system_prompt("ОВ")
    assert "НАРУШЕНИЯ, УЖЕ ВСТРЕЧАВШИЕСЯ" not in prompt
    assert '{"significant"' in prompt, "промпт должен остаться рабочим без файла примеров"
    print("OK: без файла примеров промпт остаётся корректным, анализ не падает")
