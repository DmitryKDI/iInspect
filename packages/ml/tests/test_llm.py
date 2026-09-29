"""Связь с локальной моделью: протокол, повторы, сетевой запрет.

Официальный прогон идёт в закрытом контуре без Интернета, внешние
LLM/VLM-сервисы в зачётном запуске недопустимы. Здесь проверяются три вещи:
запрос уходит на локальный сервер в поддерживаемом формате, повторы при
перегрузке имеют потолок ожидания, никакой вызов не может уйти за пределы
контура.
"""
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import llm as llm_module  # noqa: E402
from app import llm_runtime  # noqa: E402
from app.llm import (  # noqa: E402
    ExternalNetworkForbiddenError,
    LlmConfig,
    call_llm_json,
    extract_json_object,
    png_bytes_to_data_url,
)


@pytest.fixture(autouse=True)
def isolated_runtime(monkeypatch):
    """Каждый тест моделирует отдельный процесс, включая общий лимит."""
    monkeypatch.setattr(llm_runtime, "PROVIDER_LIMITER", llm_runtime.AdaptiveLimiter(2))
    llm_runtime.RESULT_CACHE.clear()


def _response(payload=None, status=200, headers=None, url="http://llm:8000/v1/chat/completions"):
    return httpx.Response(status, json=payload or {}, headers=headers or {},
                          request=httpx.Request("POST", url))


def _answer(content='{"ok": true}', finish="stop"):
    return {"choices": [{"message": {"content": content}, "finish_reason": finish}]}


def test_extract_json_object_strips_think_block():
    text = "<think>рассуждаю о нормализации данных...</think>{\"significant\": [], \"checked_total\": 3}"
    assert extract_json_object(text) == {"significant": [], "checked_total": 3}
    print("OK: блок рассуждений снят до разбора JSON")


def test_extract_json_object_fenced():
    assert extract_json_object("Вот результат:\n```json\n{\"a\": 1}\n```\nготово") == {"a": 1}
    print("OK: JSON в огороженном блоке извлечён")


def test_extract_json_object_invalid_returns_none():
    assert extract_json_object("просто текст без JSON") is None
    print("OK: текст без JSON даёт None, а не исключение")


def test_request_goes_to_the_local_server_in_its_protocol(monkeypatch):
    """Протокол Chat Completions-совместимого сервера: system и user отдельными ролями."""
    captured = {}

    def fake_post(url, **kwargs):
        captured.update(url=url, **kwargs)
        return _response(_answer())

    monkeypatch.setattr(llm_module.httpx, "post", fake_post)
    result = call_llm_json(LlmConfig(), "правила", "текст", use_cache=False)

    assert result == {"ok": True}
    assert captured["url"] == "http://llm:8000/v1/chat/completions"
    body = captured["json"]
    assert body["messages"][0] == {"role": "system", "content": "правила"}
    assert body["messages"][1] == {"role": "user", "content": "текст"}
    assert body["model"] == llm_module.LOCAL_LLM_MODEL
    print("OK: запрос уходит на локальный сервер с раздельными ролями")


def test_request_is_reproducible(monkeypatch):
    """Нулевая температура: перезапуск образа даёт тот же отчёт."""
    captured = {}
    monkeypatch.setattr(llm_module.httpx, "post",
                        lambda url, **kw: captured.update(kw) or _response(_answer()))

    call_llm_json(LlmConfig(), "правила", "текст", use_cache=False)

    assert captured["json"]["temperature"] == 0
    print("OK: вызов детерминирован нулевой температурой")


def test_images_travel_inside_the_message(monkeypatch):
    """Изображение идёт прямо в сообщении — отдельной загрузки, как у облака, нет."""
    captured = {}
    monkeypatch.setattr(llm_module.httpx, "post",
                        lambda url, **kw: captured.update(kw) or _response(_answer()))
    image = png_bytes_to_data_url(b"synthetic pixels")

    call_llm_json(LlmConfig(), "правила", "что на листе", images=[image], use_cache=False)

    content = captured["json"]["messages"][1]["content"]
    assert content[0] == {"type": "text", "text": "что на листе"}
    assert content[1] == {"type": "image_url", "image_url": {"url": image}}
    print("OK: изображение передаётся внутри сообщения")


def test_truncated_answer_is_an_error_not_an_empty_result(monkeypatch):
    """Обрезанный по длине ответ — сбой проверки, а не «нарушений нет» (Г.10)."""
    monkeypatch.setattr(llm_module.httpx, "post",
                        lambda url, **kw: _response(_answer('{"items": [', "length")))

    with pytest.raises(ValueError, match="не выполнена"):
        call_llm_json(LlmConfig(), "правила", "текст", use_cache=False)
    print("OK: обрезанный ответ даёт ошибку, а не пустой результат")


def test_non_local_provider_setting_cannot_reach_the_network(monkeypatch):
    """Нелокальная настройка провайдера не превращается ни в вызов, ни в пустой ответ."""
    monkeypatch.setattr(llm_module.httpx, "post",
                        lambda *a, **kw: pytest.fail("вызов не должен был состояться"))

    with pytest.raises(ValueError, match="только с локальной моделью"):
        call_llm_json(LlmConfig(provider="external"), "правила", "текст", use_cache=False)
    print("OK: нелокальный провайдер отклоняется до сетевого вызова")


