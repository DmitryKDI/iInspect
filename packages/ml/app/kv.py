"""Хранилище «ключ — значение» ML-модулей: Redis (ТЗ 9.1, п.5) с шифрованием.

Разбор документа кэшируется в Redis по хешу файла — повторная проверка того
же тома не разбирает его заново. Значения — производные от документов
(тексты страниц, ответы модели), поэтому в Redis они лежат зашифрованными
AES-256-GCM (ТЗ 12, п.3): ни дамп памяти Redis, ни его файл сохранения не
раскрывают содержимое. Ключ — отпечаток, а не имя файла.

Адрес Redis — `INSPECTOR_REDIS_URL`, ключ шифрования — `INSPECTOR_CACHE_KEY`
(или файл в каталоге секретов). Без адреса хранилище живёт в памяти процесса:
так работают тесты; в промышленном контуре адрес обязателен.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_NONCE_BYTES = 12
_PREFIX = "inspector:ml:"


def _secret() -> bytes:
    raw = os.environ.get("INSPECTOR_CACHE_KEY", "").strip()
    if not raw:
        folder = Path(os.environ.get("INSPECTOR_SECRETS_DIR", "/run/secrets"))
        candidate = folder / "cache.key"
        if candidate.is_file():
            raw = candidate.read_text(encoding="utf-8").strip()
    if not raw:
        if os.environ.get("INSPECTOR_ENV", "").strip().lower() == "production":
            raise RuntimeError("не задан ключ шифрования кэша ML (INSPECTOR_CACHE_KEY)")
        raw = _ephemeral_key()
    return hashlib.sha256(f"inspector-cache:{raw}".encode()).digest()


_EPHEMERAL: str | None = None


def _ephemeral_key() -> str:
    """Ключ на время жизни процесса вне промышленного контура.

    Кэш в памяти и так не переживает рестарт.
    """
    global _EPHEMERAL
    if _EPHEMERAL is None:
        _EPHEMERAL = secrets.token_hex(32)
    return _EPHEMERAL


class Store:
    """Зашифрованные значения по ключу; Redis или память процесса."""

    def __init__(self, url: str | None = None, client: Any | None = None) -> None:
        self._cipher = AESGCM(_secret())
        self._memory: dict[str, bytes] = {}
        self._lock = threading.Lock()
        self._client = client
        if self._client is None and url:
            import redis

            self._client = redis.Redis.from_url(url, socket_timeout=10)

    @property
    def backend(self) -> str:
        return "redis" if self._client is not None else "memory"

    def _seal(self, key: str, data: bytes) -> bytes:
        nonce = secrets.token_bytes(_NONCE_BYTES)
        return nonce + self._cipher.encrypt(nonce, data, key.encode())

    def _open(self, key: str, blob: bytes) -> bytes | None:
        try:
            return self._cipher.decrypt(blob[:_NONCE_BYTES], blob[_NONCE_BYTES:], key.encode())
        except Exception:  # noqa: BLE001 — чужой ключ или порча: значения нет, считать заново
            return None

    def get_bytes(self, key: str) -> bytes | None:
        full = _PREFIX + key
        if self._client is not None:
            blob = self._client.get(full)
        else:
            with self._lock:
                blob = self._memory.get(full)
        return None if blob is None else self._open(full, blob)

    def set_bytes(self, key: str, data: bytes, ttl_s: int | None = None) -> None:
        full = _PREFIX + key
        blob = self._seal(full, data)
        if self._client is not None:
            self._client.set(full, blob, ex=ttl_s)
        else:
            with self._lock:
                self._memory[full] = blob

    def get_json(self, key: str) -> Any | None:
        data = self.get_bytes(key)
        return None if data is None else json.loads(data.decode("utf-8"))

    def set_json(self, key: str, value: Any, ttl_s: int | None = None) -> None:
        self.set_bytes(key, json.dumps(value, ensure_ascii=False).encode("utf-8"), ttl_s)

    def delete(self, key: str) -> None:
        full = _PREFIX + key
        if self._client is not None:
            self._client.delete(full)
        else:
            with self._lock:
                self._memory.pop(full, None)

    def flag(self, key: str) -> bool:
        """Незашифрованный флаг сервера (например, остановка проверки)."""
        if self._client is not None:
            return bool(self._client.exists(key))
        with self._lock:
            return key in self._memory

    def set_flag(self, key: str) -> None:
        if self._client is not None:
            self._client.set(key, "1")
        else:
            with self._lock:
                self._memory[key] = b"1"

    def keys(self, pattern: str) -> list[str]:
        full = _PREFIX + pattern
        if self._client is not None:
            return [key.decode()[len(_PREFIX) :] for key in self._client.scan_iter(full)]
        import fnmatch

        with self._lock:
            return [key[len(_PREFIX) :] for key in self._memory if fnmatch.fnmatch(key, full)]


_STORE: Store | None = None
_STORE_LOCK = threading.Lock()


def store() -> Store:
    """Общее хранилище процесса; адрес берётся в момент первого обращения."""
    global _STORE
    with _STORE_LOCK:
        if _STORE is None:
            url = os.environ.get("INSPECTOR_REDIS_URL", "").strip()
            if not url and os.environ.get("INSPECTOR_ENV", "").strip().lower() == "production":
                raise RuntimeError("не задан адрес Redis (INSPECTOR_REDIS_URL, ТЗ 9.1)")
            _STORE = Store(url or None)
        return _STORE


def use(custom: Store | None) -> None:
    """Подменить хранилище (тесты); None — вернуть обычное."""
    global _STORE
    with _STORE_LOCK:
        _STORE = custom
