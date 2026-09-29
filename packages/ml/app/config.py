"""Настройки ML-модулей: переменные окружения и файлы секретов.

Секрет берётся из переменной окружения, а если её нет — из файла в каталоге
секретов (`INSPECTOR_SECRETS_DIR`, по умолчанию `/run/secrets`): так его
передают Docker secrets, и в образ и в git он не попадает (ТЗ 12, п.3).
"""

from __future__ import annotations

import os
from pathlib import Path


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def production() -> bool:
    return env("INSPECTOR_ENV").lower() == "production"


def secret(name: str, filename: str) -> str:
    value = env(name)
    if value:
        return value
    candidate = Path(env("INSPECTOR_SECRETS_DIR", "/run/secrets")) / filename
    if candidate.is_file():
        return candidate.read_text(encoding="utf-8").strip()
    return ""


def server_url() -> str:
    return env("INSPECTOR_SERVER_URL", "http://server:8080").rstrip("/")


def internal_token() -> str:
    token = secret("INSPECTOR_INTERNAL_TOKEN", "internal.token")
    if not token and production():
        raise RuntimeError("не задан служебный токен контура (INSPECTOR_INTERNAL_TOKEN)")
    return token


def amqp_url() -> str:
    return env("INSPECTOR_AMQP_URL", "amqp://guest:guest@rabbitmq:5672/")


def workdir() -> Path:
    """Каталог временных файлов разбора: файлы живут только на время задачи."""
    folder = Path(env("INSPECTOR_ML_WORKDIR", "/tmp/inspector-ml"))  # noqa: S108 — переопределяется томом tmpfs
    folder.mkdir(parents=True, exist_ok=True)
    return folder
