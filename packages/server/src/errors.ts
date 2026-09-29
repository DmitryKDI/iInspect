/**
 * Ошибка запроса с кодом HTTP и причиной для пользователя.
 *
 * Тело ответа — `{"detail": ...}`: причина всегда сформулирована словами
 * («что произошло и что сделать»), а не кодом исключения.
 */
export class HttpError extends Error {
  constructor(public readonly status: number, public readonly detail: unknown) {
    super(typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
}

export function notFound(what: string): HttpError {
  return new HttpError(404, what)
}

export function conflict(detail: string): HttpError {
  return new HttpError(409, detail)
}

export function invalid(detail: unknown): HttpError {
  return new HttpError(422, detail)
}
