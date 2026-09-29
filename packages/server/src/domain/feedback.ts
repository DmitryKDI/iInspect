/**
 * Обратная связь и управляемое дообучение (ТЗ 7, модули 4 и 10; 9.4; 14).
 *
 * Решение инспектора превращается в размеченную запись:
 *   CONFIRMED_VIOLATION    → положительный GOLD-кандидат (черновик набора);
 *   NEGATIVE_VERIFIED      → отрицательный пример (черновик) + Rejection_Log;
 *   CLARIFICATION_REQUIRED → в GOLD не идёт, спорный случай в Dispute_Log.
 *
 * В выпуск (dataset_version) попадают только записи, одобренные куратором,
 * из финализированных протоколов. Разбиение — по объектам: объект получает
 * набор один раз и навсегда, поэтому одна стройка не окажется в TRAIN и
 * HIDDEN_TEST одновременно ни в одном выпуске (ТЗ 14.2).
 */
import { createHash } from 'node:crypto'
import type { Context } from '../context.js'
import { fromJson, nowIso, toJson } from '../db/database.js'
import type { Json, SnapshotItem } from './protocol.js'

export const POSITIVE = 'POSITIVE'
export const NEGATIVE = 'NEGATIVE'
export const LABELS: Record<string, string> = {
  CONFIRMED_VIOLATION: POSITIVE, NEGATIVE_VERIFIED: NEGATIVE,
}

// Приёмочные пороги (ТЗ 14.3) и допустимое ухудшение (ТЗ 9.4) — из самого ТЗ.
export const ACCEPTANCE: Record<string, number> = { precision: 0.9, recall: 0.8, f1: 0.85 }
export const MAX_FALSE_POSITIVE_RATE = 0.1
export const MAX_RECALL_DROP = 0.02
export const MAX_FPR_GROWTH = 0.02
// Доли разбиения объектов на TRAIN / VALIDATION / HIDDEN_TEST, в процентах.
const SPLIT_TRAIN_PERCENT = 70
const SPLIT_VALIDATION_PERCENT = 15

export const TRAIN = 'TRAIN'
export const VALIDATION = 'VALIDATION'
export const HIDDEN_TEST = 'HIDDEN_TEST'
export const SPLITS = [TRAIN, VALIDATION, HIDDEN_TEST]

/** Что посоветовать по коду причины отклонения (ТЗ 7, модуль 10). */
export const SUGGESTED_FIX: Record<string, string> = {
  WRONG_REVISION: 'проверить метаданные редакций и цепочку замены в реестре файлов',
  APPROVED_CHANGE: 'учитывать ведомость согласованных изменений при сравнении параметра',
  OCR_ERROR: 'проверить качество распознавания листов; страницы LOW_QUALITY не использовать ' +
    'как единственный источник',
  BINDING_ERROR: 'проверить привязку цитаты к листу и координатам',
  NOT_APPLICABLE: 'уточнить условие применимости параметра (trigger_logic)',
  NO_DIFFERENCE: 'уточнить правило сравнения или порог параметра в матрице',
  OTHER: 'разобрать основание инспектора вручную',
}

/** Системный комментарий к решению — формулировки ТЗ 9.4. */
export function systemComment(status: string, reasonCode = ''): string {
  if (status === 'NEGATIVE_VERIFIED') {
    return `Результат инспектора: NEGATIVE_VERIFIED. Причина: ${reasonCode || 'не указана'}. ` +
      'Запись включена в черновик следующей версии набора данных; её использование для обучения ' +
      'допускается только после проверки куратором данных и выпуска dataset_version.'
  }
  if (status === 'CLARIFICATION_REQUIRED') {
    return 'Статус: CLARIFICATION_REQUIRED. Показаны точные страницы и доказательные фрагменты. ' +
      'До повторного решения инспектора запись не включается в GOLD и не передаётся во внешнюю систему.'
  }
  if (status === 'CONFIRMED_VIOLATION') {
    return 'Результат инспектора: CONFIRMED_VIOLATION. Запись сохранена как положительный ' +
      'GOLD-кандидат; передача наружу — только после финализации протокола, в обучение — после ' +
      'проверки куратором и выпуска dataset_version.'
  }
  return 'Решение инспектора сохранено отдельной версией.'
}

