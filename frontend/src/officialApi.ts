/**
 * Клиент официальной проверки: REST API сервера `/api/v1` (ТЗ 1.3–1.5).
 * Три стадии комплекта и результат по параметрам матрицы.
 */
/** Событие «сессия закончилась»: любой запрос, получивший 401, сообщает о нём. */
export const SESSION_EXPIRED = 'inspector:session-expired'

export function notifySessionExpired(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_EXPIRED))
}

export class OfficialApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export const API = '/api/v1'

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, init)
  if (response.status === 401) notifySessionExpired()
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: 'Сервер недоступен.' }))
    throw new OfficialApiError(response.status, body.detail || 'Сервер вернул ошибку.')
  }
  return response.json() as Promise<T>
}

export type OfficialStage = 'PD' | 'RD' | 'ID'
export type ApprovalStatus = 'DRAFT' | 'APPROVED' | 'FOR_CONSTRUCTION' | 'SUPERSEDED' | 'CANCELLED'
export type FindingStatus = 'CANDIDATE' | 'NEGATIVE_VERIFIED' | 'CONFIRMED_VIOLATION' | 'SUSPICION' | 'CLARIFICATION_REQUIRED'
export type TechnicalStatus = 'completed' | 'not_run' | 'error'

export interface OfficialParameter {
  code: string
  name: string
  section: string
  unit: string | null
  priority: 'HIGH' | 'MEDIUM' | 'LOW'
  source_pd: string
  source_rd: string
  source_id: string
  trigger: string
}

export interface OfficialDocumentMetadata {
  object_id: string
  file_id: string | null
  stage: OfficialStage
  discipline: string | null
  document_code: string
  revision: string
  approval_status: ApprovalStatus
  approval_date: string | null
  predecessor_id: number | null
  signature_status: string | null
  sheet_page_range: string | null
}

export interface OfficialDocument {
  id: number
  name: string
  pages: number
  status: string
  digest: string
  metadata: OfficialDocumentMetadata
}

export interface OfficialEvidence {
  document_id: number
  file_id: string | null
  sha256: string | null
  stage: OfficialStage
  role?: 'expected' | 'actual'
  page: number
  bbox: [number, number, number, number] | null
  quote: string | null
}

export interface ReviewHistoryItem {
  status: FindingStatus
  author: string
  reason: string
  created_at?: string
  version?: number
}

export interface OfficialCheck {
  finding_id: string
  parameter_code: string
  parameter_name: string
  priority: 'HIGH' | 'MEDIUM' | 'LOW'
  completeness_status: string
  finding_status: FindingStatus | null
  expected_value: string | null
  actual_value: string | null
  explanation: string
  evidence: OfficialEvidence[]
  technical_status: TechnicalStatus
  review_history: ReviewHistoryItem[]
  confidence?: number | null
  split_from?: string
}

export interface OfficialRunResult {
  matrix_version: string
  object_id: string
  checks: OfficialCheck[]
  coverage: { total: number; completed: number; not_run: number }
  document_selection?: {
    selected: Partial<Record<OfficialStage, number[]>>
    problems: Partial<Record<OfficialStage, string>>
  }
  graphic_analysis: {
    status: 'completed' | 'incomplete' | 'not_run' | 'error'
    reason: string
    candidates: OfficialCheck[]
    performance: { duration_seconds?: number }
  }
  /** Свободный поиск гипотез (ТЗ 9.5); сами гипотезы — отдельным запросом. */
  free_search?: { status: 'completed' | 'error'; reason: string }
}

/** Внутреннее состояние задачи проверки (в ответе сервера — run_state). */
export type RunState = 'queued' | 'parsing' | 'running' | 'completed' | 'cancelled' | 'error'

export const isActive = (run: { status: RunState } | null | undefined): boolean =>
  Boolean(run && ['queued', 'parsing', 'running'].includes(run.status))

export interface OfficialRun {
  id: number
  object_id: string
  status: RunState
  stage: string
  completed: number
  total: number
  result: OfficialRunResult | null
  error: string | null
  version?: number
  /** Статус процесса в словаре ТЗ: PENDING … FINALIZED. */
  process_status?: string
  verification_status?: string
  finalized_at?: string | null
  finalized_by?: string | null
  sync_status?: string
  sync_attempts?: number
  sync_next_at?: string | null
  /** Документы, пришедшие после финализации: проверку не запускают (ТЗ 9.6). */
  pending_documents?: { id: number; metadata: { stage?: string; document_code?: string } }[]
  /** Системный комментарий к последнему решению (ТЗ 9.4). */
  system_comment?: string
  protocol?: {
    scenario: string
    upload_status: Record<string, string>
    pending_candidates: string[]
    versions: Record<string, string>
  }
}

/** Кодированные причины отклонения кандидата (ТЗ 9.3). */
export const REASON_CODES: Record<string, string> = {
  WRONG_REVISION: 'неверно выбрана актуальная редакция',
  APPROVED_CHANGE: 'есть согласованное изменение',
  OCR_ERROR: 'ошибка распознавания',
  BINDING_ERROR: 'ошибка привязки доказательства',
  NOT_APPLICABLE: 'параметр неприменим',
  NO_DIFFERENCE: 'расхождения нет',
  OTHER: 'иное (см. основание)',
}

/** Действия инспектора по ТЗ 9.3: подтвердить, отклонить, запросить уточнение. */
export type DecisionStatus = Extract<FindingStatus, 'CONFIRMED_VIOLATION' | 'NEGATIVE_VERIFIED' | 'CLARIFICATION_REQUIRED'>

/** Часть составного кандидата: свои значения и доказательства из его карточки (ТЗ 9.3, п.2). */
export interface SplitPart {
  expected_value: string
  actual_value: string
  evidence_indexes: number[]
}

