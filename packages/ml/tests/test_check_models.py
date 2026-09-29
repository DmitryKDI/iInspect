from __future__ import annotations

import json
from pathlib import Path

from app import check_models


def _qwen(root: Path, shards: dict[str, bytes]) -> Path:
    folder = root / "Qwen2.5-VL-7B-Instruct"
    folder.mkdir(parents=True)
    for name in ("config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json",
                 "generation_config.json"):
        (folder / name).write_text("{}", encoding="utf-8")
    index = {"weight_map": {f"layer.{i}": name for i, name in enumerate(["a.safetensors", "b.safetensors"])}}
    (folder / "model.safetensors.index.json").write_text(json.dumps(index), encoding="utf-8")
    for name, data in shards.items():
        (folder / name).write_bytes(data)
    return folder


def test_complete_weights_pass(tmp_path):
    folder = _qwen(tmp_path, {"a.safetensors": b"1", "b.safetensors": b"2"})
    assert check_models.vision_model_problems(folder) == []


def test_missing_shard_is_named(tmp_path):
    folder = _qwen(tmp_path, {"a.safetensors": b"1"})
    assert check_models.vision_model_problems(folder) == ["нет файла весов b.safetensors"]


def test_empty_shard_is_named(tmp_path):
    # Прерванная загрузка оставляет файл нулевого размера.
    folder = _qwen(tmp_path, {"a.safetensors": b"1", "b.safetensors": b""})
    assert check_models.vision_model_problems(folder) == ["файл весов b.safetensors пустой"]


def test_missing_folder_is_reported(tmp_path):
    assert check_models.vision_model_problems(tmp_path / "absent") == [f"нет каталога {tmp_path / 'absent'}"]
