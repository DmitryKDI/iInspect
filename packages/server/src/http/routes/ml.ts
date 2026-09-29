/**
 * Набор данных, версии моделей и еженедельный отчёт (ТЗ 7, модули 4 и 10; 9.4; 14).
 *
 * Куратор данных (ML-инженер) одобряет записи черновика, выпускает
 * dataset_version и регистрирует результаты обучения. Публикацию модели
 * подписывает администратор — только после приёмки; откат сохраняется.
 */
import type { FastifyInstance } from 'fastify'
import { display, requireRole } from '../../auth/auth.js'
import type { Context } from '../../context.js'
import { fromJson, nowIso, toJson } from '../../db/database.js'
import { csv } from '../../domain/csv.js'
import * as feedback from '../../domain/feedback.js'
import { listParameters, matrixVersion } from '../../domain/parameters.js'
import * as processes from '../../domain/processes.js'
import { conflict, invalid, notFound } from '../../errors.js'
import { anyObject, id, nonEmpty, params, text } from '../schemas.js'

export const GOLD_COLUMNS = ['evidence_group_id', 'finding_id', 'object_id', 'matrix_code', 'rule_version',
  'expected_value', 'actual_value', 'source_expected_file_id', 'source_expected_sha256', 'source_expected_stage',
  'source_expected_code', 'source_expected_revision', 'source_expected_approval', 'source_expected_page',
  'source_expected_bbox_polygon', 'source_actual_file_id', 'source_actual_sha256', 'source_actual_stage',
  'source_actual_code', 'source_actual_revision', 'source_actual_approval', 'source_actual_page',
  'source_actual_bbox_polygon', 'approved_change_ref', 'completeness_status', 'finding_status', 'review_priority',
  'expert_id', 'timestamp', 'expert_reason_code', 'expert_comment', 'dataset_version', 'matrix_version',
  'model_version', 'split'] as const

interface VersionRow {
  id: number; version: string; matrix_version: string; item_ids: string; split_hashes: string; counts: string
  created_at: string
}

interface ModelRow {
  id: number; model_version: string; dataset_version: string; matrix_version: string; split_hashes: string
  precision: number | null; recall: number | null; f1: number | null; false_positive_rate: number | null
  per_category_metrics: string; training_params: string; code_ref: string; previous_model: string
  acceptance: string; approval_status: string; approved_by: string; approved_at: string | null
  artifact_hash: string; deployed_at: string | null; created_at: string
}

const versionDict = (row: VersionRow) => ({ version: row.version, matrix_version: row.matrix_version,
  items: fromJson<number[]>(row.item_ids, []).length, split_hashes: fromJson(row.split_hashes, {}),
  counts: fromJson(row.counts, {}), created_at: row.created_at })

const modelDict = (row: ModelRow) => ({ id: row.id, model_version: row.model_version,
  dataset_version: row.dataset_version, matrix_version: row.matrix_version, artifact_hash: row.artifact_hash,
  split_hashes: fromJson(row.split_hashes, {}), precision: row.precision, recall: row.recall, f1: row.f1,
  false_positive_rate: row.false_positive_rate, per_category_metrics: fromJson(row.per_category_metrics, {}),
  training_params: fromJson(row.training_params, {}), code_ref: row.code_ref, previous_model: row.previous_model,
  acceptance: fromJson(row.acceptance, {}), approval_status: row.approval_status, approved_by: row.approved_by,
  approved_at: row.approved_at, deployed_at: row.deployed_at, created_at: row.created_at })

const MODEL_SELECT = `SELECT l.id, l.model_version, l.dataset_version, l.matrix_version, l.split_hashes,
  l.precision, l.recall, l.f1, l.false_positive_rate, l.per_category_metrics, l.training_params, l.code_ref,
  l.previous_model, l.acceptance, v.approval_status, v.approved_by, v.approved_at, v.artifact_hash,
  v.deployed_at, l.created_at FROM ml_retraining_log l JOIN model_versions v ON v.model_version = l.model_version`

