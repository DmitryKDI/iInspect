/**
 * Управление матрицей и нормативной базой (ТЗ 7, модуль 8).
 *
 * Администратор добавляет, редактирует и деактивирует нормативные ссылки и
 * логические правила, обновляет пороги (min_value, max_value) без
 * перекодирования системы. Удаления нет: запись деактивируется, чтобы прежние
 * протоколы оставались объяснимыми. Каждая правка матрицы — новая ревизия.
 */
import type { FastifyInstance } from 'fastify'
import { READERS, requireRole } from '../../auth/auth.js'
import type { Context } from '../../context.js'
import { bool, nowIso } from '../../db/database.js'
import {
  bumpMatrixRevision, DATA_TYPES, EDITABLE_FIELDS, listParameters, matrixVersion, paramDict, PRIORITIES,
  type ParamRow,
} from '../../domain/parameters.js'
import { invalid, notFound } from '../../errors.js'
import { date, id, nullableNumber, params, text } from '../schemas.js'

interface NormRow {
  id: number; document_name: string; document_number: string; section: string; parameter_name: string
  min_value: number | null; max_value: number | null; effective_from: string | null; effective_to: string | null
  is_active: number
}

interface RuleRow {
  id: number; rule_name: string; condition: string; expected: string; normative_base: string
  review_priority: string; is_active: number
}

const normDict = (row: NormRow) => ({ ...row, is_active: bool(row.is_active) })
const ruleDict = (row: RuleRow) => ({ ...row, is_active: bool(row.is_active) })

function checkRange(low: number | null | undefined, high: number | null | undefined): void {
  if (low !== null && low !== undefined && high !== null && high !== undefined && low > high) {
    throw invalid('min_value больше max_value')
  }
}

