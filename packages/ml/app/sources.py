"""Файлы для разбора: получение с сервера и приведение к PDF.

Оригиналы хранит сервер — зашифрованными (ТЗ 12, п.3); ML-модуль получает
их по внутреннему REST (`/internal/files/<sha256>`, служебный токен контура)
только на время задачи и кладёт во временный каталог, который удаляется
вместе с задачей. Весь конвейер работает с PDF, поэтому:

- PDF разбирается как есть;
- DOCX и XML приводятся к PDF с текстовым слоем (`document_convert`);
- чертёж DWG/DXF сервер при приёме уже привёл к DXF (производный файл),
  здесь он отрисовывается в PDF с текстовым слоем (`cad.render`), а факты
  чертежа (размеры и их расхождение с геометрией) возвращаются отдельно.

Ключ разбора — SHA-256 оригинала: доказательство ссылается на загруженный
файл, а не на производный.
"""

from __future__ import annotations

import contextlib
import hashlib
import shutil
import tempfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from . import cad, config, document_convert
from .contracts import PermanentError

# Сколько ждать файл от сервера, секунд: пакет до 200 МБ по внутренней сети.
# БЮДЖЕТ времени задачи (ТЗ 11, п.8).
FETCH_TIMEOUT_S = 120.0

Fetcher = Callable[[str], bytes]


def fetch(sha256: str) -> bytes:
    """Файл из хранилища сервера; содержимое сверяется с отпечатком."""
    response = httpx.get(
        f"{config.server_url()}/internal/files/{sha256}",
        headers={"X-Internal-Token": config.internal_token()},
        timeout=FETCH_TIMEOUT_S,
    )
    if response.status_code == 404:
        raise PermanentError(f"файл {sha256[:12]}… не найден в хранилище сервера")
    response.raise_for_status()
    data = response.content
    if hashlib.sha256(data).hexdigest() != sha256:
        raise PermanentError(f"содержимое файла {sha256[:12]}… не совпадает с отпечатком")
    return data


_FETCHER: Fetcher = fetch


def use(custom: Fetcher | None) -> None:
    """Подменить получение файлов (тесты); None — обычное."""
    global _FETCHER
    _FETCHER = custom or fetch


@dataclass
class Source:
    """Документ, готовый к разбору: PDF во временном каталоге."""

    id: int
    name: str
    digest: str
    file_path: str
    pages: int = 0
    source_metadata: dict = field(default_factory=dict)
    source_format: str = "PDF"
    cad: cad.CadFacts | None = None


def to_pdf(document: dict, fetcher: Fetcher | None = None) -> tuple[bytes, cad.CadFacts | None]:
    """PDF для разбора и факты чертежа (если документ — чертёж)."""
    get = fetcher or _FETCHER
    source_format = str(document.get("source_format") or "PDF").upper()
    if source_format in {"DWG", "DXF"}:
        derived = document.get("derived_sha256")
        if not derived:
            raise PermanentError(
                "у чертежа нет производного DXF: сервер не принял его при загрузке"
            )
        try:
            return cad.render(get(derived))
        except ValueError as exc:
            raise PermanentError(str(exc)) from exc
    data = get(document["sha256"])
    try:
        converted = document_convert.to_pdf(data, str(document.get("name") or "документ"))
    except document_convert.UnsupportedFormatError as exc:
        raise PermanentError(str(exc)) from exc
    return converted.pdf, None


@contextlib.contextmanager
def workspace() -> Iterator[Path]:
    """Временный каталог задачи; удаляется вместе с расшифрованными файлами."""
    folder = Path(tempfile.mkdtemp(prefix="task-", dir=config.workdir()))
    try:
        yield folder
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def materialize(document: dict, folder: Path, fetcher: Fetcher | None = None) -> Source:
    pdf, facts = to_pdf(document, fetcher)
    path = folder / f"{document['sha256']}.pdf"
    path.write_bytes(pdf)
    return Source(
        id=int(document["id"]),
        name=str(document.get("name") or ""),
        digest=str(document["sha256"]),
        file_path=str(path),
        pages=int(document.get("pages") or 0),
        source_metadata=dict(document.get("metadata") or {}),
        source_format=str(document.get("source_format") or "PDF").upper(),
        cad=facts,
    )
