"""Связь с языковой моделью — только локальная, внутри закрытого контура.

Официальный прогон конкурса выполняется в закрытом контуре без Интернета, и
внешние LLM/OCR/VLM-сервисы в зачётном запуске недопустимы: документы и их
фрагменты нельзя передавать наружу. Поэтому провайдер здесь один — модель,
работающая на той же машине, в соседнем контейнере, через Chat Completions-совместимый
протокол vLLM. Код разрешает обращения только к локальным и явно разрешённым
внутренним адресам.

Что сохранено и почему. Структурированный JSON-ответ и снятие рассуждений
модели из текста, ограниченные повторы при перегрузке с потолком ожидания,
кэш ответов по полному отпечатку входа, единый ограничитель параллельности,
предполётная проверка связи — всё это свойства работы с любой моделью, и
все они покрыты тестами.
"""
from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import os
import re
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from . import llm_runtime as runtime

PROVIDER_LOCAL = "local"

# Адрес модели внутри контура. Умолчание — имя сервиса в docker-compose:
# движок и модель поднимаются одной командой и видят друг друга по имени.
LOCAL_LLM_URL = os.environ.get("INSPECTOR_LOCAL_LLM_URL", "http://llm:8000")
# Какая модель обслуживает запросы. Задаётся при развёртывании вместе с
# весами, а не выбирается в интерфейсе: модель зашита в комплект сдачи, и
# просить у сервера другую — значит получить отказ на каждом вызове.
LOCAL_LLM_MODEL = os.environ.get("INSPECTOR_LOCAL_LLM_MODEL", "Qwen/Qwen2.5-VL-7B-Instruct")


class ExternalNetworkForbiddenError(RuntimeError):
    """Попытка обратиться за пределы закрытого контура."""


def _extra_allowed_hosts() -> set[str]:
    raw = os.environ.get("INSPECTOR_ALLOWED_HOSTS", "")
    return {host.strip().casefold() for host in raw.split(",") if host.strip()}


def is_local_url(url: str) -> bool:
    """Адрес внутри контура: петля, частная сеть или имя сервиса.

    Имя без точки — это имя контейнера в сети docker-compose: наружу оно не
    разрешается. Всё, что выглядит как публичное доменное имя, считается
    внешним. Дополнительные внутренние имена можно разрешить явно через
    INSPECTOR_ALLOWED_HOSTS — молча расширить границу нельзя.
    """
    host = (urlsplit(url).hostname or "").casefold()
    if not host:
        return False
    if host == "localhost" or host in _extra_allowed_hosts():
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return "." not in host
    return address.is_loopback or address.is_private


def assert_local_url(url: str) -> None:
    """Остановиться ДО отправки, если адрес ведёт наружу.

    Проверка стоит перед каждым сетевым вызовом, а не только в настройках:
    так нарушение невозможно получить никаким путём — ни опечаткой в
    окружении, ни забытым вызовом, ни будущей правкой.
    """
    if not is_local_url(url):
        raise ExternalNetworkForbiddenError(
            f"обращение к {urlsplit(url).hostname!r} запрещено: решение работает "
            f"в закрытом контуре, документы не покидают машину")


_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)
_FENCED_JSON_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


@dataclass
class LlmConfig:
    provider: str = PROVIDER_LOCAL
    base_url: str = ""
    model: str = ""

    def resolved_model(self) -> str:
        return self.model or LOCAL_LLM_MODEL

    def resolved_base_url(self) -> str:
        return (self.base_url or LOCAL_LLM_URL).rstrip("/")


def local_config() -> LlmConfig:
    """Конфигурация модели для любого прогона — из окружения развёртывания.

    Настройки из базы сюда намеренно не читаются. Модель и адрес сервера
    задаются при развёртывании комплекта, поэтому каждый прогон использует
    одну и ту же локальную конфигурацию.
    """
    return LlmConfig(provider=PROVIDER_LOCAL)


def model_configured(config: LlmConfig | None) -> bool:
    """Есть ли модель, которую можно вызвать.

    У локальной модели нет обязательного ключа, поэтому проверка «ключ задан»
    молча выключила бы каждый шаг с моделью: разбор, сверку и графику.
    Проверяется прямо: локальный ли провайдер и заданы ли адрес и модель.
    """
    return (config is not None and config.provider == PROVIDER_LOCAL
            and bool(config.resolved_model()) and bool(config.resolved_base_url()))


def extract_json_object(text: str) -> dict | None:
    if not text:
        return None
    cleaned = _THINK_BLOCK_RE.sub("", text).strip()
    m = _FENCED_JSON_RE.search(cleaned)
    candidate = m.group(1) if m else cleaned
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        return json.loads(candidate[start : end + 1])
    except json.JSONDecodeError:
        return None


