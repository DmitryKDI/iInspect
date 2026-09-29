"""Извлечение требований из текста ПД через LLM.

Главный принцип: модель получает связные страницы одного документа, возвращает
проверяемые требования с привязкой к странице, а сбой одной пачки не превращает
весь прогон в пустой результат.
"""
from __future__ import annotations

import hashlib
import os
import re
from collections.abc import Callable

from .llm import LlmConfig, call_llm_json
from .llm_runtime import parallel_map, text_batch_for
from .requirement_registry import Requirement
from .vision import UNTRUSTED_INPUT_RULE, known_violations_block


def _positive_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, value))


# На реальном 177-страничном томе прежние 6000 символов давали около 69
# обращений к модели. У локальной модели окно контекста больше пачки, поэтому для
# основного текстового пути безопаснее тратить меньше, но более ёмких вызовов.
# Потолок остаётся консервативным относительно полного контекста и может быть
# переопределён администратором без изменения интерфейса инспектора.
DEFAULT_REQUIREMENT_CHUNK_CHARS = _positive_int_env(
    "INSPECTOR_REQUIREMENT_CHUNK_CHARS", 18_000, 4_000, 60_000
)

_REQUIREMENT_EXTRACTION_TEMPLATE = f"""\
Ты помогаешь инспектору государственного строительного надзора составить
сводку требований из текста проектной документации (пояснительной записки
или другого текстового раздела ЛЮБОЙ дисциплины — не только инженерных
систем, это может быть конструктив, электрика, слаботочные системы, любой
раздел).

{UNTRUSTED_INPUT_RULE}

Тебе показан текст одной или нескольких страниц одного тома, каждая
страница отмечена меткой «--- Страница N ---» перед своим текстом. Весь
текст документа заключён в теги
<НЕДОВЕРЕННЫЙ_ДОКУМЕНТ>…</НЕДОВЕРЕННЫЙ_ДОКУМЕНТ>.

Твоя задача: выписать ВСЁ, что описывает, каким должен быть объект и как
он строится. Инспектор получает твой ответ как готовую сводку — он не
будет её дочищать, поэтому не выдавай ничего лишнего и ничего не пропускай.

ВЫПИСЫВАЙ:
- обязывающие формулировки: «предусмотреть», «должен быть», «следует»,
  «не допускается», «выполнить»;
- констатации проектного решения: «предусмотрена система...», «принята схема...»;
- способы производства работ;
- характеристики и марки материалов, изделий, оборудования;
- количественные параметры: расходы, температуры, кратности, нагрузки,
  габариты, отметки.

НЕ ВЫПИСЫВАЙ:
- фразы без проверяемого факта;
- голые ссылки на норму без конкретного решения;
- утверждения о самом документе, а не об объекте;
- классификационные утверждения об объекте в целом;
- оглавления, колонтитулы, штампы, подписи, обрывки таблиц без смысла.

ВАЖНО: читай по смыслу, а не по образцу оформления.

Помещение указывай ТОЛЬКО если требование действительно относится к
конкретному помещению и оно названо в тексте. Если требование относится к
объекту или системе целиком — оставь `rooms` пустым списком.
{{known}}

ПОЛЕ "requirement" — короткая выжимка для инспектора, НЕ БОЛЕЕ 100 СИМВОЛОВ.
Дословная цитата исходной страницы должна попасть в `sentence` без пересказа.
Параметры пиши числом с единицей измерения. Убирай канцелярские вводные вроде
«предусмотрено», «выполняется», «принято», когда они не несут смысла.

НОРМАТИВНЫЕ ДОКУМЕНТЫ. Если на этих страницах есть перечень нормативных
документов, на которые опирается проект, выпиши его в поле `norms`. Только
то, что реально написано на странице. Ничего не добавляй по памяти.

Отвечай только JSON без пояснений вне JSON:
{{{{"requirements": [
  {{{{"rooms": ["номера помещений, если требование именно к ним; иначе пустой список"],
   "code": "короткое обозначение рядом с требованием (марка, позиция), или null",
   "requirement": "выжимка до 100 символов",
   "sentence": "дословная цитата исходного текста",
   "page": <int, номер страницы из метки>}}}}
 ],
 "norms": [
  {{{{"designation": "обозначение документа, как написано на странице",
   "title": "наименование документа или пустая строка",
   "page": <int, номер страницы из метки>}}}}
 ]}}}}
Если на этих страницах нет ничего, кроме шума, — верни
{{{{"requirements": [], "norms": []}}}}."""


def requirement_extraction_system_prompt(discipline: str | None = None) -> str:
    return _REQUIREMENT_EXTRACTION_TEMPLATE.format(
        known=known_violations_block("text", discipline)
    )


_SENTENCE_BREAK_RE = re.compile(r"(?<=[.!?])\s+(?=[А-ЯЁA-Z])|\n\s*\n")


def _split_long_page(fact: dict, max_chars: int) -> list[dict]:
    """Разрезает слишком плотную страницу только когда она сама больше пачки."""
    text = fact["text"]
    if len(text) <= max_chars:
        return [fact]

    pieces: list[str] = []
    current = ""
    for sentence in _SENTENCE_BREAK_RE.split(text):
        if not sentence:
            continue
        if current and len(current) + len(sentence) + 1 > max_chars:
            pieces.append(current)
            current = sentence
        elif current:
            current = f"{current} {sentence}"
        else:
            current = sentence
        while len(current) > max_chars:
            pieces.append(current[:max_chars])
            current = current[max_chars:]
    if current:
        pieces.append(current)

    return [
        {**fact, "text": piece, "part": i + 1, "parts_total": len(pieces)}
        for i, piece in enumerate(pieces)
    ]


