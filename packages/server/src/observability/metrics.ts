/**
 * Метрики для Prometheus (ТЗ 13, п.4–5).
 *
 * Собираются: загрузка CPU и память процесса, место на диске, число запросов
 * в секунду (счётчик запросов), время ответа (гистограмма), ошибки HTTP 5xx,
 * размер очередей сообщений RabbitMQ, активные сессии пользователей. Метрики
 * другого сервиса (ML-модулей) Prometheus забирает у него самого.
 */
import { statfs } from 'node:fs/promises'
import client from 'prom-client'

// Границы гистограммы времени ответа, секунды: 0.2 — целевой 95-й процентиль
// ТЗ 11, п.10; 0.5 — порог алерта ТЗ 13, п.7.
const LATENCY_BUCKETS = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2.5, 5, 10]

export class Metrics {
  readonly registry = new client.Registry()
  readonly requests: client.Counter<'method' | 'status'>
  readonly errors5xx: client.Counter
  readonly latency: client.Histogram<'method'>
  readonly gauges = new Map<string, client.Gauge>()

  constructor(service: string) {
    this.registry.setDefaultLabels({ service })
    client.collectDefaultMetrics({ register: this.registry, prefix: 'inspector_' })
    this.requests = new client.Counter({ name: 'inspector_http_requests_total',
      help: 'Запросы по методу и коду ответа.', labelNames: ['method', 'status'],
      registers: [this.registry] })
    this.errors5xx = new client.Counter({ name: 'inspector_http_5xx_total',
      help: 'Ответы с ошибкой сервера.', registers: [this.registry] })
    this.latency = new client.Histogram({ name: 'inspector_http_request_duration_seconds',
      help: 'Время ответа.', labelNames: ['method'], buckets: LATENCY_BUCKETS,
      registers: [this.registry] })
  }

  observe(method: string, status: number, seconds: number): void {
    this.requests.inc({ method, status: String(status) })
    if (status >= 500) this.errors5xx.inc()
    this.latency.observe({ method }, seconds)
  }

  gauge(name: string, help: string): client.Gauge {
    let gauge = this.gauges.get(name)
    if (!gauge) {
      gauge = new client.Gauge({ name, help, registers: [this.registry] })
      this.gauges.set(name, gauge)
    }
    return gauge
  }

  async diskUsage(path: string): Promise<void> {
    try {
      const stats = await statfs(path)
      const total = stats.blocks * stats.bsize
      const free = stats.bavail * stats.bsize
      this.gauge('inspector_disk_free_bytes', 'Свободное место на диске данных.').set(free)
      this.gauge('inspector_disk_used_ratio', 'Доля занятого места на диске данных.')
        .set(total ? (total - free) / total : 0)
    } catch {
      // Диск недоступен — метрика не обновляется, а не выдумывается.
    }
  }
}
