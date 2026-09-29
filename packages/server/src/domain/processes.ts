/**
 * Процесс проверки (ТЗ 1.4, 9.1–9.3): жизненный цикл, решения инспектора,
 * финализация, версии протокола.
 *
 * Машинный результат (от ML-модулей) и решения инспектора хранятся раздельно:
 * протокол собирается из них при каждом чтении, поэтому ни одно решение не
 * переписывает машинный вывод, а история решений видна целиком.
 */
import type { Context } from '../context.js'
import { fromJson, nowIso, toJson } from '../db/database.js'
import { conflict, HttpError, invalid, notFound } from '../errors.js'
import * as feedback from './feedback.js'
import { matrixVersion } from './parameters.js'
import * as protocol from './protocol.js'
import type { Json, SnapshotItem } from './protocol.js'

export const STAGES = ['PD', 'RD', 'ID'] as const
export const DECISION_STATUSES = new Set(['CONFIRMED_VIOLATION', 'NEGATIVE_VERIFIED',
  'CLARIFICATION_REQUIRED'])

export interface ProcessRow {
  id: number; object_id: string; run_state: string; stage: string; completed: number; total: number
  input_snapshot: string; result: string | null; error: string | null; cancelled_at: string | null
  finalized_at: string | null; finalized_by: string; sync_status: string; sync_package: string | null
  sync_key: string; sync_attempts: number; sync_next_at: string | null; pending_documents: string
  model_version: string; created_at: string; updated_at: string
}

export interface ProcessRecord extends Omit<ProcessRow, 'input_snapshot' | 'result' | 'pending_documents' |
  'sync_package'> {
  input_snapshot: SnapshotItem[]
  result: Json | null
  pending_documents: Json[]
  sync_package: Json | null
}

export function parse(row: ProcessRow): ProcessRecord {
  return {
    ...row,
    input_snapshot: fromJson(row.input_snapshot, []),
    result: fromJson(row.result, null),
    pending_documents: fromJson(row.pending_documents, []),
    sync_package: fromJson(row.sync_package, null),
  }
}

export function load(ctx: Context, id: number, what = 'процесс не найден'): ProcessRecord {
  const row = ctx.db.prepare('SELECT * FROM processes WHERE id = ?').get(id) as ProcessRow | undefined
  if (!row) throw notFound(what)
  return parse(row)
}

export function update(ctx: Context, id: number, fields: Record<string, unknown>): void {
  const entries = Object.entries(fields).map(([key, value]) => [key,
    value !== null && typeof value === 'object' ? toJson(value) : value] as const)
  const sql = entries.map(([key]) => `${key} = ?`).join(', ')
  ctx.db.prepare(`UPDATE processes SET ${sql}, updated_at = ? WHERE id = ?`)
    .run(...entries.map(([, value]) => value), nowIso(ctx.now()), id)
}

