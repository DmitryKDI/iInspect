/**
 * Передача результатов в ИАИС «РиН» (ТЗ 9.6; 12, п.10).
 *
 * Передаются только подтверждённые инспектором записи финализированного
 * протокола вместе с версиями протокола, матрицы, модели и реестром входных
 * файлов (ТЗ 9.3, п.4). Адрес приёма задаётся окружением; пока он не задан,
 * пакет формируется, а статус честно LOCAL_ONLY.
 *
 * Аутентификация — клиентский сертификат (УКЭП) по TLS 1.3. Криптография ГОСТ
 * выполняется сертифицированным СКЗИ заказчика (шлюз перед приёмником); сервер
 * передаёт сертификат и ключ стандартным TLS. Адрес проходит проверку контура:
 * наружу опечаткой в окружении выйти нельзя.
 *
 * При 5xx, таймауте или обрыве связи статус PENDING_SYNC и до трёх повторов
 * через 1, 5 и 15 минут. Сбой передачи не отменяет решение инспектора.
 */
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { Agent } from 'undici'
import type { Context } from '../context.js'
import { nowIso } from '../db/database.js'
import * as processes from './processes.js'

export const LOCAL_ONLY = 'LOCAL_ONLY'
export const SENT = 'SENT'
export const PENDING_SYNC = 'PENDING_SYNC'
export const SEND_FAILED = 'SEND_FAILED'
export const SEND_REFUSED = 'SEND_REFUSED'
// Задержки повторов, минуты (ТЗ 9.6: 1, 5, 15 минут).
export const RETRY_DELAYS_MIN = [1, 5, 15]
// Сколько ждать ответа приёмника, мс: пакет — протокол, а не файлы.
const SEND_TIMEOUT_MS = 30_000

export interface SyncResult { status: string; detail: string; retryable: boolean }

function privateIpv4(host: string): boolean {
  const [a, b] = host.split('.').map(Number)
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** Адрес внутри контура: петля, частная сеть, имя сервиса или явно разрешённое имя. */
export function isLocalUrl(url: string, allowed: string[]): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return false
  if (host === 'localhost' || allowed.includes(host)) return true
  const version = isIP(host)
  if (version === 4) return privateIpv4(host)
  if (version === 6) return host === '::1' || host.startsWith('fc') || host.startsWith('fd')
  return !host.includes('.')
}

function dispatcher(ctx: Context): Agent | undefined {
  const { rinClientCert, rinClientKey, rinCa } = ctx.config
  if (!rinClientCert && !rinCa) return undefined
  return new Agent({ connect: {
    cert: rinClientCert ? readFileSync(rinClientCert) : undefined,
    key: rinClientKey ? readFileSync(rinClientKey) : undefined,
    ca: rinCa ? readFileSync(rinCa) : undefined,
    minVersion: 'TLSv1.3',
  } })
}

export async function send(ctx: Context, pack: unknown, key: string): Promise<SyncResult> {
  const url = ctx.config.rinUrl
  if (!url) return { status: LOCAL_ONLY, detail: 'передача не включена: адрес приёма (INSPECTOR_RIN_URL) не задан', retryable: false }
  if (!isLocalUrl(url, ctx.config.allowedHosts)) {
    return { status: SEND_REFUSED, detail: 'адрес приёма должен использовать HTTPS и находиться внутри контура: ' +
      'разрешены имена сервисов, частные сети и имена из INSPECTOR_ALLOWED_HOSTS', retryable: false }
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Idempotency-Key': key }
  if (ctx.config.rinToken) headers.Authorization = `Bearer ${ctx.config.rinToken}`
  let response: Response
  try {
    response = await ctx.send(url, { method: 'POST', headers, body: JSON.stringify(pack),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS), dispatcher: dispatcher(ctx) })
  } catch (error) {
    const message = (error as Error).message
    // Ошибка настройки (нет файла сертификата) повтором не лечится.
    if (/ENOENT|certificate|key/i.test(message) && !/timeout|ECONN|fetch failed/i.test(message)) {
      return { status: SEND_FAILED, detail: `отправка не выполнена: ${message}`, retryable: false }
    }
    return { status: SEND_FAILED, detail: `приёмник недоступен: ${message}`, retryable: true }
  }
  if (response.ok) return { status: SENT, detail: `принято приёмником: HTTP ${response.status}`, retryable: false }
  const body = (await response.text().catch(() => '')).slice(0, 200)
  return { status: SEND_FAILED, detail: `приёмник отказал: HTTP ${response.status} ${body}`,
    retryable: response.status >= 500 }
}

/** Когда повторять после `attemptsDone` неудачных попыток; null — повторы исчерпаны. */
export function nextAttempt(attemptsDone: number, now: Date): Date | null {
  const retriesDone = attemptsDone - 1
  if (retriesDone >= RETRY_DELAYS_MIN.length) return null
  return new Date(now.getTime() + RETRY_DELAYS_MIN[retriesDone] * 60_000)
}

export async function attempt(ctx: Context, processId: number): Promise<SyncResult> {
  const proc = processes.load(ctx, processId)
  const result = await send(ctx, proc.sync_package ?? {}, proc.sync_key || `inspector-${processId}`)
  const attempts = proc.sync_attempts + 1
  let { status, detail } = result
  let next: string | null = null
  if (result.retryable) {
    const when = nextAttempt(attempts, ctx.now())
    if (when) {
      status = PENDING_SYNC
      next = nowIso(when)
      detail += `; повтор в ${next.slice(11, 16)} UTC`
    } else detail += `; повторы исчерпаны (${RETRY_DELAYS_MIN.length})`
  }
  processes.update(ctx, processId, { sync_attempts: attempts, sync_status: status, sync_next_at: next })
  processes.event(ctx, processId, 'EXPORT_EXTERNAL', '', `попытка ${attempts}: ${status}: ${detail}`)
  if (status === SEND_FAILED) ctx.log.error(`передача в ИАИС «РиН» не выполнена: ${detail}`, { event: 'rin_sync' })
  return { status, detail, retryable: result.retryable }
}

export async function retryDue(ctx: Context): Promise<number> {
  const due = ctx.db.prepare(`SELECT id FROM processes WHERE sync_status = ? AND sync_next_at <= ?`)
    .all(PENDING_SYNC, nowIso(ctx.now())) as { id: number }[]
  for (const row of due) await attempt(ctx, row.id)
  return due.length
}
