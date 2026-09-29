/**
 * Постановка задач ML-модулям и приём их результатов (ТЗ 1.5, 9.1, 9.2).
 *
 * Разбор каждого файла и проверка комплекта — задачи в очереди RabbitMQ.
 * Сервер помнит каждую задачу со сроком: не пришёл результат — задача
 * повторяется (ТЗ 9.1: до двух повторов), после исчерпания повторов файл или
 * процесс получает статус ошибки с причиной, а администратор — уведомление.
 * Опоздавший результат снятой задачи игнорируется: повтор уже в работе.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '../context.js'
import { fromJson, nowIso, toJson } from '../db/database.js'
import {
  CANCEL_KEY_PREFIX, QUEUE_INSPECT, QUEUE_PARSE, type DocumentRef, type InspectTask, type ParseTask,
  type Progress, type TaskResult,
} from '../queue/contracts.js'
import { fileMetadata, type FileRow } from './files.js'
import { listParameters, matrixVersion } from './parameters.js'
import * as processes from './processes.js'
import * as protocol from './protocol.js'
import type { Json } from './protocol.js'
import { evidenceGroupId } from './feedback.js'
import { notify } from './notifications.js'

// ТЗ 9.1: таймаут — повторная попытка обработки до 2 раз.
export const MAX_RETRIES = 2

interface TaskRow {
  id: string; kind: string; ref_id: number; attempt: number; status: string; payload: string
  deadline: string
}

function deadline(ctx: Context, kind: string): string {
  const seconds = kind === 'inspect' ? ctx.config.inspectTimeoutS : ctx.config.taskTimeoutS
  return nowIso(new Date(ctx.now().getTime() + seconds * 1000))
}

async function enqueue(ctx: Context, kind: 'parse' | 'inspect', refId: number, body: Json,
  attempt = 1): Promise<string> {
  const id = randomUUID()
  const message = { ...body, task_id: id, kind, attempt }
  const now = nowIso(ctx.now())
  ctx.db.prepare(`INSERT INTO tasks (id, kind, ref_id, attempt, status, payload, deadline, created_at,
    updated_at) VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?)`)
    .run(id, kind, refId, attempt, toJson(message), deadline(ctx, kind), now, now)
  await ctx.broker.publish(kind === 'parse' ? QUEUE_PARSE : QUEUE_INSPECT, message)
  return id
}

function setTask(ctx: Context, id: string, status: string, error: string | null = null): void {
  ctx.db.prepare('UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE id = ?')
    .run(status, error, nowIso(ctx.now()), id)
}

export async function dispatchParse(ctx: Context, file: FileRow): Promise<void> {
  const document: ParseTask['document'] = { id: file.id, name: file.file_name, sha256: file.file_hash,
    source_format: file.source_format, derived_sha256: file.derived_hash,
    derived_format: file.derived_format }
  await enqueue(ctx, 'parse', file.id, { document })
}

function historyValues(ctx: Context, objectId: string): Record<string, number[]> {
  // Значения параметров на ДРУГИХ объектах: последний завершённый процесс объекта (ТЗ 9.5, п.4).
  const rows = ctx.db.prepare(`SELECT object_id, result FROM processes WHERE object_id != ? AND
    run_state = 'completed' AND result IS NOT NULL ORDER BY id`).all(objectId) as
    { object_id: string; result: string }[]
  const latest = new Map<string, Json>()
  for (const row of rows) latest.set(row.object_id, fromJson(row.result, {}))
  const values: Record<string, number[]> = {}
  for (const result of latest.values()) {
    for (const check of result.checks ?? []) {
      const match = /-?\d+(?:[.,]\d+)?/.exec(String(check.actual_value ?? '').replace(/\s/g, ''))
      if (match && check.technical_status === 'completed') {
        (values[check.parameter_code] ??= []).push(Number(match[0].replace(',', '.')))
      }
    }
  }
  return values
}

function freeSearchInputs(ctx: Context, objectId: string): InspectTask['free_search'] {
  const rules = ctx.db.prepare(`SELECT id, rule_name, condition, expected, normative_base,
    review_priority FROM logical_rules WHERE is_active = 1`).all() as Json[]
  const norms = ctx.db.prepare(`SELECT id, document_number, section, parameter_name, min_value,
    max_value, effective_from, effective_to FROM normative_base WHERE is_active = 1`).all() as Json[]
  return { rules, norms, history: historyValues(ctx, objectId) }
}

function filesOf(ctx: Context, ids: number[]): Map<number, FileRow> {
  if (!ids.length) return new Map()
  const rows = ctx.db.prepare(`SELECT * FROM files WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as FileRow[]
  return new Map(rows.map((row) => [row.id, row]))
}

/** Запустить проверку, когда все документы процесса разобраны. */
export async function dispatchIfReady(ctx: Context, processId: number): Promise<void> {
  const proc = processes.load(ctx, processId)
  if (!['queued', 'parsing'].includes(proc.run_state)) return
  if (proc.cancelled_at) {
    processes.update(ctx, processId, { run_state: 'cancelled', stage: 'Остановлено до начала проверки' })
    return
  }
  const files = filesOf(ctx, proc.input_snapshot.map((item) => item.id))
  const rows = proc.input_snapshot.map((item) => files.get(item.id))
  if (rows.some((row) => !row || row.status === 'PARSING')) {
    // ТЗ 9.1: PARSING — выполняется разбор документов, дозагрузка недоступна.
    processes.update(ctx, processId, { run_state: 'parsing', stage: 'Разбор документов' })
    return
  }
  const readable = rows.filter((row): row is FileRow => row?.status === 'OK')
  if (!readable.length) {
    processes.update(ctx, processId, { run_state: 'error',
      error: 'проверка не выполнена: ни один документ комплекта не разобран' })
    return
  }
  const documents: DocumentRef[] = readable.map((row) => {
    const snapshot = proc.input_snapshot.find((item) => item.id === row.id)
    return { id: row.id, name: row.file_name, sha256: row.file_hash, source_format: row.source_format,
      derived_sha256: row.derived_hash, derived_format: row.derived_format, pages: row.pages,
      metadata: snapshot?.metadata ?? fileMetadata(row) }
  })
  const previous = ctx.db.prepare(`SELECT version, result FROM protocols WHERE process_id = ? AND
    result IS NOT NULL ORDER BY version DESC LIMIT 1`).get(processId) as
    { version: number; result: string } | undefined
  const task: Omit<InspectTask, 'task_id' | 'kind' | 'attempt'> = {
    process_id: processId, object_id: proc.object_id, documents,
    parameters: listParameters(ctx), matrix_version: matrixVersion(ctx),
    previous: previous ? { version: previous.version, result: fromJson(previous.result, null) } : null,
    decision_version: processes.decisionVersion(ctx, processId),
    free_search: freeSearchInputs(ctx, proc.object_id),
  }
  processes.update(ctx, processId, { run_state: 'running', stage: 'Проверка по матрице',
    error: null })
  await ctx.flags.clear(`${CANCEL_KEY_PREFIX}${processId}`)
  await enqueue(ctx, 'inspect', processId, task)
}

