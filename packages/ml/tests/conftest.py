"""Изоляция тестов ML-модулей от окружения машины.

Тест проверяет код, а не содержимое чужого диска: адрес и имя локальной
модели, список разрешённых адресов и хранилище кэша подменяются на каждом
тесте. Кэш разбора и ответов модели — хранилище в памяти процесса (в
контуре это Redis); каждый тест начинает с пустого.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def isolate_local_environment(monkeypatch, tmp_path):
    for name in ("INSPECTOR_LOCAL_LLM_URL", "INSPECTOR_LOCAL_LLM_MODEL", "INSPECTOR_ALLOWED_HOSTS",
                 "INSPECTOR_LLM_JSON_MODE", "INSPECTOR_LLM_CONCURRENCY", "INSPECTOR_REDIS_URL",
                 "INSPECTOR_CACHE_KEY", "INSPECTOR_ENV", "INSPECTOR_EMBEDDING_MODEL_DIR"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("INSPECTOR_SECRETS_DIR", str(tmp_path / "secrets"))
    monkeypatch.setenv("INSPECTOR_ML_WORKDIR", str(tmp_path / "work"))
    from app import kv, semantic

    kv.use(kv.Store())
    semantic.use(None, "модель в тестах не подключена")
    yield
    kv.use(None)
