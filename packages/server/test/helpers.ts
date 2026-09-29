/**
 * Тестовый стенд сервера: настоящая зашифрованная база и хранилище во
 * временном каталоге, очередь и флаги в памяти, ML-модули — заменитель,
 * который отвечает на задачи так, как ответил бы воркер.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { readFileSync } from 'node:fs'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument } from 'pdf-lib'
import { loadConfig } from '../src/config.js'
import type { Context } from '../src/context.js'
import { CLEAN } from '../src/domain/antivirus.js'
import type { MlClient } from '../src/mlClient.js'
import { Logger } from '../src/observability/logging.js'
import { MemoryBroker } from '../src/queue/broker.js'
import { QUEUE_INSPECT, QUEUE_PARSE, QUEUE_RESULTS, type InspectTask, type ParseTask } from '../src/queue/contracts.js'
import { MemoryFlags } from '../src/queue/flags.js'
import { start } from '../src/server.js'

export const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082', 'hex')

export class FakeMl implements MlClient {
  evaluated: unknown[] = []
  async renderPage(): Promise<Buffer> { return PNG }
  async llmCheck() { return { reachable: true, message: 'ok', model: 'test-model' } }
  async evaluate(body: unknown) { this.evaluated.push(body); return { passed: false, echo: true } }
  async validateRule(expression: string) {
    return expression.includes('!!') ? { ok: false, error: 'не разобрано выражение' } : { ok: true }
  }
}

export interface Stand {
  app: FastifyInstance
  ctx: Context
  broker: MemoryBroker
  flags: MemoryFlags
  ml: FakeMl
  logs: string[]
  clock: { now: Date }
  close: () => Promise<void>
  login: (login?: string, password?: string) => Promise<string>
  as: (role: string) => Promise<string>
  call: (method: string, url: string, token: string | null, body?: unknown,
    headers?: Record<string, string>) => Promise<LightMyRequestResponse>
}

export async function stand(options: { scan?: Context['scan']; send?: Context['send'] } = {}): Promise<Stand> {
  const dir = mkdtempSync(path.join(tmpdir(), 'inspector-test-'))
  const logs: string[] = []
  const clock = { now: new Date('2026-09-01T09:00:00Z') }
  const config = loadConfig({ env: 'test', dataDir: path.join(dir, 'data'), dbPath: path.join(dir, 'data/db.sqlite'),
    storageDir: path.join(dir, 'data/storage'), dbKey: 'test-db-key', storageKey: 'test-storage-key',
    internalToken: 'internal-test-token', logLevel: 'debug', backupDir: '', cookieSecure: false })
  const broker = new MemoryBroker()
  const flags = new MemoryFlags()
  const ml = new FakeMl()
  const running = await start(config, {
    broker, flags, ml, log: new Logger('debug', false, '', (line) => logs.push(line)),
    scan: options.scan ?? (async () => ({ status: CLEAN, detail: '' })),
    send: options.send ?? (async () => new Response('{}', { status: 200 })),
    now: () => clock.now,
  }, false)
  const call: Stand['call'] = async (method, url, token, body, headers = {}) => running.app.inject({
    method: method as 'GET', url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : typeof body === 'string' || Buffer.isBuffer(body) ? { payload: body } : { payload: body as object }),
  })
  const login = async (name = 'admin', password = 'admin') => {
    const response = await call('POST', '/api/v1/auth/login', null, { login: name, password })
    if (response.statusCode !== 200) throw new Error(`вход не выполнен: ${response.body}`)
    return response.json().token as string
  }
  const tokens = new Map<string, string>()
  const as = async (role: string) => {
    if (role === 'admin') return login()
    const cached = tokens.get(role)
    if (cached) return cached
    const admin = await login()
    const name = `user-${role}`
    await call('POST', '/api/v1/admin/users', admin, { login: name, password: 'password-123', role,
      full_name: `Тест ${role}` })
    const token = await login(name, 'password-123')
    tokens.set(role, token)
    return token
  }
  return { app: running.app, ctx: running.ctx, broker, flags, ml, logs, clock, call, login, as,
    close: async () => { await running.stop(); rmSync(dir, { recursive: true, force: true }) } }
}

export async function pdf(lines: string[] = ['Test page'], pages = 1): Promise<Buffer> {
  const document = await PDFDocument.create()
  document.registerFontkit(fontkit)
  // Шрифт с кириллицей: тексты тестовых листов — на русском, как в реальных томах.
  const font = await document.embedFont(readFileSync('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'))
  for (let index = 0; index < pages; index += 1) {
    const page = document.addPage()
    lines.forEach((line, row) => page.drawText(`${line} ${index + 1}`, { x: 50, y: 750 - row * 20, size: 12, font }))
  }
  return Buffer.from(await document.save())
}

/** Тело multipart/form-data для inject. */
export function multipart(parts: { name: string; filename?: string; data: Buffer | string }[]) {
  const boundary = `----inspector${Math.random().toString(16).slice(2)}`
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"` +
      `${part.filename ? `; filename="${part.filename}"` : ''}\r\n` +
      `${part.filename ? 'Content-Type: application/octet-stream\r\n' : ''}\r\n`))
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

