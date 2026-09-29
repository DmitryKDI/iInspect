/**
 * Безопасность и администрирование (ТЗ 7, модули 4, 8, 9, 10; ТЗ 12–13):
 * вход, роли, журнал аудита, матрица и правила, реестр моделей, метрики.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { stand, type Stand } from './helpers.js'

let s: Stand
beforeEach(async () => { s = await stand() })
afterEach(async () => { await s.close() })

describe('вход и роли (ТЗ 12, п.1–2)', () => {
  it('всё, кроме входа и /health, — только после входа', async () => {
    expect((await s.call('GET', '/health', null)).statusCode).toBe(200)
    expect((await s.call('GET', '/api/v1/processes', null)).statusCode).toBe(401)
    expect((await s.call('POST', '/api/v1/auth/login', null, { login: 'admin', password: 'нет' })).statusCode)
      .toBe(401)
  })

  it('подбор пароля: после 5 неудач вход закрыт на 15 минут', async () => {
    const attempt = (password: string) => s.call('POST', '/api/v1/auth/login', null, { login: 'admin', password })
    for (let i = 0; i < 5; i += 1) expect((await attempt('неверный')).statusCode).toBe(401)
    const locked = await attempt('admin')
    expect(locked.statusCode).toBe(429)
    expect(locked.body).toMatch(/повторите через/)
    s.clock.now = new Date(s.clock.now.getTime() + 16 * 60_000)
    expect((await attempt('admin')).statusCode).toBe(200)
    expect((await attempt('неверный')).statusCode).toBe(401) // успешный вход обнулил счётчик
    expect((await attempt('admin')).statusCode).toBe(200)
  })

  it('пароль хранится только хешем с солью', async () => {
    await s.as('inspector')
    const row = s.ctx.db.prepare("SELECT password_hash FROM users WHERE login = 'user-inspector'").get() as
      { password_hash: string }
    expect(row.password_hash).not.toContain('password-123')
    expect(row.password_hash.length).toBeGreaterThan(40)
  })

  it('роли ограничивают действия', async () => {
    const inspector = await s.as('inspector')
    expect((await s.call('GET', '/api/v1/admin/users', inspector)).statusCode).toBe(403)
    expect((await s.call('GET', '/api/v1/ml/models', inspector)).statusCode).toBe(403)
    expect((await s.call('GET', '/metrics', inspector)).statusCode).toBe(403)
    const engineer = await s.as('ml_engineer')
    expect((await s.call('GET', '/api/v1/ml/models', engineer)).statusCode).toBe(200)
  })
})

describe('журнал аудита (ТЗ 12, п.4)', () => {
  it('изменение записано с пользователем, IP и User-Agent; журнал только дополняется', async () => {
    const admin = await s.login()
    await s.call('POST', '/api/v1/admin/users', admin, { login: 'u1', password: 'password-123', role: 'inspector' },
      { 'user-agent': 'проверка', 'x-forwarded-for': '10.0.0.7' })
    const row = s.ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'POST /api/v1/admin/users'").get() as
      { login: string; ip_address: string; user_agent: string; status_code: number }
    expect(row).toMatchObject({ login: 'admin', ip_address: '10.0.0.7', user_agent: 'проверка', status_code: 200 })
    expect(() => s.ctx.db.prepare('UPDATE audit_log SET login = ?').run('x')).toThrow(/только дополняется/)
    const listed = (await s.call('GET', '/api/v1/admin/audit', admin)).json()
    expect(listed.some((item: { action: string }) => item.action === 'POST /api/v1/admin/users')).toBe(true)
  })
})

describe('матрица и правила (ТЗ 8.1, модуль 8)', () => {
  it('ошибочный шаблон и правило отклоняются с причиной', async () => {
    const admin = await s.login()
    const bad = await s.call('PATCH', '/api/v1/admin/params/M-001', admin, { regex_pattern: '([' })
    expect(bad.statusCode).toBe(422)
    const ok = await s.call('PATCH', '/api/v1/admin/params/M-001', admin, { min_value: 1, max_value: 10 })
    expect(ok.statusCode, ok.body).toBe(200)
    const rule = { rule_name: 'Если A, то B', condition: 'M-001 > 10', expected: 'present(M-002)' }
    expect((await s.call('POST', '/api/v1/admin/rules', admin, { ...rule, condition: 'M-001 !! 1' })).statusCode)
      .toBe(422)
    expect((await s.call('POST', '/api/v1/admin/rules', admin, rule)).statusCode).toBe(200)
  })
})

describe('дообучение и мониторинг (ТЗ 9.4, 13)', () => {
  it('модель регистрируется только на выпущенном наборе данных', async () => {
    const engineer = await s.as('ml_engineer')
    const response = await s.call('POST', '/api/v1/ml/models', engineer, { model_version: 'm-2',
      dataset_version: 'нет-такого', precision: 0.95, recall: 0.9, f1: 0.92, false_positive_rate: 0.05 })
    expect(response.statusCode).toBe(422)
    const report = await s.call('GET', '/api/v1/ml/report?days=7', engineer)
    expect(report.statusCode).toBe(200)
    expect(report.json().decisions).toBeDefined()
  })

  it('метрики Prometheus для роли service; целостность и копии — администратору', async () => {
    const service = await s.as('service')
    const metrics = await s.call('GET', '/metrics', service)
    expect(metrics.statusCode).toBe(200)
    expect(metrics.body).toContain('inspector_http_requests_total')
    expect(metrics.body).toContain('inspector_queue_parse_size')
    const admin = await s.login()
    const integrity = await s.call('POST', '/api/v1/admin/integrity', admin)
    expect(integrity.statusCode).toBe(200)
    expect(integrity.json().status).toBe('OK')
    expect((await s.call('GET', '/api/v1/admin/backups', admin)).statusCode).toBe(200)
    expect((await s.call('GET', '/api/v1/dashboard', admin)).statusCode).toBe(200)
  })
})
