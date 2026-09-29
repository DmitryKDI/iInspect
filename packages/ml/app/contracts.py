"""Контракт очереди между сервером и ML-модулями (ТЗ 1.5).

Зеркало `packages/server/src/queue/contracts.ts`; расхождение имён очередей
и полей ловит тест контракта. Сервер ставит задачи в `inspector.parse` и
`inspector.inspect`, воркер отвечает в `inspector.results` и сообщает ход
проверки в `inspector.progress`. Остановку проверки сервер отмечает ключом
`inspector:cancel:<process_id>` в Redis.
"""

from __future__ import annotations

QUEUE_PARSE = "inspector.parse"
QUEUE_INSPECT = "inspector.inspect"
QUEUE_RESULTS = "inspector.results"
QUEUE_PROGRESS = "inspector.progress"
CANCEL_KEY_PREFIX = "inspector:cancel:"

QUEUES = (QUEUE_PARSE, QUEUE_INSPECT, QUEUE_RESULTS, QUEUE_PROGRESS)

DOCUMENT_FIELDS = (
    "id",
    "name",
    "sha256",
    "source_format",
    "derived_sha256",
    "derived_format",
    "pages",
    "metadata",
)
INSPECT_FIELDS = (
    "task_id",
    "kind",
    "attempt",
    "process_id",
    "object_id",
    "documents",
    "parameters",
    "matrix_version",
    "previous",
    "decision_version",
    "free_search",
)


class PermanentError(Exception):
    """Сбой, который повтор не исправит: повреждённый файл, неподдерживаемый формат."""


def ok(task: dict, payload: dict) -> dict:
    return {"task_id": task["task_id"], "kind": task["kind"], "status": "ok", "payload": payload}


def error(task: dict, message: str, *, permanent: bool) -> dict:
    return {
        "task_id": task.get("task_id"),
        "kind": task.get("kind"),
        "status": "error",
        "error": message[:2000],
        "permanent": permanent,
    }


def progress(process_id: int, stage: str, completed: int, total: int) -> dict:
    return {"process_id": process_id, "stage": stage, "completed": completed, "total": total}


def cancel_key(process_id: int) -> str:
    return f"{CANCEL_KEY_PREFIX}{process_id}"
