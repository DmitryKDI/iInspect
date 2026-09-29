"""Общие бюджеты и измерения LLM; метрики не содержат текстов и ключей."""
from __future__ import annotations

import copy
import hashlib
import json
import os
import threading
import time
from collections import OrderedDict, defaultdict
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import contextmanager
from contextvars import ContextVar, copy_context
from email.utils import parsedate_to_datetime

# Сколько запросов к модели держать одновременно. Локальный сервер
# (vLLM) сам собирает параллельные запросы в пакеты на GPU, поэтому
# несколько одновременных вызовов быстрее, чем очередь по одному. Бюджет, а
# не граница истины: больше — выше загрузка GPU и памяти под контекст.
DEFAULT_CONCURRENCY = 4
DEFAULT_CACHE_ENTRIES = 256
DEFAULT_CLASSIFICATION_TOKENS = 1024
DEFAULT_EXTRACTION_TOKENS = 4096
DEFAULT_TEXT_VERIFY_TOKENS = 4096
DEFAULT_VISION_TOKENS = 4096
DEFAULT_WAIT_BUDGET = 30.0


def positive_env(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def output_tokens(operation: str) -> int:
    defaults = {
        "classification": DEFAULT_CLASSIFICATION_TOKENS,
        "extraction": DEFAULT_EXTRACTION_TOKENS,
        "text_verify": DEFAULT_TEXT_VERIFY_TOKENS,
        "vision": DEFAULT_VISION_TOKENS,
    }
    default = defaults.get(operation, DEFAULT_EXTRACTION_TOKENS)
    return positive_env(f"INSPECTOR_LLM_{operation.upper()}_MAX_TOKENS", default)


class Metrics:
    def __init__(self):
        self.started = time.monotonic()
        self.finished = None
        self.values = defaultdict(float)
        self.lock = threading.Lock()

    def add(self, name, value=1):
        with self.lock:
            self.values[name] += value

    def snapshot(self):
        with self.lock:
            data = dict(self.values)
        for name in (
            "requests", "retries", "rate_limits", "errors", "responses",
            "image_uploads", "image_cache_hits", "result_cache_hits",
            "persistent_cache_hits", "text_characters", "text_batches",
            "invalid_results", "provider_queue_events", "provider_slot_acquired",
            "provider_queue_timeouts", "text_batch_narrowed", "text_batch_widened",
        ):
            data.setdefault(name, 0)
        data.setdefault("provider_queue_wait_seconds", 0.0)
        data["mean_response_seconds"] = (
            data.get("response_seconds", 0) / data["responses"] if data["responses"] else None
        )
        data["mean_provider_queue_wait_seconds"] = (
            data.get("provider_queue_wait_seconds", 0) / data["provider_queue_events"]
            if data["provider_queue_events"] else 0.0
        )
        data["mean_text_batch_characters"] = (
            data["text_characters"] / data["text_batches"] if data["text_batches"] else None
        )
        end = self.finished if self.finished is not None else time.monotonic()
        data["elapsed_seconds"] = end - self.started
        return data


PROCESS_METRICS = Metrics()
_RUN_METRICS = ContextVar("llm_run_metrics", default=None)
# Рядом с метриками намеренно: и то и другое живёт ровно столько, сколько
# прогон. Сами подстройщики — ниже, AdaptiveTextBatch.
_TEXT_BATCHES = ContextVar("llm_text_batches", default=None)


def record(name: str, value=1):
    PROCESS_METRICS.add(name, value)
    metrics = _RUN_METRICS.get()
    if metrics is not None:
        metrics.add(name, value)


@contextmanager
def measure_run(label: str = ""):
    metrics = Metrics()
    token = _RUN_METRICS.set(metrics)
    # Подстройка длины пачек — часть обстоятельств этого прогона: она
    # начинается с заявленного потолка и заканчивается вместе с прогоном.
    batches_token = _TEXT_BATCHES.set({})
    try:
        yield metrics
    finally:
        metrics.finished = time.monotonic()
        _RUN_METRICS.reset(token)
        _TEXT_BATCHES.reset(batches_token)


class AdaptiveTextBatch:
    """Сколько символов отдавать провайдеру за один текстовый вызов.

    Ограниченная параллельность отвечает на вопрос «сколько вызовов
    одновременно», а этот класс — «какой длины каждый». Оба подстраиваются
    под одно и то же поведение провайдера, но раздельно: сузив
    параллельность, мы всё равно отправляли бы прежнюю по объёму пачку, а
    именно её длина упирается в лимит выходных токенов и в таймаут.

    Направление подстройки несимметрично намеренно. Сужение немедленное:
    отказ уже случился, повторять его тем же объёмом незачем. Расширение
    только после серии успехов: один удачный ответ ещё не значит, что
    провайдер разгрузился, и поспешное расширение вернуло бы отказ.

    Потолок задаёт вызывающий и превысить его нельзя: у него свои причины
    для этого числа — лимит контекста и читаемость цитат внутри пачки.
    """

    # Во сколько раз сужать и насколько расширять — форма подстройки, а не
    # измеренный порог: половина как самый простой шаг вниз и вчетверо
    # более осторожный шаг вверх.
    NARROW_FACTOR = 2
    WIDEN_FRACTION = 4
    # Длина серии успехов до расширения — та же осторожность, что у
    # AdaptiveLimiter.succeeded(): расширяемся редко, сужаемся сразу.
    SUCCESS_STREAK = 8

    def __init__(self, maximum: int):
        self.maximum = max(1, int(maximum))
        self.current = self.maximum
        self.success_streak = 0
        self.lock = threading.Lock()

    def chars(self) -> int:
        with self.lock:
            return self.current

    def refused(self) -> None:
        """Провайдер отказал: сузить немедленно."""
        with self.lock:
            narrowed = max(1, self.current // self.NARROW_FACTOR)
            changed = narrowed != self.current
            self.current = narrowed
            self.success_streak = 0
        if changed:
            # Сужение — наблюдаемое событие прогона: без него в метриках
            # виден только итог, а не то, что пачки пришлось резать (Г.10).
            record("text_batch_narrowed")

    def succeeded(self) -> None:
        with self.lock:
            if self.current >= self.maximum:
                self.success_streak = 0
                return
            self.success_streak += 1
            if self.success_streak < self.SUCCESS_STREAK:
                return
            self.success_streak = 0
            step = max(1, self.maximum // self.WIDEN_FRACTION)
            self.current = min(self.maximum, self.current + step)
        record("text_batch_widened")


def text_batch_for(maximum: int) -> AdaptiveTextBatch:
    """Подстройщик длины пачки для этого потолка в пределах прогона.

    По одному на каждый заявленный потолок: потолки у шагов разные
    (извлечение и текстовая сверка читают текст по-разному), и общий
    счётчик на всех сузил бы пачку там, где отказа не было.

    Вне прогона возвращается свежий подстройщик на каждый вызов: копить
    историю не на чем, а тянуть её из чужого прогона значит менять нарезку
    документа по причинам, к нему не относящимся.
    """
    key = max(1, int(maximum))
    registry = _TEXT_BATCHES.get()
    if registry is None:
        return AdaptiveTextBatch(key)
    batch = registry.get(key)
    if batch is None:
        batch = AdaptiveTextBatch(key)
        registry[key] = batch
    return batch


class AdaptiveLimiter:
    """Единый лимит запросов к модели с осторожным восстановлением после 429.

    Лимитер не решает семантический приоритет задач, но является единой точкой
    сериализации для провайдера и явно измеряет ожидание слота. Это позволяет
    отличить "модель ещё ничего не обработала" от "задача стоит в provider
    queue", не меняя контракт вызовов LLM.
    """

    def __init__(self, limit: int):
        self.max_limit = max(1, limit)
        self.limit = min(2, self.max_limit)
        self.active = 0
        self.not_before = 0.0
        self.success_streak = 0
        self.condition = threading.Condition()

    def rate_limited(self, delay: float):
        with self.condition:
            self.limit = max(1, self.limit - 1)
            self.success_streak = 0
            self.not_before = max(self.not_before, time.monotonic() + delay)
            self.condition.notify_all()

    def succeeded(self):
        with self.condition:
            if self.limit >= self.max_limit:
                return
            self.success_streak += 1
            if self.success_streak >= max(4, self.limit * 3):
                self.limit += 1
                self.success_streak = 0
                self.condition.notify_all()

    @contextmanager
    def slot(self):
        wait_started = time.monotonic()
        queued = False
        with self.condition:
            while self.active >= self.limit or self.not_before > time.monotonic():
                if not queued:
                    queued = True
                    record("provider_queue_events")
                wait_for = self.not_before - time.monotonic()
                if wait_for > DEFAULT_WAIT_BUDGET:
                    record("provider_queue_timeouts")
                    raise RuntimeError("Провайдер требует паузу; проверка пока не выполнена")
                self.condition.wait(timeout=wait_for if wait_for > 0 else None)

            if queued:
                record("provider_queue_wait_seconds", max(0.0, time.monotonic() - wait_started))
            self.active += 1
            record("provider_slot_acquired")

        completed = False
        try:
            yield
            completed = True
        finally:
            with self.condition:
                self.active -= 1
                self.condition.notify_all()
            # HTTP 429 определяется уже после выхода из slot(); временный
            # success здесь безопасен — rate_limited() тут же обнулит streak.
            if completed:
                self.succeeded()


PROVIDER_LIMITER = AdaptiveLimiter(
    positive_env("INSPECTOR_LLM_CONCURRENCY", DEFAULT_CONCURRENCY)
)


def parallel_map(function, items, workers: int | None = None):
    """Параллельная обработка без head-of-line blocking.

    Готовый worker сразу получает следующий элемент, даже если более ранний
    запрос ещё выполняется. Наружу результаты по-прежнему выдаются в исходном
    порядке, чтобы существующие callback-и и отчёты не меняли семантику.
    """
    budget = workers or positive_env("INSPECTOR_LLM_CONCURRENCY", DEFAULT_CONCURRENCY)
    iterator = enumerate(items)
    next_to_yield = 0
    ready = {}

    with ThreadPoolExecutor(max_workers=budget) as executor:
        pending = {}

        def submit_next() -> bool:
            try:
                index, item = next(iterator)
            except StopIteration:
                return False
            future = executor.submit(copy_context().run, function, item)
            pending[future] = index
            return True

        for _ in range(budget):
            if not submit_next():
                break

        while pending:
            completed, _ = wait(tuple(pending), return_when=FIRST_COMPLETED)
            for future in completed:
                index = pending.pop(future)
                ready[index] = future.result()
                submit_next()

            while next_to_yield in ready:
                yield ready.pop(next_to_yield)
                next_to_yield += 1


def retry_after_seconds(value: str | None, fallback: float) -> float:
    try:
        delay = float(value) if value else fallback
    except ValueError:
        try:
            delay = parsedate_to_datetime(value).timestamp() - time.time()
        except (ValueError, TypeError, OverflowError):
            delay = fallback
    import math
    return max(0.0, delay) if math.isfinite(delay) else fallback


def request_cache_key(**identity) -> str:
    encoded = json.dumps(identity, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class ResultCache:
    def __init__(self, capacity: int):
        self.capacity = capacity
        self.values = OrderedDict()
        self.lock = threading.RLock()
        self.flights = {}

    @contextmanager
    def single_flight(self, key):
        with self.lock:
            entry = self.flights.setdefault(key, [threading.Lock(), 0])
            entry[1] += 1
        try:
            with entry[0]:
                yield
        finally:
            with self.lock:
                entry[1] -= 1
                if not entry[1]:
                    del self.flights[key]

    def get(self, key):
        with self.lock:
            if key not in self.values:
                return None
            self.values.move_to_end(key)
            return copy.deepcopy(self.values[key])

    def put(self, key, value):
        with self.lock:
            self.values[key] = copy.deepcopy(value)
            self.values.move_to_end(key)
            while len(self.values) > self.capacity:
                self.values.popitem(last=False)

    def clear(self):
        with self.lock:
            self.values.clear()


class PersistentResultCache(ResultCache):
    """LRU в памяти + зашифрованное хранилище ML (Redis) для переживания рестартов.

    Ответы модели — производные от документов, поэтому на диске и в Redis они
    лежат только зашифрованными (ТЗ 12, п.3; `kv`).
    """

    # Сколько хранить ответ модели, секунд: разбор того же тома повторяется
    # в пределах проверки и дозагрузок; дольше держать производные незачем.
    TTL_S = 30 * 24 * 3600

    def get(self, key):
        value = super().get(key)
        if value is not None:
            return value
        from . import kv

        try:
            value = kv.store().get_json(f"llm:{key}")
        except Exception:  # noqa: BLE001 — недоступный кэш не роняет вызов модели
            return None
        if value is None:
            return None
        super().put(key, value)
        record("persistent_cache_hits")
        return copy.deepcopy(value)

    def put(self, key, value):
        super().put(key, value)
        from . import kv

        try:
            kv.store().set_json(f"llm:{key}", value, ttl_s=self.TTL_S)
        except Exception:  # noqa: BLE001 — кэш не обязателен для результата
            return

    def clear(self):
        """Очистка памяти процесса; записи Redis истекают по сроку."""
        super().clear()


RESULT_CACHE = PersistentResultCache(
    positive_env("INSPECTOR_LLM_CACHE_ENTRIES", DEFAULT_CACHE_ENTRIES))
IMAGE_CACHE = ResultCache(positive_env("INSPECTOR_LLM_CACHE_ENTRIES", DEFAULT_CACHE_ENTRIES))
