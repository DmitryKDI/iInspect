/**
 * Ежедневная проверка целостности хранилища (ТЗ 13, п.8; 12, п.7).
 *
 * Каждый файл расшифровывается (метка GCM) и сверяется с SHA-256, под которым
 * записан, и с отпечатком в таблице Files. Расхождение — событие безопасности
 * уровня ERROR (хранится год) и строка результата; метрика
 * `inspector_integrity_failures` даёт повод для алерта.
 */
import type { Context } from '../context.js'
import { fromJson, nowIso, toJson } from '../db/database.js'

export const CHECK_PERIOD_HOURS = 24

interface CheckRow {
  id: number; started_at: string; finished_at: string | null; checked: number; failures: string
  status: string
}

export function checkDict(row: CheckRow): Record<string, unknown> {
  return { id: row.id, status: row.status, checked: row.checked, failures: fromJson(row.failures, []),
    started_at: row.started_at, finished_at: row.finished_at }
}

export function runCheck(ctx: Context): Record<string, unknown> {
  const info = ctx.db.prepare('INSERT INTO integrity_checks (started_at) VALUES (?)').run(nowIso(ctx.now()))
  const id = Number(info.lastInsertRowid)
  let checked = 0
  const failures: { digest: string; reason: string }[] = []
  try {
    const result = ctx.store.verifyAll()
    checked = result.checked
    failures.push(...result.failures)
    const stored = new Set(ctx.store.digests())
    const referenced = ctx.db.prepare('SELECT file_hash, derived_hash FROM files').all() as
      { file_hash: string; derived_hash: string | null }[]
    for (const row of referenced) {
      for (const digest of [row.file_hash, row.derived_hash]) {
        if (digest && !stored.has(digest)) failures.push({ digest, reason: 'файл отсутствует в хранилище' })
      }
    }
  } catch (error) {
    ctx.db.prepare(`UPDATE integrity_checks SET status = 'ERROR', finished_at = ?, failures = ? WHERE id = ?`)
      .run(nowIso(ctx.now()), toJson([{ digest: '', reason: `проверка не выполнена: ${(error as Error).message}` }]), id)
    ctx.log.error(`проверка целостности не выполнена: ${(error as Error).message}`,
      { event: 'integrity_check', security: true })
    return checkDict(ctx.db.prepare('SELECT * FROM integrity_checks WHERE id = ?').get(id) as CheckRow)
  }
  ctx.db.prepare('UPDATE integrity_checks SET checked = ?, failures = ?, status = ?, finished_at = ? WHERE id = ?')
    .run(checked, toJson(failures), failures.length ? 'FAILED' : 'OK', nowIso(ctx.now()), id)
  for (const failure of failures) {
    ctx.log.error(`нарушена целостность файла ${failure.digest}: ${failure.reason}`,
      { event: 'integrity_failure', security: true })
  }
  ctx.metrics.gauge('inspector_integrity_failures', 'Файлы с нарушенной целостностью при последней проверке.')
    .set(failures.length)
  return checkDict(ctx.db.prepare('SELECT * FROM integrity_checks WHERE id = ?').get(id) as CheckRow)
}

export function due(ctx: Context): boolean {
  const last = ctx.db.prepare('SELECT started_at FROM integrity_checks ORDER BY id DESC LIMIT 1').get() as
    { started_at: string } | undefined
  if (last && ctx.now().getTime() - Date.parse(last.started_at) < CHECK_PERIOD_HOURS * 3600_000) return false
  runCheck(ctx)
  return true
}

export function lastFailures(ctx: Context): number {
  const last = ctx.db.prepare(`SELECT failures FROM integrity_checks WHERE finished_at IS NOT NULL
    ORDER BY id DESC LIMIT 1`).get() as { failures: string } | undefined
  return last ? fromJson<unknown[]>(last.failures, []).length : 0
}
