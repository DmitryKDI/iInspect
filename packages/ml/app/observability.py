"""Журналирование и метрики (ТЗ 13).

Логи — JSON-строки с обязательными полями timestamp, level, service, message,
request_id, user_id (ТЗ 13, п.1). Идентификатор запроса приходит заголовком
`X-Request-ID` или назначается сервисом и возвращается в ответе, поэтому
запись в логе связывается с конкретным обращением внешней системы.

Уровни (ТЗ 13, п.2): INFO — штатные операции, WARNING — некритичные
проблемы, ERROR — сбои; DEBUG включается только вне промышленного контура
(`INSPECTOR_ENV` не `production`).

Хранение (ТЗ 13, п.3): логи идут в stdout — их собирает сборщик контура
(ELK); при заданном `INSPECTOR_LOG_DIR` дополнительно пишутся файлы с дневной
ротацией: общий — 90 дней, события безопасности (WARNING и ERROR с пометкой
security) — 365 дней.

Метрики (ТЗ 13, п.4–5) — формат Prometheus на `/metrics` ML-модуля: запросы
и время ответа внутреннего REST, ошибки 5xx, CPU и память процесса, место на
диске, состояние кэша разбора. Очереди RabbitMQ и сессии считает сервер.
"""
from __future__ import annotations

import contextvars
import datetime as dt
import json
import logging
import logging.handlers
import os
import resource
import shutil
import socket
import threading
import time
import uuid
from pathlib import Path

SERVICE = os.environ.get("INSPECTOR_SERVICE", "inspector-ml")
# Сколько дней хранить файлы логов (ТЗ 13, п.3).
LOG_RETENTION_DAYS = 90
SECURITY_LOG_RETENTION_DAYS = 365
# Границы гистограммы времени ответа, секунды; 0.5 — порог алерта ТЗ 13, п.7.
LATENCY_BUCKETS = (0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="")
user_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("user_id", default="")

logger = logging.getLogger("inspector")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": dt.datetime.fromtimestamp(record.created, dt.UTC).isoformat(),
            "level": record.levelname,
            "service": SERVICE,
            "message": record.getMessage(),
            "request_id": getattr(record, "request_id", "") or request_id_var.get(),
            "user_id": getattr(record, "user_id", "") or user_id_var.get(),
        }
        for key in ("event", "method", "path", "status", "duration_ms", "ip", "security"):
            if hasattr(record, key):
                payload[key] = getattr(record, key)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False)


class _SecurityFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return bool(getattr(record, "security", False)) and record.levelno >= logging.WARNING


def configure_logging(service: str) -> None:
    """Журнал процесса ML-модуля под своим именем сервиса (ТЗ 13, п.1)."""
    global SERVICE
    SERVICE = service
    configure()
    for name in ("inspector.ml.worker", "inspector.ml.service"):
        child = logging.getLogger(name)
        child.handlers = logger.handlers
        child.setLevel(logger.level)
        child.propagate = False


def configure() -> None:
    """Настроить журнал сервиса; повторный вызов ничего не дублирует."""
    if getattr(logger, "_configured", False):
        return
    production = os.environ.get("INSPECTOR_ENV", "").strip().lower() == "production"
    wanted = os.environ.get("INSPECTOR_LOG_LEVEL", "INFO").strip().upper()
    if wanted == "DEBUG" and production:
        wanted = "INFO"  # DEBUG — только в тестовом контуре (ТЗ 13, п.2)
    logger.setLevel(getattr(logging, wanted, logging.INFO))
    formatter = JsonFormatter()
    stream = logging.StreamHandler()
    stream.setFormatter(formatter)
    logger.addHandler(stream)
    log_dir = os.environ.get("INSPECTOR_LOG_DIR", "").strip()
    if log_dir:
        Path(log_dir).mkdir(parents=True, exist_ok=True)
        # Реплики воркера пишут в общий том логов: у каждой свой файл.
        name = f"{SERVICE}-{socket.gethostname()}"
        general = logging.handlers.TimedRotatingFileHandler(
            Path(log_dir) / f"{name}.log", when="midnight", backupCount=LOG_RETENTION_DAYS,
            encoding="utf-8")
        general.setFormatter(formatter)
        security = logging.handlers.TimedRotatingFileHandler(
            Path(log_dir) / f"{name}.security.log", when="midnight",
            backupCount=SECURITY_LOG_RETENTION_DAYS, encoding="utf-8")
        security.setFormatter(formatter)
        security.addFilter(_SecurityFilter())
        logger.addHandler(general)
        logger.addHandler(security)
    logger.propagate = False
    logger._configured = True  # type: ignore[attr-defined]


