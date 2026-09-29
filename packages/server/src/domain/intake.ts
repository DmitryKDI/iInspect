/**
 * Приём комплекта по внешнему контракту: POST /api/v1/documents/upload
 * (ТЗ 1.4, 9.1, 9.6; перечень ИД, ред. 1.1).
 *
 * Пакет файлов с реестром сразу возвращает process_id; разбор и проверка идут
 * асинхронно через очередь, результат забирается по process_id. Дозагрузка —
 * тот же вызов с process_id, до финализации протокола. После финализации
 * документы сохраняются, но проверку не запускают: инспектор получает
 * уведомление (ТЗ 9.6).
 */
import type { Context } from '../context.js'
import { nowIso, toJson } from '../db/database.js'
import { HttpError, invalid } from '../errors.js'
import { fileMetadata, limits, loadFile, prepare, store, type FileRow, type Prepared } from './files.js'
import { notify } from './notifications.js'
import { listParameters, matrixVersion } from './parameters.js'
import { dispatchIfReady } from './pipeline.js'
import * as processes from './processes.js'
import * as protocol from './protocol.js'
import { parseRegistry, validateMetadata, type RegistryRow } from './registry.js'

export interface UploadInput {
  files: { name: string; data: Buffer }[]
  registry: { name: string; data: Buffer } | null
  processId: number | null
}

interface Rejected { file_name: string; reason: string }

function byFileId(ctx: Context, objectId: string, fileId: string): FileRow | undefined {
  if (!fileId) return undefined
  return ctx.db.prepare(`SELECT * FROM files WHERE file_id = ? AND (? = '' OR object_id = ?)
    ORDER BY id DESC LIMIT 1`).get(fileId, objectId, objectId) as FileRow | undefined
}