def _chunk_text_facts(text_facts: list[dict], max_chars: int) -> list[list[dict]]:
    """Собирает страницы в пачки, не смешивая разные документы."""
    expanded: list[dict] = []
    for fact in text_facts:
        expanded.extend(_split_long_page(fact, max_chars))

    chunks: list[list[dict]] = []
    current: list[dict] = []
    current_len = 0
    current_doc = None
    for fact in expanded:
        fact_len = len(fact["text"])
        doc = fact.get("document", "")
        if current and (current_len + fact_len > max_chars or doc != current_doc):
            chunks.append(current)
            current, current_len = [], 0
        current.append(fact)
        current_len += fact_len
        current_doc = doc
    if current:
        chunks.append(current)
    return chunks


def _fact_for_page(chunk: list[dict], page: int) -> dict:
    for fact in chunk:
        if fact.get("page") == page:
            return fact
    return {}


def _quoted_source(chunk: list[dict], page: object, sentence: object) -> dict:
    """Нормализуем только пробелы: число, отрицание и буква должны совпадать."""
    if type(page) is not int or not isinstance(sentence, str) or not sentence.strip():
        return {}
    quote = " ".join(sentence.split())
    for fact in chunk:
        if fact.get("page") == page and quote in " ".join(str(fact.get("text") or "").split()):
            return fact
    return {}


def _render_chunk(chunk: list[dict]) -> str:
    body = "\n\n".join(
        f"--- Страница {fact['page']}"
        + (f" (часть {fact['part']} из {fact['parts_total']})" if fact.get("part") else "")
        + f" ---\n{fact['text']}"
        for fact in chunk
    )
    return f"<НЕДОВЕРЕННЫЙ_ДОКУМЕНТ>\n{body}\n</НЕДОВЕРЕННЫЙ_ДОКУМЕНТ>"


def extract_requirements_llm(
    text_facts: list[dict],
    config: LlmConfig,
    discipline: str | None = None,
    max_chars_per_call: int = DEFAULT_REQUIREMENT_CHUNK_CHARS,
    timeout: float = 120.0,
    on_chunk_error: Callable[[int, Exception], None] | None = None,
    on_norms: Callable[[list[dict]], None] | None = None,
    hint_for_section: Callable[[str | None], str] | None = None,
    on_progress: Callable[[int, int], None] | None = None,
) -> list[Requirement]:
    """Извлекает требования независимыми пачками с сохранением привязки."""
    # Длину пачки задаёт не только вызывающий: подстройщик помнит, чем
    # кончились предыдущие вызовы с тем же потолком в этом прогоне, и после
    # отказов режет объём. Пачки нарезаются один раз на документ, поэтому
    # сужение действует со следующей нарезки — на соседнем шаге разбора и
    # на следующем томе, а не в середине уже начатой очереди.
    sizer = text_batch_for(max_chars_per_call)
    chunks = _chunk_text_facts(text_facts, sizer.chars())
    total = len(chunks)
    if on_progress:
        on_progress(0, total)

    prepared: list[tuple[list[dict], str, str]] = []
    for chunk in chunks:
        chunk_section = discipline or (chunk[0].get("section") if chunk else None)
        system_prompt = requirement_extraction_system_prompt(chunk_section)
        if hint_for_section is not None:
            system_prompt += hint_for_section(chunk_section)
        prepared.append((chunk, system_prompt, _render_chunk(chunk)))

    def _call_prepared(item: tuple[list[dict], str, str]):
        chunk, system_prompt, user_text = item
        try:
            result = call_llm_json(
                config,
                system_prompt,
                user_text,
                timeout=timeout,
                operation="extraction",
                source_digest=hashlib.sha256(user_text.encode("utf-8")).hexdigest(),
                prompt_version="requirements-v4-source-verified",
            )
        except Exception as exc:  # noqa: BLE001
            return chunk, None, exc
        if not isinstance(result, dict) or not isinstance(result.get("requirements"), list):
            return chunk, None, ValueError("модель не вернула обязательный массив requirements")
        return chunk, result, None

    out: list[Requirement] = []
    for done, (chunk, result, error) in enumerate(
        parallel_map(_call_prepared, prepared), start=1
    ):
        if error is not None:
            sizer.refused()
            if on_chunk_error:
                on_chunk_error(chunk[0]["page"] if chunk else -1, error)
            if on_progress:
                on_progress(done, total)
            continue

        sizer.succeeded()
        if on_norms:
            found = result.get("norms")
            if isinstance(found, list) and found:
                source = chunk[0] if chunk else {}
                on_norms([
                    {
                        **item,
                        "document": source.get("document", ""),
                        "section": source.get("section"),
                    }
                    for item in found
                    if isinstance(item, dict)
                ])

        for item in result.get("requirements", []):
            if not isinstance(item, dict):
                if on_chunk_error:
                    on_chunk_error(chunk[0]["page"], ValueError("некорректная запись требования"))
                continue
            rooms = item.get("rooms") or []
            if not isinstance(rooms, list):
                rooms = []
            page = item.get("page")
            sentence = item.get("sentence")
            source = _quoted_source(chunk, page, sentence)
            if not source:
                if on_chunk_error:
                    on_chunk_error(chunk[0]["page"], ValueError(
                        "цитата требования не подтверждена текстом указанной страницы"
                    ))
                continue
            out.append(
                Requirement(
                    rooms=[str(r) for r in rooms],
                    page=page,
                    sentence=sentence,
                    summary=str(item.get("requirement") or ""),
                    code=str(item["code"]) if item.get("code") else None,
                    document=str(source.get("document") or ""),
                    section=source.get("section") or discipline,
                )
            )

        if on_progress:
            on_progress(done, total)
    return out
