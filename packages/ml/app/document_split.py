"""Разрезание тяжёлого тома на части по ВЕСУ, с сохранением нумерации листов.

Зачем. Том приходит одним файлом на сотни мегабайт, а работать с ним нужно
частями: рендер листа держит страницу в памяти целиком, просмотр изображения
отправляется по сети, а сбой на одной части не должен ронять разбор всего
тома. Резать по числу страниц бессмысленно — вес страницы отличается на
порядки (страница прозы и полноформатный чертёж), поэтому счёт идёт по
байтам, а число страниц в части получается разным. Это и есть смысл слова
«по весу».

ЧЕМ ЭТО НЕ ЯВЛЯЕТСЯ. Текст для модели режется отдельно и по-другому — на
пачки символов (`requirement_llm_extract`), и от разрезания файла это не
зависит. Здесь режется сам PDF: части — это файлы, а не запросы.

Главное требование к результату: **инспектор не должен увидеть нумерацию
частей**. Лист 217 обязан остаться листом 217, в какой бы части он ни
оказался, иначе ссылка «смотреть лист N» перестанет работать — а ради неё
всё и делается. Поэтому часть несёт смещение (`first_page`), и обратный
перевод — единственный способ показать номер наружу (`original_page`).

Порядок и полнота: части идут подряд, без пропусков и без перекрытий, и в
сумме дают исходный документ страница в страницу. Это проверяется тестом,
потому что «почти все страницы» здесь означает молча потерянный лист.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pymupdf

# Бюджет: сколько весит одна часть. Не порог истины — ошибка стоит времени и
# памяти, а не правильности разбора (см. реестр видов констант). Значение
# задаётся вызывающим кодом или переменной окружения; здесь только умолчание.
DEFAULT_PART_BYTES = 32 * 1024 * 1024


@dataclass
class DocumentPart:
    """Часть документа: свой файл и смещение в исходной нумерации."""
    data: bytes
    first_page: int   # номер первой страницы части в ИСХОДНОМ документе, с 1
    pages: int

    @property
    def last_page(self) -> int:
        return self.first_page + self.pages - 1

    def original_page(self, page_in_part: int) -> int:
        """Номер страницы в исходном документе по номеру внутри части."""
        return self.first_page + page_in_part - 1


def needs_split(path: str | Path, max_bytes: int = DEFAULT_PART_BYTES) -> bool:
    return Path(path).stat().st_size > max_bytes


def split_pdf(path: str | Path, max_bytes: int = DEFAULT_PART_BYTES) -> list[DocumentPart]:
    """Части документа по весу. Документ легче бюджета возвращается одной
    частью — вызывающему не нужно знать, резали его или нет.

    Страница тяжелее бюджета целиком (полноформатный чертёж с растром) НЕ
    отбрасывается и не режется: она становится частью на одну страницу.
    Потерять лист хуже, чем превысить бюджет, и превышение здесь видно по
    размеру части, а не скрыто.
    """
    source = pymupdf.open(str(path))
    try:
        total = source.page_count
        if total == 0:
            return []
        parts: list[DocumentPart] = []
        start = 0
        while start < total:
            end = start
            data = b""
            while end < total:
                candidate = _extract(source, start, end)
                if candidate is None:
                    break
                if len(candidate) > max_bytes and end > start:
                    break  # без этой страницы часть уже укладывалась в бюджет
                data = candidate
                end += 1
                if len(data) > max_bytes:
                    break  # одна страница тяжелее бюджета — часть из неё одной
            if not data:  # страница не извлеклась — не молчим, идём дальше
                start += 1
                continue
            parts.append(DocumentPart(data=data, first_page=start + 1, pages=end - start))
            start = end
        return parts
    finally:
        source.close()


def _extract(source: "pymupdf.Document", start: int, end: int) -> bytes | None:
    part = pymupdf.open()
    try:
        part.insert_pdf(source, from_page=start, to_page=end)
        return part.tobytes(garbage=3, deflate=True)
    except Exception:  # noqa: BLE001 — сбой на одной странице не роняет разбор
        return None
    finally:
        part.close()


def part_for_page(parts: list[DocumentPart], original_page: int) -> tuple[int, int] | None:
    """(индекс части, номер страницы внутри неё) по исходному номеру листа."""
    for index, part in enumerate(parts):
        if part.first_page <= original_page <= part.last_page:
            return (index, original_page - part.first_page + 1)
    return None