/** Процессы в очереди, куда входит файл: после его разбора — проверить готовность. */
async function processesWaitingFor(ctx: Context, fileId: number): Promise<void> {
  const rows = ctx.db.prepare("SELECT id, input_snapshot FROM processes WHERE run_state IN ('queued', 'parsing')")
    .all() as { id: number; input_snapshot: string }[]
  for (const row of rows) {
    if (fromJson<Json[]>(row.input_snapshot, []).some((item) => item.id === fileId)) {
      await dispatchIfReady(ctx, row.id)
    }
  }
}

function markFile(ctx: Context, fileId: number, fields: Record<string, unknown>): void {
  const entries = Object.entries(fields)
  ctx.db.prepare(`UPDATE files SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
    .run(...entries.map(([, value]) => (value !== null && typeof value === 'object' ? toJson(value) : value)),
      fileId)
}

export async function handleResult(ctx: Context, message: TaskResult): Promise<void> {
  const task = ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(message.task_id) as TaskRow | undefined
  if (!task || task.status !== 'QUEUED') return // снятая или уже обработанная задача
  if (message.status === 'error') {
    if (!message.permanent && task.attempt <= MAX_RETRIES) {
      setTask(ctx, task.id, 'RETRIED', message.error ?? '')
      await retry(ctx, task)
      return
    }
    setTask(ctx, task.id, 'FAILED', message.error ?? '')
    failTarget(ctx, task, message.error ?? 'ошибка обработки')
    if (task.kind === 'parse') await processesWaitingFor(ctx, task.ref_id)
    return
  }
  setTask(ctx, task.id, 'DONE')
  if (task.kind === 'parse') {
    const payload = message.payload ?? {}
    markFile(ctx, task.ref_id, { status: 'OK', parse_error: null, pages: Number(payload.pages ?? 0),
      parse_info: payload })
    await processesWaitingFor(ctx, task.ref_id)
  } else {
    applyInspection(ctx, task.ref_id, message.payload ?? {})
  }
}

function failTarget(ctx: Context, task: TaskRow, reason: string): void {
  const attempts = `после ${task.attempt} попыток`
  if (task.kind === 'parse') {
    const file = ctx.db.prepare('SELECT file_name FROM files WHERE id = ?').get(task.ref_id) as
      { file_name: string } | undefined
    markFile(ctx, task.ref_id, { status: 'ERROR', parse_error: `${reason} (${attempts})` })
    notify(ctx, 'admin', 'processing_failed', null,
      `Файл «${file?.file_name ?? task.ref_id}» не обработан ${attempts}: ${reason}`)
  } else {
    processes.update(ctx, task.ref_id, { run_state: 'error', error: `проверка не выполнена ${attempts}: ${reason}` })
    notify(ctx, 'admin', 'processing_failed', task.ref_id,
      `Проверка процесса ${task.ref_id} не выполнена ${attempts}: ${reason}`)
  }
  ctx.log.error(`задача ${task.kind} для ${task.ref_id} не выполнена ${attempts}: ${reason}`,
    { event: 'processing_failed' })
}

async function retry(ctx: Context, task: TaskRow): Promise<void> {
  const body = fromJson<Json>(task.payload, {})
  delete body.task_id
  delete body.attempt
  delete body.kind
  await enqueue(ctx, task.kind as 'parse' | 'inspect', task.ref_id, body, task.attempt + 1)
}

/** Задачи с истёкшим сроком: повтор или отказ с уведомлением (ТЗ 9.1). */
export async function checkTimeouts(ctx: Context): Promise<number> {
  const overdue = ctx.db.prepare("SELECT * FROM tasks WHERE status = 'QUEUED' AND deadline <= ?")
    .all(nowIso(ctx.now())) as TaskRow[]
  for (const task of overdue) {
    if (task.attempt <= MAX_RETRIES) {
      setTask(ctx, task.id, 'TIMEOUT', 'превышено время обработки; поставлен повтор')
      await retry(ctx, task)
    } else {
      setTask(ctx, task.id, 'FAILED', 'превышено время обработки')
      failTarget(ctx, task, 'превышено время обработки')
      if (task.kind === 'parse') await processesWaitingFor(ctx, task.ref_id)
    }
  }
  return overdue.length
}

export function handleProgress(ctx: Context, message: Progress): void {
  const row = ctx.db.prepare('SELECT run_state FROM processes WHERE id = ?').get(message.process_id) as
    { run_state: string } | undefined
  if (!row || !['queued', 'parsing', 'running'].includes(row.run_state)) return
  processes.update(ctx, message.process_id, { stage: String(message.stage), completed: message.completed,
    total: message.total })
}

function unreadableProblems(ctx: Context, proc: processes.ProcessRecord): Record<string, string> {
  const files = filesOf(ctx, proc.input_snapshot.map((item) => item.id))
  const problems: Record<string, string> = {}
  for (const item of proc.input_snapshot) {
    const file = files.get(item.id)
    if (file?.status !== 'ERROR') continue
    const stage = String(item.metadata?.stage ?? '')
    if (!stage) continue
    const note = `файл «${file.file_name}» не разобран: ${file.parse_error ?? 'ошибка'}`
    problems[stage] = problems[stage] ? `${problems[stage]}; ${note}` : note
  }
  return problems
}

/** Сохранить результат проверки: процесс, версия протокола, Checks, Evidence_Fragments, Suspicions. */
export function applyInspection(ctx: Context, processId: number, payload: Json): void {
  const proc = processes.load(ctx, processId)
  const result: Json = payload.result ?? {}
  const problems = unreadableProblems(ctx, proc)
  if (Object.keys(problems).length) {
    const selection = result.document_selection ?? { selected: {}, problems: {} }
    selection.problems = { ...(selection.problems ?? {}), ...Object.fromEntries(Object.entries(problems)
      .map(([stage, note]) => [stage, [selection.problems?.[stage], note].filter(Boolean).join('; ')])) }
    result.document_selection = selection
  }
  const now = nowIso(ctx.now())
  ctx.db.transaction(() => {
    // Гипотезы свободного поиска (ТЗ 9.5) — в таблицу Suspicions.
    const free = result.free_search ?? { status: 'not_run', reason: 'свободный поиск не выполнялся', items: [] }
    // Дозагрузка не сбрасывает верификацию (ТЗ 9.3, п.3): гипотезы с решением
    // инспектора остаются, заменяются только нерассмотренные.
    ctx.db.prepare(`DELETE FROM suspicions WHERE process_id = ? AND inspector_status = 'PENDING'`).run(processId)
    const reviewed = new Set((ctx.db.prepare('SELECT discovery_method, description FROM suspicions WHERE process_id = ?')
      .all(processId) as { discovery_method: string; description: string }[])
      .map((row) => `${row.discovery_method}\u0000${row.description}`))
    const insert = ctx.db.prepare(`INSERT INTO suspicions (object_id, process_id, discovery_method,
      confidence, description, pd_reference, rd_reference, review_priority, normative_base,
      parameter_code, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const item of free.items ?? []) {
      if (reviewed.has(`${item.discovery_method}\u0000${item.description ?? ''}`)) continue
      insert.run(proc.object_id, processId, item.discovery_method, item.confidence ?? null,
        item.description ?? '', item.pd_reference ?? '', item.rd_reference ?? '',
        item.review_priority ?? 'MEDIUM', item.normative_base ?? '', item.parameter_code ?? '',
        toJson(item.evidence ?? []), now)
    }
    free.items = (ctx.db.prepare('SELECT * FROM suspicions WHERE process_id = ? ORDER BY id').all(processId) as
      Parameters<typeof processes.suspicionDict>[0][]).map(processes.suspicionDict)
    result.free_search = free
    const cancelled = proc.cancelled_at !== null
    const total = Number(result.coverage?.total ?? (result.checks ?? []).length)
    processes.update(ctx, processId, {
      result, run_state: cancelled ? 'cancelled' : 'completed', stage: cancelled ? 'Остановлено' : 'Готово',
      completed: total, total, model_version: String(payload.model_version ?? ''), error: null,
    })
    storeProtocolVersion(ctx, processId)
  })()
  notify(ctx, 'inspector', 'protocol_ready', processId,
    `Протокол по объекту ${proc.object_id} сформирован и ожидает верификации (процесс ${processId})`)
}

