# Модель угроз

Угрозы, меры в коде и тесты, которые их проверяют. Меры, которых решение не
реализует, названы отдельно: выдавать их за сделанное нельзя.

Документы предоставляет поднадзорное лицо — сторона, заинтересованная в
сокрытии нарушений. Поэтому входные данные недоверенные по умолчанию, а вывод
системы — гипотеза для инспектора, а не заключение.

Тесты сервера — `packages/server/test/*.test.ts` (vitest), ML-модулей —
`packages/ml/tests/` (pytest).

## У-1. Инъекция инструкций через проверяемый документ

| Мера | Реализация | Проверка |
|---|---|---|
| Текст документа — данные, а не инструкции | `UNTRUSTED_INPUT_RULE` в каждом промпте (`ml/app/vision.py`, `official_pipeline.py`) | `test_official_pipeline.py::test_document_text_is_sent_as_untrusted_data` |
| Только структурированный ответ; неразобранный — техническая ошибка | `ml/app/llm.py`, `official_pipeline.py` | `test_official_pipeline.py::test_missing_model_is_reported_for_every_parameter_and_not_as_clean_result`, `test_llm.py::test_truncated_answer_is_an_error_not_an_empty_result` |
| Цитата обязана существовать на указанном листе | код ищет цитату на странице и строит bbox сам | `test_official_pipeline.py::test_candidate_needs_verified_quotes_and_boxes_from_both_sides` |
| Решение принимает человек | `CONFIRMED_VIOLATION` — только инспектор; финализация — когда все кандидаты решены | `process.test.ts` «решения: кодированная причина…», `protocol.test.ts` «в кандидаты — только с координатами…» |

## У-2. Утечка документов за пределы контура

| Мера | Реализация | Проверка |
|---|---|---|
| Модель только локальная; адрес вне контура отклоняется до запроса | `ml/app/llm.py` | `test_llm.py::test_external_address_is_refused_before_sending`, `test_model_availability.py::test_external_server_address_is_refused` |
| Адрес ИАИС «РиН» вне контура отклоняется | `server/src/domain/rin.ts` | `process.test.ts` «адрес РиН вне контура отклоняется до отправки» |
| Сеть сервисов без выхода наружу | сеть `contour` объявлена `internal` в `docker-compose.yml` | проверено запуском состава |
| Внутренний REST ML только со служебным токеном | `ml/app/service.py`, `server /internal/files` | `test_model_availability.py::test_internal_api_requires_the_contour_token` |
| Расшифрованные файлы живут только на время задачи | временный каталог задачи в tmpfs | `test_worker.py::test_workspace_is_removed_after_task` |

## У-3. Раскрытие данных «в покое»

| Мера | Реализация | Проверка |
|---|---|---|
| База зашифрована | SQLCipher, ключ — Docker secret (`server/src/db/database.ts`) | `process.test.ts` (база стенда тестов зашифрована) |
| Оригиналы зашифрованы | AES-256-GCM, SHA-256 как AAD (`server/src/storage/fileStore.ts`) | проверка целостности `admin.test.ts` |
| Кэш ML в Redis зашифрован и привязан к ключу | AES-256-GCM, имя ключа как AAD (`ml/app/kv.py`) | `test_kv.py::test_values_in_redis_are_encrypted_and_bound_to_the_key` |
| Резервные копии сохраняют шифрование | `VACUUM INTO` той же зашифрованной базы | `server/src/domain/backup.ts` |
| Канал | TLS 1.3 на nginx (порт 5443), к РиН — TLS 1.3 с клиентским сертификатом | конфигурация `docker/nginx-tls.conf`, `rin.ts` |

## У-4. Подмена документа или редакции

| Мера | Реализация | Проверка |
|---|---|---|
| SHA-256 каждого файла; значение из реестра сверяется | `server/src/domain/intake.ts` | `process.test.ts` «запрещает перезапись file_id…» |
| Файл, полученный ML, сверяется с отпечатком | `ml/app/sources.py::fetch` | устройство функции |
| Актуальная редакция по цепочке замены; неоднозначность — `CLARIFICATION_REQUIRED` | `official_pipeline.select_current_documents` | `test_official_pipeline.py::test_current_revision_requires_an_unambiguous_replacement_chain` |
| Воспроизводимость | `input_manifest_hash`, версии матрицы, модели, набора данных | `protocol.test.ts` «пять таблиц, карточки источников и версии» |

