/** Вход, выход, пользователи, журнал аудита, целостность и копии (ТЗ 12). */
import type { FastifyInstance } from 'fastify'
import { note } from '../../audit.js'
import {
  COOKIE_NAME, createSession, dropSession, authenticate, requestToken, requireRole, ROLE_TITLES, ROLES,
  SESSION_TTL_HOURS, type Role,
} from '../../auth/auth.js'
import { LoginLockout } from '../../auth/lockout.js'
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../../auth/passwords.js'
import type { Context } from '../../context.js'
import { bool, fromJson, nowIso } from '../../db/database.js'
import * as backup from '../../domain/backup.js'
import * as integrity from '../../domain/integrity.js'
import { conflict, HttpError, invalid, notFound } from '../../errors.js'
import { id, nonEmpty, ok, params, text } from '../schemas.js'

interface UserRow {
  id: number; login: string; role: Role; full_name: string; is_active: number; last_login_at: string | null
  password_hash: string
}

export function userDict(row: UserRow): Record<string, unknown> {
  return { id: row.id, login: row.login, role: row.role, role_title: ROLE_TITLES[row.role] ?? row.role,
    full_name: row.full_name, is_active: bool(row.is_active), last_login_at: row.last_login_at }
}

function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) throw invalid(`пароль короче ${MIN_PASSWORD_LENGTH} символов`)
}