export async function upload(ctx: Context, input: UploadInput): Promise<Record<string, unknown>> {
  const { maxPackage, maxFile } = limits(ctx)
  const total = input.files.reduce((sum, file) => sum + file.data.length, 0)
  if (total > maxPackage) {
    throw new HttpError(413, `пакет ${(total / 1048576).toFixed(1)} МБ больше допустимых ` +
      `${Math.round(maxPackage / 1048576)} МБ`)
  }
  let proc = input.processId !== null ? processes.load(ctx, input.processId) : null
  let finalized = false
  if (proc) {
    const status = processes.payload(ctx, proc).status
    finalized = status === protocol.FINALIZED
    if (!finalized && !protocol.canUpload(status)) {
      throw new HttpError(409, `дозагрузка невозможна в статусе ${status}`)
    }
  }
  const rows: RegistryRow[] = input.registry ? await parseRegistry(input.registry.data, input.registry.name) : []
  const byName = new Map(rows.map((row) => [row.file_name, row]))
  const objectIds = new Set(rows.map((row) => row.object_id))
  if (proc) objectIds.add(proc.object_id)
  if (objectIds.size > 1) throw invalid(`в пакете смешаны разные объекты: ${[...objectIds].sort().join(', ')}`)
  const objectId = [...objectIds][0] ?? ''

  const rejected: Rejected[] = []
  const ready: { file: Prepared; row: RegistryRow | undefined }[] = []
  for (const file of input.files) {
    if (file.data.length > maxFile) {
      rejected.push({ file_name: file.name, reason: `файл больше ${Math.round(maxFile / 1048576)} МБ` })
      continue
    }
    let prepared: Prepared
    try {
      prepared = await prepare(ctx, file.data, file.name)
    } catch (error) {
      // Антивирус недоступен — пакет не принимается вовсе (ТЗ 12, п.11).
      if (error instanceof HttpError && error.status === 503) throw error
      rejected.push({ file_name: file.name, reason: error instanceof HttpError ? String(error.detail) :
        (error as Error).message })
      continue
    }
    const row = byName.get(file.name)
    if (rows.length && !row) {
      rejected.push({ file_name: file.name, reason: 'файла нет в реестре' })
      continue
    }
    const expected = (row?.sha256 ?? '').trim().toLowerCase()
    if (expected && expected !== prepared.sha256) {
      rejected.push({ file_name: file.name, reason: 'SHA-256 не совпадает с реестром' })
      continue
    }
    // Перечень ИД: «Перезапись файла под тем же file_id запрещена». Тот же файл
    // повторно — допустим; другое содержимое под старым file_id — отказ.
    const previous = byFileId(ctx, row?.object_id ?? '', row?.file_id ?? '')
    if (previous && previous.file_hash !== prepared.sha256) {
      rejected.push({ file_name: file.name, reason: 'file_id уже занят файлом с другим содержимым; ' +
        'перезапись запрещена — загрузите файл с новым file_id и укажите predecessor_id' })
      continue
    }
    if (row) {
      try {
        validateMetadata({ ...row, stage: row.doc_stage, predecessor_id: null })
      } catch (error) {
        rejected.push({ file_name: file.name, reason: `реестр: ${(error as Error).message}` })
        continue
      }
    }
    ready.push({ file: prepared, row })
  }
  if (!ready.length) throw invalid({ message: 'ни один файл не принят', rejected })

  const stored: { file: FileRow; row: RegistryRow | undefined; name: string }[] = []
  for (const item of ready) stored.push({ file: await store(ctx, item.file), row: item.row, name: item.file.name })

  // Связь редакций задаётся идентификаторами реестра (predecessor_id у новой
  // редакции или successor_id у заменённой); ссылка может вести и на файл из
  // прежней загрузки того же объекта.
  const registryIds = new Map(stored.filter((item) => item.row?.file_id)
    .map((item) => [item.row!.file_id, item.file.id]))
  const successors = new Map(stored.filter((item) => item.row?.successor_id)
    .map((item) => [item.row!.successor_id, item.row!.file_id]))
  const documentId = (fileId: string): number | null => {
    if (!fileId) return null
    return registryIds.get(fileId) ?? byFileId(ctx, objectId, fileId)?.id ?? null
  }
  const accepted: Record<string, unknown>[] = []
  const snapshotAdd: protocol.SnapshotItem[] = []
  ctx.db.transaction(() => {
    for (const item of stored) {
      if (item.row) {
        const own = item.row.file_id
        const predecessor = documentId(item.row.predecessor_id ?? '') ?? documentId(successors.get(own) ?? '')
        const metadata = validateMetadata({ ...item.row, stage: item.row.doc_stage, predecessor_id: predecessor })
        ctx.db.prepare(`UPDATE files SET object_id = ?, file_id = ?, doc_stage = ?, discipline = ?,
          document_code = ?, revision = ?, approval_status = ?, approval_date = ?, predecessor_id = ?,
          signature_status = ?, sheet_page_range = ?, metadata_version = 1 WHERE id = ?`).run(
          metadata.object_id, metadata.file_id, metadata.stage, metadata.discipline, metadata.document_code,
          metadata.revision, metadata.approval_status, metadata.approval_date, metadata.predecessor_id,
          metadata.signature_status, metadata.sheet_page_range, item.file.id)
        if (predecessor !== null) {
          ctx.db.prepare('UPDATE files SET successor_id = ? WHERE id = ?').run(item.file.id, predecessor)
        }
      } else if (objectId) {
        ctx.db.prepare('UPDATE files SET object_id = ? WHERE id = ?').run(objectId, item.file.id)
      }
      const fresh = loadFile(ctx, item.file.id)
      snapshotAdd.push({ id: fresh.id, digest: fresh.file_hash, metadata: fileMetadata(fresh) })
      accepted.push({ file_name: item.name, document_id: fresh.id, stage: fresh.doc_stage })
    }
  })()

  if (proc && finalized) {
    processes.update(ctx, proc.id, { pending_documents: [...proc.pending_documents, ...snapshotAdd] })
    processes.event(ctx, proc.id, 'NEW_DOCUMENTS_AFTER_FINALIZATION', '',
      accepted.map((item) => item.file_name).join(', '))
    notify(ctx, 'inspector', 'documents_after_finalization', proc.id,
      `В финализированный протокол процесса ${proc.id} поступили новые документы; для их проверки ` +
      'создайте новый процесс')
    const body = processes.payload(ctx, processes.load(ctx, proc.id))
    return { process_id: proc.id, status: body.status, upload_status: body.protocol.upload_status,
      scenario: body.protocol.scenario, accepted, rejected,
      notice: 'протокол финализирован: новые документы сохранены, проверка не запускалась; для их ' +
        'проверки создайте новый процесс' }
  }

  let processId: number
  if (!proc) {
    processId = processes.newProcess(ctx, objectId || 'UNKNOWN', snapshotAdd)
  } else {
    // Дозагрузка: прежняя версия протокола остаётся в таблице Protocols (ТЗ 9.2).
    processId = proc.id
    processes.update(ctx, processId, { input_snapshot: [...proc.input_snapshot, ...snapshotAdd],
      result: null, run_state: 'queued', cancelled_at: null, stage: 'Разбор документов', error: null })
    processes.event(ctx, processId, 'RELOAD', '', accepted.map((item) => item.file_name).join(', '))
  }
  proc = processes.load(ctx, processId)
  if (!rows.length && !proc.input_snapshot.some((item) => item.metadata?.stage)) {
    // Без реестра сопоставимые редакции выбрать нельзя: пакет принят, но
    // каждый параметр честно ждёт уточнения (перечень ИД, ред. 1.1).
    const result = protocol.clarificationResult(proc.object_id, 'пакет загружен без реестра файлов: ' +
      'стадия, шифр и редакция не определены', listParameters(ctx), matrixVersion(ctx))
    processes.update(ctx, processId, { result, run_state: 'completed', stage: 'Требуется реестр файлов',
      completed: result.checks.length, total: result.checks.length })
  } else {
    await dispatchIfReady(ctx, processId)
  }
  const body = processes.payload(ctx, processes.load(ctx, processId))
  return { process_id: processId, status: body.status, upload_status: body.protocol.upload_status,
    scenario: body.protocol.scenario, accepted, rejected }
}

/** Процесс проверки из уже загруженных документов (интерфейс инспектора). */
export async function createFromDocuments(ctx: Context, objectId: string, documentIds: number[]): Promise<number> {
  if (!objectId.trim() || !documentIds.length) throw invalid('выберите документы одного объекта')
  if (new Set(documentIds).size !== documentIds.length) throw invalid('документ выбран повторно')
  const rows = documentIds.map((id) => ctx.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined)
  if (rows.some((row) => !row)) throw new HttpError(404, 'один или несколько документов не найдены')
  for (const row of rows as FileRow[]) {
    if (row.object_id !== objectId) throw invalid('в комплекте смешаны разные объекты')
    if (!row.doc_stage) throw invalid('для документа не задана стадия')
    if (row.status === 'ERROR') throw new HttpError(409, `документ «${row.file_name}» не разобран: ${row.parse_error}`)
  }
  const snapshot = (rows as FileRow[]).map((row) => ({ id: row.id, digest: row.file_hash,
    metadata: fileMetadata(row) }))
  const processId = processes.newProcess(ctx, objectId.trim(), snapshot)
  processes.event(ctx, processId, 'CREATE', '', toJson(documentIds))
  await dispatchIfReady(ctx, processId)
  return processId
}

export { nowIso }
