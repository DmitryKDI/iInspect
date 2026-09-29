/**
 * Процессы проверки — внешний контракт /api/v1 (ТЗ 1.3, 1.4, 9.1–9.3, 9.6)
 * и те же обработчики для интерфейса инспектора: две реализации одного
 * контракта разошлись бы.
 */
import type { FastifyInstance } from 'fastify'
import { display, READERS, requireRole, VERIFIERS, type Principal } from '../../auth/auth.js'
import type { Context } from '../../context.js'
import { toCsv } from '../../domain/csv.js'
import { toDocx, toPdf, toXml } from '../../domain/export.js'
import { createFromDocuments, upload } from '../../domain/intake.js'
import * as processes from '../../domain/processes.js'
import * as protocol from '../../domain/protocol.js'
import * as rin from '../../domain/rin.js'
import { conflict, HttpError, invalid } from '../../errors.js'
import { fileSchema, files, filesSchema, integerField, multipartValidation, valueSchema } from '../multipart.js'
import { anyArray, id, nonEmpty, ok, params, processParams, statusValues, text, uploadStatusBody } from '../schemas.js'

const actor = (principal: Principal) => ({ userId: principal.userId, display: display(principal) })

export function processRoutes(app: FastifyInstance, ctx: Context): void {
  const read = { preHandler: requireRole(ctx, ...READERS) }
  const verify = { preHandler: requireRole(ctx, ...VERIFIERS) }
  const intake = { preHandler: requireRole(ctx, ...VERIFIERS, 'service') }
  const supervisor = { preHandler: requireRole(ctx, 'supervisor') }
  const current = (processId: number) => processes.payload(ctx, processes.load(ctx, processId))
  const pid = (request: { params: unknown }) => (request.params as { process_id: number }).process_id

  app.post('/api/v1/documents/upload', {
    ...intake, ...multipartValidation, schema: { tags: ['api-v1'], summary: 'Загрузить документы и получить process_id',
      description: 'Пакет PDF/DOCX/XML (и чертежи DWG/DXF) с реестром файлов CSV/XLSX/JSON. Ответ сразу ' +
        'содержит process_id; проверка идёт асинхронно, статус — GET /api/v1/processes/{process_id}/status. ' +
        'С process_id — дозагрузка до финализации протокола.',
      consumes: ['multipart/form-data'],
      body: { type: 'object', required: ['files'], properties: { files: filesSchema, registry: fileSchema,
        process_id: valueSchema('^[0-9]+$') } },
      response: { 200: { ...uploadStatusBody, description: 'Процесс создан или дополнен' } } },
  }, async (request) => {
    const body = request.body as Record<string, unknown>
    const incoming = await files(body, 'files')
    if (!incoming.length) throw invalid('файлы не переданы')
    const [registry] = await files(body, 'registry')
    return upload(ctx, { files: incoming, registry: registry ?? null,
      processId: integerField(body, 'process_id') })
  })

  app.get('/api/v1/processes', {
    ...read, schema: { tags: ['api-v1'], summary: 'Процессы проверки',
      querystring: { type: 'object', properties: { object_id: text, limit: { type: 'integer', minimum: 1,
        maximum: 500, default: 100 } } } },
  }, async (request) => {
    const query = request.query as { object_id?: string; limit: number }
    const rows = ctx.db.prepare(`SELECT * FROM processes ${query.object_id ? 'WHERE object_id = ?' : ''}
      ORDER BY id DESC LIMIT ?`).all(...(query.object_id ? [query.object_id] : []), query.limit) as processes.ProcessRow[]
    return rows.map((row) => processes.payload(ctx, processes.parse(row)))
  })

  app.post('/api/v1/processes', {
    ...verify, schema: { tags: ['api-v1'], summary: 'Запустить проверку по уже загруженным документам',
      body: { type: 'object', required: ['object_id', 'document_ids'], properties: { object_id: nonEmpty,
        document_ids: { type: 'array', minItems: 1, items: id } } } },
  }, async (request) => {
    const body = request.body as { object_id: string; document_ids: number[] }
    return current(await createFromDocuments(ctx, body.object_id, body.document_ids))
  })

  app.get('/api/v1/processes/:process_id/status', {
    ...read, schema: { tags: ['api-v1'], summary: 'Мониторинг статуса процесса', params: processParams,
      response: ok('Статус процесса', { type: 'object', properties: {
        process_id: id, status: { type: 'string', enum: statusValues.process }, run_state: text,
        verification_status: { type: 'string', enum: statusValues.verification }, stage: text,
        completed: { type: 'integer' }, total: { type: 'integer' }, error: { type: ['string', 'null'] },
        protocol_version: { type: 'integer' }, sync_status: { type: 'string', enum: statusValues.sync },
        scenario: { type: 'string', enum: statusValues.scenario }, upload_status: { type: 'object' } } }) },
  }, async (request) => {
    const body = current(pid(request))
    return { process_id: body.process_id, status: body.status, run_state: body.run_state,
      verification_status: body.verification_status, stage: body.stage, completed: body.completed,
      total: body.total, error: body.error, protocol_version: body.protocol_version, sync_status: body.sync_status,
      scenario: body.protocol.scenario, upload_status: body.protocol.upload_status }
  })

  app.get('/api/v1/processes/:process_id', {
    ...read, schema: { tags: ['api-v1'], summary: 'Протокол и результат процесса', params: processParams },
  }, async (request) => current(pid(request)))

  app.post('/api/v1/processes/:process_id/cancel', {
    ...verify, schema: { tags: ['api-v1'], summary: 'Остановить проверку', params: processParams },
  }, async (request) => {
    await processes.cancel(ctx, pid(request))
    return current(pid(request))
  })

  app.post('/api/v1/processes/:process_id/decisions', {
    ...verify, schema: { tags: ['api-v1'], summary: 'Решение инспектора по кандидату', params: processParams,
      body: { type: 'object', required: ['finding_id', 'status', 'reason', 'expected_version'], properties: {
        finding_id: nonEmpty, status: { type: 'string', enum: statusValues.decision }, reason: text,
        reason_code: { type: 'string' }, expected_version: { type: 'integer', minimum: 0 }, author: text } } },
  }, async (request) => {
    const status = current(pid(request)).status
    if (!protocol.canVerify(status)) throw conflict(`верификация невозможна в статусе ${status}`)
    processes.decide(ctx, pid(request), request.body as Parameters<typeof processes.decide>[2],
      actor(request.principal!))
    return current(pid(request))
  })

  app.post('/api/v1/processes/:process_id/findings/:finding_id/split', {
    ...verify, schema: { tags: ['api-v1'], summary: 'Разделить составной кандидат на атомарные findings',
      description: 'ТЗ 9.3, п.2: каждая часть получает свои expected/actual и доказательства из карточки ' +
        'кандидата (индексы evidence) с координатами в двух стадиях; решение принимается по каждой части.',
      params: { type: 'object', required: ['process_id', 'finding_id'], properties: {
        process_id: { type: 'integer', minimum: 1 }, finding_id: nonEmpty } },
      body: { type: 'object', required: ['reason', 'expected_version', 'parts'], properties: {
        reason: text, expected_version: { type: 'integer', minimum: 0 },
        parts: { type: 'array', minItems: 2, items: { type: 'object',
          required: ['expected_value', 'actual_value', 'evidence_indexes'], properties: {
            expected_value: text, actual_value: text,
            evidence_indexes: { type: 'array', minItems: 1, items: { type: 'integer', minimum: 0 } } } } } } } },
  }, async (request) => {
    const status = current(pid(request)).status
    if (!protocol.canVerify(status)) throw conflict(`верификация невозможна в статусе ${status}`)
    const { finding_id: findingId } = request.params as { finding_id: string }
    processes.split(ctx, pid(request), findingId, request.body as Parameters<typeof processes.split>[3],
      actor(request.principal!))
    return current(pid(request))
  })

  app.post('/api/v1/processes/:process_id/finalize', {
    ...verify, schema: { tags: ['api-v1'], summary: 'Финализировать протокол («Завершить»)', params: processParams,
      body: { type: ['object', 'null'], properties: { author: text } } },
  }, async (request) => {
    processes.finalize(ctx, pid(request), actor(request.principal!))
    return current(pid(request))
  })

  app.post('/api/v1/processes/:process_id/unfinalize', {
    ...supervisor, schema: { tags: ['api-v1'], summary: 'Отменить финализацию (администратор или супервизор)',
      params: processParams, body: { type: 'object', required: ['reason'], properties: { reason: text } } },
  }, async (request) => {
    processes.unfinalize(ctx, pid(request), (request.body as { reason: string }).reason, actor(request.principal!))
    return current(pid(request))
  })

  app.get('/api/v1/processes/:process_id/events', {
    ...read, schema: { tags: ['api-v1'], summary: 'Журнал событий протокола', params: processParams },
  }, async (request) => processes.events(ctx, pid(request)))

  app.get('/api/v1/processes/:process_id/suspicions', {
    ...read, schema: { tags: ['api-v1'], summary: 'Гипотезы свободного поиска (ТЗ 9.5)', params: processParams },
  }, async (request) => processes.suspicions(ctx, pid(request)))

  app.post('/api/v1/processes/:process_id/suspicions/:suspicion_id', {
    ...verify, schema: { tags: ['api-v1'], summary: 'Решение по гипотезе свободного поиска',
      params: params({ process_id: id, suspicion_id: id }),
      body: { type: 'object', required: ['action'], properties: {
        action: { type: 'string', enum: Object.keys(processes.SUSPICION_ACTIONS) }, comment: text,
        reason_code: text, evidence: { anyOf: [anyArray, { type: 'null' }] } } } },
  }, async (request) => {
    const { process_id: processId, suspicion_id: suspicionId } = request.params as
      { process_id: number; suspicion_id: number }
    return processes.reviewSuspicion(ctx, processId, suspicionId,
      request.body as Parameters<typeof processes.reviewSuspicion>[3], actor(request.principal!))
  })

  app.get('/api/v1/processes/:process_id/export', {
    ...read, schema: { tags: ['api-v1'], summary: 'Протокол в JSON, XML, DOCX, PDF (или таблица проверок CSV)',
      params: processParams, querystring: { type: 'object', properties: {
        format: { type: 'string', enum: ['json', 'xml', 'docx', 'pdf', 'csv'], default: 'json' } } } },
  }, async (request, reply) => {
    const body = current(pid(request))
    const format = (request.query as { format: string }).format
    const name = `protocol-${body.process_id}.${format}`
    const builders: Record<string, [() => Promise<Buffer> | Buffer, string]> = {
      json: [() => Buffer.from(JSON.stringify(body, null, 2)), 'application/json'],
      xml: [() => toXml(body), 'application/xml'],
      docx: [() => toDocx(body), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      pdf: [() => toPdf(body), 'application/pdf'],
      csv: [() => toCsv(body), 'text/csv; charset=utf-8'],
    }
    const [build, type] = builders[format]
    reply.header('Content-Disposition', `attachment; filename="${name}"`).type(type)
    return build()
  })

  app.post('/api/v1/inspection/:process_id', {
    ...intake, schema: { tags: ['api-v1'], summary: 'Передача результатов в ИАИС «РиН»', params: processParams,
      description: 'Только для финализированного протокола. Передаются подтверждённые инспектором записи, ' +
        'версии протокола, матрицы и модели и реестр входных файлов. Недоступность приёмника — PENDING_SYNC ' +
        'и повторы через 1, 5 и 15 минут.' },
  }, async (request) => {
    const processId = pid(request)
    const proc = processes.load(ctx, processId)
    const body = processes.payload(ctx, proc)
    if (body.status !== protocol.FINALIZED) {
      throw new HttpError(409, 'передача возможна только для финализированного протокола')
    }
    const proto = body.protocol
    const pack = { process_id: processId, protocol_version: body.protocol_version, versions: proto.versions,
      input_files: proc.input_snapshot.map((item) => ({ sha256: item.digest, ...item.metadata,
        file_id: item.metadata.file_id ?? `D${item.id}` })),
      confirmed_violations: proto.tables.confirmed_violations }
    const key = `inspector-${processId}-v${body.protocol_version}`
    if (proc.sync_key !== key) processes.update(ctx, processId, { sync_attempts: 0, sync_next_at: null })
    processes.update(ctx, processId, { sync_package: pack, sync_key: key })
    const result = await rin.attempt(ctx, processId)
    const after = processes.load(ctx, processId)
    return { ...pack, sync_status: result.status, sync_detail: result.detail, sync_attempts: after.sync_attempts,
      sync_next_at: after.sync_next_at }
  })
}
