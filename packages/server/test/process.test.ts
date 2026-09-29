/**
 * Сквозной сценарий внешнего контракта (ТЗ 1.4, 9.1–9.3, 9.6): загрузка с
 * реестром → process_id → разбор и проверка через очередь → решения →
 * финализация → передача в ИАИС «РиН».
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { QUEUE_INSPECT, QUEUE_PARSE, type InspectTask } from '../src/queue/contracts.js'
import { answerInspect, answerParse, check, multipart, pdf, registry, stand, type Stand } from './helpers.js'

let s: Stand
beforeEach(async () => { s = await stand() })
afterEach(async () => { await s.close() })

function rows(object = 'OBJ-1', suffix = '') {
  return [
    { file_id: `PD-1${suffix}`, file_name: 'pd.pdf', object_id: object, doc_stage: 'PD', discipline: 'АР',
      document_code: 'X-PD', revision: '1', approval_status: 'APPROVED', approval_date: '2026-01-10' },
    { file_id: `RD-1${suffix}`, file_name: 'rd.pdf', object_id: object, doc_stage: 'RD', discipline: 'АР',
      document_code: 'X-RD', revision: '2', approval_status: 'FOR_CONSTRUCTION', approval_date: '2026-02-10' },
  ]
}

async function uploadPackage(token: string, extra: { name: string; filename?: string; data: Buffer | string }[] = [],
  registryRows = rows()) {
  const pd = await pdf(['PD'])
  const rd = await pdf(['RD'])
  const body = multipart([
    { name: 'files', filename: 'pd.pdf', data: pd },
    { name: 'files', filename: 'rd.pdf', data: rd },
    { name: 'registry', filename: 'registry.json', data: registry(registryRows, { 'pd.pdf': pd, 'rd.pdf': rd }) },
    ...extra,
  ])
  return s.call('POST', '/api/v1/documents/upload', token, body.payload, body.headers)
}

describe('внешний контракт /api/v1', () => {
  it('загрузка с реестром возвращает process_id, статус идёт PARSING → READY', async () => {
    const token = await s.as('service')
    const response = await uploadPackage(token)
    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.process_id).toBeGreaterThan(0)
    expect(body.status).toBe('PARSING')
    expect(body.accepted).toHaveLength(2)
    expect(body.scenario).toBe('PD_RD_ONLY')
    expect(body.upload_status).toEqual({ PD: 'PD_UPLOADED', RD: 'RD_UPLOADED', ID: 'ID_MISSING' })

    const parse = await answerParse(s)
    expect(parse).toHaveLength(2)
    expect(parse[0].document.sha256).toMatch(/^[0-9a-f]{64}$/)
    const [task] = s.broker.queues.get(QUEUE_INSPECT) as InspectTask[]
    expect(task.parameters).toHaveLength(132)
    expect(task.documents.map((item) => item.metadata.stage).sort()).toEqual(['PD', 'RD'])

    await answerInspect(s, [check('M-001', 'CANDIDATE'), check('M-002', 'NEGATIVE_VERIFIED'), check('M-003', null)])
    const status = await s.call('GET', `/api/v1/processes/${body.process_id}/status`, token)
    expect(status.json()).toMatchObject({ status: 'READY', verification_status: 'PENDING', protocol_version: 1 })
    const full = (await s.call('GET', `/api/v1/processes/${body.process_id}`, token)).json()
    expect(full.protocol.tables.candidates).toHaveLength(1)
    expect(full.protocol.tables.negative_verified).toHaveLength(1)
    expect(full.protocol.missing_evidence).toEqual(['M-003:matrix'])
    const card = full.protocol.tables.candidates[0]
    expect(card.sources[0]).toMatchObject({ stage: 'PD', page: 2, bbox_polygon: [0.1, 0.1, 0.3, 0.2] })

    // Таблицы ТЗ 10: Protocols, Checks, Evidence_Fragments заполнены.
    const count = (table: string) => (s.ctx.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
    expect(count('protocols')).toBe(1)
    expect(count('checks')).toBe(3)
    expect(count('evidence_fragments')).toBe(4)
    // Уведомление инспектору о готовности протокола (ТЗ 9.2, п.5).
    const notes = (await s.call('GET', '/api/v1/notifications', await s.as('inspector'))).json()
    expect(notes[0].kind).toBe('protocol_ready')
  })

  it('без реестра пакет принят, каждый параметр — CLARIFICATION_REQUIRED', async () => {
    const token = await s.as('inspector')
    const body = multipart([{ name: 'files', filename: 'a.pdf', data: await pdf() }])
    const response = await s.call('POST', '/api/v1/documents/upload', token, body.payload, body.headers)
    expect(response.statusCode).toBe(200)
    const full = (await s.call('GET', `/api/v1/processes/${response.json().process_id}`, token)).json()
    expect(full.result.checks).toHaveLength(132)
    expect(new Set(full.result.checks.map((item: { completeness_status: string }) => item.completeness_status)))
      .toEqual(new Set(['CLARIFICATION_REQUIRED']))
  })

  it('отклоняет неподдерживаемый и повреждённый файл с причиной', async () => {
    const token = await s.as('inspector')
    const body = multipart([
      { name: 'files', filename: 'pd.pdf', data: await pdf() },
      { name: 'files', filename: 'bad.pdf', data: Buffer.from('%PDF-1.7\nсломано') },
      { name: 'files', filename: 'x.exe', data: Buffer.from('MZ\x90\x00') },
    ])
    const response = await s.call('POST', '/api/v1/documents/upload', token, body.payload, body.headers)
    const rejected = response.json().rejected as { file_name: string; reason: string }[]
    expect(rejected.find((item) => item.file_name === 'bad.pdf')?.reason).toMatch(/повреждённый PDF/)
    expect(rejected.find((item) => item.file_name === 'x.exe')?.reason).toMatch(/PDF, DOCX, XML/)
  })

  it('запрещает перезапись file_id другим содержимым и связывает редакции', async () => {
    const token = await s.as('inspector')
    await uploadPackage(token)
    const otherPdf = await pdf(['другое содержимое'])
    const other = multipart([
      { name: 'files', filename: 'pd.pdf', data: otherPdf },
      { name: 'registry', filename: 'r.json', data: registry([rows()[0]], { 'pd.pdf': otherPdf }) },
    ])
    const response = await s.call('POST', '/api/v1/documents/upload', token, other.payload, other.headers)
    expect(response.statusCode).toBe(422)
    expect(JSON.stringify(response.json())).toMatch(/перезапись запрещена/)

    const nextPdf = await pdf(['новая редакция'])
    const next = multipart([
      { name: 'files', filename: 'pd2.pdf', data: nextPdf },
      { name: 'registry', filename: 'r.json', data: registry([{ ...rows()[0], file_id: 'PD-2', file_name: 'pd2.pdf',
        revision: '2', predecessor_id: 'PD-1' }], { 'pd2.pdf': nextPdf }) },
    ])
    const linked = await s.call('POST', '/api/v1/documents/upload', token, next.payload, next.headers)
    expect(linked.statusCode).toBe(200)
    const newer = s.ctx.db.prepare("SELECT id, predecessor_id FROM files WHERE file_id = 'PD-2'").get() as
      { id: number; predecessor_id: number }
    const older = s.ctx.db.prepare("SELECT id, successor_id FROM files WHERE file_id = 'PD-1'").get() as
      { id: number; successor_id: number }
    expect(newer.predecessor_id).toBe(older.id)
    expect(older.successor_id).toBe(newer.id)
  })

  it('реестр в CSV (с «;») и в XLSX читается', async () => {
    const token = await s.as('inspector')
    const data = await pdf()
    const digest = createHash('sha256').update(data).digest('hex')
    const header = 'file_id;file_name;SHA-256;object_id;doc_stage;discipline;document_code;revision;approval_status;approval_date;sheet_page_range;predecessor_id;successor_id;signature_status'
    const csv = `${header}\nPD-9;pd.pdf;${digest};OBJ-9;PD;АР;C-1;1;APPROVED;2026-01-01;ALL;;;PRESENT\n`
    const body = multipart([{ name: 'files', filename: 'pd.pdf', data },
      { name: 'registry', filename: 'r.csv', data: csv }])
    const response = await s.call('POST', '/api/v1/documents/upload', token, body.payload, body.headers)
    expect(response.statusCode).toBe(200)
    expect(response.json().accepted[0].stage).toBe('PD')
  })

  it('реестр без обязательных полей и контрольной суммы отклоняется', async () => {
    const token = await s.as('inspector')
    const data = await pdf()
    const body = multipart([{ name: 'files', filename: 'pd.pdf', data },
      { name: 'registry', filename: 'r.json', data: Buffer.from(JSON.stringify([{ file_id: 'PD-9',
        file_name: 'pd.pdf', object_id: 'OBJ-9', doc_stage: 'PD', discipline: 'АР', document_code: 'C-1',
        revision: '1', approval_status: 'APPROVED' }])) }])
    const response = await s.call('POST', '/api/v1/documents/upload', token, body.payload, body.headers)
    expect(response.statusCode).toBe(422)
    expect(response.body).toMatch(/обязательных полей/)
  })

  it('решения: кодированная причина, полные доказательства, версия, финализация и отмена', async () => {
    const inspector = await s.as('inspector')
    const pid = (await uploadPackage(inspector)).json().process_id
    await answerParse(s)
    await answerInspect(s, [check('M-001', 'CANDIDATE'), check('M-002', 'CANDIDATE'), check('M-004', 'CANDIDATE', {
      completeness_status: 'MISSING_EVIDENCE' })])
    const decide = (body: Record<string, unknown>) => s.call('POST', `/api/v1/processes/${pid}/decisions`, inspector, body)

    expect((await decide({ finding_id: 'M-001:matrix', status: 'NEGATIVE_VERIFIED', reason: 'нет', expected_version: 0 }))
      .statusCode).toBe(422)
    expect((await decide({ finding_id: 'M-004:matrix', status: 'CONFIRMED_VIOLATION', reason: 'да', expected_version: 0 }))
      .json().detail).toMatch(/полного комплекта доказательств/)
    expect((await decide({ finding_id: 'M-001:matrix', status: 'CANDIDATE', reason: 'оставить', expected_version: 0 }))
      .statusCode).toBe(422)
    const first = await decide({ finding_id: 'M-001:matrix', status: 'CONFIRMED_VIOLATION', reason: 'подтверждаю',
      expected_version: 0 })
    expect(first.json()).toMatchObject({ status: 'VERIFYING', version: 1 })
    expect((await decide({ finding_id: 'M-002:matrix', status: 'NEGATIVE_VERIFIED', reason: 'согласовано',
      reason_code: 'APPROVED_CHANGE', expected_version: 0 })).statusCode).toBe(409) // устаревшая версия
    await decide({ finding_id: 'M-002:matrix', status: 'NEGATIVE_VERIFIED', reason: 'согласовано',
      reason_code: 'APPROVED_CHANGE', expected_version: 1 })

    expect((await s.call('POST', `/api/v1/processes/${pid}/finalize`, inspector, {})).json().detail)
      .toMatch(/кандидаты без решения/)
    await decide({ finding_id: 'M-004:matrix', status: 'CLARIFICATION_REQUIRED', reason: 'нужен документ',
      expected_version: 2 })
    const finalized = await s.call('POST', `/api/v1/processes/${pid}/finalize`, inspector, {})
    expect(finalized.json()).toMatchObject({ status: 'FINALIZED', verification_status: 'PROTOCOL_FINALIZED' })

    // Разметка GOLD, лог отклонений и спорных случаев (ТЗ 9.4).
    const labels = s.ctx.db.prepare('SELECT gold_label FROM dataset_items ORDER BY id').all()
    expect(labels).toEqual([{ gold_label: 'POSITIVE' }, { gold_label: 'NEGATIVE' }])
    expect((s.ctx.db.prepare('SELECT count(*) AS n FROM rejection_log').get() as { n: number }).n).toBe(1)
    expect((s.ctx.db.prepare('SELECT count(*) AS n FROM dispute_log').get() as { n: number }).n).toBe(1)

    // После финализации решения и дозагрузка закрыты; отмена — только супервизор.
    expect((await decide({ finding_id: 'M-001:matrix', status: 'NEGATIVE_VERIFIED', reason: 'x',
      reason_code: 'OTHER', expected_version: 3 })).statusCode).toBe(409)
    expect((await s.call('POST', `/api/v1/processes/${pid}/unfinalize`, inspector, { reason: 'ошибка' })).statusCode).toBe(403)
    const supervisor = await s.as('supervisor')
    const back = await s.call('POST', `/api/v1/processes/${pid}/unfinalize`, supervisor, { reason: 'ошибка в реестре' })
    expect(back.json().status).toBe('COMPLETED')
    const events = (await s.call('GET', `/api/v1/processes/${pid}/events`, inspector)).json()
    expect(events.map((item: { action: string }) => item.action)).toEqual(['FINALIZE', 'UNFINALIZE'])
  })

  it('выгрузка протокола: JSON, XML, DOCX, PDF, CSV', async () => {
    const inspector = await s.as('inspector')
    const pid = (await uploadPackage(inspector)).json().process_id
    await answerParse(s)
    await answerInspect(s, [check('M-001', 'CANDIDATE')])
    for (const [format, marker] of [['json', '{'], ['xml', '<?xml'], ['docx', 'PK'], ['pdf', '%PDF'], ['csv', '﻿']]) {
      const response = await s.call('GET', `/api/v1/processes/${pid}/export?format=${format}`, inspector)
      expect(response.statusCode, format).toBe(200)
      expect(response.rawPayload.toString('utf8').startsWith(marker), format).toBe(true)
    }
    const xml = (await s.call('GET', `/api/v1/processes/${pid}/export?format=xml`, inspector)).body
    expect(xml).toContain('<candidates>')
    expect(xml).toContain('input_manifest_hash=')
  })

  it('дозагрузка: новая версия протокола, прежняя сохраняется; после финализации — только уведомление', async () => {
    const inspector = await s.as('inspector')
    const pid = (await uploadPackage(inspector)).json().process_id
    await answerParse(s)
    await answerInspect(s, [check('M-001', 'NEGATIVE_VERIFIED')])
    const idPdf = await pdf(['ИД'])
    const more = multipart([
      { name: 'files', filename: 'id.pdf', data: idPdf },
      { name: 'registry', filename: 'r.json', data: registry([{ file_id: 'ID-1', file_name: 'id.pdf',
        object_id: 'OBJ-1', doc_stage: 'ID', discipline: 'АР', document_code: 'X-ID', revision: '1',
        approval_status: 'APPROVED', approval_date: '2026-03-01' }], { 'id.pdf': idPdf }) },
      { name: 'process_id', data: String(pid) },
    ])
    const reload = await s.call('POST', '/api/v1/documents/upload', inspector, more.payload, more.headers)
    expect(reload.json()).toMatchObject({ process_id: pid, scenario: 'FULL' })
    await answerParse(s)
    const [task] = await answerInspect(s, [check('M-001', 'NEGATIVE_VERIFIED')])
    expect(task.previous?.version).toBe(1) // инкрементальный пересчёт получает прежнюю версию
    const status = (await s.call('GET', `/api/v1/processes/${pid}/status`, inspector)).json()
    expect(status.protocol_version).toBe(2)
    await s.call('POST', `/api/v1/processes/${pid}/finalize`, inspector, {})
    const late = multipart([{ name: 'files', filename: 'late.pdf', data: await pdf(['поздний']) },
      { name: 'process_id', data: String(pid) }])
    const after = await s.call('POST', '/api/v1/documents/upload', inspector, late.payload, late.headers)
    expect(after.json().notice).toMatch(/проверка не запускалась/)
    expect(s.broker.queues.get(QUEUE_PARSE)?.length).toBe(1) // файл разбирается, но проверка не запускается
    expect(s.broker.queues.get(QUEUE_INSPECT) ?? []).toHaveLength(0)
  })

  it('передача в РиН: только финализированный протокол, PENDING_SYNC и повторы 1/5/15 мин', async () => {
    let calls = 0
    await s.close()
    s = await (await import('./helpers.js')).stand({ send: async () => {
      calls += 1
      return new Response('temporary', { status: 503 })
    } })
    s.ctx.config.rinUrl = 'https://rin-gateway:8443/receive'
    const inspector = await s.as('inspector')
    const pid = (await uploadPackage(inspector)).json().process_id
    await answerParse(s)
    await answerInspect(s, [check('M-001', 'CANDIDATE')])
    expect((await s.call('POST', `/api/v1/inspection/${pid}`, inspector)).statusCode).toBe(409)
    await s.call('POST', `/api/v1/processes/${pid}/decisions`, inspector, { finding_id: 'M-001:matrix',
      status: 'CONFIRMED_VIOLATION', reason: 'да', expected_version: 0 })
    await s.call('POST', `/api/v1/processes/${pid}/finalize`, inspector, {})
    const sent = await s.call('POST', `/api/v1/inspection/${pid}`, inspector)
    expect(sent.json()).toMatchObject({ sync_status: 'PENDING_SYNC', sync_attempts: 1 })
    expect(sent.json().confirmed_violations).toHaveLength(1)
    expect(sent.json().input_files.map((item: { file_id: string }) => item.file_id).sort()).toEqual(['PD-1', 'RD-1'])
    const { retryDue } = await import('../src/domain/rin.js')
    for (const minutes of [1, 5, 15]) {
      s.clock.now = new Date(s.clock.now.getTime() + minutes * 60_000 + 1000)
      await retryDue(s.ctx)
    }
    const status = (await s.call('GET', `/api/v1/processes/${pid}/status`, inspector)).json()
    expect(status.sync_status).toBe('SEND_FAILED')
    expect(calls).toBe(4)
    // Сбой передачи не меняет решение инспектора.
    expect(status.status).toBe('FINALIZED')
  })

  it('адрес РиН вне контура отклоняется до отправки', async () => {
    const { isLocalUrl } = await import('../src/domain/rin.js')
    expect(isLocalUrl('http://rin-gateway:8443/x', [])).toBe(false)
    expect(isLocalUrl('https://10.1.2.3/x', [])).toBe(true)
    expect(isLocalUrl('https://example.com/x', [])).toBe(false)
    expect(isLocalUrl('https://gateway.city.local/x', ['gateway.city.local'])).toBe(true)
  })

  it('таймаут обработки файла: два повтора, затем ошибка и уведомление администратора', async () => {
    const inspector = await s.as('inspector')
    await uploadPackage(inspector)
    const { checkTimeouts } = await import('../src/domain/pipeline.js')
    for (let attempt = 0; attempt < 3; attempt += 1) {
      s.broker.take(QUEUE_PARSE)
      s.clock.now = new Date(s.clock.now.getTime() + (s.ctx.config.taskTimeoutS + 1) * 1000)
      await checkTimeouts(s.ctx)
    }
    const files = s.ctx.db.prepare('SELECT status, parse_error FROM files').all() as { status: string; parse_error: string }[]
    expect(files.every((file) => file.status === 'ERROR')).toBe(true)
    expect(files[0].parse_error).toMatch(/после 3 попыток/)
    const notes = (await s.call('GET', '/api/v1/notifications', await s.login())).json()
    expect(notes.some((item: { kind: string }) => item.kind === 'processing_failed')).toBe(true)
    const proc = (await s.call('GET', '/api/v1/processes', inspector)).json()[0]
    expect(proc.status).toBe('ERROR')
  })

  it('остановка проверки ставит флаг в Redis для ML-воркера', async () => {
    const inspector = await s.as('inspector')
    const pid = (await uploadPackage(inspector)).json().process_id
    await answerParse(s)
    const response = await s.call('POST', `/api/v1/processes/${pid}/cancel`, inspector)
    expect(response.json().stage).toMatch(/Остановка/)
    expect(s.flags.values.has(`inspector:cancel:${pid}`)).toBe(true)
  })
})