def new_request_id(incoming: str | None) -> str:
    value = (incoming or "").strip()
    # Чужой идентификатор принимается, только если он похож на идентификатор:
    # иначе через заголовок в журнал можно было бы вписать произвольный текст.
    if value and len(value) <= 64 and all(ch.isalnum() or ch in "-_." for ch in value):
        return value
    return uuid.uuid4().hex


class Metrics:
    """Счётчики запросов; потокобезопасны, без внешних зависимостей."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.requests: dict[tuple[str, str], int] = {}
        self.latency_buckets = [0] * len(LATENCY_BUCKETS)
        self.latency_sum = 0.0
        self.latency_count = 0
        self.started = time.time()

    def observe(self, method: str, status: int, seconds: float) -> None:
        with self._lock:
            key = (method, str(status))
            self.requests[key] = self.requests.get(key, 0) + 1
            self.latency_sum += seconds
            self.latency_count += 1
            for index, bound in enumerate(LATENCY_BUCKETS):
                if seconds <= bound:
                    self.latency_buckets[index] += 1

    def snapshot(self) -> dict:
        with self._lock:
            return {"requests": dict(self.requests), "buckets": list(self.latency_buckets),
                    "sum": self.latency_sum, "count": self.latency_count}


METRICS = Metrics()


def _memory_bytes() -> int:
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    except OSError:
        pass
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024


def render(gauges: dict[str, tuple[str, float]], disk_path: str) -> str:
    """Текст метрик в формате Prometheus."""
    data = METRICS.snapshot()
    usage = resource.getrusage(resource.RUSAGE_SELF)
    lines = [
        "# HELP inspector_http_requests_total Запросы по методу и коду ответа.",
        "# TYPE inspector_http_requests_total counter",
    ]
    for (method, status), count in sorted(data["requests"].items()):
        lines.append(f'inspector_http_requests_total{{method="{method}",status="{status}"}} '
                     f"{count}")
    errors = sum(count for (_, status), count in data["requests"].items()
                 if status.startswith("5"))
    lines += [
        "# HELP inspector_http_5xx_total Ответы с ошибкой сервера.",
        "# TYPE inspector_http_5xx_total counter",
        f"inspector_http_5xx_total {errors}",
        "# HELP inspector_http_request_duration_seconds Время ответа.",
        "# TYPE inspector_http_request_duration_seconds histogram",
    ]
    for bound, count in zip(LATENCY_BUCKETS, data["buckets"], strict=True):
        lines.append(f'inspector_http_request_duration_seconds_bucket{{le="{bound}"}} {count}')
    lines += [
        f'inspector_http_request_duration_seconds_bucket{{le="+Inf"}} {data["count"]}',
        f"inspector_http_request_duration_seconds_sum {data['sum']:.6f}",
        f"inspector_http_request_duration_seconds_count {data['count']}",
        "# TYPE process_cpu_seconds_total counter",
        f"process_cpu_seconds_total {usage.ru_utime + usage.ru_stime:.3f}",
        "# TYPE process_resident_memory_bytes gauge",
        f"process_resident_memory_bytes {_memory_bytes()}",
        "# TYPE process_uptime_seconds gauge",
        f"process_uptime_seconds {time.time() - METRICS.started:.0f}",
    ]
    try:
        disk = shutil.disk_usage(disk_path)
        lines += ["# TYPE inspector_disk_free_bytes gauge",
                  f"inspector_disk_free_bytes {disk.free}",
                  "# TYPE inspector_disk_used_ratio gauge",
                  f"inspector_disk_used_ratio {disk.used / disk.total:.4f}"]
    except OSError:
        pass
    for name, (help_text, value) in gauges.items():
        lines += [f"# HELP {name} {help_text}", f"# TYPE {name} gauge", f"{name} {value}"]
    return "\n".join(lines) + "\n"