export interface SplitInput {
  reason: string
  expected_version: number
  parts: SplitPart[]
}

export interface DecisionInput {
  finding_id: string
  status: DecisionStatus
  reason: string
  expected_version: number
  reason_code?: string
}

/** Гипотеза свободного поиска в структуре ТЗ 9.5. */
export interface Suspicion {
  suspicion_id: number
  discovery_method: 'LOGICAL_ANALYSIS' | 'SEMANTIC_DISSONANCE' | 'NORMATIVE_ANALYSIS' | 'ML_PATTERN_ANALYSIS'
  confidence: number | null
  description: string
  pd_reference: string
  rd_reference: string
  review_priority: string
  normative_base: string
  finding_status: 'SUSPICION' | 'CANDIDATE' | 'CONFIRMED_VIOLATION' | 'NEGATIVE_VERIFIED'
  inspector_status: string
  inspector_comment: string
}

export interface SuspicionReview {
  action: 'promote' | 'dismiss' | 'confirm' | 'reject'
  comment?: string
  reason_code?: string
}

export interface ProviderSettings {
  provider: string
  model: string
  base_url: string
}

export interface ProviderCheck {
  reachable: boolean
  provider: string
  message: string
  tls?: string
  /** Какая модель выбрана сейчас. */
  model?: string
  /**
   * Обслуживает ли сервер выбранную модель. Намеренно трёхзначно: null —
   * «перечень не получен», а не «модели нет»: сбой связи и недоступную
   * модель инспектор чинит по-разному.
   */
  model_available?: boolean | null
  models_available?: string[]
  models_message?: string
}

/** Ответ сервера о процессе: status — словарь ТЗ, run_state — состояние задачи. */
type ProcessPayload = Omit<OfficialRun, 'status'> & { status: string; run_state: RunState }

/** Экраны работают с состоянием задачи, словарь ТЗ — в process_status. */
function toRun(body: ProcessPayload): OfficialRun {
  return { ...body, status: body.run_state, process_status: body.status }
}

const json = (body: unknown, method = 'POST'): RequestInit =>
  ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

interface LlmCheckPayload {
  reachable: boolean
  message: string
  model: string
  served_models?: string[]
  model_served?: boolean | null
}

export const officialApi = {
  parameters: () => request<{ matrix_version: string; parameters: OfficialParameter[] }>('/parameters'),
  documents: () => request<OfficialDocument[]>('/documents'),
  /** Контур поддерживает только локальную модель (ТЗ 12): внешних провайдеров нет. */
  settings: async (): Promise<ProviderSettings> => ({ provider: 'local', model: '', base_url: '' }),
  checkProvider: async (): Promise<ProviderCheck> => {
    const body = await request<LlmCheckPayload>('/llm-check')
    return { reachable: body.reachable, provider: 'local', message: body.message, model: body.model,
      model_available: body.model_served ?? null, models_available: body.served_models ?? [],
      models_message: body.reachable ? undefined : 'связи с моделью нет' }
  },
  upload: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<OfficialDocument>('/documents', { method: 'POST', body: form })
  },
  saveMetadata: (id: number, metadata: OfficialDocumentMetadata) =>
    request<OfficialDocument>(`/documents/${id}/metadata`, json(metadata, 'PUT')),
  deleteDocument: (id: number) => request<{ ok: boolean }>(`/documents/${id}`, { method: 'DELETE' }),
  createRun: async (object_id: string, document_ids: number[]) =>
    toRun(await request<ProcessPayload>('/processes', json({ object_id, document_ids }))),
  run: async (id: number) => toRun(await request<ProcessPayload>(`/processes/${id}`)),
  runs: async () => (await request<ProcessPayload[]>('/processes')).map(toRun),
  cancelRun: async (id: number) => toRun(await request<ProcessPayload>(`/processes/${id}/cancel`, json({}))),
  decide: async (id: number, input: DecisionInput) =>
    toRun(await request<ProcessPayload>(`/processes/${id}/decisions`, json(input))),
  split: async (id: number, findingId: string, input: SplitInput) =>
    toRun(await request<ProcessPayload>(`/processes/${id}/findings/${encodeURIComponent(findingId)}/split`,
      json(input))),
  exportUrl: (id: number, format: 'json' | 'csv') => `${API}/processes/${id}/export?format=${format}`,
  protocolUrl: (id: number, format: 'pdf' | 'docx' | 'xml') => `${API}/processes/${id}/export?format=${format}`,
  finalize: async (id: number) => toRun(await request<ProcessPayload>(`/processes/${id}/finalize`, json({}))),
  unfinalize: async (id: number, reason: string) =>
    toRun(await request<ProcessPayload>(`/processes/${id}/unfinalize`, json({ reason }))),
  suspicions: (id: number) => request<Suspicion[]>(`/processes/${id}/suspicions`),
  reviewSuspicion: (id: number, suspicionId: number, input: SuspicionReview) =>
    request<Suspicion>(`/processes/${id}/suspicions/${suspicionId}`, json(input)),
  pageImageUrl: (documentId: number, page: number) => `${API}/documents/${documentId}/pages/${page}/image`,
}

export function findingLabel(status: FindingStatus | null, technical: TechnicalStatus): string {
  if (technical === 'not_run') return 'не выполнялось'
  if (technical === 'error') return 'техническая ошибка'
  if (status === 'CONFIRMED_VIOLATION') return 'подтверждено инспектором'
  if (status === 'NEGATIVE_VERIFIED') return 'не подтверждено инспектором'
  if (status === 'CANDIDATE') return 'кандидат для проверки'
  if (status === 'SUSPICION') return 'требует уточнения'
  if (status === 'CLARIFICATION_REQUIRED') return 'запрошено уточнение'
  return 'нет машинной оценки'
}
