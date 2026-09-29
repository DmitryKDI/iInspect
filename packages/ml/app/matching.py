"""Автоматическое сопоставление листов ПД и РД/ИД для сравнения.

Каскад: тип листа -> раздел -> подсистема -> номера помещений/оборудования ->
текст. Инженерный якорь сильнее повторяющейся лексики штампа.

Позиционный fallback теперь разрешён только когда хотя бы у одной страницы
структурный разбор фактически пуст. Если обе страницы разобраны, но не имеют
ни одного содержательного сигнала для пары, сопоставлять их «по номеру»
нельзя: это выдуманная связь с score=0, которая порождает ложные LLM-находки.
Исключение — явно разные известные разделы: такая пара сохраняется только как
видимый ``discipline_mismatch`` для диагностики покрытия и никогда не выглядит
как уверенное содержательное совпадение.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .classification import PAGE_KIND_TEXT
from .diffing import jaccard, norm_word
from .subsystem import subsystem_lean

MIN_PAGE_MATCH_SIMILARITY = 0.12
CONFIDENT_PAGE_MATCH_SIMILARITY = 0.35
SUBSYSTEM_MISMATCH_PENALTY = 0.4
SUBSYSTEM_MATCH_BONUS = 0.08
ROOM_ANCHOR_FLOOR = 0.55
EQUIPMENT_ANCHOR_FLOOR = 0.50


@dataclass
class DocumentInput:
    name: str
    pages: int
    text_facts: list[dict] = field(default_factory=list)
    room_facts: list[dict] = field(default_factory=list)
    discipline_code: Optional[str] = None
    page_kinds: dict[int, str] = field(default_factory=dict)
    equipment_facts: list[dict] = field(default_factory=list)
    balance_facts: list[dict] = field(default_factory=list)


@dataclass
class _PageRef:
    file_idx: int
    page: int
    tokens: set[str]
    kind: str
    room_keys: set[str] = field(default_factory=set)
    equipment_keys: set[str] = field(default_factory=set)
    lean: Optional[str] = None

    @property
    def has_structural_signal(self) -> bool:
        return bool(self.tokens or self.room_keys or self.equipment_keys)


@dataclass
class PagePair:
    before_file_idx: int
    before_page: int
    after_file_idx: int
    after_page: int
    score: float
    matched_by: str
    page_kind: str
    discipline_mismatch: bool = False

    @property
    def needs_review(self) -> bool:
        return self.matched_by in {"review", "position"} or self.discipline_mismatch


def _cover_pairs(before_list: list[_PageRef], after_list: list[_PageRef]) -> list[tuple[_PageRef, _PageRef]]:
    if not before_list or not after_list:
        return []
    n = max(len(before_list), len(after_list))
    return [
        (
            before_list[min(i * len(before_list) // n, len(before_list) - 1)],
            after_list[min(i * len(after_list) // n, len(after_list) - 1)],
        )
        for i in range(n)
    ]


def _allow_positional_fallback(before: _PageRef, after: _PageRef) -> bool:
    """Позиция — fallback только для непрочитанной стороны."""
    return not before.has_structural_signal or not after.has_structural_signal


def page_token_set(entry: DocumentInput, page_no: int) -> set[str]:
    tokens: set[str] = set()
    for fact in entry.text_facts:
        if fact["page"] != page_no:
            continue
        for word in fact["text"].split():
            token = norm_word(word)
            if len(token) > 2:
                tokens.add(token)
    for fact in entry.room_facts:
        if fact["page"] != page_no:
            continue
        if fact.get("key"):
            tokens.add(f"room:{fact['key']}")
        for word in fact["name"].split():
            token = norm_word(word)
            if len(token) > 2:
                tokens.add(token)
    for fact in entry.equipment_facts:
        if fact["page"] != page_no:
            continue
        if fact.get("key"):
            tokens.add(f"equip:{fact['key']}")
        for word in fact["name"].split():
            token = norm_word(word)
            if len(token) > 2:
                tokens.add(token)
    return tokens


def room_key_set(entry: DocumentInput, page_no: int) -> set[str]:
    return {
        str(fact["key"])
        for fact in entry.room_facts
        if fact["page"] == page_no and fact.get("key")
    }


def equipment_key_set(entry: DocumentInput, page_no: int) -> set[str]:
    return {
        str(fact["key"])
        for fact in entry.equipment_facts
        if fact["page"] == page_no and fact.get("key")
    }


def _page_text(entry: DocumentInput, page_no: int) -> str:
    return next((fact["text"] for fact in entry.text_facts if fact["page"] == page_no), "")


def _candidate_score(before: _PageRef, after: _PageRef) -> tuple[float, int, float]:
    text_score = jaccard(before.tokens, after.tokens)
    score = text_score
    anchors = 0

    if before.room_keys and after.room_keys:
        common_rooms = before.room_keys & after.room_keys
        anchors += len(common_rooms)
        if common_rooms:
            room_score = jaccard(before.room_keys, after.room_keys)
            score = max(score, ROOM_ANCHOR_FLOOR + (1.0 - ROOM_ANCHOR_FLOOR) * room_score)

    if before.equipment_keys and after.equipment_keys:
        common_equipment = before.equipment_keys & after.equipment_keys
        anchors += len(common_equipment)
        if common_equipment:
            equipment_score = jaccard(before.equipment_keys, after.equipment_keys)
            score = max(
                score,
                EQUIPMENT_ANCHOR_FLOOR + (1.0 - EQUIPMENT_ANCHOR_FLOOR) * equipment_score,
            )

    if before.lean and after.lean:
        if before.lean == after.lean:
            score = min(1.0, score + SUBSYSTEM_MATCH_BONUS)
        else:
            score *= SUBSYSTEM_MISMATCH_PENALTY

    return score, anchors, text_score


def _match_pool(
    before_pages: list[_PageRef],
    after_pages: list[_PageRef],
    before_codes: list[Optional[str]],
    after_codes: list[Optional[str]],
) -> list[PagePair]:
    after_code_set = {code for code in after_codes if code}
    candidates: list[tuple[float, int, float, _PageRef, _PageRef]] = []

    for before in before_pages:
        if not before.has_structural_signal:
            continue
        before_code = before_codes[before.file_idx]
        gate_by_discipline = bool(before_code) and before_code in after_code_set
        for after in after_pages:
            if not after.has_structural_signal:
                continue
            if gate_by_discipline and after_codes[after.file_idx] != before_code:
                continue
            score, anchors, text_score = _candidate_score(before, after)
            if score >= MIN_PAGE_MATCH_SIMILARITY:
                candidates.append((score, anchors, text_score, before, after))

    candidates.sort(key=lambda item: (-item[0], -item[1], -item[2], item[3].page, item[4].page))
    used_before: set[tuple[int, int]] = set()
    used_after: set[tuple[int, int]] = set()
    pairs: list[PagePair] = []

    for score, _anchors, _text_score, before, after in candidates:
        before_key = (before.file_idx, before.page)
        after_key = (after.file_idx, after.page)
        if before_key in used_before or after_key in used_after:
            continue
        used_before.add(before_key)
        used_after.add(after_key)
        matched_by = "text" if score >= CONFIDENT_PAGE_MATCH_SIMILARITY else "review"
        pairs.append(PagePair(
            before.file_idx, before.page, after.file_idx, after.page,
            score, matched_by, before.kind,
        ))

    remaining_before = [page for page in before_pages if (page.file_idx, page.page) not in used_before]
    remaining_after = [page for page in after_pages if (page.file_idx, page.page) not in used_after]

    by_code: dict[str, dict[str, list[_PageRef]]] = {}
    leftover_before: list[_PageRef] = []
    for before in remaining_before:
        code = before_codes[before.file_idx]
        if code and code in after_code_set:
            by_code.setdefault(code, {"before": [], "after": []})["before"].append(before)
        else:
            leftover_before.append(before)

    leftover_after: list[_PageRef] = []
    for after in remaining_after:
        code = after_codes[after.file_idx]
        if code and code in by_code:
            by_code[code]["after"].append(after)
        else:
            leftover_after.append(after)

    positional: list[tuple[_PageRef, _PageRef, bool]] = []
    for group in by_code.values():
        group_before, group_after = group["before"], group["after"]
        if group_before and group_after:
            for before, after in _cover_pairs(group_before, group_after):
                if _allow_positional_fallback(before, after):
                    positional.append((before, after, False))
        else:
            leftover_before.extend(group_before)
            leftover_after.extend(group_after)

    if leftover_before and leftover_after:
        for before, after in _cover_pairs(leftover_before, leftover_after):
            before_code = before_codes[before.file_idx]
            after_code = after_codes[after.file_idx]
            mismatch = bool(before_code and after_code and before_code != after_code)
            if not mismatch and not _allow_positional_fallback(before, after):
                continue
            positional.append((before, after, mismatch))

    for before, after, mismatch in positional:
        pairs.append(PagePair(
            before.file_idx, before.page, after.file_idx, after.page,
            0.0, "position", before.kind, mismatch,
        ))

    return pairs


def match_page_pairs(before_files: list[DocumentInput], after_files: list[DocumentInput]) -> list[PagePair]:
    before_codes = [entry.discipline_code for entry in before_files]
    after_codes = [entry.discipline_code for entry in after_files]
    after_file_leans = [
        subsystem_lean(" ".join(fact["text"] for fact in entry.text_facts), code)
        for entry, code in zip(after_files, after_codes)
    ]

    before_pages = [
        _PageRef(
            file_index, page, page_token_set(entry, page),
            entry.page_kinds.get(page, PAGE_KIND_TEXT),
            room_key_set(entry, page), equipment_key_set(entry, page),
            subsystem_lean(_page_text(entry, page), before_codes[file_index]),
        )
        for file_index, entry in enumerate(before_files)
        for page in range(1, entry.pages + 1)
    ]
    after_pages = [
        _PageRef(
            file_index, page, page_token_set(entry, page),
            entry.page_kinds.get(page, PAGE_KIND_TEXT),
            room_key_set(entry, page), equipment_key_set(entry, page),
            after_file_leans[file_index],
        )
        for file_index, entry in enumerate(after_files)
        for page in range(1, entry.pages + 1)
    ]

    pairs: list[PagePair] = []
    for kind in {page.kind for page in before_pages} | {page.kind for page in after_pages}:
        pool_before = [page for page in before_pages if page.kind == kind]
        pool_after = [page for page in after_pages if page.kind == kind]
        if pool_before and pool_after:
            pairs.extend(_match_pool(pool_before, pool_after, before_codes, after_codes))
    return pairs