function sourceOf(evidence: Json[], stages: Set<string>, documents: Map<number, Json>): Json {
  const items = evidence.filter((item) => stages.has(item.stage))
  const first = items[0] ?? {}
  const meta = documents.get(first.document_id) ?? {}
  return {
    file_id: first.file_id ?? null, sha256: first.sha256 ?? null, stage: first.stage ?? null,
    code: meta.document_code ?? null, revision: meta.revision ?? null,
    approval: meta.approval_status ?? null, page: first.page ?? null,
    bbox_polygon: items.filter((item) => item.page === first.page && item.bbox !== undefined &&
      item.bbox !== null).map((item) => item.bbox),
  }
}

/** Объект + параметр + актуальные источники (схема GOLD): один ключ группы. */
export function evidenceGroupId(objectId: string, matrixCode: string, evidence: Json[]): string {
  const sources = evidence.map((item) => `${item.file_id ?? 'None'}:${item.page ?? 'None'}`).sort()
  const raw = [objectId, matrixCode, ...sources].join('|')
  return `EG-${createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
}

export interface ProcessLike {
  id: number
  object_id: string
  input_snapshot: SnapshotItem[]
}

export function goldRecord(ctx: Context, process: ProcessLike, check: Json, options: {
  status: string; reason: string; reasonCode: string; userId: number | null; sourceVersions: Json
}): Json {
  const documents = new Map<number, Json>(process.input_snapshot.map((item) => [item.id, item.metadata]))
  const evidence: Json[] = check.evidence ?? []
  const matrixCode = check.parameter_code ?? ''
  const expected = sourceOf(evidence, new Set(['PD']), documents)
  const actual = sourceOf(evidence, new Set(['RD', 'ID']), documents)
  const record: Json = {
    evidence_group_id: evidenceGroupId(process.object_id, matrixCode, evidence),
    finding_id: check.finding_id, object_id: process.object_id, matrix_code: matrixCode,
    rule_version: options.sourceVersions.matrix_version, expected_value: check.expected_value ?? null,
    actual_value: check.actual_value ?? null, approved_change_ref: check.approved_change_ref || 'NONE',
    completeness_status: check.completeness_status, finding_status: options.status,
    review_priority: check.priority ?? null, expert_id: options.userId,
    timestamp: nowIso(ctx.now()), expert_reason_code: options.reasonCode,
    expert_comment: options.reason, matrix_version: options.sourceVersions.matrix_version,
    model_version: options.sourceVersions.model_version,
    input_manifest_hash: options.sourceVersions.input_manifest_hash,
  }
  for (const [prefix, value] of [['source_expected', expected], ['source_actual', actual]] as const) {
    for (const [key, item] of Object.entries(value)) record[`${prefix}_${key}`] = item
  }
  return record
}

/** Набор объекта: назначается один раз по отпечатку object_id и не меняется. */
export function splitOf(ctx: Context, objectId: string): string {
  const row = ctx.db.prepare('SELECT split FROM object_splits WHERE object_id = ?').get(objectId) as
    { split: string } | undefined
  if (row) return row.split
  const bucket = Number(BigInt(`0x${createHash('sha256').update(objectId).digest('hex')}`) % 100n)
  const split = bucket < SPLIT_TRAIN_PERCENT ? TRAIN
    : bucket < SPLIT_TRAIN_PERCENT + SPLIT_VALIDATION_PERCENT ? VALIDATION : HIDDEN_TEST
  ctx.db.prepare('INSERT INTO object_splits (object_id, split, assigned_at) VALUES (?, ?, ?)')
    .run(objectId, split, nowIso(ctx.now()))
  return split
}

/** Разметка по решению инспектора (вызывается в транзакции решения). */
export function recordDecision(ctx: Context, process: ProcessLike, check: Json, options: {
  status: string; version: number; reason: string; reasonCode: string; sourceVersions: Json
  userId: number | null
}): void {
  const findingId = String(check.finding_id ?? '')
  const existing = ctx.db.prepare('SELECT id FROM dataset_items WHERE process_id = ? AND finding_id = ?')
    .get(process.id, findingId) as { id: number } | undefined
  const label = LABELS[options.status]
  const now = nowIso(ctx.now())
  if (!label) {
    // Решение изменено на уточнение — из GOLD убрать.
    if (existing) ctx.db.prepare("UPDATE dataset_items SET status = 'SUPERSEDED' WHERE id = ?").run(existing.id)
  } else {
    const record = goldRecord(ctx, process, check, options)
    const values = {
      label, version: options.version, code: check.parameter_code ?? '',
      group: record.evidence_group_id, reason: options.reason, reason_code: options.reasonCode,
      machine: check.machine_status ?? check.finding_status ?? '',
      evidence: toJson(check.evidence ?? []), versions: toJson(options.sourceVersions),
      record: toJson(record), expert: options.userId, split: splitOf(ctx, process.object_id),
    }
    if (existing) {
      ctx.db.prepare(`UPDATE dataset_items SET gold_label = @label, decision_version = @version,
        parameter_code = @code, evidence_group_id = @group, reason = @reason,
        reason_code = @reason_code, machine_status = @machine, evidence = @evidence,
        source_versions = @versions, record = @record, expert_id = @expert, split = @split,
        status = 'DRAFT', curated_by = NULL, curated_at = NULL WHERE id = @id`)
        .run({ ...values, id: existing.id })
    } else {
      ctx.db.prepare(`INSERT INTO dataset_items (process_id, object_id, object_group_id, finding_id,
        parameter_code, evidence_group_id, gold_label, expert_id, reason_code, reason,
        decision_version, machine_status, evidence, source_versions, record, split, created_at)
        VALUES (@process, @object, @object, @finding, @code, @group, @label, @expert, @reason_code,
        @reason, @version, @machine, @evidence, @versions, @record, @split, @now)`)
        .run({ ...values, process: process.id, object: process.object_id, finding: findingId, now })
    }
  }
  if (options.status === 'NEGATIVE_VERIFIED') {
    const verdict = `${check.finding_status ?? ''}: ${check.explanation ?? ''}`.replace(/^[:\s]+|[:\s]+$/g, '')
    ctx.db.prepare(`INSERT INTO rejection_log (process_id, violation_id, parameter_code,
      rejection_reason, inspector_comment, ai_verdict, suggested_fix, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(process.id, findingId, check.parameter_code ?? '',
      options.reasonCode, options.reason, verdict,
      SUGGESTED_FIX[options.reasonCode] ?? SUGGESTED_FIX.OTHER, now)
  }
  if (options.status === 'CLARIFICATION_REQUIRED') {
    ctx.db.prepare(`INSERT INTO dispute_log (process_id, violation_id, inspector_comment,
      ai_comment, created_at) VALUES (?, ?, ?, ?, ?)`).run(process.id, findingId, options.reason,
      systemComment(options.status), now)
  } else {
    ctx.db.prepare(`UPDATE dispute_log SET resolution_status = 'RESOLVED', resolved_by = ?,
      resolved_at = ? WHERE process_id = ? AND violation_id = ? AND resolution_status = 'OPEN'`)
      .run(options.status, now, process.id, findingId)
  }
}

export interface DatasetItemRow {
  id: number; process_id: number; object_id: string; finding_id: string; parameter_code: string
  gold_label: string; reason_code: string; reason: string; status: string; evidence: string
  source_versions: string; record: string; machine_status: string; evidence_group_id: string
  decision_version: number; created_at: string; split: string
}

export function itemDict(row: DatasetItemRow): Json {
  return {
    id: row.id, run_id: row.process_id, process_id: row.process_id, object_id: row.object_id,
    finding_id: row.finding_id, parameter_code: row.parameter_code, label: row.gold_label,
    gold_label: row.gold_label, reason_code: row.reason_code, reason: row.reason,
    status: row.status, evidence: fromJson(row.evidence, []),
    evidence_group_id: row.evidence_group_id,
    source_versions: fromJson(row.source_versions, {}), created_at: row.created_at,
  }
}

function complete(evidence: Json[]): boolean {
  const stages = new Set(evidence.filter((item) => item.bbox !== undefined && item.bbox !== null)
    .map((item) => item.stage))
  return stages.has('PD') && (stages.has('RD') || stages.has('ID'))
}

export function curate(ctx: Context, row: DatasetItemRow, approve: boolean, userId: number): void {
  if (!['DRAFT', 'APPROVED', 'EXCLUDED'].includes(row.status)) {
    throw new Error(`запись в статусе ${row.status} не курируется`)
  }
  if (approve && !complete(fromJson(row.evidence, []))) {
    throw new Error('в GOLD — только записи с полным комплектом доказательств')
  }
  ctx.db.prepare('UPDATE dataset_items SET status = ?, curated_by = ?, curated_at = ? WHERE id = ?')
    .run(approve ? 'APPROVED' : 'EXCLUDED', userId, nowIso(ctx.now()), row.id)
}

function hashItems(items: Json[]): string {
  const sorted = [...items].sort((a, b) => a.id - b.id)
  return createHash('sha256').update(stableStringify(sorted)).digest('hex')
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Json).sort().map((key) =>
      `${JSON.stringify(key)}:${stableStringify((value as Json)[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** Выпуск dataset_version из одобренных записей финализированных протоколов. */
export function release(ctx: Context, userId: number, matrixVersion: string): Json {
  const rows = ctx.db.prepare(`SELECT d.* FROM dataset_items d JOIN processes p ON p.id = d.process_id
    WHERE d.status = 'APPROVED' AND p.finalized_at IS NOT NULL ORDER BY d.id`).all() as DatasetItemRow[]
  if (!rows.length) throw new Error('нет одобренных куратором записей из финализированных протоколов')
  const splits: Record<string, Json[]> = Object.fromEntries(SPLITS.map((name) => [name, []]))
  for (const row of rows) {
    splits[splitOf(ctx, row.object_id)].push({ id: row.id, object_id: row.object_id,
      finding_id: row.finding_id, label: row.gold_label, evidence: fromJson(row.evidence, []),
      source_versions: fromJson(row.source_versions, {}), record: fromJson(row.record, {}) })
  }
  const number = (ctx.db.prepare('SELECT count(*) AS n FROM dataset_versions').get() as { n: number }).n + 1
  const version = `ds-${String(number).padStart(4, '0')}`
  const splitHashes = Object.fromEntries(Object.entries(splits).map(([name, items]) => [name, hashItems(items)]))
  const counts = Object.fromEntries(Object.entries(splits).map(([name, items]) => {
    const tally: Record<string, number> = {}
    for (const item of items) tally[item.label] = (tally[item.label] ?? 0) + 1
    return [name, tally]
  }))
  ctx.db.prepare(`INSERT INTO dataset_versions (version, matrix_version, item_ids, split_hashes,
    counts, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(version, matrixVersion,
    toJson(rows.map((row) => row.id)), toJson(splitHashes), toJson(counts), userId, nowIso(ctx.now()))
  ctx.db.prepare(`UPDATE dataset_items SET dataset_version = ? WHERE id IN (${rows.map(() => '?').join(',')})`)
    .run(version, ...rows.map((row) => row.id))
  return { version, matrix_version: matrixVersion, items: rows.length, split_hashes: splitHashes,
    counts, created_at: nowIso(ctx.now()) }
}

/** Выпуск набора в полях листа «Схема GOLD»: по строке на evidence_group. */
export function goldRows(ctx: Context, version: string, itemIds: number[]): Json[] {
  if (!itemIds.length) return []
  const rows = ctx.db.prepare(`SELECT * FROM dataset_items WHERE id IN (${itemIds.map(() => '?')
    .join(',')}) ORDER BY id`).all(...itemIds) as DatasetItemRow[]
  return rows.map((row) => {
    const versions = fromJson<Json>(row.source_versions, {})
    const base = {
      evidence_group_id: row.evidence_group_id || `EG-legacy-${row.id}`,
      finding_id: row.finding_id, object_id: row.object_id, matrix_code: row.parameter_code,
      finding_status: row.gold_label === POSITIVE ? 'CONFIRMED_VIOLATION' : 'NEGATIVE_VERIFIED',
      expert_reason_code: row.reason_code, expert_comment: row.reason,
      matrix_version: versions.matrix_version ?? null, model_version: versions.model_version ?? null,
    }
    return { ...base, ...fromJson<Json>(row.record, {}), dataset_version: version,
      split: splitOf(ctx, row.object_id) }
  })
}

export interface ModelRow {
  model_version: string; false_positive_rate: number | null; per_category_metrics: string
}

/** Приёмка модели: пороги 14.3 и сравнение с действующей моделью (9.4). */
export function acceptance(metrics: Json, perCategory: Json, current: ModelRow | undefined): Json {
  const failures: string[] = []
  for (const [key, threshold] of Object.entries(ACCEPTANCE)) {
    const value = metrics[key]
    if (value === null || value === undefined || value < threshold) {
      failures.push(`${key} = ${value ?? 'None'} ниже порога ${threshold}`)
    }
  }
  const fpr = metrics.false_positive_rate
  if (fpr === null || fpr === undefined || fpr > MAX_FALSE_POSITIVE_RATE) {
    failures.push(`false_positive_rate = ${fpr ?? 'None'} выше порога ${MAX_FALSE_POSITIVE_RATE}`)
  }
  if (current) {
    for (const [category, values] of Object.entries(fromJson<Json>(current.per_category_metrics, {}))) {
      const before = values?.recall
      const after = perCategory?.[category]?.recall
      if (before !== undefined && before !== null && (after === undefined || after === null ||
        before - after > MAX_RECALL_DROP + 1e-12)) {
        failures.push(`Recall категории ${category} снизился: ${before} → ${after ?? 'None'}`)
      }
    }
    const before = current.false_positive_rate
    if (before !== null && fpr !== null && fpr !== undefined && fpr - before > MAX_FPR_GROWTH + 1e-12) {
      failures.push(`False Positive Rate вырос: ${before} → ${fpr}`)
    }
  }
  return { passed: !failures.length, failures, compared_with: current?.model_version ?? null }
}

export function publishedModel(ctx: Context): (ModelRow & { dataset_version: string }) | undefined {
  return ctx.db.prepare(`SELECT l.*, v.approved_at FROM ml_retraining_log l
    JOIN model_versions v ON v.model_version = l.model_version
    WHERE v.approval_status = 'APPROVED' ORDER BY v.approved_at DESC, v.id DESC LIMIT 1`).get() as
    (ModelRow & { dataset_version: string }) | undefined
}

/** Статистика отклонений и рекомендации для ML-инженеров (модуль 10). */
export function weeklyReport(ctx: Context, end: Date, days: number): Json {
  const start = new Date(end.getTime() - days * 86_400_000)
  const [from, to] = [nowIso(start), nowIso(end)]
  const decisions = ctx.db.prepare(`SELECT status FROM inspector_decisions
    WHERE created_at >= ? AND created_at < ?`).all(from, to) as { status: string }[]
  const rejections = ctx.db.prepare(`SELECT rejection_reason, parameter_code FROM rejection_log
    WHERE created_at >= ? AND created_at < ?`).all(from, to) as
    { rejection_reason: string; parameter_code: string }[]
  const byReason = new Map<string, number>()
  const byParameter = new Map<string, number>()
  for (const row of rejections) {
    const reason = row.rejection_reason || 'OTHER'
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
    if (row.parameter_code) byParameter.set(row.parameter_code, (byParameter.get(row.parameter_code) ?? 0) + 1)
  }
  const sortDesc = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1])
  const confirmed = decisions.filter((row) => row.status === 'CONFIRMED_VIOLATION').length
  const rejected = decisions.filter((row) => row.status === 'NEGATIVE_VERIFIED').length
  const recommendations = [
    ...sortDesc(byReason).map(([reason, count]) =>
      `${reason} (${count}): ${SUGGESTED_FIX[reason] ?? SUGGESTED_FIX.OTHER}`),
    ...sortDesc(byParameter).filter(([, count]) => count > 1).map(([code, count]) =>
      `Параметр ${code}: отклонено кандидатов — ${count}; проверить правило сравнения и порог в матрице`),
  ]
  const drafts = (ctx.db.prepare("SELECT count(*) AS n FROM dataset_items WHERE status = 'DRAFT'")
    .get() as { n: number }).n
  if (drafts) recommendations.push(`Записей в черновике набора, ожидающих куратора: ${drafts}`)
  const openDisputes = (ctx.db.prepare("SELECT count(*) AS n FROM dispute_log WHERE resolution_status = 'OPEN'")
    .get() as { n: number }).n
  return {
    period_start: from, period_end: to,
    decisions: { total: decisions.length, confirmed, rejected,
      clarification: decisions.length - confirmed - rejected },
    rejection_share: confirmed + rejected ? Math.round((rejected / (confirmed + rejected)) * 1e4) / 1e4 : null,
    rejections_by_reason: Object.fromEntries(byReason),
    rejections_by_parameter: Object.fromEntries(sortDesc(byParameter)),
    open_disputes: openDisputes, dataset_drafts: drafts,
    published_model: publishedModel(ctx)?.model_version ?? null,
    recommendations,
  }
}
