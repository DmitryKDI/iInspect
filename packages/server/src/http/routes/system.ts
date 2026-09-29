/**
 * Служебные маршруты: здоровье, метрики Prometheus (ТЗ 13, п.4–5), проверка
 * связи с моделью, лимиты загрузки, уведомления, дашборд (модуль 7), версия,
 * и внутренний доступ ML-модулей к файлам (REST внутри контура, ТЗ 1.5).
 */
import { timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { FastifyInstance } from 'fastify'
import { authenticate, READERS, requireRole } from '../../auth/auth.js'
import type { Context } from '../../context.js'
import { nowIso } from '../../db/database.js'
import { dashboard } from '../../domain/dashboard.js'
import { audiencesOf } from '../../domain/notifications.js'
import { HttpError, notFound } from '../../errors.js'
import { gauges } from '../../jobs.js'
import { date, id, params, text } from '../schemas.js'

function versionInfo(root: string): Record<string, string> {
  const git = (...args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: root, timeout: 5000 }).toString().trim()
    } catch {
      return ''
    }
  }
  return { commit: process.env.INSPECTOR_BUILD_COMMIT || git('rev-parse', '--short', 'HEAD'),
    date: git('log', '-1', '--format=%cs'), branch: git('rev-parse', '--abbrev-ref', 'HEAD') }
}

export function systemRoutes(app: FastifyInstance, ctx: Context): void {
  const read = { preHandler: requireRole(ctx, ...READERS) }

  app.get('/health', { schema: { tags: ['system'], summary: 'Состояние сервиса' } }, async () => ({ status: 'ok' }))

  app.get('/metrics', {
    preHandler: requireRole(ctx, 'ml_engineer', 'service'),
    schema: { tags: ['system'], summary: 'Метрики Prometheus (ТЗ 13, п.4–5)' },
  }, async (_request, reply) => {
    for (const [name, value] of Object.entries(await gauges(ctx))) {
      ctx.metrics.gauge(name, name.replace(/_/g, ' ')).set(value)
    }
    await ctx.metrics.diskUsage(ctx.config.dataDir)
    reply.type(ctx.metrics.registry.contentType)
    return ctx.metrics.registry.metrics()
  })

  app.get('/api/v1/llm-check', { ...read, schema: { tags: ['system'], summary: 'Проверка связи с локальной моделью' } },
    async () => {
      try {
        return await ctx.ml.llmCheck()
      } catch (error) {
        return { reachable: false, model: '', message: error instanceof HttpError ? String(error.detail) :
          (error as Error).message }
      }
    })

  app.get('/api/v1/settings', { ...read, schema: { tags: ['system'], summary: 'Лимиты загрузки и хранения' } },
    async () => ctx.db.prepare('SELECT max_upload_mb, max_package_mb, max_pages, retention_days FROM settings WHERE id = 1').get())

  app.put('/api/v1/settings', {
    preHandler: requireRole(ctx, 'admin'),
    schema: { tags: ['system'], summary: 'Изменить лимиты (ТЗ 9.1: 50 МБ на файл, 200 МБ на пакет)',
      body: { type: 'object', properties: { max_upload_mb: { type: 'integer', minimum: 1, maximum: 50 },
        max_package_mb: { type: 'integer', minimum: 1, maximum: 200 }, max_pages: { type: 'integer', minimum: 1 },
        retention_days: { type: 'integer', minimum: 1 } }, additionalProperties: false } },
  }, async (request) => {
    const body = request.body as Record<string, number>
    for (const [key, value] of Object.entries(body)) {
      ctx.db.prepare(`UPDATE settings SET ${key} = ? WHERE id = 1`).run(value)
    }
    return ctx.db.prepare('SELECT max_upload_mb, max_package_mb, max_pages, retention_days FROM settings WHERE id = 1').get()
  })

  app.get('/api/v1/notifications', {
    schema: { tags: ['system'], summary: 'Уведомления пользователя по роли',
      querystring: { type: 'object', properties: { unread: { type: 'boolean' } } } },
  }, async (request) => {
    const audiences = audiencesOf(authenticate(ctx, request).role)
    if (!audiences.length) return []
    const unread = (request.query as { unread?: boolean }).unread
    return ctx.db.prepare(`SELECT * FROM notifications WHERE audience IN (${audiences.map(() => '?').join(',')})
      ${unread ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT 100`).all(...audiences)
  })

  app.post('/api/v1/notifications/:notification_id/read', {
    schema: { tags: ['system'], summary: 'Отметить уведомление прочитанным', params: params({ notification_id: id }) },
  }, async (request) => {
    authenticate(ctx, request)
    const notificationId = (request.params as { notification_id: number }).notification_id
    const info = ctx.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL')
      .run(nowIso(ctx.now()), notificationId)
    return { ok: info.changes > 0 }
  })

  app.get('/api/v1/dashboard', {
    ...read, schema: { tags: ['dashboard'], summary: 'Объекты с цветовой индикацией (модуль 7)',
      querystring: { type: 'object', properties: { section: text, status: text,
        color: { type: 'string', enum: ['green', 'yellow', 'red'] }, date_from: date, date_to: date } } },
  }, async (request) => dashboard(ctx, request.query as Record<string, string>))

  app.get('/api/v1/version', { schema: { tags: ['system'], summary: 'Версия работающего кода' } },
    async () => versionInfo(process.cwd()))

  // --- внутренний REST для ML-модулей (не публикуется наружу) ---------------
  const internal = async (request: { headers: Record<string, unknown> }) => {
    const token = String(request.headers['x-internal-token'] ?? '')
    const expected = Buffer.from(ctx.config.internalToken)
    const given = Buffer.from(token)
    if (!token || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new HttpError(403, 'внутренний доступ запрещён')
    }
  }

  app.get('/internal/files/:sha256', {
    preHandler: internal, schema: { hide: true, params: params({ sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' } }) },
  }, async (request, reply) => {
    const data = ctx.store.read((request.params as { sha256: string }).sha256)
    if (!data) throw notFound('файл не найден в хранилище')
    reply.type('application/octet-stream')
    return data
  })
}
