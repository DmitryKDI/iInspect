/**
 * Зависимости сервера, собранные в одном месте: база, хранилище, очередь,
 * флаги Redis, ML-модули, журнал, метрики. Тесты подменяют очередь, флаги и
 * ML-модули заменителями в памяти; всё остальное — настоящее.
 */
import type { Config } from './config.js'
import type { Db } from './db/database.js'
import type { MlClient } from './mlClient.js'
import type { Logger } from './observability/logging.js'
import type { Metrics } from './observability/metrics.js'
import type { Broker } from './queue/broker.js'
import type { Flags } from './queue/flags.js'
import type { FileStore } from './storage/fileStore.js'

export interface Context {
  config: Config
  db: Db
  store: FileStore
  broker: Broker
  flags: Flags
  ml: MlClient
  log: Logger
  metrics: Metrics
  /** Проверка файла антивирусом контура; подменяется в тестах. */
  scan: (data: Buffer) => Promise<import('./domain/antivirus.js').ScanResult>
  /** Отправка пакета во внешнюю систему; подменяется в тестах. */
  send: (url: string, init: RequestInit & { dispatcher?: unknown }) => Promise<Response>
  now: () => Date
}