export function event(ctx: Context, processId: number, action: string, author = '', reason = ''): void {
  ctx.db.prepare(`INSERT INTO protocol_events (process_id, action, author, reason, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(processId, action, author, reason, nowIso(ctx.now()))
}

interface DecisionRow {
  version: number; finding_id: string; status: string; author: string; user_id: number | null
  reason: string; reason_code: string; created_at: string
}

function decisions(ctx: Context, processId: number): DecisionRow[] {
  return ctx.db.prepare(`SELECT version, finding_id, status, author, user_id, reason, reason_code,
    created_at FROM inspector_decisions WHERE process_id = ? ORDER BY version`).all(processId) as DecisionRow[]
}

export function decisionVersion(ctx: Context, processId: number): number {
  const row = ctx.db.prepare('SELECT max(version) AS v FROM inspector_decisions WHERE process_id = ?')
    .get(processId) as { v: number | null }
  return row.v ?? 0
}

export function resultChecks(result: Json | null): Json[] {
  return protocol.allFindings(result)
}

function splits(ctx: Context, processId: number): protocol.FindingSplit[] {
  return (ctx.db.prepare('SELECT finding_id, parts FROM finding_splits WHERE process_id = ?').all(processId) as
    { finding_id: string; parts: string }[]).map((row) => ({ finding_id: row.finding_id,
    parts: fromJson<protocol.SplitPart[]>(row.parts, []) }))
}

/** Результат проверки с разделёнными составными кандидатами (копия, исходный не меняется). */
function expandedResult(ctx: Context, proc: ProcessRecord): Json | null {
  const result: Json | null = proc.result ? structuredClone(proc.result) : null
  protocol.applySplits(result, splits(ctx, proc.id))
  return result
}

function protocolVersion(ctx: Context, processId: number): number {
  const row = ctx.db.prepare('SELECT max(version) AS v FROM protocols WHERE process_id = ?')
    .get(processId) as { v: number | null }
  return Math.max(1, row.v ?? 0)
}

export function datasetVersion(ctx: Context): string {
  return feedback.publishedModel(ctx)?.dataset_version ?? ctx.config.datasetVersion
}

/** Процесс целиком для интерфейса и внешнего контракта (результат + решения + протокол). */
export function view(ctx: Context, proc: ProcessRecord): Json {
  const result = expandedResult(ctx, proc)
  const history = decisions(ctx, proc.id)
  if (result) {
    const checks = new Map<string, Json>(resultChecks(result).map((item) => [item.finding_id, item]))
    for (const decision of history) {
      const check = checks.get(decision.finding_id)
      if (!check || decision.version <= (check.decisions_after_version ?? 0)) continue
      check.review_history = [...(check.review_history ?? []), {
        status: decision.status, author: decision.author, user_id: decision.user_id,
        reason: decision.reason, reason_code: decision.reason_code,
        created_at: decision.created_at, version: decision.version,
      }]
      check.finding_status = decision.status
    }
  }
  const built = protocol.build(result, proc.input_snapshot, {
    runState: proc.run_state, finalized: proc.finalized_at !== null, decisions: history.length,
    modelVersion: proc.model_version, datasetVersion: datasetVersion(ctx),
  })
  const last = history[history.length - 1]
  return {
    process_id: proc.id, id: proc.id, object_id: proc.object_id,
    // status — внутреннее состояние задачи (queued → running → completed |
    // cancelled | error); process_status — словарь ТЗ (PENDING … FINALIZED).
    status: proc.run_state, stage: proc.stage, process_status: built.status,
    verification_status: built.verification_status, finalized_at: proc.finalized_at,
    finalized_by: proc.finalized_by || null, sync_status: proc.sync_status,
    sync_attempts: proc.sync_attempts, sync_next_at: proc.sync_next_at,
    pending_documents: proc.pending_documents, protocol_version: protocolVersion(ctx, proc.id),
    completed: proc.completed, total: proc.total, result, protocol: built, error: proc.error,
    version: last?.version ?? 0, created_at: proc.created_at,
    system_comment: last ? feedback.systemComment(last.status, last.reason_code) : '',
  }
}

/** Внешний контракт: status — словарь ТЗ, внутреннее состояние рядом (run_state). */
export function payload(ctx: Context, proc: ProcessRecord): Json {
  const body = view(ctx, proc)
  return { ...body, run_state: body.status, status: body.process_status }
}

export function sourceVersions(ctx: Context, proc: ProcessRecord): Json {
  const versions = view(ctx, proc).protocol.versions
  return { matrix_version: versions.matrix_version, model_version: versions.model_version,
    input_manifest_hash: versions.input_manifest_hash }
}

export interface Actor { userId: number; display: string }

export function decide(ctx: Context, processId: number, input: {
  finding_id: string; status: string; reason: string; reason_code?: string; expected_version: number
}, actor: Actor): void {
  const proc = load(ctx, processId, 'прогон не найден')
  if (proc.run_state !== 'completed' || !proc.result) {
    throw conflict('решение можно сохранить только для завершённой проверки')
  }
  if (proc.finalized_at) throw conflict('протокол финализирован: решения изменить нельзя')
  if (!DECISION_STATUSES.has(input.status)) throw invalid('неизвестный статус решения')
  const reasonCode = (input.reason_code ?? '').trim().toUpperCase()
  if (input.status === 'NEGATIVE_VERIFIED' && !protocol.REASON_CODES[reasonCode]) {
    throw invalid(`при отклонении нужна кодированная причина: ${Object.keys(protocol.REASON_CODES).join(', ')}`)
  }
  const reason = input.reason.trim()
  if (!reason) throw invalid('укажите основание решения')
  const current = decisionVersion(ctx, processId)
  if (input.expected_version !== current) throw conflict('протокол уже изменён; обновите страницу')
  const check = resultChecks(expandedResult(ctx, proc)).find((item) => item.finding_id === input.finding_id)
  if (!check) throw notFound('проверка параметра не найдена')
  const evidence: Json[] = check.evidence ?? []
  if (['CONFIRMED_VIOLATION', 'NEGATIVE_VERIFIED'].includes(input.status) &&
    (check.completeness_status !== 'COMPLETE' || !evidence.length || !evidence.every((item) => item.bbox))) {
    throw invalid('экспертное решение требует полного комплекта доказательств')
  }
  const versions = sourceVersions(ctx, proc)
  ctx.db.transaction(() => {
    ctx.db.prepare(`INSERT INTO inspector_decisions (process_id, version, finding_id, status, author,
      user_id, reason, reason_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(processId,
      current + 1, input.finding_id, input.status, actor.display, actor.userId, reason, reasonCode,
      nowIso(ctx.now()))
    // Разметка для GOLD, лог отклонений и спорных случаев (ТЗ 9.4).
    feedback.recordDecision(ctx, proc, check, { status: input.status, version: current + 1, reason,
      reasonCode, sourceVersions: versions, userId: actor.userId })
  })()
}

