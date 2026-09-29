#!/usr/bin/env bash
# Запуск ML-модулей без Docker (разработка): внутренний REST и воркер очереди.
# Нужны RabbitMQ и Redis (INSPECTOR_AMQP_URL, INSPECTOR_REDIS_URL) и сервер
# (INSPECTOR_SERVER_URL, INSPECTOR_INTERNAL_TOKEN) — см. docs/ЗАПУСК.md.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
fi

.venv/bin/python -m app.worker &
worker=$!
trap 'kill "$worker"' EXIT
.venv/bin/uvicorn app.service:app --host 127.0.0.1 --port 8090
