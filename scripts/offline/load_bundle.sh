#!/usr/bin/env bash
# Запуск на стенде БЕЗ Интернета: загрузить образы, сверить с манифестом,
# создать секреты, поднять систему. Повторный запуск безопасен.
#
# Требования к стенду: Linux, Docker с compose, NVIDIA-драйвер на хосте и
# NVIDIA Container Toolkit. Драйвер в комплект не входит; CUDA runtime — в
# образе vLLM.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

MANIFEST=bundle/MANIFEST.txt
[ -f "$MANIFEST" ] || { echo "нет $MANIFEST — сначала scripts/offline/prepare_bundle.sh" >&2; exit 1; }
value() { grep -m1 "^$1=" "$MANIFEST" | cut -d= -f2-; }

MODEL_DIR="$(value model_dir)"
[ -f "models/${MODEL_DIR}/config.json" ] || { echo "веса модели не найдены: models/${MODEL_DIR}" >&2; exit 1; }

echo "1/4 Загрузка образов"
docker load -i bundle/inspector-images.tar

echo "2/4 Сверка образов с манифестом"
# Загружен ровно тот образ, что собран и проверен, а не одноимённый.
grep '^image_id ' "$MANIFEST" | while read -r _ pair; do
  image="${pair%%=*}"; expected="${pair#*=}"
  actual="$(docker image inspect -f '{{.Id}}' "$image")"
  [ "$actual" = "$expected" ] || { echo "образ $image не совпадает с манифестом" >&2; exit 1; }
done

echo "3/4 Секреты и базы антивируса"
scripts/make-secrets.sh
docker volume create inspector-ai_clamav-db >/dev/null
docker run --rm -v inspector-ai_clamav-db:/target -v "$ROOT/bundle/clamav:/source:ro" \
  --entrypoint sh clamav/clamav:1.4 -c 'cp -n /source/* /target/ 2>/dev/null || true'

echo "4/4 Запуск"
INSPECTOR_MODEL_DIR="$MODEL_DIR" docker compose up -d --no-build
echo "Интерфейс: https://localhost:5443"
echo "API: https://localhost:5443/api/v1, схема: /api/v1/openapi.json"
echo "Первый запуск модели — несколько минут (загрузка весов в GPU): docker compose ps"
