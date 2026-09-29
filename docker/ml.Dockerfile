# ML-модули «Инспектор ИИ» (ТЗ 1.5): воркер очереди и внутренний REST.
# Один образ, два процесса — роль задаёт команда в docker-compose.yml.
# Базовый образ закреплён выпуском ОС: пересборка не должна молча менять
# версию Tesseract и путь к его словарям.
FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata \
    INSPECTOR_ENV=production \
    INSPECTOR_SECRETS_DIR=/run/secrets \
    INSPECTOR_ML_WORKDIR=/tmp/inspector-ml \
    INSPECTOR_EMBEDDING_MODEL_DIR=/models/paraphrase-multilingual-MiniLM-L12-v2 \
    KNOWN_VIOLATIONS_PATH=/app/data/known_violations.json

WORKDIR /app

# Tesseract — локальное распознавание страниц без текстового слоя: внешние
# OCR-сервисы в закрытом контуре недопустимы. Русский словарь обязателен.
# OpenCV (CV-анализ чертежей) требует libgl1 и libglib2.0.
RUN apt-get update && apt-get install -y --no-install-recommends \
        fonts-dejavu-core libgl1 libglib2.0-0 \
        tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/* \
    && test -f "$TESSDATA_PREFIX/rus.traineddata" \
    && test -f "$TESSDATA_PREFIX/eng.traineddata"

COPY packages/ml/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY packages/ml/app ./app
COPY data/known_violations.json ./data/known_violations.json

# Сборка падает, если распознавание в образе не настроено: иначе стенд
# поднялся бы и отвечал «движок распознавания не установлен» на каждом скане.
RUN python -c "from app.local_ocr import load_config; assert load_config() is not None, 'Tesseract rus+eng не настроен'"

RUN useradd --create-home --uid 10001 inspector && mkdir -p /tmp/inspector-ml /app/logs \
    && chown -R inspector:inspector /app /tmp/inspector-ml
USER inspector

EXPOSE 8090
CMD ["uvicorn", "app.service:app", "--host", "0.0.0.0", "--port", "8090"]
