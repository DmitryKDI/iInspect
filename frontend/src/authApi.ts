/**
 * Вход по логину и паролю (ТЗ 12, п.1). Сессия хранится в HttpOnly-cookie,
 * поэтому в браузере нет токена, который можно украсть скриптом; интерфейс
 * знает только, кто вошёл и с какой ролью.
 */
export type Role = 'inspector' | 'supervisor' | 'admin' | 'ml_engineer' | 'service'

export interface SessionUser {
  id: number
  login: string
  role: Role
  role_title: string
  full_name: string
  is_active: boolean
  last_login_at: string | null
}

export class AuthError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export { SESSION_EXPIRED, notifySessionExpired } from './officialApi'

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: 'Сервер недоступен.' }))
    throw new AuthError(response.status, typeof body.detail === 'string' ? body.detail : 'Ошибка входа.')
  }
  return response.json() as Promise<T>
}

export const authApi = {
  me: () => call<SessionUser>('/auth/me'),
  session: () => call<{ user: SessionUser | null }>('/auth/session'),
  login: (login: string, password: string) =>
    call<{ user: SessionUser }>('/auth/login', { method: 'POST', body: JSON.stringify({ login, password }) }),
  logout: () => call<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
  changePassword: (current_password: string, new_password: string) =>
    call<{ ok: boolean }>('/auth/password', {
      method: 'POST', body: JSON.stringify({ current_password, new_password }),
    }),
}

/** Может ли роль выполнять действие. Администратору разрешено всё. */
export function can(user: SessionUser | null, ...roles: Role[]): boolean {
  if (!user) return false
  return user.role === 'admin' || roles.includes(user.role)
}