/** Ответить на задачи разбора так, как ответил бы ML-воркер. */
export async function answerParse(s: Stand, fail: (task: ParseTask) => string | null = () => null): Promise<ParseTask[]> {
  const tasks = s.broker.take(QUEUE_PARSE) as ParseTask[]
  for (const task of tasks) {
    const error = fail(task)
    await s.broker.publish(QUEUE_RESULTS, error
      ? { task_id: task.task_id, kind: 'parse', status: 'error', error, permanent: false }
      : { task_id: task.task_id, kind: 'parse', status: 'ok', payload: { pages: 3, discipline_code: 'АР',
        classification_source: 'test', ocr_quality: { low_quality_pages: [] } } })
  }
  await s.broker.drain(QUEUE_RESULTS)
  return tasks
}

export function check(code: string, status: string | null, extra: Record<string, unknown> = {}) {
  const evidence = status === 'CANDIDATE' || status === 'NEGATIVE_VERIFIED' ? [
    { stage: 'PD', document_id: extra.pd ?? 1, file_id: 'F-PD', sha256: 'a'.repeat(64), page: 2,
      bbox: [0.1, 0.1, 0.3, 0.2], quote: 'проект' },
    { stage: 'RD', document_id: extra.rd ?? 2, file_id: 'F-RD', sha256: 'b'.repeat(64), page: 4,
      bbox: [0.2, 0.2, 0.4, 0.3], quote: 'рабочая' },
  ] : []
  return { finding_id: `${code}:matrix`, parameter_code: code, parameter_name: `Параметр ${code}`, priority: 'HIGH',
    section: 'ПЗ', completeness_status: status ? 'COMPLETE' : 'MISSING_EVIDENCE', finding_status: status,
    technical_status: 'completed', expected_value: '100', actual_value: status === 'CANDIDATE' ? '120' : '100',
    explanation: 'тест', evidence, review_history: [], ...extra }
}

/** Ответить на задачу проверки результатом с заданными находками. */
export async function answerInspect(s: Stand, checks: Record<string, unknown>[],
  freeItems: Record<string, unknown>[] = []): Promise<InspectTask[]> {
  const tasks = s.broker.take(QUEUE_INSPECT) as InspectTask[]
  for (const task of tasks) {
    const selected: Record<string, number[]> = {}
    for (const document of task.documents) {
      const stage = String(document.metadata.stage ?? '')
      if (stage) (selected[stage] ??= []).push(document.id)
    }
    await s.broker.publish(QUEUE_RESULTS, { task_id: task.task_id, kind: 'inspect', status: 'ok', payload: {
      model_version: 'test-model', result: { matrix_version: task.matrix_version, object_id: task.object_id, checks,
        coverage: { total: checks.length, completed: checks.length, not_run: 0 },
        document_selection: { selected, problems: {} },
        graphic_analysis: { status: 'not_run', reason: '', candidates: [], performance: {} },
        free_search: { status: 'completed', reason: '', items: freeItems } } } })
  }
  await s.broker.drain(QUEUE_RESULTS)
  return tasks
}

export function registry(rows: Record<string, string>[], files: Record<string, Buffer>): Buffer {
  return Buffer.from(JSON.stringify(rows.map((row) => ({
    approval_date: '', sheet_page_range: 'ALL', predecessor_id: '', successor_id: '',
    signature_status: 'PRESENT', ...row,
    sha256: createHash('sha256').update(files[row.file_name]).digest('hex'),
  }))))
}
