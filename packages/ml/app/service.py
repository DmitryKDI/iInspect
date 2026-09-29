"""Внутренний REST API ML-модулей (ТЗ 1.5): короткие запросы сервера.

Долгие операции — разбор тома и проверка комплекта — идут через очередь
(`worker.py`). Здесь то, на что сервер ждёт ответ сразу:

- `GET /render` — изображение листа для карточки доказательства;
- `GET /llm-check` — связь с локальной моделью одним коротким вызовом;
- `POST /evaluate` — метрики по эталонной разметке (ТЗ 14);
- `POST /rules/validate` — синтаксис логического правила (ТЗ 9.5);
- `GET /health`, `GET /metrics` — состояние и метрики (ТЗ 13).

Наружу сервис не публикуется: каждый запрос несёт служебный токен контура
(`X-Internal-Token`), сравнение — за постоянное время.
"""

from __future__ import annotations

import hmac
import time

import pymupdf
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from pydantic import BaseModel

from . import (
    config,
    evaluation,
    facts_store,
    kv,
    local_ocr,
    observability,
    semantic,
    sources,
    suspicions,
)
from .contracts import PermanentError
from .llm import available_models, check_llm_reachable, local_config, model_configured

# Разрешение изображения листа, точек на дюйм: верхняя граница — БЮДЖЕТ
# памяти на лист А0 (ГЕОМЕТРИЯ/ФОРМАТ).
MAX_DPI = 300
# Сколько хранить отрисованный PDF чертежа или DOCX/XML, секунд: повторные
# листы того же документа не перерисовываются. БЮДЖЕТ кэша.
RENDER_CACHE_TTL_S = 24 * 3600


def require_token(
    x_internal_token: str = Header(default=""), authorization: str = Header(default="")
) -> None:
    """Служебный токен контура: заголовок X-Internal-Token или Bearer (Prometheus)."""
    expected = config.internal_token()
    given = x_internal_token or authorization.removeprefix("Bearer ").strip()
    if not expected or not hmac.compare_digest(given.encode(), expected.encode()):
        raise HTTPException(403, "внутренний доступ запрещён")


app = FastAPI(
    title="Инспектор ИИ — ML-модули",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
guarded = [Depends(require_token)]


@app.middleware("http")
async def _observe(request: Request, call_next):
    started = time.perf_counter()
    token = observability.request_id_var.set(
        observability.new_request_id(request.headers.get("x-request-id"))
    )
    try:
        response = await call_next(request)
    finally:
        observability.request_id_var.reset(token)
    observability.METRICS.observe(
        request.method, response.status_code, time.perf_counter() - started
    )
    return response


@app.get("/health")
def health(response: Response) -> dict:
    """Состояние модулей; недоступный кэш — 503 с причиной, а не трассировка."""
    llm = local_config()
    embedding = semantic.status()
    body = {"status": "ok", "ocr": "configured" if local_ocr.is_configured() else "not_configured",
            "semantic": {"available": embedding.available, "model": embedding.model,
                         "reason": embedding.reason},
            "llm": {"configured": model_configured(llm), "model": llm.resolved_model()}}
    try:
        body["cache"] = kv.store().backend
        body["facts"] = facts_store.stats()
    except Exception as exc:  # noqa: BLE001 — состояние, а не падение проверки здоровья
        response.status_code = 503
        body.update(status="degraded", cache=f"недоступен: {exc}")
    return body


def _pdf(sha256: str, source_format: str, derived: str | None) -> bytes:
    fmt = source_format.upper()
    if fmt == "PDF":
        return sources._FETCHER(sha256)
    key = f"render:{sha256}"
    cached = kv.store().get_bytes(key)
    if cached is not None:
        return cached
    pdf, _ = sources.to_pdf(
        {"sha256": sha256, "source_format": fmt, "derived_sha256": derived, "name": sha256[:12]}
    )
    kv.store().set_bytes(key, pdf, ttl_s=RENDER_CACHE_TTL_S)
    return pdf


@app.get("/render", dependencies=guarded)
def render(
    sha256: str = Query(pattern="^[0-9a-f]{64}$"),
    source_format: str = "PDF",
    page: int = Query(ge=1),
    dpi: int = Query(default=150, ge=36, le=MAX_DPI),
    derived_sha256: str | None = Query(default=None, pattern="^[0-9a-f]{64}$"),
) -> Response:
    try:
        data = _pdf(sha256, source_format, derived_sha256)
    except PermanentError as exc:
        raise HTTPException(422, str(exc)) from exc
    with pymupdf.open(stream=data, filetype="pdf") as document:
        if page > document.page_count:
            raise HTTPException(404, "лист вне документа")
        pixmap = document[page - 1].get_pixmap(dpi=dpi)
        return Response(pixmap.tobytes("png"), media_type="image/png")


@app.get("/llm-check", dependencies=guarded)
def llm_check() -> dict:
    llm = local_config()
    reachable, message = check_llm_reachable(llm)
    # Перечень моделей — только при живой связи: иначе второй вызов с известным исходом.
    models = available_models(llm) if reachable else None
    return {
        "reachable": reachable,
        "message": message,
        "model": llm.resolved_model(),
        "served_models": models.models if models else [],
        "model_served": models.configured_available if models else None,
    }


class EvaluateInput(BaseModel):
    reference: dict | list
    processes: list[dict]
    parameters: list[dict] | None = None


@app.post("/evaluate", dependencies=guarded)
def evaluate(body: EvaluateInput) -> dict:
    return evaluation.evaluate(body.reference, body.processes, body.parameters)


class RuleInput(BaseModel):
    expression: str


@app.post("/rules/validate", dependencies=guarded)
def validate_rule(body: RuleInput) -> dict:
    try:
        suspicions.parse_expression(body.expression)
    except (ValueError, SyntaxError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


@app.get("/metrics", dependencies=guarded)
def metrics() -> Response:
    stats = facts_store.stats()
    gauges = {"inspector_ml_facts_cached": ("Документов в кэше разбора.", stats["documents"])}
    return Response(
        observability.render(gauges, str(config.workdir())), media_type="text/plain; version=0.0.4"
    )


observability.configure_logging("inspector-ml")