function storeProtocolVersion(ctx: Context, processId: number): void {
  const proc = processes.load(ctx, processId)
  const body = processes.view(ctx, proc)
  const versions = body.protocol.versions
  const version = ((ctx.db.prepare('SELECT max(version) AS v FROM protocols WHERE process_id = ?')
    .get(processId) as { v: number | null }).v ?? 0) + 1
  const info = ctx.db.prepare(`INSERT INTO protocols (process_id, object_id, version, matrix_version,
    dataset_version, model_version, input_manifest_hash, status, result, input_snapshot, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(processId, proc.object_id, version,
    versions.matrix_version, versions.dataset_version, versions.model_version,
    versions.input_manifest_hash, body.protocol.status, toJson(proc.result),
    toJson(proc.input_snapshot), nowIso(ctx.now()))
  const protocolId = Number(info.lastInsertRowid)
  const params = new Map((ctx.db.prepare('SELECT id, code FROM params').all() as { id: number; code: string }[])
    .map((row) => [row.code, row.id]))
  const insertCheck = ctx.db.prepare(`INSERT INTO checks (protocol_id, param_id, object_id, finding_id,
    parameter_code, expected_value, actual_value, delta, completeness_status, finding_status,
    technical_status, review_priority, evidence_group_id, explanation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insertEvidence = ctx.db.prepare(`INSERT INTO evidence_fragments (protocol_id, finding_id,
    evidence_group_id, file_id, document_id, sha256, stage, sheet_page, bbox_polygon_norm,
    extracted_value, quote, role_expected_actual) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const check of protocol.allFindings(proc.result)) {
    const evidence: Json[] = check.evidence ?? []
    const group = evidenceGroupId(proc.object_id, String(check.parameter_code ?? ''), evidence)
    insertCheck.run(protocolId, params.get(check.parameter_code) ?? null, proc.object_id,
      String(check.finding_id), String(check.parameter_code ?? ''), check.expected_value ?? null,
      check.actual_value ?? null, typeof check.delta === 'number' ? check.delta : null,
      check.completeness_status ?? null, check.finding_status ?? null, check.technical_status ?? null,
      check.priority ?? null, group, String(check.explanation ?? ''))
    for (const item of evidence) {
      const role = item.stage === 'PD' ? 'EXPECTED' : 'ACTUAL'
      insertEvidence.run(protocolId, String(check.finding_id), group, item.file_id ?? null,
        item.document_id ?? null, item.sha256 ?? null, item.stage ?? null, item.page ?? null,
        item.bbox ? toJson(item.bbox) : null,
        (role === 'EXPECTED' ? check.expected_value : check.actual_value) ?? null,
        item.quote ?? null, role)
    }
  }
}
