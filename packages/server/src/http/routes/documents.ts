/** Документы комплекта: приём, карточка, удаление, изображение листа; матрица (ТЗ 8, 9.1). */
import type { FastifyInstance } from 'fastify'
import { READERS, requireRole, VERIFIERS } from '../../auth/auth.js'
import type { Context } from '../../context.js'
import { documentDict, ingest, loadFile, removeFile, saveMetadata, type FileRow } from '../../domain/files.js'
import { listParameters, matrixVersion } from '../../domain/parameters.js'
import { validateMetadata } from '../../domain/registry.js'
import { HttpError, invalid, notFound } from '../../errors.js'
import { fileSchema, files, multipartValidation } from '../multipart.js'
import { date, id, ok, params, statusValues, text } from '../schemas.js'

// Разрешение изображения листа, точек на дюйм: подписи чертежа читаются,
// а PNG листа А1 остаётся в пределах нескольких мегабайт.
const PAGE_DPI = 110

export function documentRoutes(app: FastifyInstance, ctx: Context): void {
  const read = { preHandler: requireRole(ctx, ...READERS) }
  const verify = { preHandler: requireRole(ctx, ...VERIFIERS) }

  app.get('/api/v1/parameters', { ...read, schema: { tags: ['matrix'], summary: 'Матрица контроля (132 параметра)' } },
    async () => ({ matrix_version: matrixVersion(ctx), parameters: listParameters(ctx) }))

  app.get('/api/v1/documents', {
    ...read, schema: { tags: ['documents'], summary: 'Загруженные документы',
      querystring: { type: 'object', properties: { object_id: text, with_stage: { type: 'boolean' } } } },
  }, async (request) => {
    const query = request.query as { object_id?: string; with_stage?: boolean }
    const rows = ctx.db.prepare('SELECT * FROM files ORDER BY uploaded_at DESC, id DESC').all() as FileRow[]
    return rows.filter((row) => (!query.object_id || row.object_id === query.object_id) &&
      (!query.with_stage || row.doc_stage)).map(documentDict)
  })

  app.post('/api/v1/documents', {
    ...verify, ...multipartValidation, schema: { tags: ['documents'], summary: 'Загрузить один документ (интерфейс инспектора)',
      consumes: ['multipart/form-data'],
      body: { type: 'object', required: ['file'], properties: { file: fileSchema } }, response: ok('Документ') },
  }, async (request) => {
    const [file] = await files(request.body as Record<string, unknown>, 'file')
    if (!file) throw invalid('файл не передан')
    return documentDict(await ingest(ctx, file.data, file.name))
  })

  app.put('/api/v1/documents/:document_id/metadata', {
    ...verify, schema: { tags: ['documents'], summary: 'Карточка документа: стадия, шифр, редакция, утверждение',
      params: params({ document_id: id }),
      body: { type: 'object', required: ['object_id', 'file_id', 'stage', 'discipline', 'document_code', 'revision',
        'approval_status', 'signature_status', 'sheet_page_range'],
        properties: { object_id: text, file_id: text, stage: { type: 'string', enum: statusValues.stage },
          discipline: text, document_code: text,
          revision: text, approval_status: { type: 'string', enum: statusValues.approval },
          approval_date: { anyOf: [date, { type: 'null' }] }, predecessor_id: { type: ['integer', 'null'] },
          signature_status: text, sheet_page_range: text } } },
  }, async (request) => {
    let metadata
    try {
      metadata = validateMetadata(request.body as Record<string, unknown>)
    } catch (error) {
      throw invalid((error as Error).message)
    }
    return documentDict(saveMetadata(ctx, (request.params as { document_id: number }).document_id, metadata))
  })

  app.delete('/api/v1/documents/:document_id', {
    ...verify, schema: { tags: ['documents'], summary: 'Удалить документ, не вошедший в протокол',
      params: params({ document_id: id }) },
  }, async (request) => {
    removeFile(ctx, (request.params as { document_id: number }).document_id)
    return { ok: true }
  })

  app.get('/api/v1/documents/:document_id/pages/:page/image', {
    ...read, schema: { tags: ['documents'], summary: 'Изображение листа для карточки доказательства',
      params: params({ document_id: id, page: id }) },
  }, async (request, reply) => {
    const { document_id: documentId, page } = request.params as { document_id: number; page: number }
    const row = loadFile(ctx, documentId)
    if (row.status !== 'OK') throw new HttpError(409, 'документ ещё не разобран')
    if (page > row.pages) throw notFound('лист вне документа')
    const image = await ctx.ml.renderPage({ sha256: row.file_hash, sourceFormat: row.source_format,
      derivedSha256: row.derived_hash }, page, PAGE_DPI)
    reply.header('Cache-Control', 'private, max-age=3600').type('image/png')
    return image
  })
}
