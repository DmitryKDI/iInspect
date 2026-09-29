"""Модель не меняется вслепую: перечень обслуживаемых моделей проверяется.

Модель нельзя менять без проверки того, что она действительно доступна.
Локальный сервер отдаёт перечень обслуживаемых моделей по `/v1/models` —
по нему и сверяется выбранное имя. Иначе ошибка в имени выяснялась бы
падением первого рабочего вызова, уже после запуска разбора тома.

Три состояния различаются явно: перечень получен и модель в нём есть;
перечень получен и модели в нём нет; перечень получить не удалось.
Последнее НЕ является ответом «модели нет»: незапущенный сервер и
неподходящие веса чинятся по-разному (Г.10).
"""
from __future__ import annotations

import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import llm  # noqa: E402


def _answer(monkeypatch, payload=None, error: Exception | None = None):
    captured = {}

    def fake_get(url, **kwargs):
        captured.update({"url": url, **kwargs})
        if error is not None:
            raise error
        return httpx.Response(200, json=payload or {}, request=httpx.Request("GET", url))

    monkeypatch.setattr(llm.httpx, "get", fake_get)
    return captured


def test_served_models_are_listed(monkeypatch):
    captured = _answer(monkeypatch, {"data": [{"id": "ModelA"}, {"id": "ModelB"}]})

    result = llm.available_models(llm.LlmConfig(model="ModelA"))

    assert result.models == ["ModelA", "ModelB"]
    assert result.configured_available is True
    assert captured["url"] == "http://llm:8000/v1/models"
    print("OK: перечень моделей получен с локального сервера")


def test_configured_model_is_checked_against_the_list(monkeypatch):
    _answer(monkeypatch, {"data": [{"id": "ModelA"}]})

    result = llm.available_models(llm.LlmConfig(model="ModelB"))

    assert result.configured_available is False
    print("OK: модель, которой нет на сервере, названа недоступной")


def test_unreachable_server_is_not_read_as_missing_model(monkeypatch):
    """Незапущенный сервер не означает, что модели нет."""
    _answer(monkeypatch, error=httpx.ConnectError("нет связи"))

    result = llm.available_models(llm.LlmConfig())

    assert result.models == []
    assert result.configured_available is None, "неизвестно — это не «нет»"
    assert "нет связи" in result.error
    print("OK: недоступный сервер не выдан за отсутствие модели")


def test_external_server_address_is_refused(monkeypatch):
    """Перечень моделей тоже нельзя запросить за пределами контура."""
    monkeypatch.setattr(llm.httpx, "get", lambda *a, **kw: (_ for _ in ()).throw(
        AssertionError("внешний вызов состоялся")))

    result = llm.available_models(llm.LlmConfig(base_url="https://llm.example.com"))

    assert result.configured_available is None
    assert "запрещено" in result.error
    print("OK: запрос перечня моделей наружу отклонён")


def _service(monkeypatch):
    from app import service
    from fastapi.testclient import TestClient

    monkeypatch.setenv("INSPECTOR_INTERNAL_TOKEN", "t")
    return service, TestClient(service.app, headers={"X-Internal-Token": "t"})


def test_llm_check_reports_the_model_and_its_availability(monkeypatch):
    """Администратор видит выбранную модель и то, обслуживает ли её сервер."""
    service, client = _service(monkeypatch)
    monkeypatch.setattr(service, "check_llm_reachable", lambda config: (True, "отвечает"))
    monkeypatch.setattr(service, "available_models",
                        lambda config: llm.ModelAvailability(["ModelA"], "ModelB", False))
    monkeypatch.setattr(service, "local_config", lambda: llm.LlmConfig(model="ModelB"))

    body = client.get("/llm-check").json()

    assert body["model"] == "ModelB"
    assert body["model_served"] is False
    assert body["served_models"] == ["ModelA"]
    print("OK: проверка связи показывает модель и её доступность")


def test_llm_check_does_not_claim_the_model_is_missing_when_offline(monkeypatch):
    """Нет связи — нет и суждения о модели, а не «модели нет»."""
    service, client = _service(monkeypatch)
    monkeypatch.setattr(service, "check_llm_reachable", lambda config: (False, "не отвечает"))

    body = client.get("/llm-check").json()

    assert body["reachable"] is False
    assert body["model_served"] is None
    print("OK: без связи суждения о модели нет")


def test_internal_api_requires_the_contour_token(monkeypatch):
    from fastapi.testclient import TestClient

    service, client = _service(monkeypatch)
    assert TestClient(service.app).post("/rules/validate", json={"expression": "M-001 > 1"}).status_code == 403
    assert client.post("/rules/validate", json={"expression": "M-001 > 1"}).json() == {"ok": True}
    assert client.post("/rules/validate", json={"expression": "M-001 >"}).json()["ok"] is False
    assert client.get("/health").json()["cache"] == "memory"
    print("OK: внутренний REST только со служебным токеном контура")
