"""Кэш ML-модулей в Redis (ТЗ 9.1, п.5) — зашифрован (ТЗ 12, п.3).

Разбор документа и ответы модели — производные от документов. В Redis они
лежат только в виде AES-256-GCM: ни дамп памяти, ни файл сохранения Redis
не раскрывают текст листа. Флаг остановки проверки — служебный, без
шифрования: его ставит сервер.
"""
import concurrent.futures

import fakeredis
import pytest
from app import facts_store, kv
from app.documents import DocumentFacts
from app.llm_runtime import PersistentResultCache


@pytest.fixture
def redis_store(monkeypatch):
    monkeypatch.setenv("INSPECTOR_CACHE_KEY", "test-key")
    client = fakeredis.FakeRedis()
    kv.use(kv.Store(client=client))
    yield client
    kv.use(None)


def test_values_in_redis_are_encrypted_and_bound_to_the_key(redis_store):
    facts = DocumentFacts(name="том.pdf", pages=1,
                          text_facts=[{"page": 1, "text": "Секретный текст листа"}], room_facts=[])
    facts_store.put("a" * 64, facts)
    raw = b"".join(redis_store.get(key) for key in redis_store.keys("*"))
    assert "Секретный".encode() not in raw, "текст листа не лежит в Redis открыто"
    assert facts_store.stored("a" * 64).text_facts[0]["text"] == "Секретный текст листа"
    # Значение, переложенное под другой ключ, не расшифровывается: ключ — часть AAD.
    key = next(k for k in redis_store.keys("*") if b"facts" in k)
    redis_store.set(b"inspector:ml:facts:5:" + b"b" * 64, redis_store.get(key))
    assert facts_store.stored("b" * 64) is None
    print("OK: кэш разбора зашифрован и привязан к ключу")


def test_other_key_cannot_read_the_cache(redis_store, monkeypatch):
    kv.store().set_json("x", {"a": 1})
    monkeypatch.setenv("INSPECTOR_CACHE_KEY", "другой")
    assert kv.Store(client=redis_store).get_json("x") is None


def test_cancel_flag_is_plain_and_set_by_server(redis_store):
    redis_store.set("inspector:cancel:7", "1")
    assert kv.store().flag("inspector:cancel:7") is True
    assert kv.store().flag("inspector:cancel:8") is False


def test_production_requires_redis_and_key(monkeypatch):
    kv.use(None)
    monkeypatch.setenv("INSPECTOR_ENV", "production")
    monkeypatch.setenv("INSPECTOR_CACHE_KEY", "k")
    with pytest.raises(RuntimeError, match="Redis"):
        kv.store()
    monkeypatch.delenv("INSPECTOR_CACHE_KEY")
    with pytest.raises(RuntimeError, match="ключ"):
        kv.Store()


def test_concurrent_access_is_safe():
    store = kv.store()

    def work(index: int) -> int:
        store.set_json(f"k{index % 4}", {"i": index})
        return store.get_json(f"k{index % 4}")["i"] % 4

    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        assert sorted(set(pool.map(work, range(48)))) == [0, 1, 2, 3]


def test_llm_answers_survive_process_restart(redis_store):
    PersistentResultCache(8).put("chunk", {"requirements": [{"page": 7}]})
    assert PersistentResultCache(8).get("chunk") == {"requirements": [{"page": 7}]}
