/**
 * Уведомления пользователей: протокол готов (ТЗ 9.2, п.5), сбой обработки
 * файла — администратору (ТЗ 9.1), новые документы после финализации (ТЗ 9.6).
 *
 * Уведомление — запись в базе, которую интерфейс показывает по роли, и
 * строка журнала: алерт по ней отправляет Alertmanager (ТЗ 13, п.7).
 */
import type { Context } from '../context.js'
import { nowIso } from '../db/database.js'

export type Audience = 'inspector' | 'admin' | 'ml_engineer'

export function notify(ctx: Context, audience: Audience, kind: string, processId: number | null,
  message: string): void {
  ctx.db.prepare(`INSERT INTO notifications (audience, kind, process_id, message, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(audience, kind, processId, message, nowIso(ctx.now()))
  const extra = { event: `notification_${kind}`, audience }
  if (audience === 'admin') ctx.log.error(message, extra)
  else ctx.log.info(message, extra)
}

/** Кому адресованы уведомления роли: супервизор видит инспекторские. */
export function audiencesOf(role: string): Audience[] {
  if (role === 'admin') return ['admin', 'inspector', 'ml_engineer']
  if (role === 'ml_engineer') return ['ml_engineer']
  if (role === 'inspector' || role === 'supervisor') return ['inspector']
  return []
}
