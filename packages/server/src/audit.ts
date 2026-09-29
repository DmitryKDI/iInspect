/**
 * Журнал аудита действий пользователей (ТЗ 7, модуль 9; 12, п.4).
 *
 * Каждое действие, меняющее данные, и каждая попытка входа записываются со
 * временем, IP-адресом, типом действия, идентификатором объекта и
 * пользователем. Запись делается хуком после ответа, поэтому ни один
 * обработчик не может её «забыть». Журнал только дополняется: правку и
 * удаление запрещает сама база (триггеры схемы).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Context } from './context.js'
import { nowIso, toJson } from './db/database.js'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const OBJECT_KEYS = ['process_id', 'run_id', 'document_id', 'user_id', 'code', 'item_id',
  'model_id', 'suspicion_id']

export function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  if (value) return value.split(',')[0].trim()
  return request.ip ?? ''
}

export function note(request: FastifyRequest, details: Record<string, unknown>): void {
  request.auditDetails = { ...(request.auditDetails ?? {}), ...details }
}

export function shouldRecord(request: FastifyRequest): boolean {
  return MUTATING.has(request.method) && !request.url.startsWith('/internal/')
}

export function record(ctx: Context, request: FastifyRequest, reply: FastifyReply): void {
  const params = (request.params ?? {}) as Record<string, unknown>
  const key = OBJECT_KEYS.find((name) => params[name] !== undefined)
  const details = { ...(request.auditDetails ?? {}) }
  const login = request.principal?.login ?? String(details.login ?? '')
  delete details.login
  ctx.db.prepare(`INSERT INTO audit_log (user_id, login, action, object_id, details, status_code,
      timestamp, ip_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    request.principal?.userId ?? null, login,
    `${request.method} ${request.routeOptions?.url ?? request.url.split('?')[0]}`,
    key ? String(params[key]) : '', toJson(details), reply.statusCode, nowIso(ctx.now()),
    clientIp(request), String(request.headers['user-agent'] ?? '').slice(0, 500))
}
