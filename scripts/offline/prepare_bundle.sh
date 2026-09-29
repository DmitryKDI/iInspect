#!/usr/bin/env bash
# Сборка офлайн-комплекта. Выполняется ОДИН раз на машине с Интернетом.
#
# Результат — всё, что нужно стенду без сети:
#   bundle/inspector-images.tar  образы: server, ml, frontend, модель (vLLM),
#                                RabbitMQ, Redis, ClamAV, мониторинг и логи
#   bundle/clamav/               базы сигнатур антивируса на дату сборки
#   models/<каталог модели>      веса LLM (с диска, не из сети)
#   models/<модель эмбеддингов>  Sentence-BERT в ONNX (ТЗ 9.1, п.2)
#   bundle/MANIFEST.txt          версии: ревизии весов, ID образов, SHA-256
#
# Перенос на стенд: каталог репозитория вместе с bundle/ и models/.
# Запуск на стенде: scripts/offline/load_bundle.sh (без Интернета).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

VLLM_IMAGE="vllm/vllm-openai:v0.28.0"
VLLM_DIGEST="sha256:61fc8a896b0a4fbbbdc063bc4b0dbc25ce98e02b5050c24aeb7830ac02039b14"
MODEL_REPO="${INSPECTOR_MODEL_REPO:-Qwen/Qwen2.5-VL-7B-Instruct}"
MODEL_DIR="${INSPECTOR_MODEL_DIR:-Qwen2.5-VL-7B-Instruct}"
EMBED_REPO="${INSPECTOR_EMBEDDING_REPO:-sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2}"
EMBED_DIR="paraphrase-multilingual-MiniLM-L12-v2"
# Ревизия весов фиксируется коммитом репозитория модели. Пусто — берётся
# текущая, и её коммит записывается в манифест.
MODEL_REVISION="${INSPECTOR_MODEL_REVISION:-}"
THIRD_PARTY=(rabbitmq:4.1-management-alpine redis:7.2-alpine clamav/clamav:1.4
  prom/prometheus:v3.5.0 prom/alertmanager:v0.28.1 grafana/grafana:12.1.0
  elasticsearch:8.18.2 logstash:8.18.2 kibana:8.18.2 nginx:1.27-alpine)
OWN=(inspector-ai/server:local inspector-ai/ml:local inspector-ai/frontend:local)

mkdir -p bundle/clamav models

echo "1/6 Образ сервера модели по дайджесту"
docker pull "vllm/vllm-openai@${VLLM_DIGEST}"
docker tag "vllm/vllm-openai@${VLLM_DIGEST}" "$VLLM_IMAGE"

echo "2/6 Веса LLM ${MODEL_REPO} и модель эмбеддингов ${EMBED_REPO}"
# Скачивание — инструментом из того же образа vLLM: ставить ничего не нужно.
docker run --rm -v "$ROOT/models:/models" \
  -e MODEL_REPO="$MODEL_REPO" -e MODEL_DIR="$MODEL_DIR" -e MODEL_REVISION="$MODEL_REVISION" \
  -e EMBED_REPO="$EMBED_REPO" -e EMBED_DIR="$EMBED_DIR" \
  --entrypoint python3 "$VLLM_IMAGE" -c '
import os, shutil
from huggingface_hub import HfApi, hf_hub_download, snapshot_download
repo, rev = os.environ["MODEL_REPO"], os.environ["MODEL_REVISION"] or None
sha = HfApi().model_info(repo, revision=rev).sha
snapshot_download(repo_id=repo, revision=sha, local_dir="/models/" + os.environ["MODEL_DIR"])
open("/models/" + os.environ["MODEL_DIR"] + "/REVISION", "w").write(sha + "\n")
print("ревизия весов LLM:", sha)
embed = os.environ["EMBED_REPO"]; target = "/models/" + os.environ["EMBED_DIR"]
os.makedirs(target, exist_ok=True)
esha = HfApi().model_info(embed).sha
shutil.copy(hf_hub_download(embed, "onnx/model.onnx", revision=esha), target + "/model.onnx")
shutil.copy(hf_hub_download(embed, "tokenizer.json", revision=esha), target + "/tokenizer.json")
open(target + "/REVISION", "w").write(esha + "\n")
print("ревизия модели эмбеддингов:", esha)
'

echo "3/6 Образы server, ml, frontend"
docker compose build server ml-worker frontend

echo "4/6 Сторонние образы"
for image in "${THIRD_PARTY[@]}"; do docker pull "$image"; done

echo "5/6 Базы сигнатур антивируса"
docker run --rm -v "$ROOT/bundle/clamav:/var/lib/clamav" --entrypoint freshclam clamav/clamav:1.4 \
  --datadir=/var/lib/clamav --foreground

echo "6/6 Сохранение образов и манифест"
ALL=("$VLLM_IMAGE" "${OWN[@]}" "${THIRD_PARTY[@]}")
docker save -o bundle/inspector-images.tar "${ALL[@]}"
{
  echo "# Офлайн-комплект «Инспектор ИИ» — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "model_repo=${MODEL_REPO}"
  echo "model_revision=$(cat "models/${MODEL_DIR}/REVISION")"
  echo "model_dir=${MODEL_DIR}"
  echo "embedding_repo=${EMBED_REPO}"
  echo "embedding_revision=$(cat "models/${EMBED_DIR}/REVISION")"
  echo "vllm_digest=${VLLM_DIGEST}"
  for image in "${ALL[@]}"; do
    echo "image_id ${image}=$(docker image inspect -f '{{.Id}}' "$image")"
  done
  echo "images_tar_sha256=$(sha256sum bundle/inspector-images.tar | cut -d' ' -f1)"
  echo "# SHA-256 файлов весов"
  (cd models && find "$MODEL_DIR" "$EMBED_DIR" -type f ! -name REVISION -print0 | sort -z | xargs -0 sha256sum)
} > bundle/MANIFEST.txt

echo "Готово: bundle/ и models/. Перенесите их на стенд вместе с репозиторием."
