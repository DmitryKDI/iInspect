"""Семантические якоря (ТЗ 9.1, п.2): модель Sentence-BERT для поиска страниц.

ТЗ называет all-MiniLM-L6-v2 «или совместимые аналоги». Документы на
русском, поэтому по умолчанию — многоязычный аналог той же архитектуры
(MiniLM, 384 измерения, mean pooling), выгруженный в ONNX: модель работает
в контуре без PyTorch и без сети. Каталог модели задаёт
`INSPECTOR_EMBEDDING_MODEL_DIR` (`tokenizer.json` и `model.onnx` — в корне
каталога или в `onnx/`, как раскладывает выгрузка Hugging Face);
его готовит офлайн-комплект (`scripts/offline/prepare_bundle.sh`).

Без модели ранжирование остаётся лексическим (слова матрицы и regex_pattern),
и результат проверки называет это отдельным состоянием — «семантический
поиск не выполнялся», а не «похожих страниц нет».
"""

from __future__ import annotations

import hashlib
import os
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import kv

DEFAULT_MODEL = "paraphrase-multilingual-MiniLM-L12-v2"
# Длина фрагмента для модели, токенов: предел позиционных эмбеддингов MiniLM.
# ПРАВИЛО ФОРМАТА модели.
MAX_TOKENS = 256
# Сколько текстов кодировать за один проход: БЮДЖЕТ памяти процесса.
BATCH = 32


@dataclass(frozen=True)
class Status:
    available: bool
    model: str
    reason: str


def model_files(folder: Path) -> tuple[Path, Path] | None:
    """Пути к ONNX-модели и токенизатору или None, если чего-то нет."""
    tokenizer = folder / "tokenizer.json"
    if not tokenizer.is_file():
        return None
    for onnx in (folder / "model.onnx", folder / "onnx" / "model.onnx"):
        if onnx.is_file():
            return onnx, tokenizer
    return None


class Encoder:
    def __init__(self, folder: Path) -> None:
        import onnxruntime
        from tokenizers import Tokenizer

        files = model_files(folder)
        if files is None:
            raise FileNotFoundError(f"model.onnx или tokenizer.json не найдены в {folder}")
        onnx, tokenizer = files
        self.folder = folder
        self.name = folder.name
        self.tokenizer = Tokenizer.from_file(str(tokenizer))
        self.tokenizer.enable_truncation(MAX_TOKENS)
        self.tokenizer.enable_padding()
        self.session = onnxruntime.InferenceSession(
            str(onnx), providers=["CPUExecutionProvider"]
        )
        self.inputs = {item.name for item in self.session.get_inputs()}

    def encode(self, texts: list[str]) -> np.ndarray:
        vectors = []
        for start in range(0, len(texts), BATCH):
            encoded = self.tokenizer.encode_batch(
                [text or " " for text in texts[start : start + BATCH]]
            )
            ids = np.array([item.ids for item in encoded], dtype=np.int64)
            mask = np.array([item.attention_mask for item in encoded], dtype=np.int64)
            feed = {"input_ids": ids, "attention_mask": mask}
            if "token_type_ids" in self.inputs:
                feed["token_type_ids"] = np.zeros_like(ids)
            vectors.append(pool(self.session.run(None, feed)[0], mask))
        return np.vstack(vectors) if vectors else np.zeros((0, 1), dtype=np.float32)


def pool(output: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Нормированный вектор предложения: среднее по токенам маски или готовый вектор выгрузки."""
    if output.ndim == 3:
        weights = mask[..., None].astype(np.float32)
        output = (output * weights).sum(axis=1) / np.clip(weights.sum(axis=1), 1e-9, None)
    return output / np.clip(np.linalg.norm(output, axis=1, keepdims=True), 1e-9, None)


_ENCODER: Encoder | None = None
_STATUS: Status | None = None
_LOCK = threading.Lock()


def _folder() -> Path:
    configured = os.environ.get("INSPECTOR_EMBEDDING_MODEL_DIR", "").strip()
    return Path(configured) if configured else Path("/models") / DEFAULT_MODEL


def status() -> Status:
    encoder()
    return _STATUS or Status(False, DEFAULT_MODEL, "модель не загружалась")


def encoder() -> Encoder | None:
    """Кодировщик или None, если модели нет в контуре (причина — в status())."""
    global _ENCODER, _STATUS
    with _LOCK:
        if _STATUS is not None:
            return _ENCODER
        folder = _folder()
        if model_files(folder) is None:
            _STATUS = Status(False, folder.name, f"модель Sentence-BERT не найдена в {folder}")
            return None
        try:
            _ENCODER = Encoder(folder)
            _STATUS = Status(True, folder.name, "")
        except Exception as exc:  # noqa: BLE001 — сбой загрузки — состояние, а не падение проверки
            _STATUS = Status(
                False, folder.name, f"модель не загружена: {type(exc).__name__}: {exc}"
            )
        return _ENCODER


def use(custom: Encoder | None, reason: str = "") -> None:
    """Подменить кодировщик (тесты); None с причиной — «модели нет»."""
    global _ENCODER, _STATUS
    with _LOCK:
        _ENCODER = custom
        _STATUS = Status(custom is not None, getattr(custom, "name", DEFAULT_MODEL), reason)


def page_vectors(digest: str, texts: list[str]) -> np.ndarray | None:
    """Векторы страниц документа; кэшируются по отпечатку файла и модели."""
    model = encoder()
    if model is None:
        return None
    key = f"embed:{model.name}:{digest}:{hashlib.sha256('|'.join(texts).encode()).hexdigest()[:16]}"
    cached = kv.store().get_bytes(key)
    if cached is not None:
        return np.frombuffer(cached, dtype=np.float32).reshape(len(texts), -1)
    vectors = model.encode(texts).astype(np.float32)
    kv.store().set_bytes(key, vectors.tobytes())
    return vectors


def similarity(query: str, vectors: np.ndarray) -> np.ndarray | None:
    model = encoder()
    if model is None or vectors is None or not len(vectors):
        return None
    return vectors @ model.encode([query])[0]
