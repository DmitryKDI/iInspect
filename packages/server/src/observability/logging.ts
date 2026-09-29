/**
 * Журнал сервиса (ТЗ 13, п.1–3).
 *
 * Каждая строка — JSON с обязательными полями timestamp, level, service,
 * message, request_id, user_id. Идентификаторы запроса и пользователя
 * берутся из контекста запроса (AsyncLocalStorage), поэтому их не нужно
 * передавать в каждый вызов и нельзя забыть.
 *
 * Строки идут в stdout — их принимает Logstash (ELK, ТЗ 13, п.6). При
 * заданном каталоге логов дополнительно пишутся файлы с дневной ротацией:
 * общий журнал хранится 90 дней, события безопасности — 365 (ТЗ 12, п.5;
 * 13, п.3). DEBUG в промышленном контуре не включается (ТЗ 13, п.2).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

export const SERVICE = 'inspector-server'
export const LOG_RETENTION_DAYS = 90
export const SECURITY_LOG_RETENTION_DAYS = 365

type Level = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR'
const ORDER: Record<Level, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 }

export interface RequestContext {
  requestId: string
  userId: string
}

export const requestContext = new AsyncLocalStorage<RequestContext>()

export interface LogExtra {
  event?: string
  security?: boolean
  [key: string]: unknown
}

export class Logger {
  private threshold: number
  private lastCleanup = ''

  constructor(level: string, private readonly production: boolean,
    private readonly dir: string, private readonly sink: (line: string) => void =
    (line) => process.stdout.write(`${line}\n`)) {
    const wanted = (level.toUpperCase() === 'WARN' ? 'WARNING' : level.toUpperCase()) as Level
    const effective: Level = ORDER[wanted] ? wanted : 'INFO'
    // DEBUG — только в тестовом контуре (ТЗ 13, п.2).
    this.threshold = ORDER[effective === 'DEBUG' && production ? 'INFO' : effective]
    if (dir) mkdirSync(dir, { recursive: true })
  }

  debug(message: string, extra: LogExtra = {}): void { this.write('DEBUG', message, extra) }
  info(message: string, extra: LogExtra = {}): void { this.write('INFO', message, extra) }
  warning(message: string, extra: LogExtra = {}): void { this.write('WARNING', message, extra) }
  error(message: string, extra: LogExtra = {}): void { this.write('ERROR', message, extra) }

  private write(level: Level, message: string, extra: LogExtra): void {
    if (ORDER[level] < this.threshold) return
    const context = requestContext.getStore()
    const now = new Date()
    const record = {
      timestamp: now.toISOString(),
      level,
      service: SERVICE,
      message,
      request_id: (extra.request_id as string | undefined) ?? context?.requestId ?? '',
      user_id: (extra.user_id as string | undefined) ?? context?.userId ?? '',
      ...Object.fromEntries(Object.entries(extra).filter(([key]) =>
        !['request_id', 'user_id'].includes(key))),
    }
    const line = JSON.stringify(record)
    this.sink(line)
    if (!this.dir) return
    const day = record.timestamp.slice(0, 10)
    appendFileSync(path.join(this.dir, `service-${day}.log`), `${line}\n`)
    if (extra.security && ORDER[level] >= ORDER.WARNING) {
      appendFileSync(path.join(this.dir, `security-${day}.log`), `${line}\n`)
    }
    if (this.lastCleanup !== day) {
      this.lastCleanup = day
      this.cleanup(now)
    }
  }

  /** Удалить файлы старше срока хранения: общий — 90 дней, безопасности — 365. */
  cleanup(now: Date): number {
    if (!this.dir || !existsSync(this.dir)) return 0
    let removed = 0
    for (const name of readdirSync(this.dir)) {
      const match = /^(service|security)-(\d{4}-\d{2}-\d{2})\.log$/.exec(name)
      if (!match) continue
      const keep = match[1] === 'security' ? SECURITY_LOG_RETENTION_DAYS : LOG_RETENTION_DAYS
      const age = (now.getTime() - Date.parse(`${match[2]}T00:00:00Z`)) / 86_400_000
      if (age > keep) {
        rmSync(path.join(this.dir, name))
        removed += 1
      }
    }
    return removed
  }
}

/** Идентификатор запроса: чужой принимается, только если похож на идентификатор. */
export function requestIdFrom(incoming: unknown, fallback: () => string): string {
  const value = typeof incoming === 'string' ? incoming.trim() : ''
  return value && value.length <= 64 && /^[\w.-]+$/.test(value) ? value : fallback()
}
