/**
 * Аутентификация и разграничение прав (ТЗ 12, п.1–2).
 *
 * Вход по логину и паролю для всех категорий пользователей. Роли:
 *   inspector   — просмотр и верификация (ТЗ 12, п.2), финализация протокола;
 *   supervisor  — инспектор с правом супервизора: ещё и отмена финализации (ТЗ 9.3);
 *   admin       — управление пользователями, параметрами и нормативной базой;
 *   ml_engineer — доступ к логам и данным дообучения;
 *   service     — учётная запись внешней системы (ИАИС «РиН»): загрузка и результаты.
 *
 * Токен передаётся заголовком `Authorization: Bearer` (внешние системы) или
 * HttpOnly-cookie (интерфейс: изображение листа грузится тегом <img>).
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Context } from '../context.js'
import { nowIso } from '../db/database.js'
import { HttpError } from '../errors.js'
import { requestContext } from '../observability/logging.js'
import { hashPassword, newToken, tokenHash } from './passwords.js'

export const ROLES = ['inspector', 'supervisor', 'admin', 'ml_engineer', 'service'] as const
export type Role = (typeof ROLES)[number]
export const ROLE_TITLES: Record<Role, string> = {
  inspector: 'Инспектор', supervisor: 'Инспектор-супервизор', admin: 'Администратор',
  ml_engineer: 'ML-инженер', service: 'Внешняя система',
}
/** Кто проверяет и принимает решения по протоколу. */
export const VERIFIERS: Role[] = ['inspector', 'supervisor']
/** Кто читает протоколы и документы. */
export const READERS: Role[] = ['inspector', 'supervisor', 'ml_engineer', 'service']

export const COOKIE_NAME = 'inspector_session'
// Сколько живёт сессия без повторного входа, часов: рабочая смена инспектора.
export const SESSION_TTL_HOURS = 12

export interface Principal {
  userId: number
  login: string
  role: Role
  fullName: string
}

export function display(principal: Principal): string {
  return principal.fullName || principal.login
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal
    auditDetails?: Record<string, unknown>
  }
}

export function createSession(ctx: Context, userId: number): string {
  const token = newToken()
  const now = ctx.now()
  const expires = new Date(now.getTime() + SESSION_TTL_HOURS * 3600_000)
  ctx.db.prepare(`INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at)
    VALUES (?, ?, ?, ?)`).run(tokenHash(token), userId, nowIso(now), nowIso(expires))
  ctx.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(now), userId)
  return token
}

export function dropSession(ctx: Context, token: string): void {
  ctx.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash(token))
}

export function requestToken(request: FastifyRequest): string {
  const header = request.headers.authorization ?? ''
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  return request.cookies?.[COOKIE_NAME] ?? ''
}

interface UserRow {
  id: number; login: string; role: Role; full_name: string; is_active: number
}

/** Пользователь запроса; без действующей сессии — 401. */
export function authenticate(ctx: Context, request: FastifyRequest): Principal {
  if (request.principal) return request.principal
  const token = requestToken(request)
  if (!token) throw new HttpError(401, 'требуется вход в систему')
  const session = ctx.db.prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?')
    .get(tokenHash(token)) as { user_id: number; expires_at: string } | undefined
  if (!session || session.expires_at < nowIso(ctx.now())) {
    throw new HttpError(401, 'сессия истекла, войдите заново')
  }
  const user = ctx.db.prepare('SELECT id, login, role, full_name, is_active FROM users WHERE id = ?')
    .get(session.user_id) as UserRow | undefined
  if (!user || !user.is_active) throw new HttpError(401, 'учётная запись отключена')
  const principal: Principal = { userId: user.id, login: user.login, role: user.role,
    fullName: user.full_name }
  request.principal = principal
  const store = requestContext.getStore()
  if (store) store.userId = String(user.id)
  return principal
}

/** Проверка роли для обработчика; администратор допускается всегда. */
export function requireRole(ctx: Context, ...roles: Role[]) {
  const allowed = new Set<Role>(roles)
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const principal = authenticate(ctx, request)
    if (principal.role !== 'admin' && !allowed.has(principal.role)) {
      throw new HttpError(403, 'недостаточно прав для этого действия')
    }
  }
}

/** Первый запуск: администратор из окружения или admin/admin на стенде проверки. */
export function ensureInitialAdmin(ctx: Context): void {
  const count = (ctx.db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n
  if (count) return
  ctx.db.prepare(`INSERT INTO users (login, password_hash, role, full_name, created_at)
    VALUES (?, ?, 'admin', 'Администратор', ?)`)
    .run(ctx.config.adminLogin, hashPassword(ctx.config.adminPassword), nowIso(ctx.now()))
  if (ctx.config.adminPassword === 'admin') {
    ctx.log.warning(`создан администратор «${ctx.config.adminLogin}» с паролем по умолчанию; ` +
      'в промышленном контуре задайте INSPECTOR_ADMIN_PASSWORD', { event: 'bootstrap',
      security: true })
  }
}
