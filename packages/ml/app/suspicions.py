"""Модуль свободного поиска гипотез (ТЗ 7, модуль 5; 9.5).

Гипотезы о расхождениях вне матрицы. Результат имеет статус SUSPICION и не
считается нарушением: не входит в число нарушений и в GOLD, пока инспектор
не привяжет доказательства (тогда гипотеза становится CANDIDATE) и не примет
решение. Четыре подхода ТЗ:

  LOGICAL_ANALYSIS     — логические правила «если A, то B» из таблицы
                         Logical_Rules над значениями параметров протокола;
  SEMANTIC_DISSONANCE  — одно и то же помещение названо в ПД и в РД/ИД
                         по-разному, без общего слова;
  NORMATIVE_ANALYSIS   — значение параметра вне диапазона нормы из таблицы
                         Normative_Base, действующей на дату проверки;
  ML_PATTERN_ANALYSIS  — числовое значение резко отличается от значений того
                         же параметра на других объектах (история протоколов).

Знание о предмете — в данных (правила и нормы заводит администратор), а не в
коде: механика одинакова для любого раздела и объекта.
"""
from __future__ import annotations

import datetime as dt
import re
import statistics

LOGICAL = "LOGICAL_ANALYSIS"
SEMANTIC = "SEMANTIC_DISSONANCE"
NORMATIVE = "NORMATIVE_ANALYSIS"
ML_PATTERN = "ML_PATTERN_ANALYSIS"

# Значимое слово и длина общего корня — правило языка: окончание русского
# слова меняется, основа из первых букв сохраняется.
SIGNIFICANT_WORD_LETTERS = 4
COMMON_STEM_LETTERS = 4
# Сколько разных объектов нужно в истории, чтобы сравнивать значение со
# средним, и насколько далеко от среднего (в стандартных отклонениях)
# значение считается аномальным — общепринятое статистическое правило трёх
# сигм, а не порог, подобранный по примеру.
MIN_HISTORY_OBJECTS = 5
ANOMALY_SIGMAS = 3

# --- выражения логических правил -----------------------------------------
#
#   условие := сравнение | present(M-001) | absent(M-001) | not условие
#              | условие and условие | условие or условие | ( условие )
#   сравнение := M-001 (> | >= | < | <= | == | != | contains) литерал
#   литерал := число | "строка"

_TOKEN = re.compile(r"""\s*(?:
    (?P<num>-?\d+(?:[.,]\d+)?)
  | (?P<str>"[^"]*"|'[^']*')
  | (?P<op>>=|<=|==|!=|>|<)
  | (?P<paren>[()])
  | (?P<word>[A-Za-zА-Яа-яЁё_][\w-]*)
)""", re.VERBOSE)
_CODE = re.compile(r"^[A-ZА-Я]{1,4}-\d{1,4}$")


def _tokens(text: str) -> list[tuple[str, str]]:
    tokens, pos = [], 0
    text = text.strip()
    while pos < len(text):
        match = _TOKEN.match(text, pos)
        if match is None or match.end() == pos:
            raise ValueError(f"не разобрано выражение с позиции {pos + 1}")
        kind = match.lastgroup
        tokens.append((kind, match.group(kind)))
        pos = match.end()
    return tokens


def parse_expression(text: str):
    """Разбор выражения правила; ошибка синтаксиса — ValueError с причиной."""
    tokens = _tokens(text)
    if not tokens:
        raise ValueError("пустое выражение")
    position = 0

    def peek():
        return tokens[position] if position < len(tokens) else (None, None)

    def take(expected: str | None = None):
        nonlocal position
        kind, value = peek()
        if kind is None:
            raise ValueError("выражение оборвано")
        if expected is not None and value.lower() != expected:
            raise ValueError(f"ожидалось «{expected}», встретилось «{value}»")
        position += 1
        return kind, value

    def code() -> str:
        kind, value = take()
        if kind != "word" or not _CODE.match(value.upper()):
            raise ValueError(f"ожидался код параметра вида M-001, встретилось «{value}»")
        return value.upper()

    def factor():
        kind, value = peek()
        if kind == "word" and value.lower() == "not":
            take()
            return ("not", factor())
        if kind == "paren" and value == "(":
            take()
            node = expr()
            take(")")
            return node
        if kind == "word" and value.lower() in {"present", "absent"}:
            take()
            take("(")
            node = (value.lower(), code())
            take(")")
            return node
        left = code()
        kind, op = take()
        if kind == "word" and op.lower() == "contains":
            op = "contains"
        elif kind != "op":
            raise ValueError(f"ожидалась операция сравнения, встретилось «{op}»")
        kind, literal = take()
        if kind == "num":
            literal = float(literal.replace(",", "."))
        elif kind == "str":
            literal = literal[1:-1]
        else:
            raise ValueError(f"ожидалось число или строка в кавычках, встретилось «{literal}»")
        return ("cmp", left, op, literal)

    def term():
        node = factor()
        while peek()[0] == "word" and peek()[1].lower() == "and":
            take()
            node = ("and", node, factor())
        return node

    def expr():
        node = term()
        while peek()[0] == "word" and peek()[1].lower() == "or":
            take()
            node = ("or", node, term())
        return node

    tree = expr()
    if position != len(tokens):
        raise ValueError(f"лишний фрагмент «{tokens[position][1]}»")
    return tree


