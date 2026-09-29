"""Проверка весов моделей в ./models до запуска состава.

Запуск в контейнере ML (зависимости уже в образе):
    docker compose run --rm --no-deps ml-api python -m app.check_models

vLLM при неполных весах падает только после долгой загрузки и с общей
ошибкой; здесь недостающий или оборванный файл называется сразу. Модель
эмбеддингов прогоняется тем же кодом, что использует проверка документов.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np

from . import semantic

VISION_REQUIRED = (
    "config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json",
)


def vision_model_problems(folder: Path) -> list[str]:
    if not folder.is_dir():
        return [f"нет каталога {folder}"]
    problems = [f"нет файла {name}" for name in VISION_REQUIRED if not (folder / name).is_file()]
    index = folder / "model.safetensors.index.json"
    if index.is_file():
        shards = sorted(set(json.loads(index.read_text(encoding="utf-8"))["weight_map"].values()))
    else:
        shards = sorted(path.name for path in folder.glob("*.safetensors"))
        if not shards:
            problems.append("нет файлов весов *.safetensors")
    for name in shards:
        path = folder / name
        if not path.is_file():
            problems.append(f"нет файла весов {name}")
        elif path.stat().st_size == 0:
            problems.append(f"файл весов {name} пустой")
    return problems


def embedding_problems() -> list[str]:
    status = semantic.status()
    if not status.available:
        return [status.reason]
    encoder = semantic.encoder()
    vectors = encoder.encode([
        "дата утверждения документа", "документ утверждён в эту дату", "номер листа в штампе",
    ])
    close, far = float(np.dot(vectors[0], vectors[1])), float(np.dot(vectors[0], vectors[2]))
    if close <= far:
        return [f"модель не различает смысл: близкие фразы {close:.2f}, далёкие {far:.2f}"]
    return []


def main() -> int:
    root = Path(os.environ.get("INSPECTOR_MODELS_DIR", "/models"))
    vision = root / os.environ.get("INSPECTOR_MODEL_DIR", "Qwen2.5-VL-7B-Instruct")
    os.environ.setdefault("INSPECTOR_EMBEDDING_MODEL_DIR", str(root / semantic.DEFAULT_MODEL))
    ok = True
    for title, problems in ((f"Модель проверки {vision}", vision_model_problems(vision)),
                            ("Модель эмбеддингов", embedding_problems())):
        print(f"{title}: {'готова' if not problems else 'НЕ ГОТОВА'}")
        for problem in problems:
            print(f"  - {problem}")
        ok = ok and not problems
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
