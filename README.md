# Инспектор ИИ

Интеллектуальный сервис для автоматической сверки трёх массивов строительной
документации — проектной (ПД), рабочей (РД) и исполнительной (ИД) — по
**132 параметрам** Матрицы контроля (ТЗ задачи № 10, Мосстройнадзор).

Сервис находит **кандидатов в нарушения** с доказательствами на листах
сравниваемых стадий; подтверждает нарушение только инспектор. Работает
**офлайн в закрытом контуре**: модель локальная, внешних API нет.

## Архитектура (ТЗ 1.5)

```text
 браузер ── HTTPS (TLS 1.3) ── nginx ── /api ──┐
  React (frontend/)                             │
                                   Node.js-сервер (packages/server)
                                   REST /api/v1, OpenAPI 3.0.3
                                   SQLCipher · хранилище AES-256-GCM
                                   аудит · РиН · фоновые задачи
                                     │ RabbitMQ           │ REST (служебный токен)
                                     ▼                     ▼
                              ML-воркер (Python)     ML-API (Python)
                              разбор · OCR · CV      лист · метрики · правила
                              сверка по матрице
                              свободный поиск
                                 │        │
                             Redis     vLLM (GPU)
                        кэш по хешу   Qwen2.5-VL-7B
```

| Компонент | Технология | Каталог |
|---|---|---|
| Клиент | React 18, TypeScript, Vite | `frontend/` |
| Сервер | Node.js 22, Fastify 5, TypeScript | `packages/server/` |
| ML-модули | Python 3.12: PyMuPDF, Tesseract, OpenCV, ezdxf, ONNX Runtime | `packages/ml/` |
| Очередь | RabbitMQ 4 | `inspector.parse`, `inspector.inspect`, `inspector.results`, `inspector.progress` |
| Кэш | Redis 7.2 (значения зашифрованы) | разбор документа по SHA-256, ответы модели, флаг остановки |
| База | SQLite с шифрованием SQLCipher | все таблицы ТЗ 10 |
| Модель | vLLM + Qwen2.5-VL-7B-Instruct | сервис `llm` |
| Антивирус | ClamAV | проверка до сохранения файла |
| Мониторинг | Prometheus, Grafana, Alertmanager; ELK | профили `monitoring`, `logging` |

## Запуск

Одна команда (нужны Docker, GPU NVIDIA и NVIDIA Container Toolkit):

```bash
scripts/start.sh                 # или: make up
```

