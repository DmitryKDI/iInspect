#!/usr/bin/env bash
# Запуск стенда одной командой: ключи и сертификат (если их ещё нет), затем
# состав. Веса моделей скачивает сервис `models`, если их нет в ./models.
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/make-secrets.sh
docker compose up -d "$@"
echo
echo "Состав запущен. Первый запуск: скачивание весов (≈ 17 ГБ) и загрузка модели в GPU."
echo "Ход: docker compose logs -f models llm   Состояние: docker compose ps"
echo "Интерфейс: https://<адрес стенда>:5443   Вход: admin / admin"
