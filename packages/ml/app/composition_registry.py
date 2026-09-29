"""Комплектность по листу «Состав документации».

Правило: в комплекте почти всегда есть отдельный лист-ведомость («Состав
[проектной/рабочей] документации» / «ВЕДОМОСТЬ ОСНОВНЫХ КОМПЛЕКТОВ РАБОЧИХ
ЧЕРТЕЖЕЙ»), перечисляющий все комплекты, из которых должен состоять проект
(обозначение → наименование → разработчик). Отдельно — проза где-то в
корпусе ссылается на другой комплект по марке или обозначению («см. в
части ВК», «рассмотрены в части ИТП-УУТЭ данного проекта», «см. том
5.4.2»). Если такая ссылка указывает на обозначение, которое ЕСТЬ в
ведомости, но среди переданных на сравнение файлов такого комплекта нет —
находка «предусмотренный документ не передан»: та же трёхкатегорийная
логика, что Г.9 применяет к помещениям, только уровнем выше — на целых
документах, а не на элементах внутри них.

Вне охвата сознательно:
литеральные ссылки на нормативные документы (СП/СНиП/ГОСТ) между сторонами
построчным совпадением кодов — там другой источник ложных находок,
разобранный отдельно, сюда не относится.

СТАТУС: n=0, не n=1. В отличие от большинства правил Приложения Г, здесь
нет ни одного разобранного случая на реальном комплекте c РЕАЛЬНЫМ листом
«Состав документации» — разобранный набор (4 файла, один
раздел ОВ) такого листа не содержит вообще, полноценная ведомость там
физически отсутствует (это отдельный том, не входящий в узкую ОВ-выборку).
Регулярки ниже подобраны по общей структуре таблицы (Обозначение →
Наименование → Разработчик, тот же многострочный паттерн разбора, что
`rooms.py`/`equipment.py`) и по дословным выдержкам прозы из реального
текста (ссылки «см. в части ВК» и «рассмотрены в части ИТП-УУТЭ данного
проекта» — это НАСТОЯЩИЙ, наблюдённый текст комплекта, только сама
ведомость, куда эти ссылки должны были бы указывать, физически не входит
в переданный набор файлов). Как модуль целиком поведёт себя на реальном
листе «Состав документации» — не проверено ни разу, это честная граница,
а не заявленная полнота: правило основано только на наблюдаемых данных."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

# --------------------------------------------------------------------------
# Разбор ведомости «Состав документации»
# --------------------------------------------------------------------------

# Обозначение комплекта: минимум три сегмента через "/", последний может
# продолжаться через "-"/"." (подраздел, суффикс марки) — тот же паттерн,
# что видно на реальных шифрах (форма «XXX/000000/1-РД-ИТП.УУТЭ»). Требование
# ДВУХ "/" — не случайность: без него дата вида «01.23» из штампа (тоже
# «буквы/цифры + разделитель + буквы/цифры» по форме) ложно считалась бы
# обозначением, а обозначение норматива (буквы, пробел, цифры с точками)
# и без того не проходит — в строке нет "/" вообще.
#
# Г.67 — на реальном комплекте (полная ведомость, шире
# разобранной выборки) нашлась строка ведомости с обозначением
# СТОРОННЕГО субподрядчика по чужой схеме шифров — не тройка «XXX/000000/1»,
# а пять "/"-сегментов, с пробелом и строчными буквами внутри первого
# сегмента (форма вроде «Орг 11-1-1/РД/ГП/…/…-РД-СКТВ» — сама выдержка не
# приводится дословно, Г.12: реальный текст конкретного объекта пользователя
# не коммитится, только класс формы, которая ломала regex). Старая
# регулярка (только заглавные буквы/цифры, без пробела) такую строку
# целиком отвергала. Первый сегмент теперь может содержать буквы любого
# регистра, цифры, пробел и дефис; число сегментов по-прежнему не
# ограничено сверху (было верно и раньше — суффиксный цикл уже принимал
# доп. "/"-сегменты, просто не давал в них ту же ширину символов, что и в
# первом). Требование «первый символ строки — буква, не цифра» осталось
# (общее и для designation, и для search, см. ниже) — так реальные
# обозначения (АНО/…, ООО/…) отличаются от паспортных данных оборудования
# («220V/1PH/50HZ», всегда начинается с числа).
_SEGMENT_CHARS = r"А-ЯЁа-яёA-Za-z0-9 .\-"
# Г.67 (второй заход) — реальная проверка на комплекте нашла регрессию
# ИМЕННО от этого расширения: PDF переносит длинное обозначение субподрядчика
# посреди строки («...11/111-» / перенос строки / «РД-СКТВ»), и раз "-" сам
# теперь входит в символьный класс СЕГМЕНТА (не только как разделитель между
# сегментами, как было в старой регулярке с циклом «разделитель+контент»),
# усечённый фрагмент «...11/111-» сам по себе стал ПОЛНЫМ валидным
# совпадением — обрубок регистрировался как отдельная (неверная) строка
# ведомости без хвоста. Негативный лукбихайнд запрещает совпадению
# заканчиваться пробелом/точкой/дефисом — ровно то ограничение, которое
# старый цикл «разделитель, затем контент» давал бесплатно, а новый широкий
# класс сегмента потерял.
_DESIGNATION_RE = re.compile(
    rf"^[А-ЯЁа-яёA-Za-z][{_SEGMENT_CHARS}]*(?:/[{_SEGMENT_CHARS}]+){{2,}}(?<![ .\-])$"
)
# Ненаправленный поиск обозначения ВНУТРИ прозы (не целая строка) — здесь,
# в отличие от `_DESIGNATION_RE`, сознательно НЕ ослаблен до lowercase/
# пробела: это работает по ВСЕМУ корпусу текста, а не только по уже
# гейтированной странице ведомости, и более широкий символьный класс резко
# увеличил бы риск ложных совпадений на обычной прозе. Единственная правка
# Г.67 — первый сегмент обязан НАЧИНАТЬСЯ С БУКВЫ, не с цифры: реальный
# ложный класс, найденный на реальном комплекте — паспортные данные оборудования
# в спецификациях вида «220V/1PH/50HZ» (3 сегмента через "/", всё
# заглавными буквами и цифрами — по старой регулярке неотличимо от
# обозначения комплекта). Настоящие обозначения (АНО/…, ТЕСТ/…) всегда
# начинаются с буквенного кода разработчика/заказчика, не с числа.
# Одного «первый символ — буква» недостаточно: ненаправленный `.finditer`
# без анкера мог бы начать совпадение с буквы В СЕРЕДИНЕ рейтинга
# («220V/1PH/50HZ» → «V/1PH/5», реальный случай, пойманный тестом) — нужен
# ещё негативный лукбихайнд «перед началом совпадения нет буквы/цифры»,
# чтобы совпадение начиналось на границе токена, а не с любой буквы подряд.
_DESIGNATION_SEARCH_RE = re.compile(
    r"(?<![А-ЯЁа-яёA-Za-z0-9])[А-ЯЁA-Z][А-ЯЁA-Z0-9]*/[А-ЯЁA-Z0-9]+/[А-ЯЁA-Z0-9]"
    r"(?:[./\-][А-ЯЁA-Z0-9.]+)*"
)
_MARKER_RE = re.compile(r"Состав\s+\w*\s*документации|ВЕДОМОСТЬ\s+ОСНОВНЫХ\s+КОМПЛЕКТОВ",
                        re.IGNORECASE)
_DEVELOPER_RE = re.compile(r"^(?:ООО|АО|ЗАО|ОАО|ПАО|ИП)\b")


@dataclass
class CompositionEntry:
    """Одна строка ведомости «Состав документации»."""
    designation: str
    name: str
    developer: Optional[str]
    page: int


def _page_lines(text: str) -> list[str]:
    return [ln.strip() for ln in text.split("\n") if ln.strip()]


def extract_composition_entries(text_facts: list[dict]) -> list[CompositionEntry]:
    """Разбирает лист(ы) ведомости «Состав документации» в реестр записей.

    Двухпроходная схема, а не «похоже на таблицу — разбираем»:
    1. По ВСЕМ страницам ищется маркер («Состав ... документации» /
       «ВЕДОМОСТЬ ОСНОВНЫХ КОМПЛЕКТОВ...») — страница с маркером даёт
       «свой шифр» (первая строка-обозначение на странице, обычно из
       штампа) и регистрирует его как шифр ведомости.
    2. Только страницы, чей «свой шифр» состоит в этом множестве —
       маркерная страница САМА, или страница-продолжение без заголовка,
       опознанная по тому же шифру в штампе (ведомость почти всегда
       длиннее одной страницы, Г.32-стиль многостраничного разбора) —
       парсятся в строки. Страница без маркера и без совпадения по шифру
       не трогается вообще, даже если её текст по форме похож на строку
       ведомости (`test_page_without_composition_marker_is_not_parsed`).

    Внутри разрешённой страницы граница строки — совпадение с
    `_DESIGNATION_RE`: всё до первого такого совпадения (шапка штампа,
    служебные поля) игнорируется, включая «свой шифр» листа — он не
    строка ведомости, а её адрес. Из «детали» между двумя обозначениями
    последняя строка становится разработчиком, только если узнаётся по
    `_DEVELOPER_RE` («ООО»/«АО»/...) — иначе строка-другая деталь
    остаётся частью наименования (перенос длинного названия, Г.20-стиль)."""
    pages: list[tuple[int, list[str]]] = [
        (fact["page"], _page_lines(fact["text"])) for fact in text_facts
    ]

    own_shifr_by_page: dict[int, Optional[str]] = {}
    marker_shifrs: set[str] = set()
    for page_no, lines in pages:
        own = next((ln for ln in lines if _DESIGNATION_RE.match(ln)), None)
        own_shifr_by_page[page_no] = own
        if own and _MARKER_RE.search("\n".join(lines)):
            marker_shifrs.add(own)

    if not marker_shifrs:
        return []

    entries: list[CompositionEntry] = []
    for page_no, lines in pages:
        own = own_shifr_by_page[page_no]
        if own is None or own not in marker_shifrs:
            continue

        body: list[str] = []
        skipped_own = False
        for ln in lines:
            if not skipped_own and ln == own:
                skipped_own = True
                continue
            body.append(ln)

        row_idxs = [i for i, ln in enumerate(body) if _DESIGNATION_RE.match(ln)]
        for pos, i in enumerate(row_idxs):
            designation = body[i]
            end = row_idxs[pos + 1] if pos + 1 < len(row_idxs) else len(body)
            detail = body[i + 1:end]
            developer = None
            if detail and _DEVELOPER_RE.match(detail[-1]):
                developer = detail[-1]
                detail = detail[:-1]
            entries.append(CompositionEntry(
                designation=designation, name=" ".join(detail),
                developer=developer, page=page_no,
            ))
    return entries


# --------------------------------------------------------------------------
# Текстовые ссылки на другие комплекты в прозе корпуса
# --------------------------------------------------------------------------

_REF_CHAST_RE = re.compile(
    r"(?:в\s+части|см\.?\s+часть)\s+([А-ЯЁA-Z0-9][А-ЯЁA-Z0-9\-]*)", re.IGNORECASE
)
_REF_TOM_RE = re.compile(r"том\s+(\d+(?:\.\d+)+)", re.IGNORECASE)


@dataclass(frozen=True)
class DocumentReference:
    """Одна найденная в прозе ссылка на другой комплект."""
    mark: str
    kind: str  # "часть" | "обозначение" | "том"
    page: int
    doc: Optional[str] = None


def find_document_references(text_facts: list[dict], doc: Optional[str] = None) -> list[DocumentReference]:
    """Ищет упоминания других комплектов по трём наблюдённым формам:
    «см./рассмотрено в части X», голое полное обозначение в тексте, «см.
    том N.N». Не голый свип по слову «см.» — тот же урок, что Г.19 уже
    выучил для якоря в прозе: «см. техническую подборку и КП» на реальном
    комплекте встречается десятками раз и не является ссылкой на комплект
    (`test_supplier_catalog_noise_is_not_a_reference`) — триггером служит
    сама конструкция «в части»/«см. часть», а не факт наличия «см.»."""
    out: list[DocumentReference] = []
    for fact in text_facts:
        text, page = fact["text"], fact["page"]
        for m in _REF_CHAST_RE.finditer(text):
            out.append(DocumentReference(mark=m.group(1), kind="часть", page=page, doc=doc))
        for m in _REF_TOM_RE.finditer(text):
            out.append(DocumentReference(mark=m.group(1), kind="том", page=page, doc=doc))
        for m in _DESIGNATION_SEARCH_RE.finditer(text):
            out.append(DocumentReference(mark=m.group(0).rstrip("."), kind="обозначение",
                                         page=page, doc=doc))
    return out


# --------------------------------------------------------------------------
# Сопоставление обозначения ведомости с фактически переданными файлами
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class SuppliedDocument:
    """Один реально переданный файл. `shifrs` — хвосты шифра, прочитанные
    из штампа (`stamp.read_stamp`), если имя файла ничего не говорит о
    комплекте (реальный случай в этой же сессии — имя файла с маркировкой и
    5.4.2 ОВ (1).pdf`, никак не намекающее на «ИОС5.4.2» из штампа)."""
    filename: str
    shifrs: tuple[str, ...] = ()


def _normalize_designation(designation: str) -> str:
    return designation.upper().replace("/", "-")


_FILENAME_TAIL_RE = re.compile(r"[ _]")


def _filename_prefix(filename: str) -> str:
    """Часть имени файла до первого пробела ИЛИ подчёркивания, без
    расширения. Имена томов на практике устроены как «шифр + хвост», где
    хвост — версия, номер изменения или диапазон листов, а разделителем
    перед ним бывает и пробел, и подчёркивание: оба варианта встретились
    в пределах ОДНОГО комплекта, то есть выбрать один нельзя. Ни пробел,
    ни подчёркивание в состав самого обозначения не входят
    (`_DESIGNATION_RE` их не допускает), поэтому первое из двух — всегда
    граница хвоста, а не часть шифра."""
    name = filename[:-4] if filename.lower().endswith(".pdf") else filename
    m = _FILENAME_TAIL_RE.search(name)
    return (name[:m.start()] if m else name).upper()


def match_supplied(
    entries: list[CompositionEntry], supplied: list[SuppliedDocument],
) -> dict[str, list[str]]:
    """{designation: [имена файлов]} — только для обозначений, для которых
    нашёлся хотя бы один переданный файл. Точное совпадение нормализованного
    обозначения с префиксом имени файла (не подстрока/vice-versa): более
    короткое обозначение НЕ засчитывается за более длинное с тем же
    началом («...-РД-КР» не должно закрываться файлом «...-РД-КР.2» —
    два разных подкомплекта, `test_shorter_designation_is_not_satisfied_by_longer_one`)."""
    result: dict[str, list[str]] = {}
    for e in entries:
        norm = _normalize_designation(e.designation)
        matched_files = []
        for s in supplied:
            if _filename_prefix(s.filename) == norm:
                matched_files.append(s.filename)
                continue
            if any(norm.endswith(shifr.upper()) for shifr in s.shifrs):
                matched_files.append(s.filename)
        if matched_files:
            result[e.designation] = matched_files
    return result


# --------------------------------------------------------------------------
# Три категории комплектности (Г.9, уровнем выше — на документах)
# --------------------------------------------------------------------------

def _canon(s: str) -> str:
    """Обозначение из ведомости использует «.» для подраздела марки
    («ИТП.УУТЭ»), а прозаическая ссылка на то же самое — «-»
    («ИТП-УУТЭ», реальный текст этого комплекта): для сопоставления МАРКИ
    ссылки с ХВОСТОМ обозначения оба разделителя равнозначны — в отличие
    от `match_supplied`, где точность обозначение-к-файлу важнее (там
    разделители сохраняются)."""
    return s.upper().replace("/", "-").replace(".", "-")


def _match_entry_for_ref(ref: "DocumentReference", entries: list[CompositionEntry]) -> Optional[str]:
    mark_canon = _canon(ref.mark)
    best: Optional[str] = None
    for e in entries:
        entry_canon = _canon(e.designation)
        if entry_canon == mark_canon or entry_canon.endswith("-" + mark_canon):
            if best is None or len(e.designation) > len(best):
                best = e.designation
    return best


@dataclass
class CompositionFinding:
    """Находка «предусмотренный документ не передан»."""
    designation: str
    finding_type: str  # "not_supplied"
    detail: str
    reference: DocumentReference
    reference_count: int


@dataclass
class CompletenessResult:
    """Результат сверки комплектности (три категории, как Г.9)."""
    findings: list[CompositionFinding] = field(default_factory=list)
    referenced_and_supplied: list[str] = field(default_factory=list)
    referenced_not_listed: list[DocumentReference] = field(default_factory=list)
    listed_not_referenced_not_supplied: list[str] = field(default_factory=list)
    supplied: list[str] = field(default_factory=list)


def check_completeness(
    entries: list[CompositionEntry],
    refs: list[DocumentReference],
    supplied: list[SuppliedDocument],
) -> CompletenessResult:
    """Ядро Г.17: упомянуто прозой + есть в ведомости + НЕ передано →
    находка. Упомянуто и передано → тихо. Упомянуто, но нет в ведомости →
    видимое «судить не о чем», не находка (не то, о чём говорит правило).
    В ведомости, но никто не упомянул и не передал → видимый
    информационный остаток, не находка (ведомость перечисляет ВЕСЬ
    проект, на сравнение всегда передают срез — иначе каждый прогон по
    одному разделу давал бы десятки ложных «нарушений»,
    `test_listed_but_never_referenced_is_not_a_finding`)."""
    matched = match_supplied(entries, supplied)
    supplied_designations = set(matched)

    refs_by_designation: dict[str, list[DocumentReference]] = {}
    referenced_not_listed: list[DocumentReference] = []
    for ref in refs:
        target = _match_entry_for_ref(ref, entries)
        if target is None:
            referenced_not_listed.append(ref)
        else:
            refs_by_designation.setdefault(target, []).append(ref)

    findings: list[CompositionFinding] = []
    referenced_and_supplied: list[str] = []
    for designation, matching_refs in refs_by_designation.items():
        if designation in supplied_designations:
            referenced_and_supplied.append(designation)
        else:
            first_ref = matching_refs[0]
            findings.append(CompositionFinding(
                designation=designation, finding_type="not_supplied",
                detail=f"{designation}: предусмотренный документ не передан "
                       f"(упомянут стр.{first_ref.page})",
                reference=first_ref, reference_count=len(matching_refs),
            ))

    listed = {e.designation for e in entries}
    listed_not_referenced_not_supplied = sorted(
        listed - set(refs_by_designation) - supplied_designations
    )

    return CompletenessResult(
        findings=findings,
        referenced_and_supplied=referenced_and_supplied,
        referenced_not_listed=referenced_not_listed,
        listed_not_referenced_not_supplied=listed_not_referenced_not_supplied,
        supplied=sorted(supplied_designations),
    )


def render_completeness_report(result: CompletenessResult) -> str:
    """Печатный отчёт — все три категории видимы, ни одна не тонет (Г.10)."""
    lines = ["=== Комплектность документации (Г.17) ===", f"Находки: {len(result.findings)}"]
    if result.findings:
        lines.append("\n--- not_supplied ---")
        for f in result.findings:
            lines.append(f"  [существенно] {f.detail} (упоминаний: {f.reference_count})")
    if result.referenced_and_supplied:
        lines.append(f"\nУпомянуто и передано ({len(result.referenced_and_supplied)}): "
                      + ", ".join(result.referenced_and_supplied))
    if result.referenced_not_listed:
        lines.append(f"\nСсылки вне ведомости — судить не о чем ({len(result.referenced_not_listed)}):")
        for r in result.referenced_not_listed:
            lines.append(f"  {r.mark} (стр.{r.page})")
    if result.listed_not_referenced_not_supplied:
        lines.append(
            f"\nВ ведомости, но не упомянуто и не передано — информационный остаток "
            f"({len(result.listed_not_referenced_not_supplied)}):"
        )
        lines.append("  " + ", ".join(result.listed_not_referenced_not_supplied))
    return "\n".join(lines)