export function matrixRoutes(app: FastifyInstance, ctx: Context): void {
  const admin = { preHandler: requireRole(ctx, 'admin') }
  const read = { preHandler: requireRole(ctx, ...READERS) }

  app.get('/api/v1/admin/params', { ...read, schema: { tags: ['admin'], summary: 'Параметры матрицы (включая неактивные)' } },
    async () => ({ matrix_version: matrixVersion(ctx), parameters: listParameters(ctx, true) }))

  app.patch('/api/v1/admin/params/:code', {
    ...admin, schema: { tags: ['admin'], summary: 'Изменить параметр матрицы (пороги, ссылки, шаблон, активность)',
      params: params({ code: { type: 'string', pattern: '^[A-ZА-Я]{1,4}-\\d{1,4}$' } }),
      body: { type: 'object', properties: { trigger_logic: text, review_priority: { type: 'string', enum: [...PRIORITIES] },
        sp_reference: text, gost_reference: text, fz_reference: text, other_normative: text,
        data_type: { type: 'string', enum: [...DATA_TYPES] }, min_value: nullableNumber, max_value: nullableNumber,
        regex_pattern: text, is_active: { type: 'boolean' }, clear_min_value: { type: 'boolean' },
        clear_max_value: { type: 'boolean' } }, additionalProperties: false } },
  }, async (request) => {
    const code = (request.params as { code: string }).code
    const body = request.body as Record<string, unknown>
    const row = ctx.db.prepare('SELECT * FROM params WHERE code = ?').get(code) as ParamRow | undefined
    if (!row) throw notFound('параметр не найден')
    if (typeof body.regex_pattern === 'string' && body.regex_pattern) {
      try {
        new RegExp(body.regex_pattern)
      } catch (error) {
        throw invalid(`регулярное выражение с ошибкой: ${(error as Error).message}`)
      }
    }
    const next: Record<string, unknown> = { ...row }
    for (const field of EDITABLE_FIELDS) {
      if (body[field] !== undefined && body[field] !== null) next[field] = field === 'is_active' ? (body[field] ? 1 : 0) : body[field]
    }
    if (body.clear_min_value) next.min_value = null
    if (body.clear_max_value) next.max_value = null
    checkRange(next.min_value as number | null, next.max_value as number | null)
    ctx.db.transaction(() => {
      ctx.db.prepare(`UPDATE params SET ${EDITABLE_FIELDS.map((field) => `${field} = @${field}`).join(', ')},
        updated_at = @updated_at WHERE code = @code`).run({ ...Object.fromEntries(EDITABLE_FIELDS.map((field) =>
        [field, next[field]])), updated_at: nowIso(ctx.now()), code })
      bumpMatrixRevision(ctx)
    })()
    return paramDict(ctx.db.prepare('SELECT * FROM params WHERE code = ?').get(code) as ParamRow)
  })

  const normBody = { type: 'object', required: ['document_name', 'document_number'], properties: {
    document_name: text, document_number: text, section: text, parameter_name: text, min_value: nullableNumber,
    max_value: nullableNumber, effective_from: { anyOf: [date, { type: 'null' }] },
    effective_to: { anyOf: [date, { type: 'null' }] }, is_active: { type: 'boolean' } } }

  function applyNorm(body: Record<string, unknown>): Record<string, unknown> {
    const values = {
      document_name: String(body.document_name ?? '').trim(), document_number: String(body.document_number ?? '').trim(),
      section: String(body.section ?? '').trim(), parameter_name: String(body.parameter_name ?? '').trim(),
      min_value: body.min_value ?? null, max_value: body.max_value ?? null,
      effective_from: body.effective_from ?? null, effective_to: body.effective_to ?? null,
      is_active: body.is_active === false ? 0 : 1, updated_at: nowIso(ctx.now()),
    }
    if (!values.document_name || !values.document_number) throw invalid('укажите наименование и номер документа')
    checkRange(values.min_value as number | null, values.max_value as number | null)
    if (values.effective_from && values.effective_to && String(values.effective_from) > String(values.effective_to)) {
      throw invalid('дата окончания действия раньше даты начала')
    }
    if (values.parameter_name && !ctx.db.prepare('SELECT 1 FROM params WHERE code = ?').get(values.parameter_name)) {
      throw invalid('параметр матрицы с таким кодом не найден')
    }
    return values
  }

  app.get('/api/v1/admin/normative', { ...read, schema: { tags: ['admin'], summary: 'Нормативная база' } },
    async () => (ctx.db.prepare('SELECT * FROM normative_base ORDER BY id').all() as NormRow[]).map(normDict))

  app.post('/api/v1/admin/normative', { ...admin, schema: { tags: ['admin'], summary: 'Добавить нормативную ссылку', body: normBody } },
    async (request) => {
      const values = applyNorm(request.body as Record<string, unknown>)
      const info = ctx.db.transaction(() => {
        const result = ctx.db.prepare(`INSERT INTO normative_base (document_name, document_number, section,
          parameter_name, min_value, max_value, effective_from, effective_to, is_active, updated_at)
          VALUES (@document_name, @document_number, @section, @parameter_name, @min_value, @max_value,
          @effective_from, @effective_to, @is_active, @updated_at)`).run(values)
        bumpMatrixRevision(ctx)
        return result
      })()
      return normDict(ctx.db.prepare('SELECT * FROM normative_base WHERE id = ?').get(info.lastInsertRowid) as NormRow)
    })

  app.put('/api/v1/admin/normative/:item_id', {
    ...admin, schema: { tags: ['admin'], summary: 'Изменить или деактивировать нормативную ссылку',
      params: params({ item_id: id }), body: normBody },
  }, async (request) => {
    const itemId = (request.params as { item_id: number }).item_id
    if (!ctx.db.prepare('SELECT 1 FROM normative_base WHERE id = ?').get(itemId)) throw notFound('нормативная ссылка не найдена')
    const values = applyNorm(request.body as Record<string, unknown>)
    ctx.db.transaction(() => {
      ctx.db.prepare(`UPDATE normative_base SET document_name = @document_name, document_number = @document_number,
        section = @section, parameter_name = @parameter_name, min_value = @min_value, max_value = @max_value,
        effective_from = @effective_from, effective_to = @effective_to, is_active = @is_active,
        updated_at = @updated_at WHERE id = @id`).run({ ...values, id: itemId })
      bumpMatrixRevision(ctx)
    })()
    return normDict(ctx.db.prepare('SELECT * FROM normative_base WHERE id = ?').get(itemId) as NormRow)
  })

  const ruleBody = { type: 'object', required: ['rule_name', 'condition', 'expected'], properties: {
    rule_name: text, condition: text, expected: text, normative_base: text,
    review_priority: { type: 'string', enum: [...PRIORITIES] }, is_active: { type: 'boolean' } } }

  async function applyRule(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const values = { rule_name: String(body.rule_name ?? '').trim(), condition: String(body.condition ?? '').trim(),
      expected: String(body.expected ?? '').trim(), normative_base: String(body.normative_base ?? '').trim(),
      review_priority: String(body.review_priority ?? 'MEDIUM'), is_active: body.is_active === false ? 0 : 1,
      updated_at: nowIso(ctx.now()) }
    if (!values.rule_name) throw invalid('укажите название правила')
    // Синтаксис правила проверяет тот же разборщик ML-модуля, что будет его
    // исполнять: расхождения двух реализаций языка правил быть не может.
    for (const [label, expression] of [['условие', values.condition], ['ожидание', values.expected]]) {
      const check = await ctx.ml.validateRule(expression)
      if (!check.ok) throw invalid(`${label}: ${check.error}`)
    }
    return values
  }

  app.get('/api/v1/admin/rules', { ...read, schema: { tags: ['admin'], summary: 'Логические правила свободного поиска' } },
    async () => (ctx.db.prepare('SELECT * FROM logical_rules ORDER BY id').all() as RuleRow[]).map(ruleDict))

  app.post('/api/v1/admin/rules', { ...admin, schema: { tags: ['admin'], summary: 'Добавить логическое правило', body: ruleBody } },
    async (request) => {
      const values = await applyRule(request.body as Record<string, unknown>)
      const info = ctx.db.prepare(`INSERT INTO logical_rules (rule_name, condition, expected, normative_base,
        review_priority, is_active, updated_at) VALUES (@rule_name, @condition, @expected, @normative_base,
        @review_priority, @is_active, @updated_at)`).run(values)
      return ruleDict(ctx.db.prepare('SELECT * FROM logical_rules WHERE id = ?').get(info.lastInsertRowid) as RuleRow)
    })

  app.put('/api/v1/admin/rules/:item_id', {
    ...admin, schema: { tags: ['admin'], summary: 'Изменить или деактивировать правило',
      params: params({ item_id: id }), body: ruleBody },
  }, async (request) => {
    const itemId = (request.params as { item_id: number }).item_id
    if (!ctx.db.prepare('SELECT 1 FROM logical_rules WHERE id = ?').get(itemId)) throw notFound('правило не найдено')
    const values = await applyRule(request.body as Record<string, unknown>)
    ctx.db.prepare(`UPDATE logical_rules SET rule_name = @rule_name, condition = @condition, expected = @expected,
      normative_base = @normative_base, review_priority = @review_priority, is_active = @is_active,
      updated_at = @updated_at WHERE id = @id`).run({ ...values, id: itemId })
    return ruleDict(ctx.db.prepare('SELECT * FROM logical_rules WHERE id = ?').get(itemId) as RuleRow)
  })
}
