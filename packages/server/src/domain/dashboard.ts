/**
 * Дашборд инспектора (ТЗ 7, модуль 7).
 *
 * По каждому объекту — последний процесс проверки и цвет:
 *   красный — есть подтверждённые инспектором нарушения;
 *   жёлтый  — кандидаты без решения, неполные доказательства, ошибка или
 *             проверка ещё идёт: объект требует внимания;
 *   зелёный — проверка завершена, нарушений не подтверждено, открытых
 *             кандидатов нет. Это не «нарушений нет», а «работы не осталось».
 * Фильтры — по разделам, статусам, цвету и датам.
 */
import type { Context } from '../context.js'
import * as processes from './processes.js'
import type { Json } from './protocol.js'

export const GREEN = 'green'
export const YELLOW = 'yellow'
export const RED = 'red'

function color(body: Json): string {
  const proto = body.protocol
  if (proto.tables.confirmed_violations.length) return RED
  if (['queued', 'parsing', 'running', 'error'].includes(body.status) || proto.pending_candidates.length ||
    proto.missing_evidence.length) return YELLOW
  return GREEN
}

function sections(body: Json): Set<string> {
  return new Set(((body.result ?? {}).checks ?? []).filter((item: Json) => item.section &&
    ['CANDIDATE', 'CONFIRMED_VIOLATION', 'SUSPICION'].includes(item.finding_status))
    .map((item: Json) => item.section as string))
}

export function dashboard(ctx: Context, filters: { section?: string; status?: string; color?: string
  date_from?: string; date_to?: string }): Json {
  const rows = ctx.db.prepare('SELECT * FROM processes ORDER BY id').all() as processes.ProcessRow[]
  const latest = new Map<string, processes.ProcessRow>()
  for (const row of rows) latest.set(row.object_id, row)
  const objects: Json[] = []
  const allSections = new Set<string>()
  for (const [objectId, row] of [...latest.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const body = processes.view(ctx, processes.parse(row))
    const proto = body.protocol
    const found = sections(body)
    found.forEach((item) => allSections.add(item))
    const object = ctx.db.prepare('SELECT name, address FROM objects WHERE id = ?').get(objectId) as
      { name: string; address: string } | undefined
    const item = {
      object_id: objectId, name: object?.name ?? '', address: object?.address ?? '',
      process_id: row.id, color: color(body), status: body.process_status, scenario: proto.scenario,
      created_at: row.created_at, finalized_at: body.finalized_at,
      confirmed: proto.tables.confirmed_violations.length, pending_candidates: proto.pending_candidates.length,
      suspicions: proto.tables.suspicions.length, missing_evidence: proto.missing_evidence.length,
      sections: [...found].sort(), sync_status: body.sync_status, new_documents: body.pending_documents.length,
    }
    const day = row.created_at.slice(0, 10)
    if ((filters.section && !found.has(filters.section)) || (filters.status && item.status !== filters.status) ||
      (filters.color && item.color !== filters.color) || (filters.date_from && day < filters.date_from) ||
      (filters.date_to && day > filters.date_to)) continue
    objects.push(item)
  }
  return { objects, sections: [...allSections].sort(),
    totals: Object.fromEntries([GREEN, YELLOW, RED].map((name) => [name,
      objects.filter((item) => item.color === name).length])) }
}