/**
 * Разделить составной кандидат на атомарные findings (ТЗ 9.3, п.2): у каждой
 * части свои expected/actual и доказательства с координатами в двух стадиях,
 * решение принимается по каждой части отдельно.
 */
export function split(ctx: Context, processId: number, findingId: string, input: {
  reason: string; expected_version: number
  parts: { expected_value: string; actual_value: string; evidence_indexes: number[] }[]
}, actor: Actor): void {
  const proc = load(ctx, processId, 'прогон не найден')
  if (proc.run_state !== 'completed' || !proc.result) {
    throw conflict('разделить можно только кандидата завершённой проверки')
  }
  if (proc.finalized_at) throw conflict('протокол финализирован: решения изменить нельзя')
  if (input.expected_version !== decisionVersion(ctx, processId)) {
    throw conflict('протокол уже изменён; обновите страницу')
  }
  const reason = input.reason.trim()
  if (!reason) throw invalid('укажите основание разделения')
  if (ctx.db.prepare('SELECT 1 FROM finding_splits WHERE process_id = ? AND finding_id = ?')
    .get(processId, findingId)) throw conflict('кандидат уже разделён')
  const item = resultChecks(view(ctx, proc).result).find((entry) => entry.finding_id === findingId)
  if (!item) throw notFound('кандидат не найден')
  if (item.split_from) throw conflict('часть уже разделённого кандидата не делится повторно')
  if (item.finding_status !== 'CANDIDATE') throw conflict('разделить можно только кандидата без решения')
  const source: Json[] = item.evidence ?? []
  const parts = input.parts.map((part, index) => {
    const indexes = [...new Set(part.evidence_indexes)]
    if (!indexes.length || indexes.some((at) => !Number.isInteger(at) || at < 0 || at >= source.length)) {
      throw invalid(`часть ${index + 1}: укажите доказательства из карточки кандидата`)
    }
    const evidence = indexes.map((at) => source[at])
    if (!hasCoordinates(evidence) || !evidence.every((entry) => entry.bbox)) {
      throw invalid(`часть ${index + 1}: нужны источники с листом и координатами в двух сопоставляемых стадиях`)
    }
    return { expected_value: part.expected_value.trim(), actual_value: part.actual_value.trim(), evidence }
  })
  ctx.db.transaction(() => {
    ctx.db.prepare(`INSERT INTO finding_splits (process_id, finding_id, parts, reason, author, user_id,
      created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(processId, findingId, toJson(parts), reason, actor.display,
      actor.userId, nowIso(ctx.now()))
    event(ctx, processId, 'SPLIT', actor.display, `${findingId} → ${parts.length} частей: ${reason}`)
  })()
}

export function finalize(ctx: Context, processId: number, actor: Actor): void {
  const proc = load(ctx, processId, 'прогон не найден')
  if (proc.finalized_at) throw conflict('протокол уже финализирован')
  if (proc.run_state !== 'completed' || !proc.result) {
    throw conflict('финализировать можно только сформированный протокол')
  }
  const result = view(ctx, proc).result
  const pending = protocol.pendingCandidates(result)
  if (pending.length) throw conflict(`есть кандидаты без решения инспектора: ${pending.join(', ')}`)
  // Техническая ошибка не финализируется как «нарушений нет»: если сбой модели
  // оставил без проверки все параметры, протокол нечего подписывать.
  const checks = resultChecks(result)
  if (checks.some((item) => item.technical_status === 'error') &&
    !checks.some((item) => item.technical_status === 'completed')) {
    throw conflict('не проверен ни один параметр: проверка завершилась технической ошибкой модели. ' +
      'Перезапустите проверку, когда модель будет доступна')
  }
  const now = nowIso(ctx.now())
  ctx.db.transaction(() => {
    update(ctx, processId, { finalized_at: now, finalized_by: actor.display })
    ctx.db.prepare(`UPDATE protocols SET status = ?, finalized_at = ? WHERE process_id = ? AND version =
      (SELECT max(version) FROM protocols WHERE process_id = ?)`)
      .run(protocol.FINALIZED, now, processId, processId)
    event(ctx, processId, 'FINALIZE', actor.display)
  })()
}

export function unfinalize(ctx: Context, processId: number, reason: string, actor: Actor): void {
  const proc = load(ctx, processId, 'прогон не найден')
  if (!reason.trim()) throw invalid('укажите причину отмены')
  if (!proc.finalized_at) throw conflict('протокол не финализирован')
  ctx.db.transaction(() => {
    update(ctx, processId, { finalized_at: null, finalized_by: '' })
    ctx.db.prepare(`UPDATE protocols SET status = ?, finalized_at = NULL WHERE process_id = ? AND version =
      (SELECT max(version) FROM protocols WHERE process_id = ?)`)
      .run(protocol.COMPLETED, processId, processId)
    event(ctx, processId, 'UNFINALIZE', actor.display, reason.trim())
  })()
  // Отмена финализации — событие безопасности, хранится год (ТЗ 9.3; 12, п.5).
  ctx.log.warning(`отменена финализация протокола ${processId}: ${reason.trim()}`,
    { event: 'unfinalize', security: true })
}

export function events(ctx: Context, processId: number): Json[] {
  return ctx.db.prepare(`SELECT action, author, reason, created_at FROM protocol_events
    WHERE process_id = ? ORDER BY id`).all(processId) as Json[]
}

// --- свободный поиск (ТЗ 9.5) ------------------------------------------------

export const SUSPICION_ACTIONS: Record<string, [string, string, string]> = {
  // действие: (допустимый статус находки, новый статус, статус инспектора)
  promote: ['SUSPICION', 'CANDIDATE', 'PROMOTED'],
  dismiss: ['SUSPICION', 'SUSPICION', 'DISMISSED'],
  confirm: ['CANDIDATE', 'CONFIRMED_VIOLATION', 'CONFIRMED'],
  reject: ['CANDIDATE', 'NEGATIVE_VERIFIED', 'REJECTED'],
}

interface SuspicionRow {
  id: number; object_id: string; process_id: number; discovery_method: string; confidence: number | null
  description: string; pd_reference: string; rd_reference: string; review_priority: string
  normative_base: string; parameter_code: string; evidence: string; finding_status: string
  inspector_status: string; inspector_comment: string
}

export function suspicionDict(row: SuspicionRow): Json {
  return {
    suspicion_id: row.id, object_id: row.object_id, discovery_method: row.discovery_method,
    confidence: row.confidence, description: row.description, pd_reference: row.pd_reference,
    rd_reference: row.rd_reference, review_priority: row.review_priority,
    normative_base: row.normative_base, parameter_code: row.parameter_code || null,
    evidence: fromJson(row.evidence, []), finding_status: row.finding_status,
    inspector_status: row.inspector_status, inspector_comment: row.inspector_comment,
  }
}

export function suspicions(ctx: Context, processId: number): Json[] {
  return (ctx.db.prepare('SELECT * FROM suspicions WHERE process_id = ? ORDER BY id').all(processId) as
    SuspicionRow[]).map(suspicionDict)
}

/** Для перевода в CANDIDATE: источники с координатами в двух сопоставляемых стадиях (ТЗ 9.5). */
export function hasCoordinates(evidence: Json[]): boolean {
  const stages = new Set(evidence.filter((item) => item.bbox !== undefined && item.bbox !== null &&
    item.document_id !== undefined && item.document_id !== null && item.page !== undefined &&
    item.page !== null).map((item) => item.stage))
  return STAGES.filter((stage) => stages.has(stage)).length >= 2
}

export function reviewSuspicion(ctx: Context, processId: number, suspicionId: number, input: {
  action: string; comment?: string; reason_code?: string; evidence?: Json[] | null
}, actor: Actor): Json {
  const proc = load(ctx, processId, 'гипотеза не найдена')
  const row = ctx.db.prepare('SELECT * FROM suspicions WHERE id = ?').get(suspicionId) as SuspicionRow | undefined
  if (!row || row.process_id !== processId) throw notFound('гипотеза не найдена')
  if (proc.finalized_at) throw conflict('протокол финализирован: решения изменить нельзя')
  const action = SUSPICION_ACTIONS[input.action]
  if (!action) throw invalid(`действие: ${Object.keys(SUSPICION_ACTIONS).join(', ')}`)
  const [required, findingStatus, inspectorStatus] = action
  if (row.finding_status !== required || row.inspector_status === 'DISMISSED') {
    throw conflict(`действие недоступно для статуса ${row.finding_status}`)
  }
  const reasonCode = (input.reason_code ?? '').trim().toUpperCase()
  const comment = (input.comment ?? '').trim()
  if (input.action === 'reject' && !protocol.REASON_CODES[reasonCode]) {
    throw invalid(`при отклонении нужна кодированная причина: ${Object.keys(protocol.REASON_CODES).join(', ')}`)
  }
  if (['dismiss', 'confirm', 'reject'].includes(input.action) && !comment) {
    throw invalid('укажите основание решения')
  }
  const evidence = input.evidence ?? fromJson<Json[]>(row.evidence, [])
  if (input.action === 'promote' && !hasCoordinates(evidence)) {
    throw invalid('для перевода в кандидаты нужны источники с листом и координатами в двух сопоставляемых стадиях')
  }
  const inspectorComment = [reasonCode, comment].filter(Boolean).join(' ')
  ctx.db.transaction(() => {
    ctx.db.prepare(`UPDATE suspicions SET evidence = ?, finding_status = ?, inspector_status = ?,
      inspector_comment = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`).run(toJson(evidence),
      findingStatus, inspectorStatus, inspectorComment, actor.userId, nowIso(ctx.now()), suspicionId)
    if (feedback.LABELS[findingStatus]) {
      feedback.recordDecision(ctx, proc, { finding_id: `S-${suspicionId}`,
        parameter_code: row.parameter_code, finding_status: 'CANDIDATE',
        explanation: row.description, evidence, completeness_status: 'COMPLETE' },
      { status: findingStatus, version: decisionVersion(ctx, processId), reason: comment,
        reasonCode, sourceVersions: sourceVersions(ctx, proc), userId: actor.userId })
    }
    // Протокол читает гипотезы из результата процесса — обновляем и его.
    const result: Json = structuredClone(proc.result ?? {})
    const free = result.free_search ?? { status: 'completed', items: [] }
    const fresh = suspicionDict(ctx.db.prepare('SELECT * FROM suspicions WHERE id = ?').get(suspicionId) as SuspicionRow)
    free.items = (free.items ?? []).map((item: Json) => (item.suspicion_id === suspicionId ? fresh : item))
    result.free_search = free
    update(ctx, processId, { result })
    event(ctx, processId, `SUSPICION_${input.action.toUpperCase()}`, actor.display, inspectorComment)
  })()
  return suspicionDict(ctx.db.prepare('SELECT * FROM suspicions WHERE id = ?').get(suspicionId) as SuspicionRow)
}

export async function cancel(ctx: Context, processId: number): Promise<void> {
  const proc = load(ctx, processId, 'прогон не найден')
  const now = nowIso(ctx.now())
  if (['queued', 'parsing'].includes(proc.run_state)) {
    // Проверка ещё не начиналась — остановка сразу.
    update(ctx, processId, { cancelled_at: now, run_state: 'cancelled', stage: 'Остановлено до начала проверки' })
    return
  }
  if (proc.run_state !== 'running') return
  // Проверка идёт в ML-модуле: флаг в Redis, остановка на безопасной точке.
  update(ctx, processId, { cancelled_at: now, stage: 'Остановка на безопасной точке' })
  await ctx.flags.set(`inspector:cancel:${processId}`)
}

export function ensureObject(ctx: Context, objectId: string): void {
  ctx.db.prepare('INSERT OR IGNORE INTO objects (id, created_at) VALUES (?, ?)').run(objectId, nowIso(ctx.now()))
}

export function newProcess(ctx: Context, objectId: string, snapshot: SnapshotItem[]): number {
  ensureObject(ctx, objectId)
  const now = nowIso(ctx.now())
  const info = ctx.db.prepare(`INSERT INTO processes (object_id, run_state, stage, input_snapshot,
    created_at, updated_at) VALUES (?, 'queued', 'Разбор документов', ?, ?, ?)`)
    .run(objectId, toJson(snapshot), now, now)
  return Number(info.lastInsertRowid)
}

export function httpStatusError(status: string, action: string): HttpError {
  return conflict(`${action} невозможна в статусе ${status}`)
}

export { matrixVersion }