Она создаёт ключи шифрования, пароли и TLS-сертификат, а затем поднимает
состав. Веса моделей (≈ 17 ГБ) при первом запуске скачивает сервис `models`
в `./models`: с Яндекс.Диска команды
(**https://disk.yandex.ru/d/fRWLLBTKeV1CXw**), при его недоступности — с
Hugging Face. Уже скачанные веса повторно не загружаются. Ход загрузки —
`docker compose logs -f models`.

На стенде без Интернета — офлайн-комплект: `scripts/offline/prepare_bundle.sh`
(на машине с сетью) и `scripts/offline/load_bundle.sh` (на стенде). Подробно,
включая настройки стенда (1× H100, 24 ядра, 640 ГБ ОЗУ, общий GPU), —
[docs/ЗАПУСК.md](docs/ЗАПУСК.md).

Интерфейс — `https://стенд:5443`, API — `https://стенд:5443/api/v1`
(TLS 1.3; сертификат и ключ находятся в `./certs`), схема — `/api/v1/openapi.json` и
[docs/openapi.json](docs/openapi.json). Первый вход — `admin` / `admin`
(задаётся в `.env`).

## Программный интерфейс (ТЗ 1.3–1.4, 9)

REST over HTTPS, JSON, каждый запрос проверяется схемой OpenAPI 3.0.
Асинхронная pull-модель:

```text
POST /api/v1/documents/upload                 файлы + реестр (JSON/CSV/XLSX) → process_id, статус,
                                              статусы загрузки, сценарий, accepted[], rejected[];
                                              process_id в форме — дозагрузка
GET  /api/v1/processes/{id}/status            мониторинг: статус, этап, прогресс
GET  /api/v1/processes/{id}                   протокол: загрузка, сценарий, пять таблиц, версии
POST /api/v1/processes/{id}/decisions         решение инспектора (отклонение — с reason_code)
POST /api/v1/processes/{id}/finalize          только когда у всех кандидатов есть решение
POST /api/v1/processes/{id}/unfinalize        супервизор/администратор, с причиной, в журнал
GET  /api/v1/processes/{id}/export?format=    json | xml | docx | pdf | csv
POST /api/v1/processes/{id}/suspicions/{sid}  решение по гипотезе свободного поиска
POST /api/v1/inspection/{id}                  передача в ИАИС «РиН» (только FINALIZED)
```

| Что | Значения |
|---|---|
| Статус процесса | `PENDING` → `PARSING` → `READY` → `VERIFYING` → `COMPLETED` → `FINALIZED` (+ `ERROR`, `CANCELLED`) |
| Статус загрузки | `PD/RD/ID_UPLOADED`, `_PARTIAL`, `_MISSING` |
| Сценарий | `FULL`, `PD_RD_ONLY`, `PD_ID_ONLY`, `RD_ID_ONLY`, `SINGLE_ONLY`, `PARTIALLY_LOADED` |
| Полнота | `COMPLETE`, `MISSING_EVIDENCE`, `NOT_APPLICABLE`, `NOT_COMPARABLE`, `CLARIFICATION_REQUIRED` |
| Находка | `CANDIDATE`, `NEGATIVE_VERIFIED`, `CONFIRMED_VIOLATION` (только инспектор), `SUSPICION` |

**Реестр файлов** — JSON, CSV (разделитель `,` или `;`) или XLSX. Обязательные
поля: `file_id`, `file_name`, `object_id`, `doc_stage`, `discipline`,
`document_code`, `revision`, `approval_status`; дополнительно `approval_date`,
`predecessor_id` / `successor_id`, `sha256`, `sheet_page_range`,
`signature_status`. Перезапись `file_id` другим содержимым запрещена. Без
реестра пакет принимается, каждый параметр получает `CLARIFICATION_REQUIRED`.

**Приём (ТЗ 9.1).** PDF, DOCX, XML, DWG/DXF — тип по содержимому, не по
расширению; XML с DTD отклоняется (XXE); лимиты 50 МБ на файл и 200 МБ на
пакет; антивирус до сохранения. Чертёж DWG/DXF приводится к DXF AC1032 и
отрисовывается в PDF с текстовым слоем; размеры сверяются с геометрией.
Разбор кэшируется в Redis по SHA-256. Сбой задачи — до двух повторов, затем
`ERROR` и уведомление администратора. Если модель не отвечает, проверка не
выдаётся за завершённую: задача уходит в повтор, затем в `ERROR`.

**Распознавание.** Tesseract (rus+eng), качество страницы `OK` /
`LOW_QUALITY` / `ABSTAIN`. CV-анализ чертежей: масштаб по согласию размерных
линий, распознавание линий (векторных и на скане — OpenCV), расхождение
размерной надписи с графикой. Семантические якоря — Sentence-BERT
(`paraphrase-multilingual-MiniLM-L12-v2`, ONNX); без модели — видимое
состояние `not_configured`.

**Протокол (ТЗ 9.2).** Пять таблиц, карточка доказательства: `finding_id`,
параметр, `expected/actual/delta`, по каждому источнику `file_id`, SHA-256,
стадия, шифр, редакция, статус утверждения, лист, bbox в [0;1]; версии
`matrix_version`, `model_version`, `dataset_version`, `input_manifest_hash`.
Дозагрузка инкрементальна: пересчитываются только параметры, для которых
появились данные; прежняя версия протокола сохраняется.

## Интерфейс

Вход по логину и паролю; меню по роли (инспектор, супервизор,
администратор, ML-инженер, внешняя система):

- **Объекты** — дашборд: цвет объекта, фильтры по разделу, статусу и датам,
  выгрузки PDF/DOCX/XML (модуль 7);
- **Проверка ПД → РД → ИД** — загрузка и карточки документов, ход проверки,
  протокол с доказательствами на листе, решения с кодом причины, гипотезы
  свободного поиска, «Завершить», выгрузки (модули 1–3, 5);
- **Дообучение** — GOLD-набор, выпуски, реестр моделей, еженедельный отчёт
  (модули 4, 10);
- **Администрирование** — пользователи, матрица, нормативная база,
  логические правила, журнал аудита, целостность и копии (модули 8, 9).

## Безопасность и эксплуатация (ТЗ 12–13)

- база SQLCipher, хранилище оригиналов AES-256-GCM, кэш ML зашифрован;
  ключи — Docker secrets; TLS 1.3 на nginx; передача в РиН — TLS 1.3 с
  клиентским сертификатом;
- scrypt для паролей, сессии HttpOnly, роли, журнал аудита только
  дополняется (запрет на уровне базы);
- JSON-логи с `request_id` и `user_id`, ротация 90 / 365 дней, сбор в ELK;
- метрики Prometheus (запросы, 5xx, время ответа, очереди RabbitMQ,
  сессии, целостность, CPU, память, диск), алерты на почту и в Telegram;
- резервные копии каждые 15 минут и ежедневно, проверка контрольных сумм.

Модель угроз — [docs/threat-model.md](docs/threat-model.md).

## Модели

| Назначение | Модель | Лицензия |
|---|---|---|
| Текст и изображения листов | Qwen2.5-VL-7B-Instruct (ревизия — в `bundle/MANIFEST.txt`) | Apache-2.0 |
| Сервер модели | vLLM `v0.28.0`, образ закреплён дайджестом | Apache-2.0 |
| Семантические якоря | paraphrase-multilingual-MiniLM-L12-v2 (ONNX) | Apache-2.0 |
| Распознавание сканов | Tesseract OCR, rus+eng | Apache-2.0 |
| Чтение DWG/DXF | acad-ts (сервер), ezdxf (ML) | MIT |

Температура 0 и фиксированный seed: повторный прогон на тех же документах
воспроизводим. Лицензии сверить с карточками моделей при сборке комплекта.

## Разработка

```bash
make install        # зависимости
make test           # vitest (сервер) + pytest (ML)
make check-generic  # код общий для любой документации, константы объявлены
make lint           # ruff + tsc
make openapi        # docs/openapi.json
```

## Документация

| Файл | О чём |
|---|---|
| [docs/ЗАПУСК.md](docs/ЗАПУСК.md) | развёртывание, стенд, переменные |
| [docs/СТРУКТУРА-ПРОГРАММЫ.md](docs/СТРУКТУРА-ПРОГРАММЫ.md) | устройство простыми словами |
| [docs/ПРИЁМКА.md](docs/ПРИЁМКА.md) | приёмка качества по эталону (ТЗ 14) |
| [docs/threat-model.md](docs/threat-model.md) | модель угроз |
| [docs/import-substitution.md](docs/import-substitution.md) | импортозамещение и лицензии |
| [docs/integration-questions.md](docs/integration-questions.md) | вопросы к владельцам смежных систем |

## Правовая модель и ограничения

Система формирует **гипотезы**, а не заключения; ни одно юридически значимое
действие не совершается автоматически.

- Качество модели на реальных комплектах проверяется на стенде с GPU.
- Передача в ИАИС «РиН» выключена, пока не задан адрес приёма
  (`sync_status: LOCAL_ONLY`); формат приёма согласуется с владельцем системы.
- Шаблон протокола Приложения № 2 не предоставлен: протокол собран по тексту
  ТЗ (пять таблиц, карточки доказательств, версии).
