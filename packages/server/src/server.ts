/**
 * Сборка сервера: контекст, приложение, подписка на результаты ML-модулей,
 * фоновые задачи. Используется и точкой входа, и тестами.
 */
import type { FastifyInstance } from 'fastify'
import { ensureInitialAdmin } from './auth/auth.js'
import type { Config } from './config.js'
import type { Context } from './context.js'
import { openDatabase } from './db/database.js'
import { clamdScanner } from './domain/antivirus.js'
import { ensureSeeded } from './domain/parameters.js'
import { handleProgress, handleResult } from './domain/pipeline.js'
import { buildApp } from './http/app.js'
import * as jobs from './jobs.js'
import { HttpMlClient, type MlClient } from './mlClient.js'
import { Logger, SERVICE } from './observability/logging.js'
import { Metrics } from './observability/metrics.js'
import { AmqpBroker, type Broker } from './queue/broker.js'
import {
  QUEUE_INSPECT, QUEUE_PARSE, QUEUE_PROGRESS, QUEUE_RESULTS, type Progress, type TaskResult,
} from './queue/contracts.js'
import { RedisFlags, type Flags } from './queue/flags.js'
import { ensureKeys } from './secrets.js'
import { FileStore } from './storage/fileStore.js'

export interface Overrides {
  broker?: Broker
  flags?: Flags
  ml?: MlClient
  log?: Logger
  scan?: Context['scan']
  send?: Context['send']
  now?: () => Date
}

export async function createContext(input: Config, overrides: Overrides = {}): Promise<Context> {
  const log = overrides.log ?? new Logger(input.logLevel, input.env === 'production', input.logDir)
  const config = ensureKeys(input, (message) => log.warning(message, { event: 'bootstrap', security: true }))
  const db = openDatabase(config.dbPath, config.dbKey)
  const store = new FileStore(config.storageDir, config.storageKey)
  if (!overrides.broker && !config.amqpUrl) {
    throw new Error('очередь сообщений не настроена: задайте INSPECTOR_AMQP_URL (RabbitMQ, ТЗ 1.5)')
  }
  if (!overrides.flags && !config.redisUrl) {
    throw new Error('кэш не настроен: задайте INSPECTOR_REDIS_URL (Redis, ТЗ 9.1)')
  }
  const broker = overrides.broker ?? await AmqpBroker.connect(config.amqpUrl,
    [QUEUE_PARSE, QUEUE_INSPECT, QUEUE_RESULTS, QUEUE_PROGRESS])
  const ctx: Context = {
    config, db, store, broker, log,
    flags: overrides.flags ?? RedisFlags.connect(config.redisUrl),
    ml: overrides.ml ?? new HttpMlClient(config.mlUrl, config.internalToken),
    metrics: new Metrics(SERVICE),
    scan: overrides.scan ?? clamdScanner(config.clamdHost, config.clamdPort, config.env === 'production'),
    send: overrides.send ?? ((url, init) => fetch(url, init as RequestInit)),
    now: overrides.now ?? (() => new Date()),
  }
  ensureSeeded(ctx)
  ensureInitialAdmin(ctx)
  return ctx
}

/** Подписка на результаты и ход задач ML-модулей. */
export async function consume(ctx: Context): Promise<void> {
  await ctx.broker.consume(QUEUE_RESULTS, (message) => handleResult(ctx, message as TaskResult))
  await ctx.broker.consume(QUEUE_PROGRESS, async (message) => handleProgress(ctx, message as Progress))
}

export interface Running { ctx: Context; app: FastifyInstance; stop: () => Promise<void> }

export async function start(config: Config, overrides: Overrides = {}, background = true): Promise<Running> {
  const ctx = await createContext(config, overrides)
  const app = await buildApp(ctx)
  await consume(ctx)
  const stopJobs = background ? jobs.start(ctx) : () => undefined
  return {
    ctx, app,
    stop: async () => {
      stopJobs()
      await app.close()
      await ctx.broker.close()
      await ctx.flags.close()
      ctx.db.close()
    },
  }
}