export function mlRoutes(app: FastifyInstance, ctx: Context): void {
  const read = { preHandler: requireRole(ctx, 'ml_engineer', 'supervisor') }
  const curator = { preHandler: requireRole(ctx, 'ml_engineer') }
  const signer = { preHandler: requireRole(ctx, 'admin') }
  const version = (name: string) => {
    const row = ctx.db.prepare('SELECT * FROM dataset_versions WHERE version = ?').get(name) as VersionRow | undefined
    if (!row) throw notFound('выпуск не найден')
    return row
  }
  const model = (modelId: number) => {
    const row = ctx.db.prepare(`${MODEL_SELECT} WHERE l.id = ?`).get(modelId) as ModelRow | undefined
    if (!row) throw notFound('модель не найдена')
    return row
  }

  app.get('/api/v1/ml/dataset/items', {
    ...read, schema: { tags: ['ml'], summary: 'Записи набора данных',
      querystring: { type: 'object', properties: { status: { type: 'string', enum: ['DRAFT', 'APPROVED', 'EXCLUDED', 'SUPERSEDED'] } } } },
  }, async (request) => {
    const status = (request.query as { status?: string }).status
    const rows = ctx.db.prepare(`SELECT * FROM dataset_items ${status ? 'WHERE status = ?' : ''} ORDER BY id`)
      .all(...(status ? [status] : [])) as feedback.DatasetItemRow[]
    return rows.map(feedback.itemDict)
  })

  app.post('/api/v1/ml/dataset/items/:item_id/curate', {
    ...curator, schema: { tags: ['ml'], summary: 'Решение куратора по записи', params: params({ item_id: id }),
      body: { type: 'object', required: ['approve'], properties: { approve: { type: 'boolean' } } } },
  }, async (request) => {
    const itemId = (request.params as { item_id: number }).item_id
    const row = ctx.db.prepare('SELECT * FROM dataset_items WHERE id = ?').get(itemId) as feedback.DatasetItemRow | undefined
    if (!row) throw notFound('запись не найдена')
    try {
      feedback.curate(ctx, row, (request.body as { approve: boolean }).approve, request.principal!.userId)
    } catch (error) {
      throw conflict((error as Error).message)
    }
    return feedback.itemDict(ctx.db.prepare('SELECT * FROM dataset_items WHERE id = ?').get(itemId) as feedback.DatasetItemRow)
  })

  app.post('/api/v1/ml/dataset/versions', { ...curator, schema: { tags: ['ml'], summary: 'Выпустить dataset_version' } },
    async (request) => {
      try {
        return ctx.db.transaction(() => feedback.release(ctx, request.principal!.userId, matrixVersion(ctx)))()
      } catch (error) {
        throw conflict((error as Error).message)
      }
    })

  app.get('/api/v1/ml/dataset/versions', { ...read, schema: { tags: ['ml'], summary: 'Выпуски набора данных' } },
    async () => (ctx.db.prepare('SELECT * FROM dataset_versions ORDER BY id').all() as VersionRow[]).map(versionDict))

  app.get('/api/v1/ml/dataset/versions/:version/evaluate', {
    ...read, schema: { tags: ['ml'], summary: 'Метрики машинных результатов на выборке выпуска',
      params: params({ version: nonEmpty }), querystring: { type: 'object', properties: {
        split: { type: 'string', enum: feedback.SPLITS, default: feedback.HIDDEN_TEST } } } },
  }, async (request) => {
    const row = version((request.params as { version: string }).version)
    const split = (request.query as { split: string }).split
    const ids = fromJson<number[]>(row.item_ids, [])
    const items = (ids.length ? ctx.db.prepare(`SELECT * FROM dataset_items WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as feedback.DatasetItemRow[] : []).filter((item) => feedback.splitOf(ctx, item.object_id) === split)
    const sections = new Map(listParameters(ctx, true).map((item) => [item.code as string, item.section as string]))
    const groups = new Map<string, feedback.DatasetItemRow[]>([['all', items]])
    for (const item of items) {
      const name = sections.get(item.parameter_code) ?? 'без раздела'
      groups.set(name, [...(groups.get(name) ?? []), item])
    }
    const metrics = (list: feedback.DatasetItemRow[]) => {
      const tally = (label: string, candidate: boolean) => list.filter((item) => item.gold_label === label &&
        (item.machine_status === 'CANDIDATE') === candidate).length
      const [tp, fn, fp, tn] = [tally(feedback.POSITIVE, true), tally(feedback.POSITIVE, false),
        tally(feedback.NEGATIVE, true), tally(feedback.NEGATIVE, false)]
      const precision = tp + fp ? tp / (tp + fp) : null
      const recall = tp + fn ? tp / (tp + fn) : null
      return { size: list.length, tp, fp, fn, tn, precision, recall,
        f1: precision && recall ? (2 * precision * recall) / (precision + recall) : null,
        false_positive_rate: fp + tn ? fp / (fp + tn) : null }
    }
    return { dataset_version: row.version, split,
      metrics: Object.fromEntries([...groups.entries()].map(([name, list]) => [name, metrics(list)])) }
  })

  app.get('/api/v1/ml/dataset/versions/:version/export', {
    ...read, schema: { tags: ['ml'], summary: 'Выпуск набора в полях листа «Схема GOLD» (JSON или CSV)',
      params: params({ version: nonEmpty }), querystring: { type: 'object', properties: {
        format: { type: 'string', enum: ['json', 'csv'], default: 'json' } } } },
  }, async (request, reply) => {
    const row = version((request.params as { version: string }).version)
    const rows = feedback.goldRows(ctx, row.version, fromJson<number[]>(row.item_ids, []))
    if ((request.query as { format: string }).format === 'json') return rows
    reply.header('Content-Disposition', `attachment; filename="gold-${row.version}.csv"`).type('text/csv; charset=utf-8')
    return csv(GOLD_COLUMNS, rows)
  })

  app.post('/api/v1/ml/evaluate', {
    ...curator, schema: { tags: ['ml'], summary: 'Метрики по эталонной разметке (лист «Метрики», ТЗ 14.3)',
      description: 'Эталон читается только на время расчёта: он не сохраняется и не пишется в журнал.',
      body: { type: 'object', required: ['reference', 'process_ids'], properties: {
        reference: { anyOf: [anyObject, { type: 'array' }] }, process_ids: { type: 'array', items: id } } } },
  }, async (request) => {
    const body = request.body as { reference: unknown; process_ids: number[] }
    const runs = body.process_ids.map((processId) => {
      const proc = processes.load(ctx, processId)
      return { id: proc.id, object_id: proc.object_id, run_state: proc.run_state, input_snapshot: proc.input_snapshot,
        result: processes.view(ctx, proc).result }
    })
    // Матрица — для разбивки метрик по разделам (ML-модули своей матрицы не хранят).
    return ctx.ml.evaluate({ reference: body.reference, processes: runs, parameters: listParameters(ctx) })
  })

  app.get('/api/v1/ml/rejections', { ...read, schema: { tags: ['ml'], summary: 'Лог отклонений' } },
    async () => ctx.db.prepare('SELECT *, process_id AS run_id FROM rejection_log ORDER BY id DESC').all())

  app.get('/api/v1/ml/disputes', { ...read, schema: { tags: ['ml'], summary: 'Спорные случаи' } },
    async () => ctx.db.prepare('SELECT *, process_id AS run_id FROM dispute_log ORDER BY id DESC').all())

  app.get('/api/v1/ml/models', { ...read, schema: { tags: ['ml'], summary: 'Итерации дообучения и реестр моделей' } },
    async () => ({ published: feedback.publishedModel(ctx)?.model_version ?? null,
      models: (ctx.db.prepare(`${MODEL_SELECT} ORDER BY l.id`).all() as ModelRow[]).map(modelDict) }))

  const unit = { type: 'number', minimum: 0, maximum: 1 }
  app.post('/api/v1/ml/models', {
    ...curator, schema: { tags: ['ml'], summary: 'Зарегистрировать результат обучения',
      body: { type: 'object', required: ['model_version', 'dataset_version', 'precision', 'recall', 'f1',
        'false_positive_rate'], properties: { model_version: nonEmpty, dataset_version: nonEmpty,
        artifact_hash: text, precision: unit, recall: unit, f1: unit, false_positive_rate: unit,
        per_category_metrics: anyObject, training_params: anyObject, code_ref: text } } },
  }, async (request) => {
    const body = request.body as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
    const dataset = ctx.db.prepare('SELECT * FROM dataset_versions WHERE version = ?').get(body.dataset_version) as
      VersionRow | undefined
    if (!dataset) throw invalid('обучение допускается только на выпущенном dataset_version')
    if (ctx.db.prepare('SELECT 1 FROM ml_retraining_log WHERE model_version = ?').get(body.model_version)) {
      throw conflict('такая версия модели уже зарегистрирована')
    }
    const current = feedback.publishedModel(ctx)
    const metrics = { precision: body.precision, recall: body.recall, f1: body.f1,
      false_positive_rate: body.false_positive_rate }
    const acceptance = feedback.acceptance(metrics, body.per_category_metrics ?? {}, current)
    const now = nowIso(ctx.now())
    const info = ctx.db.transaction(() => {
      const result = ctx.db.prepare(`INSERT INTO ml_retraining_log (model_version, dataset_version, matrix_version,
        split_hashes, precision, recall, f1, false_positive_rate, per_category_metrics, training_params, code_ref,
        previous_model, acceptance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        body.model_version, body.dataset_version, dataset.matrix_version, dataset.split_hashes, body.precision,
        body.recall, body.f1, body.false_positive_rate, toJson(body.per_category_metrics ?? {}),
        toJson(body.training_params ?? {}), body.code_ref ?? '', current?.model_version ?? '', toJson(acceptance), now)
      ctx.db.prepare(`INSERT INTO model_versions (model_version, artifact_hash, dataset_version, metrics_json,
        rollback_to, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(body.model_version, body.artifact_hash ?? '',
        body.dataset_version, toJson({ ...metrics, per_category_metrics: body.per_category_metrics ?? {} }),
        current?.model_version ?? '', now)
      return result
    })()
    return modelDict(model(Number(info.lastInsertRowid)))
  })

  const setApproval = (row: ModelRow, status: string, approver: string, stamp: boolean) => {
    const now = nowIso(ctx.now())
    ctx.db.transaction(() => {
      ctx.db.prepare(`UPDATE model_versions SET approval_status = ?, approved_by = ?,
        approved_at = CASE WHEN ? THEN ? ELSE approved_at END,
        deployed_at = CASE WHEN ? THEN ? ELSE deployed_at END WHERE model_version = ?`)
        .run(status, approver, stamp ? 1 : 0, now, stamp ? 1 : 0, now, row.model_version)
      ctx.db.prepare('UPDATE ml_retraining_log SET approval_status = ?, approved_by = ? WHERE model_version = ?')
        .run(status, approver, row.model_version)
    })()
  }
  const modelParams = params({ model_id: id })

  app.post('/api/v1/ml/models/:model_id/approve', {
    ...signer, schema: { tags: ['ml'], summary: 'Подписать публикацию модели', params: modelParams },
  }, async (request) => {
    const row = model((request.params as { model_id: number }).model_id)
    if (row.approval_status !== 'PENDING') throw conflict(`модель в статусе ${row.approval_status}`)
    const acceptance = fromJson<{ passed?: boolean; failures?: string[] }>(row.acceptance, {})
    if (!acceptance.passed) throw conflict(`модель не прошла приёмку: ${(acceptance.failures ?? []).join('; ')}`)
    setApproval(row, 'APPROVED', display(request.principal!), true)
    ctx.log.warning(`опубликована модель ${row.model_version}`, { event: 'model_published', security: true })
    return modelDict(model(row.id))
  })

  app.post('/api/v1/ml/models/:model_id/reject', {
    ...signer, schema: { tags: ['ml'], summary: 'Отклонить модель', params: modelParams },
  }, async (request) => {
    const row = model((request.params as { model_id: number }).model_id)
    if (row.approval_status !== 'PENDING') throw conflict('отклонить можно только модель, ожидающую решения')
    setApproval(row, 'REJECTED', display(request.principal!), false)
    return modelDict(model(row.id))
  })

  app.post('/api/v1/ml/models/:model_id/rollback', {
    ...signer, schema: { tags: ['ml'], summary: 'Откатить опубликованную модель', params: modelParams },
  }, async (request) => {
    const row = model((request.params as { model_id: number }).model_id)
    if (row.approval_status !== 'APPROVED') throw conflict('откатить можно только опубликованную модель')
    setApproval(row, 'ROLLED_BACK', display(request.principal!), false)
    ctx.log.warning(`откат модели ${row.model_version}`, { event: 'model_rollback', security: true })
    return { rolled_back: row.model_version, published: feedback.publishedModel(ctx)?.model_version ?? null }
  })

  app.get('/api/v1/ml/report', {
    ...read, schema: { tags: ['ml'], summary: 'Отчёт по дообучению за период',
      querystring: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 366, default: 7 } } } },
  }, async (request) => {
    const payload = feedback.weeklyReport(ctx, ctx.now(), (request.query as { days: number }).days)
    ctx.db.prepare('INSERT INTO weekly_reports (period_start, period_end, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(payload.period_start, payload.period_end, toJson(payload), nowIso(ctx.now()))
    return payload
  })

  app.get('/api/v1/ml/reports', { ...read, schema: { tags: ['ml'], summary: 'Сохранённые отчёты' } },
    async () => (ctx.db.prepare('SELECT id, payload FROM weekly_reports ORDER BY id DESC LIMIT 52').all() as
      { id: number; payload: string }[]).map((row) => ({ ...fromJson<object>(row.payload, {}), id: row.id })))
}
