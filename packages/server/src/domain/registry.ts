/**
 * Реестр файлов комплекта (перечень ИД, ред. 1.1: «CSV/XLSX/JSON»; ТЗ 9.1).
 *
 * Каждый загружаемый комплект сопровождается реестром: object_id, file_id,
 * имя файла и SHA-256, стадия, раздел, шифр, редакция, статус и дата
 * утверждения, диапазон листов, связь редакций, статус подписи. Без реестра
 * пакет принимается со статусом CLARIFICATION_REQUIRED.
 *
 * Реестр приходит от загружающей стороны: XML с DTD отклоняется, размер
 * распакованных частей XLSX ограничен.
 */
import JSZip from 'jszip'
import { XMLParser } from 'fast-xml-parser'
import { invalid } from '../errors.js'

/** Обязательные поля реестра (перечень ИД, ред. 1.1). */
export const REGISTRY_FIELDS = ['file_id', 'file_name', 'sha256', 'object_id', 'doc_stage', 'discipline',
  'document_code', 'revision', 'approval_status', 'approval_date', 'sheet_page_range',
  'signature_status'] as const
export const STAGES = new Set(['PD', 'RD', 'ID'])
export const APPROVAL_STATUSES = new Set(['DRAFT', 'APPROVED', 'FOR_CONSTRUCTION', 'SUPERSEDED',
  'CANCELLED'])
// Сколько байт XML-части XLSX допускается распаковать: реестр — таблица на
// тысячи строк; больше — признак ZIP-бомбы.
const MAX_PART_BYTES = 20 * 1024 * 1024

export type RegistryRow = Record<string, string>

function registryKey(name: string): string {
  const key = name.trim().toLowerCase()
  return ['sha-256', 'sha_256'].includes(key) ? 'sha256' : key
}

function parseCsv(text: string): RegistryRow[] {
  // Разделитель — по строке заголовка: выгрузки Excel на русской локали пишут «;».
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1 }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === delimiter) { row.push(field); field = '' }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(field); rows.push(row); row = []; field = ''
    } else field += char
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  const table = rows.filter((line) => line.some((cell) => cell.trim()))
  if (!table.length) return []
  const header = table[0].map((name) => name.trim())
  return table.slice(1).map((line) => Object.fromEntries(header.map((name, position) =>
    [name, (line[position] ?? '').trim()]).filter(([name]) => name)))
}

function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/i.exec(reference)?.[0].toUpperCase() ?? 'A'
  let index = 0
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64)
  return index - 1
}

function textOf(node: unknown): string {
  if (node === undefined || node === null) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') {
    const record = node as Record<string, unknown>
    if ('#text' in record) return String(record['#text'])
    if ('t' in record) return textOf(record.t)
    if ('r' in record) return textOf(record.r)
  }
  return ''
}

async function xmlPart(zip: JSZip, name: string, parser: XMLParser): Promise<Record<string, any> | null> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const file = zip.file(name)
  if (!file) return null
  const data = await file.async('uint8array')
  if (data.length > MAX_PART_BYTES) throw invalid('реестр XLSX слишком большой')
  const text = Buffer.from(data).toString('utf8')
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw invalid('реестр XLSX: XML с объявлением DTD/сущностей не принимается')
  return parser.parse(text)
}

async function parseXlsx(data: Buffer): Promise<RegistryRow[]> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(data)
  } catch {
    throw invalid('реестр XLSX не прочитан: файл не является XLSX')
  }
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_',
    isArray: (name) => ['si', 'row', 'c', 'sheet', 'Relationship', 'r'].includes(name) })
  const strings = await xmlPart(zip, 'xl/sharedStrings.xml', parser)
  const shared = (strings?.sst?.si ?? []).map((item: unknown) => textOf(item))
  let sheetPath = 'xl/worksheets/sheet1.xml'
  const workbook = await xmlPart(zip, 'xl/workbook.xml', parser)
  const rels = await xmlPart(zip, 'xl/_rels/workbook.xml.rels', parser)
  const first = workbook?.workbook?.sheets?.sheet?.[0]
  const relation = (rels?.Relationships?.Relationship ?? []).find((item: Record<string, string>) =>
    item['@_Id'] === first?.['@_r:id'])
  if (relation?.['@_Target']) {
    const target = String(relation['@_Target']).replace(/^\//, '')
    sheetPath = target.startsWith('xl/') ? target : `xl/${target}`
  }
  const sheet = await xmlPart(zip, sheetPath, parser)
  if (!sheet) throw invalid('реестр XLSX не прочитан: в XLSX нет листа с реестром')
  const table: string[][] = []
  for (const row of sheet.worksheet?.sheetData?.row ?? []) {
    const values = new Map<number, string>()
    ;(row.c ?? []).forEach((cell: Record<string, unknown>, position: number) => {
      const reference = cell['@_r'] as string | undefined
      const kind = cell['@_t']
      let text = kind === 'inlineStr' ? textOf(cell.is) : textOf(cell.v)
      if (kind === 's' && /^\d+$/.test(text)) text = shared[Number(text)] ?? ''
      if (/^-?\d+\.0$/.test(text)) text = text.slice(0, -2) // целое, записанное Excel дробью
      values.set(reference ? columnIndex(reference) : position, text.trim())
    })
    if (values.size) {
      const width = Math.max(...values.keys()) + 1
      table.push(Array.from({ length: width }, (_, index) => values.get(index) ?? ''))
    }
  }
  if (!table.length) return []
  const header = table[0].map((name) => name.trim())
  return table.slice(1).filter((line) => line.some(Boolean)).map((line) =>
    Object.fromEntries(header.map((name, index) => [name, line[index] ?? '']).filter(([name]) => name)))
}