## У-5. Отказ в обслуживании и вредоносные файлы

| Мера | Реализация | Проверка |
|---|---|---|
| Антивирус до сохранения; недоступен — отказ, а не пропуск | `server/src/domain/antivirus.ts` (протокол clamd) | проверено запуском с ClamAV-совместимым сервисом |
| Тип по содержимому; повреждённый файл — отказ с причиной | `server/src/domain/formats.ts` | `process.test.ts` «отклоняет неподдерживаемый и повреждённый файл…», `cad.test.ts` |
| XML с DTD отклоняется (XXE) | `formats.ts`, `ml/app/document_convert.py` | `test_document_convert.py::test_xml_with_dtd_is_refused` |
| Лимиты: 50 МБ на файл, 200 МБ на пакет, число страниц | настройки сервера, nginx `client_max_body_size` | `routes/system.ts` (пределы ТЗ 9.1 в схеме) |
| Чтение чертежа — в отдельном потоке с лимитом 30 с | `server/src/domain/cad.ts` | `cad.test.ts` |
| Зависшая задача — повтор, затем `ERROR` и уведомление | `server/src/domain/pipeline.ts` | `process.test.ts` «таймаут обработки файла…» |
| Лимиты CPU и памяти контейнеров | `docker-compose.yml` | — |
| Лимиты частоты по IP: вход 10 в минуту, API 50 в секунду, до 50 соединений | `docker/nginx-tls.conf` (`limit_req`, `limit_conn`, ответ 429) | проверено запуском nginx |

## У-6. Компрометация цепочки поставки

| Мера | Реализация |
|---|---|
| Версии зависимостей закреплены | `packages/ml/requirements.txt`, `package-lock.json` |
| Образ сервера модели — по дайджесту | `scripts/offline/prepare_bundle.sh` |
| Офлайн-комплект сверяется с манифестом | `scripts/offline/load_bundle.sh` |
| Непривилегированный пользователь в образах | `docker/server.Dockerfile`, `docker/ml.Dockerfile` (uid 10001) |
| Скрипты установки npm в образе не выполняются | `npm ci --ignore-scripts` |

## У-7. Несанкционированный доступ и отрицание действий

| Мера | Реализация | Проверка |
|---|---|---|
| Всё, кроме входа и `/health`, — после входа | `server/src/auth/auth.ts` | `admin.test.ts` «всё, кроме входа и /health…» |
| Пароли — scrypt с солью | `server/src/auth/passwords.ts` | `admin.test.ts` «пароль хранится только хешем…» |
| Подбор пароля: после 5 неудач для пары «логин + IP» вход закрыт на 15 минут, событие в журнал безопасности | `server/src/auth/lockout.ts` | `admin.test.ts` «подбор пароля…» |
| IP клиента нельзя подделать заголовком: nginx передаёт только `$remote_addr` | `docker/nginx-tls.conf` | — |
| Роли разграничены | `requireRole` | `admin.test.ts` «роли ограничивают действия» |
| Каждое изменение записано; журнал только дополняется | `server/src/audit.ts`, триггеры схемы | `admin.test.ts` «изменение записано с пользователем, IP и User-Agent…» |
| Отмена финализации — только супервизор, с причиной, в журнал безопасности | `processes.unfinalize` | `process.test.ts` |

## Что решение не реализует

- Систему обнаружения вторжений и защиту от DDoS — средства периметра
  заказчика; сервис даёт им журнал безопасности, метрики и базовые лимиты
  частоты запросов на своём входе (nginx).
- Проверку усиленной электронной подписи: `signature_status` из реестра
  сохраняется как есть.
- Криптографию по ГОСТ: шифрование и TLS — стандартные алгоритмы;
  ГОСТ-TLS и подпись пакета УКЭП — на СКЗИ заказчика.
