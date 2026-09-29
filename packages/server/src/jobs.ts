/**
 * Фоновые задачи сервера (один цикл, проверка сроков раз в POLL_MS):
 *
 *   • задачи ML с истёкшим сроком — повтор до двух раз, затем уведомление (ТЗ 9.1);
 *   • повтор передачи в ИАИС «РиН» через 1, 5, 15 минут (ТЗ 9.6);
 *   • еженедельный отчёт для ML-инженеров (ТЗ 7, модуль 10);
 *   • ежедневная проверка контрольных сумм хранилища (ТЗ 13, п.8);
 *   • резервные копии: каждые 15 минут и ежедневные (ТЗ 12, п.8);
 *   • снимок метрик в таблицу Monitoring_Metrics (ТЗ 10, п.13);
 *   • удаление истёкших сессий.
 *
 * Сбой одной задачи записывается в журнал и не останавливает остальные.
 */
import type { Context } from './context.js'
import { nowIso, toJson } from './db/database.js'
import * as backup from './domain/backup.js'
import { weeklyReport } from './domain/feedback.js'
import * as integrity from './domain/integrity.js'
import { checkTimeouts } from './domain/pipeline.js'
import * as rin from './domain/rin.js'
import { SERVICE } from './observability/logging.js'
import { QUEUE_INSPECT, QUEUE_PARSE } from './queue/contracts.js'

export const POLL_MS = 30_000
export const REPORT_PERIOD_DAYS = 7
export const METRICS_SNAPSHOT_MINUTES = 5

export function weeklyReportDue(ctx: Context): boolean {
  const now = ctx.now()
  const last = ctx.db.prepare('SELECT period_end FROM weekly_reports ORDER BY period_end DESC LIMIT 1').get() as
    { period_end: string } | undefined
  if (last && now.getTime() - Date.parse(last.period_end) < REPORT_PERIOD_DAYS * 86_400_000) return false
  const payload = weeklyReport(ctx, now, REPORT_PERIOD_DAYS)
  ctx.db.prepare(`INSERT INTO weekly_reports (period_start, period_end, payload, created_at)
    VALUES (?, ?, ?, ?)`).run(payload.period_start, payload.period_end, toJson(payload), nowIso(now))
  return true
}

/** Показатели для мониторинга: одинаково в /metrics и в снимке таблицы. */
export async function gauges(ctx: Context): Promise<Record<string, number>> {
  const now = nowIso(ctx.now())
  const count = (sql: string, ...args: unknown[]) => (ctx.db.prepare(sql).get(...args) as { n: number }).n
  const values: Record<string, number> = {
    inspector_active_sessions: count('SELECT count(*) AS n FROM auth_sessions WHERE expires_at > ?', now),
    inspector_processes_in_work: count("SELECT count(*) AS n FROM processes WHERE run_state IN ('queued', 'parsing', 'running')"),
    inspector_pending_sync: count("SELECT count(*) AS n FROM processes WHERE sync_status = 'PENDING_SYNC'"),
    inspector_integrity_failures: integrity.lastFailures(ctx),
    inspector_tasks_failed: count("SELECT count(*) AS n FROM tasks WHERE status = 'FAILED'"),
  }
  for (const [name, queue] of [['inspector_queue_parse_size', QUEUE_PARSE], ['inspector_queue_inspect_size', QUEUE_INSPECT]]) {
    try {
      values[name] = await ctx.broker.queueSize(queue)
    } catch {
      values[name] = -1 // очередь недоступна — видно в метрике и алерте
    }
  }
  return values
}

async function snapshotMetrics(ctx: Context): Promise<void> {
  const last = ctx.db.prepare('SELECT timestamp FROM monitoring_metrics ORDER BY id DESC LIMIT 1').get() as
    { timestamp: string } | undefined
  if (last && ctx.now().getTime() - Date.parse(last.timestamp) < METRICS_SNAPSHOT_MINUTES * 60_000) return
  const now = nowIso(ctx.now())
  const insert = ctx.db.prepare(`INSERT INTO monitoring_metrics (metric_name, value, timestamp, service_name, tags)
    VALUES (?, ?, ?, ?, ?)`)
  const memory = process.memoryUsage()
  const cpu = process.cpuUsage()
  const values = { ...(await gauges(ctx)), process_resident_memory_bytes: memory.rss,
    process_cpu_seconds_total: (cpu.user + cpu.system) / 1e6 }
  for (const [name, value] of Object.entries(values)) insert.run(name, value, now, SERVICE, '{}')
}

function dropExpiredSessions(ctx: Context): void {
  ctx.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(nowIso(ctx.now()))
}

export async function runOnce(ctx: Context): Promise<void> {
  const jobs: [string, () => unknown][] = [
    ['task_timeouts', () => checkTimeouts(ctx)],
    ['rin_retry', () => rin.retryDue(ctx)],
    ['weekly_report', () => weeklyReportDue(ctx)],
    ['integrity', () => integrity.due(ctx)],
    ['backup', () => backup.due(ctx)],
    ['metrics_snapshot', () => snapshotMetrics(ctx)],
    ['sessions', () => dropExpiredSessions(ctx)],
  ]
  for (const [name, job] of jobs) {
    try {
      await job()
    } catch (error) {
      ctx.log.error(`фоновая задача ${name} не выполнена: ${(error as Error).message}`, { event: 'background_job' })
    }
  }
}

export function start(ctx: Context): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    runOnce(ctx).finally(() => { running = false })
  }, POLL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