def number_of(value) -> float | None:
    match = re.search(r"-?\d+(?:[.,]\d+)?", str(value or ""))
    return float(match.group().replace(",", ".")) if match else None


def codes_of(tree) -> set[str]:
    if tree[0] == "cmp":
        return {tree[1]}
    if tree[0] in {"present", "absent"}:
        return {tree[1]}
    return set().union(*(codes_of(child) for child in tree[1:] if isinstance(child, tuple)))


def evaluate(tree, values: dict[str, str | None]) -> bool | None:
    """Трёхзначная логика: None — значение не извлечено, вывода нет."""
    kind = tree[0]
    if kind == "present":
        return bool(values.get(tree[1]))
    if kind == "absent":
        return not values.get(tree[1])
    if kind == "not":
        inner = evaluate(tree[1], values)
        return None if inner is None else not inner
    if kind in {"and", "or"}:
        left, right = evaluate(tree[1], values), evaluate(tree[2], values)
        if kind == "and":
            if left is False or right is False:
                return False
            return None if None in (left, right) else True
        if left is True or right is True:
            return True
        return None if None in (left, right) else False
    _, code, op, literal = tree
    raw = values.get(code)
    if not raw:
        return None
    if op == "contains":
        return str(literal).casefold() in str(raw).casefold()
    if isinstance(literal, float):
        number = number_of(raw)
        if number is None:
            return None
        left, right = number, literal
    else:
        if op not in {"==", "!="}:
            return None
        left, right = " ".join(str(raw).split()).casefold(), str(literal).casefold()
    return {">": left > right, ">=": left >= right, "<": left < right,
            "<=": left <= right, "==": left == right, "!=": left != right}[op]


# --- поиск гипотез ----------------------------------------------------------

def _value(check: dict) -> str | None:
    return check.get("actual_value") or check.get("expected_value")


def _reference(check: dict | None, stages: set[str], codes: dict[int, str]) -> str:
    for item in (check or {}).get("evidence") or []:
        if item.get("stage") in stages:
            code = codes.get(item.get("document_id")) or f"D{item.get('document_id')}"
            return f"{code}, стр.{item.get('page')}"
    return ""


def _suspicion(method: str, description: str, *, check: dict | None = None,
               codes: dict[int, str] | None = None, priority: str = "MEDIUM",
               normative_base: str = "", confidence: float | None = None,
               key: str = "") -> dict:
    codes = codes or {}
    return {
        "suspicion_id": None, "discovery_method": method, "confidence": confidence,
        "description": description,
        "pd_reference": _reference(check, {"PD"}, codes),
        "rd_reference": _reference(check, {"RD", "ID"}, codes),
        "review_priority": priority, "normative_base": normative_base,
        "finding_status": "SUSPICION", "inspector_status": "PENDING",
        "parameter_code": (check or {}).get("parameter_code"), "dedup_key": key,
    }


def _logical(checks: dict[str, dict], rules: list[dict], codes: dict[int, str]) -> list[dict]:
    values = {code: _value(check) for code, check in checks.items()}
    found = []
    for rule in rules:
        try:
            condition = parse_expression(rule["condition"])
            expected = parse_expression(rule["expected"])
        except ValueError:
            continue  # ошибочное правило отклоняется при сохранении; здесь — страховка
        if evaluate(condition, values) is not True or evaluate(expected, values) is not False:
            continue
        involved = sorted(codes_of(condition) | codes_of(expected))
        anchor = next((checks[code] for code in involved if code in checks), None)
        confidences = [checks[code].get("confidence") for code in involved
                       if checks.get(code, {}).get("confidence") is not None]
        found.append(_suspicion(
            LOGICAL,
            f"Правило «{rule['rule_name']}»: выполнено условие «{rule['condition']}», "
            f"но не выполнено «{rule['expected']}».",
            check=anchor, codes=codes, priority=rule.get("review_priority") or "MEDIUM",
            normative_base=rule.get("normative_base") or "",
            confidence=min(confidences) if confidences else None,
            key=f"rule:{rule.get('id')}"))
    return found