def png_bytes_to_data_url(png_bytes: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")


# Перегрузка локального сервера (очередь полна) отвечает кодом 429 и,
# возможно, Retry-After. Повторы ограничены, а
# ожидание имеет потолок: один сбойный ответ не должен превращать прогон в
# многочасовое зависание, неотличимое от «не отвечает» (Г.82).
_RATE_LIMIT_MAX_RETRIES = 3
_RATE_LIMIT_BASE_DELAY = 2.0
_RATE_LIMIT_MAX_DELAY = 30.0


def _post_json(url: str, **kwargs) -> httpx.Response:
    """Ограниченные повторы; тело ошибки может содержать документ и не логируется."""
    assert_local_url(url)
    attempt = 0
    while True:
        with runtime.PROVIDER_LIMITER.slot():
            runtime.record("requests")
            started = time.monotonic()
            try:
                resp = httpx.post(url, **kwargs)
            except Exception:
                runtime.record("errors")
                raise
            finally:
                runtime.record("response_seconds", time.monotonic() - started)
                runtime.record("responses")
        if resp.status_code >= 400:
            runtime.record("errors")
        if resp.status_code == 429:
            runtime.record("rate_limits")
            delay = runtime.retry_after_seconds(resp.headers.get("Retry-After"),
                                                 _RATE_LIMIT_BASE_DELAY * (2 ** attempt))
            runtime.PROVIDER_LIMITER.rate_limited(delay)
        if resp.status_code == 429 and attempt < _RATE_LIMIT_MAX_RETRIES:
            time.sleep(min(delay, _RATE_LIMIT_MAX_DELAY))
            # Длинный Retry-After нельзя обрезать и немедленно повторить запрос:
            # завершаем этот вызов технической ошибкой, сохраняя бюджет ожидания.
            if delay > _RATE_LIMIT_MAX_DELAY:
                raise RuntimeError("модель требует паузу дольше бюджета ожидания; "
                                   "проверка не выполнена")
            runtime.record("retries")
            attempt += 1
            continue
        resp.raise_for_status()
        return resp


def _json_mode_enabled() -> bool:
    # Режим JSON просит сервер ограничить вывод объектом. Выключатель нужен на
    # случай сервера, который такой режим не поддерживает: разбор ответа
    # остаётся терпимым к лишнему тексту и без него.
    return os.environ.get("INSPECTOR_LLM_JSON_MODE", "1") != "0"


def call_llm_json(
    config: LlmConfig,
    system_prompt: str,
    user_text: str,
    images: list[str] | None = None,
    timeout: float = 120.0,
    *,
    operation: str | None = None,
    source_digest: str = "",
    prompt_version: str = "v1",
    use_cache: bool = True,
) -> dict | None:
    """Кэш учитывает полный контекст, а проверка цитат выполняется вызывающим кодом."""
    from contextlib import nullcontext
    selected_operation = operation or ("vision" if images else "text_verify")
    cacheable = (use_cache and bool(operation or source_digest)
                 and os.environ.get("INSPECTOR_LLM_CACHE", "1") != "0")
    key = runtime.request_cache_key(
        api=config.resolved_base_url(),
        model=config.resolved_model(), operation=selected_operation, prompt_version=prompt_version,
        source_digest=source_digest, system=system_prompt, text=user_text,
        images=[hashlib.sha256(img.encode()).hexdigest() for img in images or []],
        max_tokens=runtime.output_tokens(selected_operation))
    with runtime.RESULT_CACHE.single_flight(key) if cacheable else nullcontext():
        if cacheable:
            cached = runtime.RESULT_CACHE.get(key)
            if cached is not None:
                runtime.record("result_cache_hits")
                return cached
        runtime.record("text_batches")
        runtime.record("text_characters", len(user_text))
        try:
            result = _call_llm_json_uncached(config, system_prompt, user_text, images, timeout,
                                             selected_operation)
        except ValueError:
            runtime.record("invalid_results")
            runtime.record("errors")
            raise
        if not isinstance(result, dict):
            runtime.record("invalid_results")
            runtime.record("errors")
            raise ValueError("модель не вернула JSON-объект; проверка не выполнена")
        if cacheable:
            runtime.RESULT_CACHE.put(key, result)
        return result


def _call_llm_json_uncached(
    config: LlmConfig, system_prompt: str, user_text: str,
    images: list[str] | None, timeout: float, operation: str,
) -> dict | None:
    """Один вызов локальной модели. images — список data-URL (png/jpeg)."""
    if config.provider != PROVIDER_LOCAL:
        # Любая иная настройка не должна превратиться в попытку выхода
        # за пределы закрытого контура или в пустой ответ.
        raise ValueError(f"провайдер {config.provider!r} не поддерживается: "
                         f"решение работает только с локальной моделью")
    images = images or []
    if images:
        # Изображения передаются прямо в сообщении (протокол Chat Completions).
        user_content: object = [{"type": "text", "text": user_text}] + [
            {"type": "image_url", "image_url": {"url": image}} for image in images]
    else:
        user_content = user_text
    body: dict = {
        "model": config.resolved_model(),
        "max_tokens": runtime.output_tokens(operation),
        # Нулевая температура — воспроизводимость: организаторы перезапускают
        # образ, и один и тот же комплект обязан давать один и тот же отчёт.
        "temperature": 0,
        "messages": [{"role": "system", "content": system_prompt},
                     {"role": "user", "content": user_content}],
    }
    if _json_mode_enabled():
        body["response_format"] = {"type": "json_object"}
    resp = _post_json(f"{config.resolved_base_url()}/v1/chat/completions", json=body,
                      headers={"Content-Type": "application/json"}, timeout=timeout)
    choice = resp.json()["choices"][0]
    if choice.get("finish_reason") == "length":
        raise ValueError("ответ модели обрезан по длине; проверка не выполнена")
    return extract_json_object(choice["message"]["content"] or "")


# Бюджеты предполётной проверки: сколько ждать ответа и сколько раз пробовать.
# Не пороги истины — ошибка стоит времени, а не правильности разбора.
_REACH_TIMEOUT = 45.0
_REACH_ATTEMPTS = 3
_REACH_RETRY_DELAY = 2.0


@dataclass
class ModelAvailability:
    """Что сервер модели обслуживает на самом деле, а не что записано в настройках.

    `configured_available` трёхзначно: True — модель в перечне, False —
    перечня достигли и модели в нём нет, None — перечня не достигли. Сбой
    связи не является ответом «модели нет»: одно требует поднять сервис,
    другое — положить другие веса (Г.10).
    """

    models: list[str]
    configured: str
    configured_available: bool | None
    error: str = ""


def available_models(llm_config: LlmConfig | None) -> ModelAvailability:
    """Перечень моделей, которые сейчас обслуживает локальный сервер.

    Модель нельзя менять без проверки того, что она действительно доступна.
    Функция ничего не меняет, только сообщает.
    """
    config = llm_config or local_config()
    configured = config.resolved_model()
    url = f"{config.resolved_base_url()}/v1/models"
    try:
        assert_local_url(url)
        resp = httpx.get(url, timeout=_REACH_TIMEOUT)
        resp.raise_for_status()
        payload = resp.json()
    except Exception as exc:  # noqa: BLE001 — причина нужна целиком, любая
        return ModelAvailability([], configured, None, f"{type(exc).__name__}: {exc}")
    rows = payload.get("data") if isinstance(payload, dict) else None
    models = [str(row.get("id")) for row in rows or []
              if isinstance(row, dict) and row.get("id")]
    if not models:
        return ModelAvailability([], configured, None, "сервер вернул пустой перечень моделей")
    return ModelAvailability(models, configured, configured in models)


def check_llm_reachable(llm_config: LlmConfig | None) -> tuple[bool, str]:
    """Предполётная проверка связи с моделью — один короткий вызов.

    Г.91. Разбор тома — это десятки вызовов и минуты работы. Если модель не
    отвечает, каждый вызов молча возвращает пустой результат, и прогон
    заканчивается правдоподобным отчётом, где ничего не найдено, — ловушка
    Г.77: отказ связи был неотличим от «модель со всем согласна». Один вызов
    до начала работы отделяет «модели нет» от «модель так ответила».
    """
    config = llm_config or local_config()
    if not model_configured(config):
        # «Модель не задана» — не «связи нет»: действия администратора разные.
        return False, ("локальная модель не задана: укажите INSPECTOR_LOCAL_LLM_MODEL "
                       "и INSPECTOR_LOCAL_LLM_URL")
    last: Exception | None = None
    for attempt in range(_REACH_ATTEMPTS):
        try:
            call_llm_json(
                config,
                "Ты отвечаешь строго JSON. Проверка связи.",
                'Ответь ровно: {"ok": true}',
                timeout=_REACH_TIMEOUT,
            )
            last = None
            break
        except Exception as exc:  # noqa: BLE001 — причина нужна целиком, любая
            last = exc
            if attempt + 1 < _REACH_ATTEMPTS:
                time.sleep(_REACH_RETRY_DELAY)
    if last is not None:
        return False, (f"локальная модель не отвечает по адресу "
                       f"{config.resolved_base_url()}: {type(last).__name__}: {last} "
                       f"(попыток: {_REACH_ATTEMPTS}). Проверьте, что сервис модели "
                       f"запущен и веса загружены")
    return True, f"локальная модель {config.resolved_model()} отвечает"