export function authRoutes(app: FastifyInstance, ctx: Context): void {
  const user = (userId: number) => ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow
  const lockout = new LoginLockout()

  app.post('/api/v1/auth/login', {
    schema: { tags: ['auth'], summary: 'Вход по логину и паролю',
      body: { type: 'object', required: ['login', 'password'], properties: { login: nonEmpty, password: text } },
      response: ok('Токен сессии и пользователь') },
  }, async (request, reply) => {
    const body = request.body as { login: string; password: string }
    const login = body.login.trim()
    note(request, { login })
    const key = `${login.toLowerCase()}|${request.ip}`
    const wait = lockout.lockedFor(key, ctx.now())
    if (wait) throw new HttpError(429, `слишком много неудачных попыток входа: повторите через ${wait} мин.`)
    const row = ctx.db.prepare('SELECT * FROM users WHERE login = ?').get(login) as UserRow | undefined
    if (!row || !bool(row.is_active) || !verifyPassword(body.password, row.password_hash)) {
      ctx.log.warning(`неудачная попытка входа: ${login}`, { event: 'login_failed', security: true })
      if (lockout.fail(key, ctx.now())) {
        ctx.log.warning(`вход временно закрыт после серии неудач: ${login}, ${request.ip}`,
          { event: 'login_locked', security: true })
      }
      throw new HttpError(401, 'неверный логин или пароль')
    }
    lockout.succeed(key)
    const token = createSession(ctx, row.id)
    request.principal = { userId: row.id, login: row.login, role: row.role, fullName: row.full_name }
    reply.setCookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'strict', secure: ctx.config.cookieSecure,
      maxAge: SESSION_TTL_HOURS * 3600, path: '/' })
    return { token, token_type: 'bearer', user: userDict(user(row.id)) }
  })

  app.post('/api/v1/auth/logout', { schema: { tags: ['auth'], summary: 'Выход' } }, async (request, reply) => {
    const token = requestToken(request)
    if (token) dropSession(ctx, token)
    reply.clearCookie(COOKIE_NAME, { path: '/' })
    return { ok: true }
  })

  app.get('/api/v1/auth/me', { schema: { tags: ['auth'], summary: 'Текущий пользователь', response: ok('Пользователь') } },
    async (request) => userDict(user(authenticate(ctx, request).userId)))

  app.get('/api/v1/auth/session', {
    schema: { tags: ['auth'], summary: 'Состояние сессии (без ошибки, если вход не выполнен)' },
  }, async (request) => {
    try {
      return { user: userDict(user(authenticate(ctx, request).userId)) }
    } catch {
      return { user: null }
    }
  })

  app.post('/api/v1/auth/password', {
    schema: { tags: ['auth'], summary: 'Сменить свой пароль', body: { type: 'object',
      required: ['current_password', 'new_password'], properties: { current_password: text, new_password: text } } },
  }, async (request) => {
    const principal = authenticate(ctx, request)
    const body = request.body as { current_password: string; new_password: string }
    if (!verifyPassword(body.current_password, user(principal.userId).password_hash)) {
      throw new HttpError(403, 'текущий пароль неверен')
    }
    checkPassword(body.new_password)
    ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.new_password), principal.userId)
    return { ok: true }
  })

  const admin = { preHandler: requireRole(ctx, 'admin') }
  const roleSchema = { type: 'string', enum: [...ROLES] }

  app.get('/api/v1/admin/users', { ...admin, schema: { tags: ['auth'], summary: 'Пользователи' } },
    async () => (ctx.db.prepare('SELECT * FROM users ORDER BY id').all() as UserRow[]).map(userDict))

  app.post('/api/v1/admin/users', {
    ...admin, schema: { tags: ['auth'], summary: 'Создать пользователя', body: { type: 'object',
      required: ['login', 'password', 'role'], properties: { login: nonEmpty, password: text, role: roleSchema,
        full_name: text } } },
  }, async (request) => {
    const body = request.body as { login: string; password: string; role: Role; full_name?: string }
    const login = body.login.trim()
    if (!login) throw invalid('укажите логин')
    if (ctx.db.prepare('SELECT 1 FROM users WHERE login = ?').get(login)) throw conflict('такой логин уже есть')
    checkPassword(body.password)
    const info = ctx.db.prepare(`INSERT INTO users (login, password_hash, role, full_name, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(login, hashPassword(body.password), body.role, (body.full_name ?? '').trim(),
      nowIso(ctx.now()))
    return userDict(user(Number(info.lastInsertRowid)))
  })

  app.patch('/api/v1/admin/users/:user_id', {
    ...admin, schema: { tags: ['auth'], summary: 'Изменить пользователя', params: params({ user_id: id }),
      body: { type: 'object', properties: { role: roleSchema, full_name: text, is_active: { type: 'boolean' },
        password: text } } },
  }, async (request) => {
    const userId = (request.params as { user_id: number }).user_id
    const body = request.body as { role?: Role; full_name?: string; is_active?: boolean; password?: string }
    const row = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined
    if (!row) throw notFound('пользователь не найден')
    ctx.db.transaction(() => {
      if (body.role !== undefined) ctx.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, userId)
      if (body.full_name !== undefined) {
        ctx.db.prepare('UPDATE users SET full_name = ? WHERE id = ?').run(body.full_name.trim(), userId)
      }
      if (body.is_active !== undefined) {
        if (userId === request.principal!.userId && !body.is_active) {
          throw conflict('нельзя отключить собственную учётную запись')
        }
        ctx.db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(body.is_active ? 1 : 0, userId)
        if (!body.is_active) ctx.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId)
      }
      if (body.password) {
        checkPassword(body.password)
        ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.password), userId)
        ctx.db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId)
      }
    })()
    return userDict(user(userId))
  })

  app.get('/api/v1/admin/integrity', {
    preHandler: requireRole(ctx, 'admin', 'ml_engineer'),
    schema: { tags: ['auth'], summary: 'Проверки целостности хранилища' },
  }, async () => (ctx.db.prepare('SELECT * FROM integrity_checks ORDER BY id DESC LIMIT 30').all() as
    Parameters<typeof integrity.checkDict>[0][]).map(integrity.checkDict))

  app.post('/api/v1/admin/integrity', { ...admin, schema: { tags: ['auth'], summary: 'Проверить целостность хранилища сейчас' } },
    async () => integrity.runCheck(ctx))

  app.get('/api/v1/admin/backups', { ...admin, schema: { tags: ['auth'], summary: 'Состояние резервного копирования' } },
    async () => backup.status(ctx))

  app.post('/api/v1/admin/backups', { ...admin, schema: { tags: ['auth'], summary: 'Снять полную резервную копию сейчас' } },
    async () => {
      try {
        return { folder: backup.make(ctx, 'daily'), ...backup.status(ctx) }
      } catch (error) {
        throw conflict((error as Error).message)
      }
    })

  app.get('/api/v1/admin/audit', {
    preHandler: requireRole(ctx, 'admin', 'ml_engineer'),
    schema: { tags: ['auth'], summary: 'Журнал аудита', querystring: { type: 'object', properties: {
      limit: { type: 'integer', minimum: 1, maximum: 5000, default: 200 }, user: text, action: text } } },
  }, async (request) => {
    const query = request.query as { limit: number; user?: string; action?: string }
    const where: string[] = []
    const args: unknown[] = []
    if (query.user) { where.push('login = ?'); args.push(query.user) }
    if (query.action) { where.push('action LIKE ?'); args.push(`%${query.action}%`) }
    const rows = ctx.db.prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT ?`).all(...args, query.limit) as Record<string, unknown>[]
    return rows.map((row) => ({ ...row, details: fromJson(row.details as string, {}) }))
  })
}