def _normative(checks: dict[str, dict], norms: list[dict], codes: dict[int, str],
               today: dt.date) -> list[dict]:
    found = []
    for norm in norms:
        check = checks.get(norm.get("parameter_name") or "")
        if check is None:
            continue
        start, end = norm.get("effective_from"), norm.get("effective_to")
        if (start and start > today) or (end and end < today):
            continue  # норма не действует на дату проверки
        number = number_of(check.get("actual_value"))
        low, high = norm.get("min_value"), norm.get("max_value")
        if number is None or (low is None and high is None):
            continue
        if (low is None or number >= low) and (high is None or number <= high):
            continue
        bounds = " … ".join(str(v) for v in (low, high) if v is not None)
        reference = " ".join(part for part in (norm.get("document_number"),
                                               norm.get("section")) if part)
        found.append(_suspicion(
            NORMATIVE,
            f"«{check.get('parameter_name')}»: значение {check.get('actual_value')} вне "
            f"диапазона нормы ({bounds}) по {reference}.",
            check=check, codes=codes, priority=check.get("priority") or "MEDIUM",
            normative_base=reference, confidence=check.get("confidence"),
            key=f"norm:{norm.get('id')}:{check.get('parameter_code')}"))
    return found


def _stems(name: str) -> set[str]:
    words = re.findall(r"[а-яёa-z]+", name.casefold())
    return {word[:COMMON_STEM_LETTERS] for word in words
            if len(word) >= SIGNIFICANT_WORD_LETTERS}


def _semantic(rooms: dict[str, list[dict]], codes: dict[int, str]) -> list[dict]:
    """Одно помещение (номер) в ПД и в РД/ИД названо без единого общего слова."""
    pd_rooms = {item["key"]: item for item in rooms.get("PD", [])}
    found, seen = [], set()
    for stage in ("RD", "ID"):
        for item in rooms.get(stage, []):
            original = pd_rooms.get(item["key"])
            if original is None or item["key"] in seen:
                continue
            left, right = _stems(original["name"]), _stems(item["name"])
            if not left or not right or left & right:
                continue
            seen.add(item["key"])
            found.append({
                **_suspicion(
                    SEMANTIC,
                    f"Помещение {item['key']}: в ПД «{original['name']}», "
                    f"в {stage} «{item['name']}».",
                    key=f"room:{item['key']}"),
                "pd_reference": f"{codes.get(original['document_id'], '')}, "
                                f"стр.{original['page']}",
                "rd_reference": f"{codes.get(item['document_id'], '')}, стр.{item['page']}",
            })
    return found


def _pattern(checks: dict[str, dict], history: dict[str, list[float]],
             codes: dict[int, str]) -> list[dict]:
    found = []
    for code, check in checks.items():
        number = number_of(check.get("actual_value"))
        sample = history.get(code) or []
        if number is None or len(sample) < MIN_HISTORY_OBJECTS:
            continue
        mean = statistics.fmean(sample)
        spread = statistics.pstdev(sample)
        if not spread or abs(number - mean) < ANOMALY_SIGMAS * spread:
            continue
        found.append(_suspicion(
            ML_PATTERN,
            f"«{check.get('parameter_name')}»: {check.get('actual_value')} при среднем "
            f"{mean:.4g} по {len(sample)} объектам (отклонение больше "
            f"{ANOMALY_SIGMAS} стандартных отклонений).",
            check=check, codes=codes, priority=check.get("priority") or "MEDIUM",
            key=f"pattern:{code}"))
    return found


def discover(checks: list[dict], *, rules: list[dict], norms: list[dict],
             rooms: dict[str, list[dict]], history: dict[str, list[float]],
             document_codes: dict[int, str], today: dt.date | None = None) -> list[dict]:
    """Все гипотезы одного процесса; дубли внутри объекта объединяются (ТЗ 9.5)."""
    by_code = {check["parameter_code"]: check for check in checks
               if check.get("parameter_code") and check.get("technical_status") == "completed"}
    found = (_logical(by_code, rules, document_codes)
             + _normative(by_code, norms, document_codes, today or dt.date.today())
             + _semantic(rooms, document_codes)
             + _pattern(by_code, history, document_codes))
    unique, seen = [], set()
    for item in found:
        key = (item["discovery_method"], item.pop("dedup_key") or item["description"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique
