/**
 * Протокол проверки в терминах ТЗ: статусы загрузки, сценарий, пять таблиц,
 * карточки доказательств, версии (ТЗ 9.1–9.3).
 *
 * Результат ML-модулей отвечает на вопрос «что показали документы по каждому
 * параметру». Этот модуль отвечает на другой: как это выглядит в протоколе,
 * который принимает инспектор и передаёт дальше. Всё здесь — чистые функции
 * над готовым результатом и решениями инспектора.
 */
import { createHash } from 'node:crypto'

export const STAGES = ['PD', 'RD', 'ID'] as const

// Сценарий загрузки (ТЗ 9.2, п.2).
export const SCENARIO_FULL = 'FULL'
export const SCENARIO_PD_RD = 'PD_RD_ONLY'
export const SCENARIO_PD_ID = 'PD_ID_ONLY'
export const SCENARIO_RD_ID = 'RD_ID_ONLY'
export const SCENARIO_SINGLE = 'SINGLE_ONLY'
export const SCENARIO_PARTIAL = 'PARTIALLY_LOADED'
export const SCENARIO_NONE = 'NO_DOCUMENTS'

// Статусы процесса (ТЗ 9.1). ERROR и CANCELLED в таблице ТЗ нет, но сбой и
// остановка — реальные состояния: выдать их за PENDING или READY значило бы
// показать непроверенное как готовое.
export const PENDING = 'PENDING'
export const PARSING = 'PARSING'
export const READY = 'READY'
export const VERIFYING = 'VERIFYING'
export const COMPLETED = 'COMPLETED'
export const FINALIZED = 'FINALIZED'
export const ERROR = 'ERROR'
export const CANCELLED = 'CANCELLED'

// Статусы верификации (ТЗ 9.3).
export const VERIFICATION_PENDING = 'PENDING'
export const VERIFICATION_COMPLETED = 'VERIFICATION_COMPLETED'
export const PROTOCOL_FINALIZED = 'PROTOCOL_FINALIZED'

/** Кодированные причины отклонения кандидата (ТЗ 9.3, п.2). */
export const REASON_CODES: Record<string, string> = {
  WRONG_REVISION: 'актуальная редакция выбрана неверно',
  APPROVED_CHANGE: 'есть согласованное изменение',
  OCR_ERROR: 'ошибка распознавания',
  BINDING_ERROR: 'ошибка привязки доказательства',
  NOT_APPLICABLE: 'параметр неприменим',
  NO_DIFFERENCE: 'расхождения нет',
  OTHER: 'иное (см. комментарий)',
}

const UPLOAD_ALLOWED = new Set([PENDING, READY, VERIFYING, COMPLETED])
const VERIFY_ALLOWED = new Set([READY, VERIFYING])

export type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

export interface SnapshotItem {
  id: number
  digest: string
  metadata: Json
}

export function uploadStatuses(stageCounts: Record<string, number>,
  problems: Record<string, string>): Record<string, string> {
  const statuses: Record<string, string> = {}
  for (const stage of STAGES) {
    if (!stageCounts[stage]) statuses[stage] = `${stage}_MISSING`
    else if (problems[stage]) statuses[stage] = `${stage}_PARTIAL`
    else statuses[stage] = `${stage}_UPLOADED`
  }
  return statuses
}

export function scenario(statuses: Record<string, string>): string {
  const present = STAGES.filter((stage) => !statuses[stage].endsWith('_MISSING'))
  if (present.some((stage) => statuses[stage].endsWith('_PARTIAL'))) return SCENARIO_PARTIAL
  if (present.length === 3) return SCENARIO_FULL
  const key = present.join('+')
  if (key === 'PD+RD') return SCENARIO_PD_RD
  if (key === 'PD+ID') return SCENARIO_PD_ID
  if (key === 'RD+ID') return SCENARIO_RD_ID
  return present.length ? SCENARIO_SINGLE : SCENARIO_NONE
}

export function allFindings(result: Json | null | undefined): Json[] {
  if (!result) return []
  return [...(result.checks ?? []), ...((result.graphic_analysis ?? {}).candidates ?? [])]
}

export interface SplitPart { expected_value: string; actual_value: string; evidence: Json[] }
export interface FindingSplit { finding_id: string; parts: SplitPart[] }

export const partId = (findingId: string, index: number): string => `${findingId}/${index + 1}`

/** Заменить составные находки их атомарными частями (ТЗ 9.3, п.2); результат меняется на месте. */
export function applySplits(result: Json | null, splits: FindingSplit[]): void {
  if (!result || !splits.length) return
  const byId = new Map(splits.map((split) => [split.finding_id, split]))
  const expand = (items: Json[]): Json[] => items.flatMap((item) => {
    const split = byId.get(item.finding_id)
    if (!split) return [item]
    return split.parts.map((part, index) => ({ ...item, finding_id: partId(item.finding_id, index),
      split_from: item.finding_id, expected_value: part.expected_value, actual_value: part.actual_value,
      evidence: part.evidence, finding_status: 'CANDIDATE', review_history: [] }))
  })
  if (result.checks) result.checks = expand(result.checks)
  if (result.graphic_analysis?.candidates) {
    result.graphic_analysis.candidates = expand(result.graphic_analysis.candidates)
  }
}

function freeItems(result: Json | null | undefined): Json[] {
  return [...(((result ?? {}).free_search ?? {}).items ?? [])]
}

/** Кандидаты без решения инспектора — финализация без них запрещена (ТЗ 9.3, п.4). */
export function pendingCandidates(result: Json | null | undefined): string[] {
  return [
    ...allFindings(result).filter((item) => item.finding_status === 'CANDIDATE')
      .map((item) => String(item.finding_id)),
    ...freeItems(result).filter((item) => item.finding_status === 'CANDIDATE')
      .map((item) => `S-${item.suspicion_id}`),
  ]
}

export function processStatus(runState: string, finalized: boolean, result: Json | null,
  decisions: number): string {
  if (runState === 'queued') return PENDING
  if (runState === 'parsing' || runState === 'running') return PARSING
  if (runState === 'error') return ERROR
  if (runState === 'cancelled') return CANCELLED
  if (finalized) return FINALIZED
  if (pendingCandidates(result).length) return decisions ? VERIFYING : READY
  return COMPLETED
}

export function verificationStatus(finalized: boolean, result: Json | null): string {
  if (finalized) return PROTOCOL_FINALIZED
  return pendingCandidates(result).length ? VERIFICATION_PENDING : VERIFICATION_COMPLETED
}

export const canUpload = (status: string): boolean => UPLOAD_ALLOWED.has(status)
export const canVerify = (status: string): boolean => VERIFY_ALLOWED.has(status)

/** Отпечаток входа: какие файлы с какими реквизитами вошли в проверку (ТЗ 14.2). */
export function manifestHash(snapshot: SnapshotItem[]): string {
  const rows = snapshot.map((item) => {
    const meta = item.metadata ?? {}
    return [item.id, item.digest, meta.stage, meta.document_code, meta.revision,
      meta.approval_status].map((value) => (value === undefined || value === null ? 'None' : String(value)))
      .join('|')
  }).sort()
  return createHash('sha256').update(rows.join('\n')).digest('hex')
}

export function versions(modelVersion: string, matrixVersion: string, snapshot: SnapshotItem[],
  datasetVersion: string): Json {
  return {
    matrix_version: matrixVersion,
    model_version: modelVersion,
    dataset_version: datasetVersion || 'none',
    input_manifest_hash: manifestHash(snapshot),
  }
}

function source(evidence: Json, documents: Map<number, Json>): Json {
  const meta = documents.get(evidence.document_id) ?? {}
  return {
    file_id: evidence.file_id ?? null, sha256: evidence.sha256 ?? null, stage: evidence.stage ?? null,
    role: evidence.role ?? null, document_code: meta.document_code ?? null,
    revision: meta.revision ?? null, approval_status: meta.approval_status ?? null,
    page: evidence.page ?? null, bbox_polygon: evidence.bbox ?? null, quote: evidence.quote ?? null,
  }
}

/** Карточка доказательства (ТЗ 9.2, п.4) — всё, что нужно для решения. */
export function evidenceCard(item: Json, documents: Map<number, Json>): Json {
  const history: Json[] = item.review_history ?? []
  const last = history.length ? history[history.length - 1] : {}
  return {
    finding_id: item.finding_id, parameter_code: item.parameter_code,
    parameter_name: item.parameter_name, finding_status: item.finding_status,
    completeness_status: item.completeness_status, expected_value: item.expected_value ?? null,
    actual_value: item.actual_value ?? null, delta: item.delta ?? null,
    approved_change_ref: item.approved_change_ref || 'NONE',
    sources: (item.evidence ?? []).map((evidence: Json) => source(evidence, documents)),
    rationale: item.explanation ?? null, risk_level: item.priority ?? null,
    confidence: item.confidence ?? null, inspector_decision: last.status ?? null,
    inspector_reason_code: last.reason_code ?? null, inspector_comment: last.reason ?? null,
    inspector: last.author ?? null,
  }
}

/** Гипотеза свободного поиска в структуре ТЗ 9.5. */
export function suspicionCard(item: Json, documents: Map<number, Json>): Json {
  return {
    finding_id: `S-${item.suspicion_id}`, suspicion_id: item.suspicion_id,
    discovery_method: item.discovery_method, parameter_code: item.parameter_code ?? null,
    parameter_name: item.description, description: item.description,
    finding_status: item.finding_status, pd_reference: item.pd_reference,
    rd_reference: item.rd_reference, normative_base: item.normative_base,
    review_priority: item.review_priority, confidence: item.confidence,
    sources: (item.evidence ?? []).map((evidence: Json) => source(evidence, documents)),
    inspector_decision: item.inspector_status, inspector_comment: item.inspector_comment,
  }
}

export interface BuildOptions {
  runState: string
  finalized: boolean
  decisions: number
  modelVersion: string
  datasetVersion: string
}

/** Протокол целиком: загрузка, сценарий, пять таблиц, версии (ТЗ 9.2, п.4). */
export function build(result: Json | null, snapshot: SnapshotItem[], options: BuildOptions): Json {
  const documents = new Map<number, Json>(snapshot.map((item) => [item.id, item.metadata ?? {}]))
  const stageCounts: Record<string, number> = {}
  for (const meta of documents.values()) {
    const stage = String(meta.stage ?? '')
    stageCounts[stage] = (stageCounts[stage] ?? 0) + 1
  }
  const problems = ((result ?? {}).document_selection ?? {}).problems ?? {}
  const statuses = uploadStatuses(stageCounts, problems)
  const findings = allFindings(result)
  const cards = (status: string) => findings.filter((item) => item.finding_status === status)
    .map((item) => evidenceCard(item, documents))
  const free = (status: string) => freeItems(result).filter((item) => item.finding_status === status)
    .map((item) => suspicionCard(item, documents))
  const freeSearch = { ...((result ?? {}).free_search ?? { status: 'not_run' }) }
  delete freeSearch.items
  return {
    status: processStatus(options.runState, options.finalized, result, options.decisions),
    verification_status: verificationStatus(options.finalized, result),
    upload_status: statuses,
    scenario: scenario(statuses),
    versions: versions(options.modelVersion, (result ?? {}).matrix_version ?? '', snapshot,
      options.datasetVersion),
    tables: {
      completeness: findings.map((item) => ({
        finding_id: item.finding_id, parameter_code: item.parameter_code,
        parameter_name: item.parameter_name, completeness_status: item.completeness_status,
        technical_status: item.technical_status, reason: item.explanation ?? null,
      })),
      candidates: [...cards('CANDIDATE'), ...free('CANDIDATE')],
      confirmed_violations: [...cards('CONFIRMED_VIOLATION'), ...free('CONFIRMED_VIOLATION')],
      negative_verified: [...cards('NEGATIVE_VERIFIED'), ...free('NEGATIVE_VERIFIED')],
      // Графические находки без полного набора доказательств и гипотезы
      // свободного поиска — одна таблица, ни то ни другое не нарушение.
      suspicions: [...cards('SUSPICION'), ...free('SUSPICION')],
    },
    free_search: freeSearch,
    ocr_quality: (result ?? {}).ocr_quality ?? {},
    missing_evidence: findings.filter((item) => item.completeness_status === 'MISSING_EVIDENCE')
      .map((item) => item.finding_id),
    pending_candidates: pendingCandidates(result),
  }
}

/** Результат, где проверка не начиналась: каждый параметр ждёт уточнения. */
export function clarificationResult(objectId: string, reason: string, parameters: Json[],
  matrixVersion: string): Json {
  const checks = parameters.map((item) => emptyCheck(item, 'CLARIFICATION_REQUIRED', reason))
  return {
    matrix_version: matrixVersion, object_id: objectId, checks,
    coverage: { total: checks.length, completed: 0, not_run: checks.length },
    graphic_analysis: { status: 'not_run', reason: 'графическая проверка не выполнялась',
      candidates: [], performance: {} },
    document_selection: { selected: {}, problems: { ALL: reason } },
  }
}

export function emptyCheck(parameter: Json, completeness: string, reason: string,
  technical = 'not_run'): Json {
  // Та же форма, что у пустой проверки ML-конвейера (`official_pipeline._empty_check`).
  const refs = Object.fromEntries(['sp_reference', 'gost_reference', 'fz_reference', 'other_normative']
    .filter((key) => parameter[key]).map((key) => [key, parameter[key]]))
  return {
    finding_id: `${parameter.code}:matrix`, parameter_code: parameter.code,
    parameter_name: parameter.name, priority: parameter.priority,
    completeness_status: completeness, rule: parameter.trigger ?? null,
    finding_type: 'matrix_difference', finding_status: null, expected_value: null,
    actual_value: null, explanation: reason, evidence: [], technical_status: technical,
    review_history: [], confidence: null, section: parameter.section ?? null,
    normative_refs: refs,
  }
}
