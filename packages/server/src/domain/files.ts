/**
 * Файлы комплекта — таблица Files (ТЗ 10, п.4; 9.1; перечень ИД, ред. 1.1).
 *
 * Приём файла: антивирус до сохранения (ТЗ 12, п.11), формат по содержимому,
 * лимиты размера, запись оригинала в зашифрованное хранилище, строка Files и
 * задача разбора в очереди. Карточка документа (стадия, шифр, редакция,
 * статус утверждения, связь редакций) хранится с версией каждой правки.
 */
import type { Context } from '../context.js'
import { fromJson, nowIso, toJson } from '../db/database.js'
import { conflict, HttpError, invalid, notFound } from '../errors.js'
import * as antivirus from './antivirus.js'
import { FormatError, inspect } from './formats.js'
import { dispatchParse } from './pipeline.js'
import { sha256 } from '../storage/fileStore.js'
import type { Metadata } from './registry.js'

export interface FileRow {
  id: number; object_id: string | null; file_id: string | null; file_name: string
  doc_stage: string | null; discipline: string | null; document_code: string | null
  revision: string | null; approval_status: string | null; approval_date: string | null
  predecessor_id: number | null; successor_id: number | null; signature_status: string | null
  sheet_page_range: string | null; file_hash: string; file_path: string; source_format: string
  derived_hash: string | null; derived_format: string | null; size: number; pages: number
  status: string; parse_error: string | null; parse_info: string; metadata_version: number
  uploaded_at: string
}

export function loadFile(ctx: Context, id: number): FileRow {
  const row = ctx.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined
  if (!row) throw notFound('документ не найден')
  return row
}

/** Карточка документа в том виде, в каком она входит в снимок процесса. */
export function fileMetadata(row: FileRow): Record<string, unknown> {
  if (!row.doc_stage) return {}
  return {
    object_id: row.object_id, stage: row.doc_stage, document_code: row.document_code,
    revision: row.revision, approval_status: row.approval_status, approval_date: row.approval_date,
    predecessor_id: row.predecessor_id, successor_id: row.successor_id,
    signature_status: row.signature_status, sheet_page_range: row.sheet_page_range,
    discipline: row.discipline, file_id: row.file_id ?? `D${row.id}`,
    source_format: row.source_format, source_sha256: row.file_hash,
  }
}

export function documentDict(row: FileRow): Record<string, unknown> {
  const info = fromJson<Record<string, unknown>>(row.parse_info, {})
  return {
    id: row.id, name: row.file_name, pages: row.pages, size: row.size,
    // Статус разбора для интерфейса: parsing | ok | error.
    status: row.status === 'OK' ? 'ok' : row.status === 'ERROR' ? 'error' : 'parsing',
    error: row.parse_error, digest: row.file_hash, source_format: row.source_format,
    discipline_code: info.discipline_code ?? row.discipline ?? null,
    classification_source: info.classification_source ?? null,
    ocr_quality: info.ocr_quality ?? null, uploaded_at: row.uploaded_at,
    metadata: fileMetadata(row),
  }
}

export interface StoredFile { row: FileRow; created: boolean }

/** Антивирус до сохранения (ТЗ 12, п.11): заражён — отказ; антивирус недоступен — 503. */
export async function scanOrReject(ctx: Context, data: Buffer): Promise<void> {
  const result = await ctx.scan(data)
  if (result.status === antivirus.INFECTED) {
    ctx.log.warning(`загрузка отклонена антивирусом: ${result.detail}`, { event: 'antivirus', security: true })
    throw invalid(`файл заражён: ${result.detail}`)
  }
  if (result.status === antivirus.UNAVAILABLE) {
    ctx.log.error(result.detail, { event: 'antivirus' })
    throw new HttpError(503, `файл не принят: ${result.detail}; повторите загрузку позже`)
  }
}

export function limits(ctx: Context): { maxFile: number; maxPackage: number; maxPages: number } {
  const row = ctx.db.prepare('SELECT max_upload_mb, max_package_mb, max_pages FROM settings WHERE id = 1')
    .get() as { max_upload_mb: number; max_package_mb: number; max_pages: number }
  return { maxFile: row.max_upload_mb * 1024 * 1024, maxPackage: row.max_package_mb * 1024 * 1024,
    maxPages: row.max_pages }
}

export interface Prepared {
  data: Buffer
  name: string
  format: string
  pages: number
  sha256: string
  derived?: { format: string; data: Buffer }
}

/**
 * Проверить файл до сохранения: лимит размера, антивирус, формат и целостность.
 * Ошибка — HttpError с причиной для пользователя (ТЗ 9.1, таблица ошибок).
 */
export async function prepare(ctx: Context, data: Buffer, fileName: string): Promise<Prepared> {
  const { maxFile, maxPages } = limits(ctx)
  if (data.length > maxFile) {
    throw new HttpError(413, `файл больше допустимых ${Math.round(maxFile / 1048576)} МБ`)
  }
  await scanOrReject(ctx, data)
  try {
    const inspected = await inspect(data, maxPages)
    // Оригинальное имя — только отображаемые метаданные: на диск оно не идёт.
    return { data, name: fileName.split(/[\\/]/).pop() || 'document', format: inspected.format,
      pages: inspected.pages, sha256: sha256(data), derived: inspected.derived }
  } catch (error) {
    if (error instanceof FormatError) throw new HttpError(415, error.message)
    throw error
  }
}

