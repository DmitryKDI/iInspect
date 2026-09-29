from __future__ import annotations

from pathlib import Path

from app import semantic


def _layout(root: Path, onnx_relative: str) -> Path:
    folder = root / semantic.DEFAULT_MODEL
    (folder / onnx_relative).parent.mkdir(parents=True, exist_ok=True)
    (folder / onnx_relative).write_bytes(b"onnx")
    (folder / "tokenizer.json").write_text("{}", encoding="utf-8")
    return folder


def test_onnx_in_model_root_is_found(tmp_path):
    folder = _layout(tmp_path, "model.onnx")
    assert semantic.model_files(folder) == (folder / "model.onnx", folder / "tokenizer.json")


def test_onnx_in_hugging_face_subfolder_is_found(tmp_path):
    # snapshot_download кладёт ONNX-выгрузку sentence-transformers в onnx/model.onnx
    folder = _layout(tmp_path, "onnx/model.onnx")
    assert semantic.model_files(folder) == (folder / "onnx" / "model.onnx", folder / "tokenizer.json")


def test_missing_files_report_the_folder(tmp_path):
    assert semantic.model_files(tmp_path / "absent") is None


def test_token_vectors_are_mean_pooled_over_the_mask():
    import numpy as np

    hidden = np.array([[[1.0, 0.0], [3.0, 0.0], [100.0, 100.0]]], dtype=np.float32)
    mask = np.array([[1, 1, 0]], dtype=np.int64)
    pooled = semantic.pool(hidden, mask)
    assert np.allclose(pooled, [[1.0, 0.0]])


def test_sentence_vector_export_is_used_as_is():
    # Часть ONNX-выгрузок sentence-transformers отдаёт уже готовый вектор предложения.
    import numpy as np

    sentence = np.array([[3.0, 4.0]], dtype=np.float32)
    pooled = semantic.pool(sentence, np.array([[1, 1, 1]], dtype=np.int64))
    assert np.allclose(pooled, [[0.6, 0.8]])
