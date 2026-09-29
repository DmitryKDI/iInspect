from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "fetch_models.py"
spec = importlib.util.spec_from_file_location("fetch_models", SCRIPT)
fetch_models = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch_models)

QWEN = "Qwen2.5-VL-7B-Instruct"
MINILM = "paraphrase-multilingual-MiniLM-L12-v2"
QWEN_FILES = {"config.json": b"{}", "tokenizer.json": b"{}", "tokenizer_config.json": b"{}",
              "preprocessor_config.json": b"{}", "model.safetensors": b"weights"}
MINILM_FILES = {"tokenizer.json": b"{}", "onnx/model.onnx": b"onnx"}


class FakeYandex:
    """Публичная папка: /models/<модель>/... — вложенность как при загрузке через проводник."""

    def __init__(self, fail: bool = False):
        self.fail = fail
        self.files = {f"/models/{QWEN}/{k}": v for k, v in QWEN_FILES.items()}
        self.files.update({f"/models/{MINILM}/{k}": v for k, v in MINILM_FILES.items()})
        self.files[f"/models/{MINILM}/pytorch_model.bin"] = b"x" * 10
        self.downloads = 0

    def get_json(self, url: str) -> dict:
        if self.fail:
            raise OSError("яндекс недоступен")
        query = parse_qs(urlparse(url).query)
        path = query.get("path", ["/"])[0]
        if urlparse(url).path.endswith("/download"):
            return {"href": "yadisk:" + path}
        prefix = path.rstrip("/") + "/"
        children = {}
        for name in self.files:
            if name.startswith(prefix):
                head = name[len(prefix):].split("/")[0]
                child = prefix + head
                children[child] = "file" if child in self.files else "dir"
        items = [{"name": p.rsplit("/", 1)[1], "path": p, "type": t,
                  **({"size": len(self.files[p])} if t == "file" else {})} for p, t in children.items()]
        return {"_embedded": {"items": items, "total": len(items)}}

    def download(self, url: str, dest: Path) -> None:
        self.downloads += 1
        dest.write_bytes(self.files[url.removeprefix("yadisk:")])


class FakeHub:
    def __init__(self):
        self.repos = {
            fetch_models.MODELS[QWEN]: QWEN_FILES,
            fetch_models.MODELS[MINILM]: {**MINILM_FILES, "pytorch_model.bin": b"x" * 10,
                                           "onnx/model_O4.onnx": b"y", "config.json": b"{}"},
        }
        self.fetched: list[str] = []

    def get_json(self, url: str) -> dict:
        repo = urlparse(url).path.removeprefix("/api/models/")
        return {"siblings": [{"rfilename": name} for name in self.repos[repo]]}

    def download(self, url: str, dest: Path) -> None:
        path = urlparse(url).path.lstrip("/")
        owner, name, _, _, *rest = path.split("/")
        self.fetched.append("/".join(rest))
        dest.write_bytes(self.repos[f"{owner}/{name}"]["/".join(rest)])


def test_yandex_folder_is_laid_out_under_models(tmp_path):
    source = FakeYandex()
    fetch_models.fetch(tmp_path, "https://disk.yandex.ru/d/x", yandex=source, hub=FakeHub())
    assert (tmp_path / QWEN / "model.safetensors").read_bytes() == b"weights"
    assert (tmp_path / MINILM / "onnx" / "model.onnx").read_bytes() == b"onnx"
    assert not (tmp_path / MINILM / "pytorch_model.bin").exists()
    assert fetch_models.missing(tmp_path) == []


def test_complete_models_are_not_downloaded_again(tmp_path):
    source = FakeYandex()
    fetch_models.fetch(tmp_path, "https://disk.yandex.ru/d/x", yandex=source, hub=FakeHub())
    first = source.downloads
    fetch_models.fetch(tmp_path, "https://disk.yandex.ru/d/x", yandex=source, hub=FakeHub())
    assert source.downloads == first


def test_hugging_face_is_used_when_yandex_fails(tmp_path):
    hub = FakeHub()
    fetch_models.fetch(tmp_path, "https://disk.yandex.ru/d/x", yandex=FakeYandex(fail=True), hub=hub)
    assert fetch_models.missing(tmp_path) == []
    # Для эмбеддингов нужны только токенизатор и ONNX, не веса PyTorch.
    assert "pytorch_model.bin" not in hub.fetched
    assert "onnx/model_O4.onnx" not in hub.fetched


def test_missing_names_what_is_absent(tmp_path):
    assert fetch_models.missing(tmp_path) == [QWEN, MINILM]
    (tmp_path / QWEN).mkdir()
    (tmp_path / QWEN / "model.safetensors.index.json").write_text(
        json.dumps({"weight_map": {"a": "part-1.safetensors"}}), encoding="utf-8")
    for name in ("config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json"):
        (tmp_path / QWEN / name).write_text("{}", encoding="utf-8")
    assert fetch_models.missing(tmp_path) == [QWEN, MINILM]
    (tmp_path / QWEN / "part-1.safetensors").write_bytes(b"1")
    assert fetch_models.missing(tmp_path) == [MINILM]


class Broken:
    def get_json(self, url: str) -> dict:
        raise OSError("нет сети")

    def download(self, url: str, dest: Path) -> None:
        raise OSError("нет сети")


def test_no_network_reports_missing_models_instead_of_crashing(tmp_path):
    assert fetch_models.fetch(tmp_path, "https://disk.yandex.ru/d/x", yandex=Broken(), hub=Broken()) == [
        QWEN, MINILM]
