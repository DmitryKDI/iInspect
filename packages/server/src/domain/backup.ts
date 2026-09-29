/**
 * Резервное копирование базы и файлового хранилища (ТЗ 12, п.8; ТЗ 11: RPO ≤ 15 минут).
 *
 *   • каждые 15 минут — копия базы (решения инспектора, протоколы, журнал
 *     аудита — то, что нельзя получить повторно), хранится сутки;
 *   • ежедневно — база и файловое хранилище, хранятся 30 дней (ТЗ 12, п.8).
 *
 * Копия базы снимается VACUUM INTO: база не останавливается, копия
 * согласована и зашифрована тем же ключом. Файлы хранилища копируются как
 * есть — они уже зашифрованы. Каталог копий задаётся INSPECTOR_BACKUP_DIR;
 * без него копирование выключено, и это видно в /api/v1/admin/backups.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '../context.js'

export const FREQUENT_MINUTES = 15
export const FREQUENT_KEEP_HOURS = 24
export const DAILY_KEEP_DAYS = 30

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

function parseStamp(name: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(name)
  return match ? new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6])) : null
}

export function make(ctx: Context, kind: 'frequent' | 'daily'): string {
  const root = ctx.config.backupDir
  if (!root) throw new Error('резервное копирование выключено: не задан INSPECTOR_BACKUP_DIR')
  const folder = path.join(root, kind, stamp(ctx.now()))
  const partial = `${folder}.partial`
  mkdirSync(partial, { recursive: true, mode: 0o700 })
  ctx.db.prepare('VACUUM INTO ?').run(path.join(partial, 'inspector.db'))
  if (kind === 'daily' && existsSync(ctx.config.storageDir)) {
    cpSync(ctx.config.storageDir, path.join(partial, 'storage'), { recursive: true })
  }
  renameSync(partial, folder) // копия появляется целиком или не появляется
  ctx.log.info(`резервная копия снята: ${folder}`, { event: 'backup' })
  return folder
}

function snapshots(ctx: Context, kind: string): { date: Date; folder: string }[] {
  const root = ctx.config.backupDir
  const dir = root ? path.join(root, kind) : ''
  if (!dir || !existsSync(dir)) return []
  return readdirSync(dir).map((name) => ({ date: parseStamp(name), folder: path.join(dir, name) }))
    .filter((item): item is { date: Date; folder: string } => item.date !== null)
    .sort((a, b) => a.date.getTime() - b.date.getTime())
}

export function prune(ctx: Context): number {
  let removed = 0
  const now = ctx.now().getTime()
  for (const [kind, keep] of [['frequent', FREQUENT_KEEP_HOURS * 3600_000],
    ['daily', DAILY_KEEP_DAYS * 86_400_000]] as const) {
    for (const item of snapshots(ctx, kind)) {
      if (now - item.date.getTime() > keep) {
        rmSync(item.folder, { recursive: true, force: true })
        removed += 1
      }
    }
  }
  return removed
}

/** Снять копии, срок которых подошёл; вернуть виды снятых копий. */
export function due(ctx: Context): string[] {
  if (!ctx.config.backupDir) return []
  const made: string[] = []
  const now = ctx.now().getTime()
  for (const [kind, period] of [['frequent', FREQUENT_MINUTES * 60_000], ['daily', 86_400_000]] as const) {
    const existing = snapshots(ctx, kind)
    const last = existing[existing.length - 1]
    if (!last || now - last.date.getTime() >= period) {
      make(ctx, kind)
      made.push(kind)
    }
  }
  prune(ctx)
  return made
}

export function status(ctx: Context): Record<string, unknown> {
  if (!ctx.config.backupDir) return { enabled: false, reason: 'не задан INSPECTOR_BACKUP_DIR' }
  const result: Record<string, unknown> = { enabled: true, directory: ctx.config.backupDir }
  for (const kind of ['frequent', 'daily']) {
    const list = snapshots(ctx, kind)
    result[kind] = { count: list.length, latest: list.length ? list[list.length - 1].date.toISOString() : null }
  }
  return result
}
