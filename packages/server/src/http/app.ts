/**
 * HTTP-сервер «Инспектор ИИ» (ТЗ 1.3, 1.5): REST/JSON с валидацией каждого
 * запроса по схеме OpenAPI 3.0.
 *
 * Каждый запрос получает request_id (из X-Request-ID или новый): он
 * возвращается в ответе и стоит в каждой строке журнала этого запроса.
 * Действие, меняющее данные, — запись журнала аудита (ТЗ 12, п.4); ответ —
 * метрика времени и кода (ТЗ 13, п.4).
 */
import { randomUUID } from 'node:crypto'
import cookie from '@fastify/cookie'
import multipart from '@fastify/multipart'
import swagger from '@fastify/swagger'
import Fastify, { type FastifyInstance } from 'fastify'
import { clientIp, record, shouldRecord } from '../audit.js'
import type { Context } from '../context.js'
import { HttpError } from '../errors.js'
import { requestContext, requestIdFrom } from '../observability/logging.js'
import { authRoutes } from './routes/auth.js'
import { documentRoutes } from './routes/documents.js'
import { matrixRoutes } from './routes/matrix.js'
import { mlRoutes } from './routes/ml.js'
import { processRoutes } from './routes/processes.js'
import { systemRoutes } from './routes/system.js'

// Предел тела запроса: пакет документов по ТЗ 9.1 — до 200 МБ; остальное
// (JSON) заметно меньше. Точный лимит пакета проверяется по настройкам.
const MAX_BODY_BYTES = 210 * 1024 * 1024
const MAX_JSON_BYTES = 50 * 1024 * 1024

declare module 'fastify' {
  interface FastifyRequest { startedAt?: bigint }
}

export async function buildApp(ctx: Context): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_JSON_BYTES,
    trustProxy: true,
    genReqId: (request) => requestIdFrom(request.headers['x-request-id'], () => randomUUID().replace(/-/g, '')),
    ajv: { customOptions: { coerceTypes: 'array', removeAdditional: false, allErrors: true } },
  })

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: { title: 'Инспектор ИИ — API', version: '1.0.0',
        description: 'Сверка проектной, рабочей и исполнительной документации по матрице из 132 параметров. ' +
          'Асинхронная pull-модель: загрузка возвращает process_id, результат забирается по нему.' },
      components: { securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' },
        cookie: { type: 'apiKey', in: 'cookie', name: 'inspector_session' },
      } },
      security: [{ bearer: [] }, { cookie: [] }],
    },
  })
  await app.register(cookie)
  await app.register(multipart, { attachFieldsToBody: true, limits: { fileSize: MAX_BODY_BYTES, files: 100 } })

  app.addHook('onRequest', async (request) => {
    request.startedAt = process.hrtime.bigint()
    requestContext.enterWith({ requestId: request.id, userId: '' })
  })

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Request-ID', request.id)
    reply.header('X-Content-Type-Options', 'nosniff')
  })

  app.addHook('onResponse', async (request, reply) => {
    const seconds = Number(process.hrtime.bigint() - (request.startedAt ?? process.hrtime.bigint())) / 1e9
    const route = request.routeOptions?.url ?? request.url.split('?')[0]
    if (route !== '/health' && route !== '/metrics') ctx.metrics.observe(request.method, reply.statusCode, seconds)
    const status = reply.statusCode
    const extra = { event: 'http_request', method: request.method, path: request.url.split('?')[0], status,
      duration_ms: Math.round(seconds * 10_000) / 10, ip: clientIp(request), request_id: request.id,
      user_id: request.principal ? String(request.principal.userId) : '', security: status === 401 || status === 403 }
    const message = `${request.method} ${extra.path} → ${status}`
    if (status >= 500) ctx.log.error(message, extra)
    else if (status === 401 || status === 403) ctx.log.warning(message, extra)
    else if (route !== '/health') ctx.log.info(message, extra)
    if (shouldRecord(request)) {
      try {
        record(ctx, request, reply)
      } catch (error) {
        ctx.log.error(`запись аудита не выполнена: ${(error as Error).message}`, { event: 'audit' })
      }
    }
  })

  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({ detail: error.detail })
    }
    const failure = error as { validation?: { instancePath?: string; message?: string }[]; statusCode?: number;
      code?: string; message: string }
    if (failure.validation) {
      // Запрос не прошёл схему OpenAPI — отказ до обработчика (ТЗ 1.3).
      return reply.status(422).send({ detail: failure.validation.map((item) =>
        `${item.instancePath || 'тело запроса'}: ${item.message}`).join('; ') })
    }
    if (failure.code === 'FST_REQ_FILE_TOO_LARGE' || failure.statusCode === 413) {
      return reply.status(413).send({ detail: 'превышен допустимый размер загрузки' })
    }
    if (failure.statusCode && failure.statusCode < 500) {
      return reply.status(failure.statusCode).send({ detail: failure.message })
    }
    ctx.log.error(`необработанная ошибка: ${failure.message}`, { event: 'unhandled', request_id: request.id,
      stack: (error as Error).stack })
    return reply.status(500).send({ detail: 'внутренняя ошибка сервера; обратитесь к администратору с request_id ' +
      request.id })
  })

  app.setNotFoundHandler(async (request, reply) => reply.status(404).send({ detail: `маршрут не найден: ${request.url}` }))

  authRoutes(app, ctx)
  documentRoutes(app, ctx)
  processRoutes(app, ctx)
  matrixRoutes(app, ctx)
  mlRoutes(app, ctx)
  systemRoutes(app, ctx)

  app.get('/api/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger())
  await app.ready()
  return app
}
