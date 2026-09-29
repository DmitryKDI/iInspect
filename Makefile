.PHONY: help install server ml web up down test check-generic lint security openapi clean

help:            ## Список команд
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/' | column -t -s "$$(printf '\t')"

install:         ## Установить зависимости для локальной разработки
	python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
	cd packages/server && npm install
	cd frontend && npm install

server:          ## Запустить сервер (Node.js, REST /api/v1)
	cd packages/server && npm run dev

ml:              ## Запустить ML-модули: воркер очереди и внутренний REST
	cd packages/ml && PYTHONPATH=. ../../.venv/bin/python -m app.worker & \
	cd packages/ml && PYTHONPATH=. ../../.venv/bin/python -m uvicorn app.service:app --port 8090

web:             ## Запустить интерфейс
	cd frontend && npm run dev

up:              ## Поднять всё одной командой: ключи, веса моделей, состав (нужен GPU)
	scripts/start.sh

openapi:         ## Выгрузить схему API (OpenAPI 3.0) в docs/openapi.json
	cd packages/server && npm run openapi

down:            ## Остановить и удалить контейнеры
	docker compose down -v

test:            ## Прогнать тесты сервера и ML-модулей
	cd packages/server && npm test
	PYTHONPATH=packages/ml .venv/bin/python -m pytest packages/ml/tests -q

check-generic:   ## Проверить, что код не заточен под конкретный пример
	PYTHONPATH=packages/ml .venv/bin/python -m pytest \
		packages/ml/tests/test_code_is_generic.py \
		packages/ml/tests/test_constants_are_declared.py -q

lint:            ## Стиль и границы модулей
	.venv/bin/ruff check packages/ml scripts
	cd packages/server && npx tsc --noEmit

security:        ## Локальный прогон проверок безопасности
	.venv/bin/bandit -q -r packages -c pyproject.toml
	.venv/bin/pip-audit -r packages/ml/requirements.txt || true
	cd packages/server && npm audit --omit=dev || true

clean:           ## Убрать сгенерированное
	rm -rf .pytest_cache htmlcov packages/server/dist
