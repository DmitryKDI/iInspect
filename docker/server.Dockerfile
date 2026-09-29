# Сервер «Инспектор ИИ» (ТЗ 1.5): Node.js, REST API /api/v1, база SQLCipher,
# зашифрованное хранилище оригиналов, очередь задач ML.
# Целевая ОС — Astra Linux SE; здесь совместимый образ демонстрационного контура.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY packages/server/package.json packages/server/package-lock.json ./
# Модуль SQLCipher (better-sqlite3-multiple-ciphers) поставляется с готовыми
# сборками под linux-x64 и грузит их сам: компилятор и скрипты установки
# не нужны, сборка образа не требует сети кроме реестра npm.
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY packages/server/tsconfig.json ./
COPY packages/server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    INSPECTOR_ENV=production \
    INSPECTOR_ROOT=/app \
    INSPECTOR_DATA_DIR=/app/state \
    INSPECTOR_CATALOG_PATH=/app/data/parameter_catalog_v1_1.json \
    INSPECTOR_SECRETS_DIR=/run/secrets
WORKDIR /app/packages/server
# Шрифт с кириллицей — для выгрузки протокола в PDF.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY packages/server/package.json ./
COPY data/parameter_catalog_v1_1.json /app/data/parameter_catalog_v1_1.json
RUN useradd --create-home --uid 10001 inspector \
    && mkdir -p /app/state /app/backups /app/logs && chown -R inspector:inspector /app
USER inspector
EXPOSE 8010
HEALTHCHECK --interval=15s --timeout=5s --retries=10 \
    CMD node -e "fetch('http://127.0.0.1:8010/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