@pytest.mark.parametrize("url", [
    "https://llm.example.com/v1/chat/completions",
    "https://ocr.example.net/v1/recognize",
    "https://8.8.8.8/v1/chat/completions",
])
def test_external_address_is_refused_before_sending(monkeypatch, url):
    """Главная гарантия: ничего не уходит за пределы контура.

    Запрет стоит перед каждым сетевым вызовом, поэтому нарушение нельзя
    получить ни опечаткой в окружении, ни будущей правкой кода.
    """
    monkeypatch.setattr(llm_module.httpx, "post",
                        lambda *a, **kw: pytest.fail("внешний вызов состоялся"))

    with pytest.raises(ExternalNetworkForbiddenError):
        llm_module._post_json(url, json={})
    print(f"OK: адрес {url} отклонён до отправки")


@pytest.mark.parametrize("url", [
    "http://llm:8000/v1/chat/completions",
    "http://localhost:8000/v1/chat/completions",
    "http://127.0.0.1:8000/v1/chat/completions",
    "http://10.1.2.3:8000/v1/chat/completions",
])
def test_addresses_inside_the_contour_are_allowed(url):
    assert llm_module.is_local_url(url)
    print(f"OK: адрес {url} внутри контура")


def test_extra_internal_host_must_be_named_explicitly(monkeypatch):
    """Расширить границу можно только явно — молча она не расширяется."""
    url = "http://model.internal:8000/v1/models"
    assert not llm_module.is_local_url(url)
    monkeypatch.setenv("INSPECTOR_ALLOWED_HOSTS", "model.internal")
    assert llm_module.is_local_url(url)
    print("OK: внутреннее имя с точкой разрешается только явным списком")


def test_post_json_retries_on_429_then_succeeds(monkeypatch):
    """Перегрузка сервера (429) повторяется с задержкой, а не считается отказом."""
    monkeypatch.setattr(llm_module, "_RATE_LIMIT_BASE_DELAY", 0.0)
    monkeypatch.setattr(llm_module.time, "sleep", lambda s: None)
    attempts = {"n": 0}

    def fake_post(url, **kwargs):
        attempts["n"] += 1
        if attempts["n"] < 3:
            return _response(status=429, headers={"Retry-After": "0"})
        return _response(_answer('{"significant": []}'))

    monkeypatch.setattr(llm_module.httpx, "post", fake_post)
    result = call_llm_json(LlmConfig(), "система", "текст", use_cache=False)

    assert result == {"significant": []}
    assert attempts["n"] == 3
    print("OK: 429 повторяется с задержкой")


def test_post_json_caps_retry_after_delay(monkeypatch):
    """Г.82: огромный Retry-After не усыпляет прогон на часы молча."""
    sleeps: list[float] = []
    monkeypatch.setattr(llm_module.time, "sleep", lambda s: sleeps.append(s))
    monkeypatch.setattr(llm_module.httpx, "post",
                        lambda url, **kw: _response(status=429, headers={"Retry-After": "3600"}))

    with pytest.raises(RuntimeError, match="не выполнена"):
        call_llm_json(LlmConfig(), "система", "текст", use_cache=False)

    assert sleeps
    assert all(s <= llm_module._RATE_LIMIT_MAX_DELAY for s in sleeps)
    print("OK: ожидание обрезается потолком")


def test_post_json_gives_up_after_max_retries_on_persistent_429(monkeypatch):
    monkeypatch.setattr(llm_module, "_RATE_LIMIT_BASE_DELAY", 0.0)
    monkeypatch.setattr(llm_module.time, "sleep", lambda s: None)
    monkeypatch.setattr(llm_module.httpx, "post", lambda url, **kw: _response(status=429))

    with pytest.raises(httpx.HTTPStatusError):
        call_llm_json(LlmConfig(), "система", "текст", use_cache=False)
    print("OK: постоянная перегрузка даёт явную ошибку после ограниченных повторов")


def test_json_mode_can_be_switched_off_for_a_server_without_it(monkeypatch):
    """Разбор ответа терпим к лишнему тексту и без режима JSON на сервере."""
    captured = {}
    monkeypatch.setattr(llm_module.httpx, "post",
                        lambda url, **kw: captured.update(kw) or _response(_answer()))

    call_llm_json(LlmConfig(), "правила", "текст", use_cache=False)
    assert captured["json"]["response_format"] == {"type": "json_object"}

    monkeypatch.setenv("INSPECTOR_LLM_JSON_MODE", "0")
    call_llm_json(LlmConfig(), "правила", "текст2", use_cache=False)
    assert "response_format" not in captured["json"]
    print("OK: режим JSON включён по умолчанию и выключается окружением")


def test_model_configured_answers_the_real_question():
    """«Есть ли модель», а не «задан ли ключ»: у локальной модели ключа нет."""
    assert llm_module.model_configured(LlmConfig())
    assert not llm_module.model_configured(None)
    assert not llm_module.model_configured(LlmConfig(provider="external"))
    print("OK: локальная модель считается подключённой без всякого ключа")
