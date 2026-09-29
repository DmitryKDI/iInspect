/**
 * Матрица контроля — таблица Params (ТЗ 8, 8.1; модуль 8).
 *
 * Официальная матрица из 132 параметров (`data/parameter_catalog_v1_1.json`)
 * при первом запуске переносится в таблицу Params. Дальше администратор
 * меняет пороги (min_value, max_value), нормативные ссылки, шаблоны разбора и
 * активность без перекодирования системы. Каждая правка — новая ревизия,
 * и версия матрицы в протоколе показывает, по какой редакции шла проверка.
 */
import { readFileSync } from 'node:fs'
import type { Context } from '../context.js'
import { bool, nowIso } from '../db/database.js'

export const PARAMETER_COUNT = 132
export const CATALOG_VERSION = '1.1'
export const DATA_TYPES = ['number', 'string', 'boolean', 'coordinate', 'enum'] as const
export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const
export const EDITABLE_FIELDS = ['trigger_logic', 'review_priority', 'sp_reference', 'gost_reference',
  'fz_reference', 'other_normative', 'data_type', 'min_value', 'max_value', 'regex_pattern',
  'is_active'] as const

interface CatalogItem {
  code: string; section: string; name: string; description: string; unit: string
  source_pd: string; source_rd: string; source_id: string; trigger: string; priority: string
  version: string
}

export function readCatalog(file: string): CatalogItem[] {
  const payload = JSON.parse(readFileSync(file, 'utf8')) as { version: string; parameters: CatalogItem[] }
  if (payload.version !== CATALOG_VERSION) throw new Error('неизвестная версия официальной матрицы')
  const expected = Array.from({ length: PARAMETER_COUNT },
    (_, index) => `M-${String(index + 1).padStart(3, '0')}`)
  if (payload.parameters.map((item) => item.code).join() !== expected.join()) {
    throw new Error('каталог должен содержать все 132 кода официальной матрицы по порядку')
  }
  for (const item of payload.parameters) {
    for (const field of ['name', 'section', 'unit', 'source_pd', 'source_rd', 'source_id',
      'trigger'] as const) {
      if (!item[field]) throw new Error(`не заполнено поле ${field} параметра ${item.code}`)
    }
  }
  return payload.parameters
}

/** «Раздел 1. ПЗ» → «ПЗ»: в Params раздел — условное обозначение (ТЗ 8.1). */
function sectionCode(section: string): string {
  return section.includes('.') ? section.split('.').slice(1).join('.').trim() : section.trim()
}

/** Начальный тип значения по единице измерения; его правит администратор. */
function dataType(unit: string): string {
  if (unit.includes('Коорд')) return 'coordinate'
  if (['Марка', 'Класс', 'Кат', 'Степень', 'Буква', 'RAL', 'Статус'].some((word) => unit.includes(word))) {
    return 'enum'
  }
  return ['', '—'].includes(unit.trim()) ? 'string' : 'number'
}

export function ensureSeeded(ctx: Context): void {
  ctx.db.prepare('INSERT OR IGNORE INTO settings (id) VALUES (1)').run()
  const count = (ctx.db.prepare('SELECT count(*) AS n FROM params').get() as { n: number }).n
  if (count) return
  const now = nowIso(ctx.now())
  const insert = ctx.db.prepare(`INSERT INTO params (code, section, parameter_name, description, unit,
    source_pd, source_rd, source_id, trigger_logic, review_priority, data_type, is_active,
    created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
  ctx.db.transaction(() => {
    for (const item of readCatalog(ctx.config.catalogPath)) {
      insert.run(item.code, sectionCode(item.section), item.name, item.description, item.unit,
        item.source_pd, item.source_rd, item.source_id, item.trigger, item.priority,
        dataType(item.unit), now, now)
    }
  })()
}

export interface ParamRow {
  id: number; code: string; section: string; parameter_name: string; description: string
  unit: string; source_pd: string; source_rd: string; source_id: string; trigger_logic: string
  review_priority: string; sp_reference: string; gost_reference: string; fz_reference: string
  other_normative: string; data_type: string; min_value: number | null; max_value: number | null
  regex_pattern: string; is_active: number; created_at: string; updated_at: string
}

/** Параметр в том виде, в каком его читает сверка и интерфейс. */
export function paramDict(row: ParamRow): Record<string, unknown> {
  return {
    id: row.id, code: row.code, section: row.section, name: row.parameter_name,
    parameter_name: row.parameter_name, description: row.description, unit: row.unit,
    source_pd: row.source_pd, source_rd: row.source_rd, source_id: row.source_id,
    trigger: row.trigger_logic, trigger_logic: row.trigger_logic, priority: row.review_priority,
    review_priority: row.review_priority, sp_reference: row.sp_reference,
    gost_reference: row.gost_reference, fz_reference: row.fz_reference,
    other_normative: row.other_normative, data_type: row.data_type, min_value: row.min_value,
    max_value: row.max_value, regex_pattern: row.regex_pattern, is_active: bool(row.is_active),
    created_at: row.created_at, updated_at: row.updated_at, version: CATALOG_VERSION,
  }
}

export function listParameters(ctx: Context, includeInactive = false): Record<string, unknown>[] {
  const rows = ctx.db.prepare('SELECT * FROM params ORDER BY id').all() as ParamRow[]
  return rows.filter((row) => includeInactive || bool(row.is_active)).map(paramDict)
}

export function matrixVersion(ctx: Context): string {
  const row = ctx.db.prepare('SELECT matrix_revision FROM settings WHERE id = 1').get() as
    { matrix_revision: number } | undefined
  const revision = row?.matrix_revision ?? 0
  return revision ? `${CATALOG_VERSION}-r${revision}` : CATALOG_VERSION
}

export function bumpMatrixRevision(ctx: Context): void {
  ctx.db.prepare('UPDATE settings SET matrix_revision = matrix_revision + 1 WHERE id = 1').run()
}