/** Реестр: JSON-массив (или {"files": [...]}), CSV или XLSX с заголовком. */
export async function parseRegistry(data: Buffer, name: string): Promise<RegistryRow[]> {
  let rows: unknown
  if (name.toLowerCase().endsWith('.xlsx') || data.subarray(0, 4).toString('latin1') === 'PK\x03\x04') {
    rows = await parseXlsx(data)
  } else {
    const text = data.toString('utf8').replace(/^﻿/, '')
    if (name.toLowerCase().endsWith('.json') || /^\s*[[{]/.test(text)) {
      try {
        const parsed = JSON.parse(text)
        rows = Array.isArray(parsed) ? parsed : parsed?.files ?? []
      } catch {
        throw invalid('реестр JSON не прочитан')
      }
    } else rows = parseCsv(text)
  }
  return checkRegistry(rows)
}

export function checkRegistry(rows: unknown): RegistryRow[] {
  if (!Array.isArray(rows) || !rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) {
    throw invalid('реестр должен быть списком записей о файлах')
  }
  const records = rows.map((row) => Object.fromEntries(Object.entries(row as Record<string, unknown>)
    .map(([key, value]) => [registryKey(key), value === null || value === undefined ? '' : String(value).trim()])))
  if (!records.length) throw invalid('реестр не содержит записей о файлах')
  for (const [index, row] of records.entries()) {
    const missing: string[] = REGISTRY_FIELDS.filter((field) => !(field in row))
    if (!('predecessor_id' in row) && !('successor_id' in row)) missing.push('predecessor_id / successor_id')
    if (missing.length) throw invalid(`в записи ${index + 1} реестра нет обязательных полей: ${missing.join(', ')}`)
    const empty = REGISTRY_FIELDS.filter((field) => field !== 'approval_date' && !row[field])
    if (empty.length) throw invalid(`в записи ${index + 1} реестра не заполнены обязательные поля: ${empty.join(', ')}`)
    if (!/^[0-9a-f]{64}$/i.test(row.sha256)) throw invalid(`в записи ${index + 1} реестра некорректный SHA-256`)
  }
  const ids = records.map((row) => row.file_id)
  if (new Set(ids).size !== ids.length) throw invalid('file_id в реестре повторяется')
  return records
}

export interface Metadata {
  object_id: string
  stage: string
  document_code: string
  revision: string
  approval_status: string
  approval_date: string | null
  predecessor_id: number | null
  signature_status: string | null
  sheet_page_range: string | null
  discipline: string | null
  file_id: string | null
}

/** Проверка карточки документа; ошибки — список причин. */
export function validateMetadata(input: Record<string, unknown>): Metadata {
  const text = (key: string) => String(input[key] ?? '').trim()
  const optional = (key: string) => text(key) || null
  const errors: string[] = []
  const metadata: Metadata = {
    object_id: text('object_id'), stage: text('stage').toUpperCase(),
    document_code: text('document_code'), revision: text('revision'),
    approval_status: text('approval_status').toUpperCase(), approval_date: optional('approval_date'),
    predecessor_id: input.predecessor_id === null || input.predecessor_id === undefined ||
      input.predecessor_id === '' ? null : Number(input.predecessor_id),
    signature_status: optional('signature_status'), sheet_page_range: optional('sheet_page_range'),
    discipline: optional('discipline'), file_id: optional('file_id'),
  }
  for (const key of ['object_id', 'document_code', 'revision', 'discipline', 'file_id', 'signature_status',
    'sheet_page_range'] as const) {
    if (!metadata[key]) errors.push(`${key}: поле обязательно`)
  }
  if (!STAGES.has(metadata.stage)) errors.push('stage: стадия должна быть PD, RD или ID')
  if (!APPROVAL_STATUSES.has(metadata.approval_status)) errors.push('approval_status: неизвестный статус утверждения')
  if (metadata.approval_date && !/^\d{4}-\d{2}-\d{2}$/.test(metadata.approval_date)) {
    errors.push('approval_date: дата в формате ГГГГ-ММ-ДД')
  }
  if (metadata.predecessor_id !== null && !Number.isInteger(metadata.predecessor_id)) {
    errors.push('predecessor_id: идентификатор документа')
  }
  if (errors.length) throw new Error(errors.join('; '))
  return metadata
}