/** Сохранить проверенный файл: зашифрованное хранилище, строка Files, задача разбора. */
export async function store(ctx: Context, file: Prepared): Promise<FileRow> {
  const digest = ctx.store.put(file.data)
  const derived = file.derived ? ctx.store.put(file.derived.data) : null
  const info = ctx.db.prepare(`INSERT INTO files (file_name, file_hash, file_path, source_format,
    derived_hash, derived_format, size, pages, status, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PARSING', ?)`).run(file.name, digest, `storage:${digest}`,
    file.format, derived, file.derived?.format ?? null, file.data.length, file.pages, nowIso(ctx.now()))
  const row = loadFile(ctx, Number(info.lastInsertRowid))
  await dispatchParse(ctx, row)
  return row
}

export async function ingest(ctx: Context, data: Buffer, fileName: string): Promise<FileRow> {
  return store(ctx, await prepare(ctx, data, fileName))
}

/** Записать карточку документа с проверкой цепочки редакций. */
export function saveMetadata(ctx: Context, id: number, metadata: Metadata): FileRow {
  const row = loadFile(ctx, id)
  if (['APPROVED', 'FOR_CONSTRUCTION'].includes(metadata.approval_status) && !metadata.approval_date) {
    throw invalid('для утверждённой редакции нужна дата утверждения')
  }
  if (metadata.predecessor_id === id) throw invalid('редакция не может заменять саму себя')
  if (metadata.predecessor_id !== null) {
    const predecessor = ctx.db.prepare('SELECT * FROM files WHERE id = ?').get(metadata.predecessor_id) as
      FileRow | undefined
    if (!predecessor) throw invalid('заменяемая редакция не найдена')
    if (predecessor.object_id !== metadata.object_id) throw invalid('редакции относятся к разным объектам')
    if (predecessor.doc_stage !== metadata.stage) throw invalid('редакции относятся к разным стадиям')
    if (predecessor.document_code !== metadata.document_code) throw invalid('редакции имеют разные шифры документа')
    const seen = new Set([id])
    let current: FileRow | undefined = predecessor
    while (current) {
      if (seen.has(current.id)) throw invalid('цепочка редакций содержит цикл')
      seen.add(current.id)
      current = current.predecessor_id === null ? undefined
        : ctx.db.prepare('SELECT * FROM files WHERE id = ?').get(current.predecessor_id) as FileRow | undefined
    }
  }
  if (metadata.file_id) {
    const clash = ctx.db.prepare('SELECT id FROM files WHERE object_id = ? AND file_id = ? AND id != ? AND file_hash != ?')
      .get(metadata.object_id, metadata.file_id, id, row.file_hash)
    if (clash) throw conflict('file_id уже занят файлом с другим содержимым; перезапись запрещена')
  }
  ctx.db.transaction(() => {
    ctx.db.prepare(`UPDATE files SET object_id = ?, file_id = ?, doc_stage = ?, discipline = ?,
      document_code = ?, revision = ?, approval_status = ?, approval_date = ?, predecessor_id = ?,
      signature_status = ?, sheet_page_range = ?, metadata_version = metadata_version + 1 WHERE id = ?`)
      .run(metadata.object_id, metadata.file_id, metadata.stage, metadata.discipline,
        metadata.document_code, metadata.revision, metadata.approval_status, metadata.approval_date,
        metadata.predecessor_id, metadata.signature_status, metadata.sheet_page_range, id)
    if (metadata.predecessor_id !== null) {
      ctx.db.prepare('UPDATE files SET successor_id = ? WHERE id = ?').run(id, metadata.predecessor_id)
    }
    const fresh = loadFile(ctx, id)
    ctx.db.prepare(`INSERT INTO file_metadata_events (file_id, version, snapshot, created_at)
      VALUES (?, ?, ?, ?)`).run(id, fresh.metadata_version, toJson(fileMetadata(fresh)), nowIso(ctx.now()))
  })()
  ctx.db.prepare('INSERT OR IGNORE INTO objects (id, created_at) VALUES (?, ?)')
    .run(metadata.object_id, nowIso(ctx.now()))
  return loadFile(ctx, id)
}

export function removeFile(ctx: Context, id: number): void {
  const row = loadFile(ctx, id)
  if (ctx.db.prepare('SELECT 1 FROM files WHERE predecessor_id = ?').get(id)) {
    throw conflict('документ является предыдущей редакцией')
  }
  const used = (ctx.db.prepare('SELECT input_snapshot FROM processes').all() as { input_snapshot: string }[])
    .some((item) => fromJson<{ id: number }[]>(item.input_snapshot, []).some((entry) => entry.id === id))
  if (used) throw conflict('документ входит в сохранённый протокол')
  ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM file_metadata_events WHERE file_id = ?').run(id)
    ctx.db.prepare('UPDATE files SET successor_id = NULL WHERE successor_id = ?').run(id)
    ctx.db.prepare('DELETE FROM files WHERE id = ?').run(id)
  })()
  // Оригинал удаляется, только если на него не осталось ссылок (дедупликация).
  for (const digest of [row.file_hash, row.derived_hash]) {
    if (!digest) continue
    const still = ctx.db.prepare('SELECT 1 FROM files WHERE file_hash = ? OR derived_hash = ?').get(digest, digest)
    if (!still) ctx.store.remove(digest)
  }
}
