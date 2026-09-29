/**
 * Клиент экранов дашборда, администрирования и ML (ТЗ 7, модули 4, 7, 8, 9, 10).
 * Ошибка 401 сообщает оболочке, что сессия закончилась.
 */
import { notifySessionExpired } from './officialApi'
import type { Role, SessionUser } from './authApi'

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: init.body ? { 'Content-Type': 'application/json', ...(init.headers || {}) } : init.headers,
  })
  if (response.status === 401) notifySessionExpired()
  if (!response.ok) {
    const body = await response.json().catch(() => ({ detail: 'Сервер недоступен.' }))
    throw new ApiError(response.status, typeof body.detail === 'string' ? body.detail : 'Сервер вернул ошибку.')
  }
  return response.json() as Promise<T>
}

const post = <T>(path: string, body: unknown = {}, method = 'POST') => call<T>(path, { method, body: JSON.stringify(body) })

export interface DashboardObject {
  object_id: string
  process_id: number
  color: 'green' | 'yellow' | 'red'
  status: string
  scenario: string
  created_at: string
  finalized_at: string | null
  confirmed: number
  pending_candidates: number
  suspicions: number
  missing_evidence: number
  sections: string[]
  sync_status: string
  new_documents: number
}

export interface DashboardFilters { section?: string; status?: string; color?: string; date_from?: string; date_to?: string }

export interface AdminUser extends SessionUser { }

export interface Param {
  code: string; section: string; parameter_name: string; unit: string; review_priority: string
  trigger_logic: string; sp_reference: string; gost_reference: string; fz_reference: string
  other_normative: string; data_type: string; min_value: number | null; max_value: number | null
  regex_pattern: string; is_active: boolean
}

export interface Norm {
  id: number; document_name: string; document_number: string; section: string; parameter_name: string
  min_value: number | null; max_value: number | null; effective_from: string | null; effective_to: string | null; is_active: boolean
}

export interface Rule { id: number; rule_name: string; condition: string; expected: string; normative_base: string; review_priority: string; is_active: boolean }

export interface AuditRow { id: number; timestamp: string; login: string; action: string; object_id: string; status_code: number; ip_address: string; user_agent: string }

export interface IntegrityRow { id: number; status: string; checked: number; failures: { digest: string; reason: string }[]; started_at: string }

export interface DatasetItem { id: number; run_id: number; object_id: string; finding_id: string; parameter_code: string; label: string; reason_code: string; reason: string; status: string; created_at: string }

export interface DatasetVersion { version: string; matrix_version: string; items: number; split_hashes: Record<string, string>; counts: Record<string, Record<string, number>>; created_at: string }

export interface ModelRow {
  id: number; model_version: string; dataset_version: string; precision: number | null; recall: number | null; f1: number | null
  false_positive_rate: number | null; acceptance: { passed?: boolean; failures?: string[] }; approval_status: string; approved_by: string; previous_model: string
}

export interface Report {
  period_start: string; period_end: string
  decisions: { total: number; confirmed: number; rejected: number; clarification: number }
  rejection_share: number | null; rejections_by_reason: Record<string, number>; open_disputes: number
  dataset_drafts: number; published_model: string | null; recommendations: string[]
}

export interface Rejection { id: number; violation_id: string; parameter_code: string; rejection_reason: string; inspector_comment: string; suggested_fix: string; created_at: string }

export interface Dispute { id: number; violation_id: string; inspector_comment: string; resolution_status: string; created_at: string }

function query(filters: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value) })
  const text = params.toString()
  return text ? `?${text}` : ''
}

export const adminApi = {
  dashboard: (filters: DashboardFilters) => call<{ objects: DashboardObject[]; sections: string[]; totals: Record<string, number> }>(`/api/v1/dashboard${query({ ...filters })}`),
  users: () => call<AdminUser[]>('/api/v1/admin/users'),
  createUser: (input: { login: string; password: string; role: Role; full_name: string }) => post<AdminUser>('/api/v1/admin/users', input),
  updateUser: (id: number, input: Partial<{ role: Role; full_name: string; is_active: boolean; password: string }>) => post<AdminUser>(`/api/v1/admin/users/${id}`, input, 'PATCH'),
  params: () => call<{ matrix_version: string; parameters: Param[] }>('/api/v1/admin/params'),
  updateParam: (code: string, input: Record<string, unknown>) => post<Param>(`/api/v1/admin/params/${code}`, input, 'PATCH'),
  norms: () => call<Norm[]>('/api/v1/admin/normative'),
  saveNorm: (input: Omit<Norm, 'id'>, id?: number) => post<Norm>(id ? `/api/v1/admin/normative/${id}` : '/api/v1/admin/normative', input, id ? 'PUT' : 'POST'),
  rules: () => call<Rule[]>('/api/v1/admin/rules'),
  saveRule: (input: Omit<Rule, 'id'>, id?: number) => post<Rule>(id ? `/api/v1/admin/rules/${id}` : '/api/v1/admin/rules', input, id ? 'PUT' : 'POST'),
  audit: (filters: { user?: string; action?: string }) => call<AuditRow[]>(`/api/v1/admin/audit${query({ ...filters, limit: '200' })}`),
  integrity: () => call<IntegrityRow[]>('/api/v1/admin/integrity'),
  checkIntegrity: () => post<IntegrityRow>('/api/v1/admin/integrity'),
  backups: () => call<Record<string, unknown>>('/api/v1/admin/backups'),
  backupNow: () => post<Record<string, unknown>>('/api/v1/admin/backups'),
  datasetItems: (status?: string) => call<DatasetItem[]>(`/api/v1/ml/dataset/items${query({ status })}`),
  curate: (id: number, approve: boolean) => post<DatasetItem>(`/api/v1/ml/dataset/items/${id}/curate`, { approve }),
  datasetVersions: () => call<DatasetVersion[]>('/api/v1/ml/dataset/versions'),
  release: () => post<DatasetVersion>('/api/v1/ml/dataset/versions'),
  models: () => call<{ published: string | null; models: ModelRow[] }>('/api/v1/ml/models'),
  modelAction: (id: number, action: 'approve' | 'reject' | 'rollback') => post<unknown>(`/api/v1/ml/models/${id}/${action}`),
  report: (days: number) => call<Report>(`/api/v1/ml/report?days=${days}`),
  rejections: () => call<Rejection[]>('/api/v1/ml/rejections'),
  disputes: () => call<Dispute[]>('/api/v1/ml/disputes'),
}
