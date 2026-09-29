/** Разбор тела multipart/form-data: файлы и поля (ТЗ 9.1, приём комплекта). */
import type { MultipartFile, MultipartValue } from '@fastify/multipart'
import { invalid } from '../errors.js'

type Part = MultipartFile | MultipartValue

function list(value: unknown): Part[] {
  if (value === undefined || value === null) return []
  return (Array.isArray(value) ? value : [value]) as Part[]
}

export async function files(body: Record<string, unknown>, field: string): Promise<{ name: string; data: Buffer }[]> {
  const result: { name: string; data: Buffer }[] = []
  for (const part of list(body[field])) {
    if (part.type !== 'file') throw invalid(`поле ${field} должно содержать файл`)
    result.push({ name: part.filename || 'document', data: await part.toBuffer() })
  }
  return result
}

export function field(body: Record<string, unknown>, name: string): string | undefined {
  const part = list(body[name])[0]
  if (!part) return undefined
  if (part.type !== 'field') throw invalid(`поле ${name} должно быть значением, а не файлом`)
  return String(part.value)
}

/** Число из поля формы; не число — 422 с причиной. */
export function integerField(body: Record<string, unknown>, name: string): number | null {
  const value = field(body, name)
  if (value === undefined || value === '') return null
  if (!/^[0-9]+$/.test(value)) throw invalid(`${name}: ожидается целое число`)
  return Number(value)
}

// Схемы multipart — для документации OpenAPI 3.0: тело формы разбирает
// @fastify/multipart, а поля проверяются в обработчике (files, field,
// integerField) с тем же кодом ответа 422.
export const fileSchema = { type: 'string', format: 'binary' } as const
export const filesSchema = { type: 'array', items: fileSchema } as const
export const valueSchema = (pattern?: string) => (pattern ? { type: 'string', pattern } : { type: 'string' })

/** Маршрут multipart: тело не проходит через JSON-валидатор (он не знает файлов). */
export const multipartValidation = {
  validatorCompiler: () => () => true,
}
