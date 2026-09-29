"""Числовые пороги из текста логики срабатывания матрицы (ТЗ 8.1, «trigger_logic»).

В матрице порог записан словами: «дельта … > 1%», «ширина … менее 1.2 м»,
«высота порога > 0.014 м». Модель читает этот текст, но выход за число —
проверка, которую надёжнее сделать кодом. Разбор извлекает три вида порогов:

  max_delta_pct  — «> N%» при сравнении стадий: допустимое относительное
                   расхождение значения РД/ИД с ПД;
  max_abs_delta  — «> N <ед.>» для смещения/расхождения/дельты между стадиями;
  min_value / max_value — «< N» (менее) и «> N» (более) для самого значения.

Разбирается только то, что однозначно: число после знака сравнения или слов
«менее/более/не менее». Номер свода правил или стандарта — не порог: число
учитывается, только если перед ним стоит знак сравнения. Диапазон «10-12 м»
даёт строгую границу: для «менее» — меньшее число, для «более» — большее.
Доля «< 10% от общего числа» — не расхождение стадий и не значение параметра,
поэтому не разбирается. Пороги, заданные администратором в Params,
приоритетнее разобранных.
"""
from __future__ import annotations

import re

_NUMBER = r"\d+(?:[.,]\d+)?"
_RANGE = rf"(?P<low>{_NUMBER})(?:\s*[-–]\s*(?P<high>{_NUMBER}))?"
_LESS = r"(?:<|\\<|менее|меньше)"
_MORE = r"(?:>|\\>|более|больше|свыше)"
_PATTERN = re.compile(
    rf"(?P<op>{_LESS}|{_MORE})\s*{_RANGE}\s*(?P<unit>%|мм|м|[а-яёa-z²³/]+)?",
    re.IGNORECASE)
# Слова, по которым «> N» относится к расхождению стадий, а не к значению.
_DELTA_WORDS = re.compile(r"дельт|расхожд|смещ|разниц|превышени[ея] продолжительн",
                          re.IGNORECASE)
_SHARE_WORDS = re.compile(r"от общего|доли", re.IGNORECASE)


def _number(text: str) -> float:
    return float(text.replace(",", "."))


def parse(trigger: str) -> dict[str, float | str]:
    """Пороги из текста правила; пустой словарь — однозначного числа нет.

    Несколько порогов в одном правиле относятся к разным элементам («высота
    коридоров < 2.0 м или дверей < 1.9 м»): к одному значению их не
    применить, поэтому такое правило кодом не проверяется.
    """
    matches = list(_PATTERN.finditer(trigger or ""))
    if len(matches) != 1:
        return {}
    result: dict[str, float | str] = {}
    for match in matches:
        op = match.group("op").casefold().lstrip("\\")
        low = _number(match.group("low"))
        high = _number(match.group("high")) if match.group("high") else low
        unit = (match.group("unit") or "").casefold()
        less = op in {"<", "менее", "меньше"}
        tail = trigger[match.end():match.end() + 20]
        if unit == "%":
            if less or _SHARE_WORDS.search(tail):
                continue  # доля от целого, а не расхождение стадий
            result.setdefault("max_delta_pct", max(low, high))
        elif less:
            result.setdefault("min_value", min(low, high))
            result["unit"] = unit
        elif _DELTA_WORDS.search(trigger):
            result.setdefault("max_abs_delta", max(low, high))
            result["unit"] = unit
        else:
            result.setdefault("max_value", max(low, high))
            result["unit"] = unit
    return result


# Кратность единиц длины к метру — определение единиц, а не порог.
_LENGTH = {"мм": 0.001, "см": 0.01, "м": 1.0}
_VALUE = re.compile(rf"(-?{_NUMBER})\s*(мм|см|м)?(?![а-яё])", re.IGNORECASE)


def measure(text: object, unit: str = "") -> float | None:
    """Первое число из текста; длина приводится к единице порога (м/см/мм)."""
    match = _VALUE.search(str(text or ""))
    if match is None:
        return None
    value = _number(match.group(1))
    source = (match.group(2) or "").casefold()
    if source in _LENGTH and unit in _LENGTH:
        value = value * _LENGTH[source] / _LENGTH[unit]
    return value
