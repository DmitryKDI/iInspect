/**
 * Контракт очереди сообщений между сервером и ML-модулями (ТЗ 1.5).
 *
 * Сервер ставит задачи в очереди `inspector.parse` и `inspector.inspect`,
 * ML-модули публикуют результат в `inspector.results`, ход проверки — в
 * `inspector.progress`. Сообщения — JSON, очереди и сообщения устойчивые
 * (переживают перезапуск брокера). Остановку проверки сервер отмечает ключом
 * `inspector:cancel:<process_id>` в Redis — воркер проверяет его на
 * безопасных точках.
 *
 * Тот же контракт описан для ML-стороны в `packages/ml/app/contracts.py`;
 * расхождение ловит тест контракта.
 */
export const QUEUE_PARSE = 'inspector.parse'
export const QUEUE_INSPECT = 'inspector.inspect'
export const QUEUE_RESULTS = 'inspector.results'
export const QUEUE_PROGRESS = 'inspector.progress'
export const CANCEL_KEY_PREFIX = 'inspector:cancel:'

export interface DocumentRef {
  id: number
  name: string
  sha256: string
  source_format: string
  /** Производный файл для разбора (DXF из чертежа DWG/DXF), иначе null. */
  derived_sha256: string | null
  derived_format: string | null
  pages: number
  metadata: Record<string, unknown>
}

export interface ParseTask {
  task_id: string
  kind: 'parse'
  attempt: number
  document: Omit<DocumentRef, 'metadata' | 'pages'>
}

export interface InspectTask {
  task_id: string
  kind: 'inspect'
  attempt: number
  process_id: number
  object_id: string
  documents: DocumentRef[]
  parameters: Record<string, unknown>[]
  matrix_version: string
  /** Последняя версия протокола: для инкрементального пересчёта (ТЗ 9.2). */
  previous: { version: number; result: unknown } | null
  decision_version: number
  free_search: {
    rules: Record<string, unknown>[]
    norms: Record<string, unknown>[]
    history: Record<string, number[]>
  }
}

export interface TaskResult {
  task_id: string
  kind: 'parse' | 'inspect'
  status: 'ok' | 'error'
  error?: string
  /** Сбой, который повтор не исправит (повреждённый файл, неподдерживаемый формат). */
  permanent?: boolean
  payload?: Record<string, unknown>
}

export interface Progress {
  process_id: number
  stage: string
  completed: number
  total: number
}
