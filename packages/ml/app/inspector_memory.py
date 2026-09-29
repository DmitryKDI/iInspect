"""Опыт проверок для графической сверки: обобщённые правила (уроки).

Уроки — производные данные контура, поэтому хранятся в зашифрованном
хранилище ML-модулей (`kv`, Redis), а не файлом на диске. Слепой прогон
уроков не видит: обратная связь оценщика не должна утечь в повторный
«слепой» прогон. Урок с идентификаторами конкретного объекта (имя файла,
номер листа, номер помещения) не сохраняется вовсе.
"""
from __future__ import annotations

import os
import re
import time

from . import kv
from .llm import LlmConfig, call_llm_json

_LESSONS_KEY = "memory:lessons"
_PLAYBOOK_KEY = "memory:playbook"
# Сколько символов в сводке правил: бюджет промпта модели. БЮДЖЕТ.
PLAYBOOK_MAX_CHARS = 12000

_SPECIFIC_LESSON_PATTERNS = (
    re.compile(r"(?i)\b[^\s]+\.pdf\b"),
    re.compile(r"(?i)\b(?:лист|страниц[аеуы]?|page|sheet)\s*[№#:]?\s*\d+\b"),
    re.compile(r"(?i)\b(?:пом(?:ещение|\.)?|room)\s*[№#:]?\s*\d+\b"),
    re.compile(r"[A-Za-z]:\\"),
)


def _generic_lesson(text: str) -> bool:
    """Отклонить урок с идентификаторами конкретного объекта."""
    return not any(pattern.search(text) for pattern in _SPECIFIC_LESSON_PATTERNS)


def blind_mode() -> bool:
    return os.environ.get("INSPECTOR_BLIND_BENCHMARK", "0").strip().lower() in {
        "1", "true", "yes", "on",
    }


def _lessons() -> list[dict]:
    return list(kv.store().get_json(_LESSONS_KEY) or [])


def refresh_master_playbook(*, max_chars: int = PLAYBOOK_MAX_CHARS) -> str:
    """Собрать сводку из включённых уроков: без повторов, в порядке обучения."""
    budget = max(1000, min(30000, int(max_chars)))
    seen: set[str] = set()
    items: list[str] = []
    used = 0
    for row in _lessons():
        if not row.get("enabled", True):
            continue
        lesson = " ".join(str(row.get("lesson") or "").split()).strip()
        key = lesson.casefold()
        if not lesson or key in seen or not _generic_lesson(lesson):
            continue
        line = f"- {lesson}"
        extra = len(line) + (1 if items else 0)
        if items and used + extra > budget:
            break
        seen.add(key)
        items.append(lesson)
        used += extra
    body = "\n".join(f"- {item}" for item in items)
    kv.store().set_json(_PLAYBOOK_KEY, {"body": body, "lesson_count": len(items), "updated_at": time.time()})
    return body


def master_playbook() -> str:
    """Сводка правил; в слепом режиме — пусто."""
    if blind_mode():
        return ""
    stored = kv.store().get_json(_PLAYBOOK_KEY)
    if stored and str(stored.get("body") or "").strip():
        return str(stored["body"])
    return refresh_master_playbook() if _lessons() else ""


def add_lesson(lesson: str, *, source_type: str = "manual", source_id: str = "") -> int:
    text = " ".join(str(lesson or "").split()).strip()
    if not text:
        raise ValueError("lesson is empty")
    text = text[:1200].rstrip()
    if not _generic_lesson(text):
        raise ValueError("lesson contains object-specific identifiers")
    lessons = _lessons()
    for row in lessons:
        if row.get("lesson") == text and row.get("enabled", True):
            return int(row["id"])
    lesson_id = max((int(row["id"]) for row in lessons), default=0) + 1
    lessons.append({"id": lesson_id, "lesson": text, "source_type": source_type or "manual",
                    "source_id": source_id or "", "enabled": True, "created_at": time.time()})
    kv.store().set_json(_LESSONS_KEY, lessons)
    refresh_master_playbook()
    return lesson_id


def active_lessons(*, limit: int = 24) -> list[dict]:
    """Обобщённые уроки для рабочего режима; слепой прогон видит пустой список."""
    if blind_mode():
        return []
    rows = [row for row in _lessons() if row.get("enabled", True)]
    return rows[-max(1, min(100, int(limit))):]


def lessons_prompt(*, limit: int = 24) -> str:
    """Накопленный опыт проверок для каждого нового анализа."""
    if blind_mode():
        return ""
    playbook = master_playbook()
    if playbook:
        return (
            "\nMASTER PLAYBOOK ИНСПЕКТОРА. Это накопленные ОБЩИЕ правила прошлых "
            "проверок, а не подсказки о текущем комплекте. Не считай их "
            "доказательством; используй как стратегию поиска и перепроверки:\n"
            + playbook
            + "\n"
        )
    lessons = active_lessons(limit=limit)
    if not lessons:
        return ""
    body = "\n".join(f"- {row['lesson']}" for row in lessons)
    return (
        "\nОПЫТ ПРЕДЫДУЩИХ ПРОВЕРОК. Это общие правила, а не подсказки о текущем "
        "комплекте. Не считай их доказательством; используй только как стратегию "
        "поиска и перепроверки:\n" + body + "\n"
    )


_REFLECT_SYSTEM = """Ты превращаешь обратную связь о промахе строительного AI-инспектора
в ОБЩЕЕ правило работы для будущих, неизвестных комплектов документов.
Нельзя сохранять названия файлов, номера листов, помещений, конкретные марки,
ожидаемые benchmark-находки или любой ground truth текущего комплекта.
Нужна стратегия: что перепроверять, когда не завершать поиск, какой evidence
запрашивать, как не спутать отсутствие и ненаблюдаемость. Верни только JSON:
{"lessons":["короткое обобщённое правило", "..."]}.
Если обратная связь слишком конкретная и не даёт общего правила — lessons=[].
"""


def learn_from_feedback(
    config: LlmConfig,
    feedback: str,
    *,
    source_type: str = "teacher",
    source_id: str = "",
) -> list[int]:
    """Generalize teacher feedback and store it for experienced/demo mode.

    Even lessons learned from benchmark feedback stay disabled in blind mode
    because :func:`active_lessons` returns nothing there.
    """
    text = str(feedback or "").strip()
    if not text:
        return []
    result = call_llm_json(
        config,
        _REFLECT_SYSTEM,
        "ОБРАТНАЯ СВЯЗЬ:\n" + text[:12000],
        operation="text_verify",
        source_digest="inspector-feedback",
        prompt_version="inspector-reflection-v1",
        use_cache=False,
    )
    lessons = result.get("lessons") if isinstance(result, dict) else []
    ids: list[int] = []
    for item in lessons if isinstance(lessons, list) else []:
        lesson = " ".join(str(item or "").split()).strip()
        if lesson and _generic_lesson(lesson):
            ids.append(
                add_lesson(lesson, source_type=source_type, source_id=source_id)
            )
    return ids
