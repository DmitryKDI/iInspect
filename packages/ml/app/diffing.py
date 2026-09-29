"""Текстовый diff расхождений между параграфами ПД и РД/ИД.

Порт проверенной логики из nadzor-browser/app.js (prepareParagraphs,
findTextDifferences, wordDiff, stripLeadingListMarker) — включая защиту от
ложных срабатываний на номерах позиций в инженерных перечнях («10
Воздухонагреватель…» → «4 Воздухонагреватель…» — номер позиции меняется
независимо от содержания и не является расхождением по смыслу).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

MIN_PARAGRAPH_WORDS = 5
MIN_SIMILARITY = 0.55
MAX_SIMILARITY = 0.985
MAX_DIFF_WORDS = 150

_TRIM_RE = re.compile(r'^[.,;:()«»"\'—-]+|[.,;:()«»"\'—-]+$')
_LEADING_LIST_MARKER_RE = re.compile(r"^\s*\d{1,4}[.)]?\s+(?=\S)")


def norm_word(w: str) -> str:
    return _TRIM_RE.sub("", w.lower())


def strip_leading_list_marker(text: str) -> str:
    return _LEADING_LIST_MARKER_RE.sub("", text)


@dataclass
class Paragraph:
    text: str
    page: int
    file: str
    words: list[str] = field(default_factory=list)
    token_set: set[str] = field(default_factory=set)


def prepare_paragraphs(entries: list[dict]) -> list[Paragraph]:
    """entries: [{text, page, file}]"""
    result = []
    for e in entries:
        text = strip_leading_list_marker(e["text"])
        words = [w for w in text.split() if w]
        token_set = {norm_word(w) for w in words if len(norm_word(w)) > 1}
        if len(words) >= MIN_PARAGRAPH_WORDS:
            result.append(Paragraph(text=text, page=e["page"], file=e["file"], words=words, token_set=token_set))
    return result


def jaccard(set_a: set, set_b: set) -> float:
    inter = len(set_a & set_b)
    union = len(set_a) + len(set_b) - inter
    return 0.0 if union == 0 else inter / union


def build_paragraph_index(paragraphs: list[Paragraph]) -> dict[str, list[int]]:
    index: dict[str, list[int]] = {}
    for i, p in enumerate(paragraphs):
        for t in p.token_set:
            if len(t) < 4:
                continue
            index.setdefault(t, []).append(i)
    return index


@dataclass
class DiffOp:
    type: str  # 'eq' | 'del' | 'add'
    text: str


def word_diff(a: list[str], b: list[str]) -> list[DiffOp]:
    wa = a[:MAX_DIFF_WORDS]
    wb = b[:MAX_DIFF_WORDS]
    na = [norm_word(w) for w in wa]
    nb = [norm_word(w) for w in wb]
    n, m = len(na), len(nb)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            if na[i] == nb[j]:
                dp[i][j] = dp[i + 1][j + 1] + 1
            else:
                dp[i][j] = max(dp[i + 1][j], dp[i][j + 1])
    ops: list[DiffOp] = []
    i = j = 0
    while i < n and j < m:
        if na[i] == nb[j]:
            ops.append(DiffOp("eq", wa[i]))
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            ops.append(DiffOp("del", wa[i]))
            i += 1
        else:
            ops.append(DiffOp("add", wb[j]))
            j += 1
    while i < n:
        ops.append(DiffOp("del", wa[i]))
        i += 1
    while j < m:
        ops.append(DiffOp("add", wb[j]))
        j += 1
    return ops


@dataclass
class TextDifference:
    before: Paragraph
    after: Paragraph
    score: float
    diff: list[DiffOp]


def find_text_differences(before_entries: list[dict], after_entries: list[dict]) -> list[TextDifference]:
    before = prepare_paragraphs(before_entries)
    after = prepare_paragraphs(after_entries)
    after_index = build_paragraph_index(after)
    results: list[TextDifference] = []
    for p in before:
        candidate_idx: set[int] = set()
        for t in p.token_set:
            if len(t) < 4:
                continue
            for idx in after_index.get(t, ()):
                candidate_idx.add(idx)
        best = None
        best_score = 0.0
        for idx in candidate_idx:
            score = jaccard(p.token_set, after[idx].token_set)
            if score > best_score:
                best_score = score
                best = after[idx]
        if best is not None and MIN_SIMILARITY <= best_score < MAX_SIMILARITY:
            results.append(TextDifference(before=p, after=best, score=best_score, diff=word_diff(p.words, best.words)))
    results.sort(key=lambda r: -r.score)
    return results
