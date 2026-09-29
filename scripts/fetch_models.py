#!/usr/bin/env python3
"""Скачать веса моделей в каталог models/, если их там нет.

Запускается разовым сервисом `models` в docker-compose.yml перед моделью и
ML-модулями; вручную — `python3 scripts/fetch_models.py models`. Источник —
публичная папка команды на Яндекс.Диске (INSPECTOR_MODELS_URL), при её
недоступности — Hugging Face. Только стандартная библиотека Python. Полные
модели не скачиваются повторно, файлы нужного размера пропускаются.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_URL = "https://disk.yandex.ru/d/fRWLLBTKeV1CXw"
YANDEX_API = "https://cloud-api.yandex.net/v1/disk/public/resources"
HUB = "https://huggingface.co"
MODELS = {
    "Qwen2.5-VL-7B-Instruct": "Qwen/Qwen2.5-VL-7B-Instruct",
    "paraphrase-multilingual-MiniLM-L12-v2": "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
}
# Для эмбеддингов берутся только файлы, которые читает программа, а не все
# варианты весов из репозитория модели.
ONLY = {"paraphrase-multilingual-MiniLM-L12-v2": {"config.json", "tokenizer.json", "onnx/model.onnx",
                                                  "model.onnx"}}
VISION_REQUIRED = ("config.json", "tokenizer.json", "tokenizer_config.json", "preprocessor_config.json")
PAGE = 1000
MAX_DEPTH = 4
TIMEOUT = 120


class Http:
    def get_json(self, url: str) -> dict:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as response:
            return json.load(response)

    def download(self, url: str, dest: Path) -> None:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as response, dest.open("wb") as out:
            shutil.copyfileobj(response, out, 8 * 1024 * 1024)


def _complete(folder: Path, name: str) -> bool:
    if name == "paraphrase-multilingual-MiniLM-L12-v2":
        return (folder / "tokenizer.json").is_file() and any(
            (folder / p).is_file() for p in ("model.onnx", "onnx/model.onnx"))
    if not all((folder / f).is_file() for f in VISION_REQUIRED):
        return False
    index = folder / "model.safetensors.index.json"
    shards = (set(json.loads(index.read_text(encoding="utf-8"))["weight_map"].values())
              if index.is_file() else {p.name for p in folder.glob("*.safetensors")})
    return bool(shards) and all((folder / s).is_file() and (folder / s).stat().st_size > 0 for s in shards)


def missing(root: Path) -> list[str]:
    return [name for name in MODELS if not _complete(root / name, name)]


def _save(http, url: str, dest: Path, size: int | None) -> None:
    if dest.is_file() and size is not None and dest.stat().st_size == size:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial = dest.with_name(dest.name + ".part")
    http.download(url, partial)
    partial.replace(dest)


def _yandex_items(http, public_url: str, path: str) -> list[dict]:
    items, offset = [], 0
    while True:
        query = urllib.parse.urlencode({"public_key": public_url, "path": path, "limit": PAGE, "offset": offset})
        embedded = http.get_json(f"{YANDEX_API}?{query}").get("_embedded", {})
        batch = embedded.get("items", [])
        items.extend(batch)
        offset += len(batch)
        if not batch or offset >= embedded.get("total", 0):
            return items


def _yandex_files(http, public_url: str, path: str) -> list[dict]:
    files = []
    for item in _yandex_items(http, public_url, path):
        files.extend([item] if item["type"] == "file" else _yandex_files(http, public_url, item["path"]))
    return files


def _yandex_models(http, public_url: str, path: str = "/", depth: int = 0) -> dict[str, str]:
    """Пути папок моделей в публичной папке — на любой глубине вложенности."""
    found: dict[str, str] = {}
    for item in _yandex_items(http, public_url, path):
        if item["type"] != "dir":
            continue
        if item["name"] in MODELS:
            found[item["name"]] = item["path"]
        elif depth < MAX_DEPTH:
            found.update(_yandex_models(http, public_url, item["path"], depth + 1))
    return found


def from_yandex(http, root: Path, public_url: str, names: list[str]) -> None:
    folders = _yandex_models(http, public_url)
    for name in names:
        if name not in folders:
            raise FileNotFoundError(f"в папке {public_url} нет {name}")
        print(f"Яндекс.Диск: {name}", flush=True)
        for item in _yandex_files(http, public_url, folders[name]):
            relative = item["path"][len(folders[name]):].lstrip("/")
            if name in ONLY and relative not in ONLY[name]:
                continue
            query = urllib.parse.urlencode({"public_key": public_url, "path": item["path"]})
            href = http.get_json(f"{YANDEX_API}/download?{query}")["href"]
            _save(http, href, root / name / relative, item.get("size"))


def from_hub(http, root: Path, names: list[str]) -> None:
    for name in names:
        repo = MODELS[name]
        print(f"Hugging Face: {repo}", flush=True)
        files = [s["rfilename"] for s in http.get_json(f"{HUB}/api/models/{repo}")["siblings"]]
        wanted = ONLY.get(name)
        for relative in files:
            if wanted is None or relative in wanted:
                _save(http, f"{HUB}/{repo}/resolve/main/{relative}", root / name / relative, None)


def fetch(root: Path, public_url: str, yandex=None, hub=None) -> list[str]:
    root.mkdir(parents=True, exist_ok=True)
    names = missing(root)
    if not names:
        print("Веса моделей на месте.", flush=True)
        return []
    try:
        from_yandex(yandex or Http(), root, public_url, names)
    except Exception as exc:  # noqa: BLE001 — любой сбой источника ведёт к запасному
        print(f"Яндекс.Диск недоступен ({type(exc).__name__}: {exc}); качаю с Hugging Face", flush=True)
    names = missing(root)
    if names:
        try:
            from_hub(hub or Http(), root, names)
        except Exception as exc:  # noqa: BLE001 — итог сообщается списком недостающих моделей
            print(f"Hugging Face недоступен ({type(exc).__name__}: {exc})", flush=True)
    return missing(root)


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "models")
    left = fetch(root, os.environ.get("INSPECTOR_MODELS_URL") or DEFAULT_URL)
    if left:
        print(f"Не удалось скачать: {', '.join(left)}. Скачайте папки моделей по ссылке "
              f"{os.environ.get('INSPECTOR_MODELS_URL') or DEFAULT_URL} и положите их в models/ "
              "(см. docs/ЗАПУСК.md), затем повторите docker compose up -d", file=sys.stderr)
        return 1
    print("Веса моделей готовы.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
