/**
 * Общие фрагменты JSON-схем для OpenAPI 3.0 (ТЗ 1.3: обязательная валидация
 * запросов по схеме). Запрос, не прошедший схему, отклоняется с кодом 422 до
 * обработчика.
 */
export const id = { type: 'integer', minimum: 1 } as const
export const text = { type: 'string' } as const
export const nonEmpty = { type: 'string', minLength: 1 } as const
export const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const
export const nullableNumber = { type: ['number', 'null'] } as const

export function params(names: Record<string, object>) {
  return { type: 'object', required: Object.keys(names), properties: names } as const
}

export const processParams = params({ process_id: id })
export const anyObject = { type: 'object', additionalProperties: true } as const
export const anyArray = { type: 'array', items: {} } as const

export const errorBody = {
  type: 'object',
  properties: { detail: {} },
  description: 'Причина отказа словами: что произошло и что сделать.',
} as const

export const statusValues = {
  process: ['PENDING', 'PARSING', 'READY', 'VERIFYING', 'COMPLETED', 'FINALIZED', 'ERROR', 'CANCELLED'],
  verification: ['PENDING', 'VERIFICATION_COMPLETED', 'PROTOCOL_FINALIZED'],
  scenario: ['FULL', 'PD_RD_ONLY', 'PD_ID_ONLY', 'RD_ID_ONLY', 'SINGLE_ONLY', 'PARTIALLY_LOADED', 'NO_DOCUMENTS'],
  finding: ['CANDIDATE', 'NEGATIVE_VERIFIED', 'CONFIRMED_VIOLATION', 'SUSPICION'],
  completeness: ['COMPLETE', 'MISSING_EVIDENCE', 'NOT_APPLICABLE', 'NOT_COMPARABLE', 'CLARIFICATION_REQUIRED'],
  decision: ['CONFIRMED_VIOLATION', 'NEGATIVE_VERIFIED', 'CLARIFICATION_REQUIRED', 'CANDIDATE'],
  approval: ['DRAFT', 'APPROVED', 'FOR_CONSTRUCTION', 'SUPERSEDED', 'CANCELLED'],
  stage: ['PD', 'RD', 'ID'],
  sync: ['NOT_SENT', 'LOCAL_ONLY', 'SENT', 'PENDING_SYNC', 'SEND_FAILED', 'SEND_REFUSED'],
}

export const uploadStatusBody = {
  type: 'object',
  properties: {
    process_id: id,
    status: { type: 'string', enum: statusValues.process },
    upload_status: { type: 'object', additionalProperties: { type: 'string' },
      description: 'PD_UPLOADED | PD_PARTIAL | PD_MISSING и так же для RD, ID' },
    scenario: { type: 'string', enum: statusValues.scenario },
    accepted: { type: 'array', items: anyObject },
    rejected: { type: 'array', items: anyObject },
    notice: { type: 'string' },
  },
} as const

/** Описание ответа для документации; сериализацию ответа схема не ограничивает. */
export function ok(description: string, body: object = anyObject) {
  return { 200: { description, ...body, additionalProperties: true }, 401: errorBody, 403: errorBody, 422: errorBody }
}
