/**
 * Протокол по ТЗ: сценарии загрузки, статусы процесса, пять таблиц, версии
 * (ТЗ 9.2, п.4; 9.3) и гипотезы свободного поиска (ТЗ 9.5): гипотеза — не
 * нарушение, в кандидаты — только с координатами, нарушение — решением
 * инспектора.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as protocol from '../src/domain/protocol.js'
import { answerInspect, answerParse, check, multipart, pdf, registry, stand, type Stand } from './helpers.js'

const SNAPSHOT: protocol.SnapshotItem[] = [
  { id: 1, digest: 'a', metadata: { stage: 'PD', document_code: 'C-PD', revision: '1', approval_status: 'APPROVED' } },
  { id: 2, digest: 'b', metadata: { stage: 'RD', document_code: 'C-RD', revision: '1', approval_status: 'APPROVED' } },
]

function result(checks: Record<string, unknown>[]) {
  return { matrix_version: '1.1', checks, coverage: { total: checks.length, completed: checks.length, not_run: 0 },
    graphic_analysis: { status: 'not_run', candidates: [] },
    document_selection: { selected: { PD: [1], RD: [2] }, problems: {} } }
}

describe('правила протокола', () => {
  it('сценарии загрузки по ТЗ', () => {
    const run = (counts: Record<string, number>, problems: Record<string, string> = {}) =>
      protocol.scenario(protocol.uploadStatuses(counts, problems))
    expect(run({ PD: 1, RD: 1, ID: 1 })).toBe('FULL')
    expect(run({ PD: 1, RD: 2 })).toBe('PD_RD_ONLY')
    expect(run({ PD: 1, ID: 1 })).toBe('PD_ID_ONLY')
    expect(run({ RD: 1, ID: 1 })).toBe('RD_ID_ONLY')
    expect(run({ RD: 1 })).toBe('SINGLE_ONLY')
    expect(run({ PD: 1, RD: 1 }, { RD: 'две редакции' })).toBe('PARTIALLY_LOADED')
    expect(protocol.uploadStatuses({ PD: 1, RD: 1 }, { RD: 'x' }))
      .toEqual({ PD: 'PD_UPLOADED', RD: 'RD_PARTIAL', ID: 'ID_MISSING' })
  })

  it('жизненный цикл статуса процесса', () => {
    const candidate = result([check('M-001', 'CANDIDATE')])
    const decided = result([check('M-001', 'CONFIRMED_VIOLATION')])
    expect(protocol.processStatus('queued', false, null, 0)).toBe('PENDING')
    expect(protocol.processStatus('parsing', false, null, 0)).toBe('PARSING')
    expect(protocol.processStatus('running', false, null, 0)).toBe('PARSING')
    expect(protocol.processStatus('completed', false, candidate, 0)).toBe('READY')
    expect(protocol.processStatus('completed', false, candidate, 1)).toBe('VERIFYING')
    expect(protocol.processStatus('completed', false, decided, 1)).toBe('COMPLETED')
    expect(protocol.processStatus('completed', true, decided, 1)).toBe('FINALIZED')
    expect(protocol.processStatus('error', false, null, 0)).toBe('ERROR')
    expect(protocol.canUpload('FINALIZED') || protocol.canUpload('PARSING')).toBe(false)
    expect(protocol.canVerify('READY')).toBe(true)
    expect(protocol.canVerify('COMPLETED')).toBe(false)
  })

  it('пять таблиц, карточки источников и версии', () => {
    const checks = [check('M-001', 'CANDIDATE'), check('M-002', 'NEGATIVE_VERIFIED'), check('M-003', null),
      { ...check('M-004', 'SUSPICION'), finding_id: 'graphic:1', parameter_code: 'GRAPHIC' }]
    const built = protocol.build(result(checks), SNAPSHOT,
      { runState: 'completed', finalized: false, decisions: 0, modelVersion: 'm', datasetVersion: 'd' })
    expect(Object.keys(built.tables).sort())
      .toEqual(['candidates', 'completeness', 'confirmed_violations', 'negative_verified', 'suspicions'])
    expect(built.tables.candidates.map((card: { finding_id: string }) => card.finding_id)).toEqual(['M-001:matrix'])
    expect(built.tables.suspicions.map((card: { finding_id: string }) => card.finding_id)).toEqual(['graphic:1'])
    const source = built.tables.candidates[0].sources[0]
    expect(source).toMatchObject({ document_code: 'C-PD', revision: '1', approval_status: 'APPROVED' })
    expect(built.missing_evidence).toEqual(['M-003:matrix'])
    expect(built.scenario).toBe('PD_RD_ONLY')
    expect(built.versions).toMatchObject({ model_version: 'm', matrix_version: '1.1' })
    expect(built.versions.input_manifest_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('гипотеза свободного поиска — не нарушение', () => {
    const body = { ...result([]), free_search: { status: 'completed', items: [
      { suspicion_id: 5, discovery_method: 'LOGICAL_RULE', finding_status: 'SUSPICION', evidence: [] }] } }
    const built = protocol.build(body, [], { runState: 'completed', finalized: false, decisions: 0,
      modelVersion: 'm', datasetVersion: 'd' })
    expect(built.tables.suspicions).toHaveLength(1)
    expect(built.pending_candidates).toEqual([])
    expect(built.status).toBe('COMPLETED')
  })
})

describe('техническая ошибка не финализируется как «нарушений нет»', () => {
  let s: Stand
  beforeEach(async () => { s = await stand() })
  afterEach(async () => { await s.close() })

  async function run(checks: Record<string, unknown>[]) {
    const token = await s.as('inspector')
    const pd = await pdf(['PD'])
    const rd = await pdf(['RD'])
    const body = multipart([
      { name: 'files', filename: 'pd.pdf', data: pd },
      { name: 'files', filename: 'rd.pdf', data: rd },
      { name: 'registry', filename: 'r.json', data: registry([
        { file_id: 'PD-Z', file_name: 'pd.pdf', object_id: 'OBJ-Z', doc_stage: 'PD', discipline: 'АР',
          document_code: 'Z-PD', revision: '1', approval_status: 'APPROVED', approval_date: '2026-01-10' },
        { file_id: 'RD-Z', file_name: 'rd.pdf', object_id: 'OBJ-Z', doc_stage: 'RD', discipline: 'АР',
          document_code: 'Z-RD', revision: '1', approval_status: 'APPROVED', approval_date: '2026-01-11' }],
      { 'pd.pdf': pd, 'rd.pdf': rd }) },
    ])
    const processId = (await s.call('POST', '/api/v1/documents/upload', token, body.payload, body.headers))
      .json().process_id
    await answerParse(s)
    await answerInspect(s, checks)
    return s.call('POST', `/api/v1/processes/${processId}/finalize`, token, {})
  }

  it('ни один параметр не проверен из-за сбоя модели — финализация запрещена', async () => {
    const failed = (code: string) => ({ ...check(code, null), completeness_status: 'NOT_COMPARABLE',
      technical_status: 'error', explanation: 'ответ модели не разобран' })
    const response = await run([failed('M-001'), failed('M-002')])
    expect(response.statusCode).toBe(409)
    expect(response.body).toMatch(/не проверен ни один параметр/)
  })

  it('всё требует уточнения из-за входных данных — финализация разрешена', async () => {
    const unclear = (code: string) => ({ ...check(code, null), completeness_status: 'CLARIFICATION_REQUIRED',
      technical_status: 'not_run', explanation: 'нет реестра' })
    expect((await run([unclear('M-001'), unclear('M-002')])).statusCode).toBe(200)
  })
})

describe('составной кандидат делится на атомарные findings (ТЗ 9.3, п.2)', () => {
  let s: Stand
  beforeEach(async () => { s = await stand() })
  afterEach(async () => { await s.close() })

  it('каждая часть получает собственное решение и доказательства', async () => {
    const token = await s.as('inspector')
    const pd = await pdf(['PD'])
    const rd = await pdf(['RD'])
    const body = multipart([
      { name: 'files', filename: 'pd.pdf', data: pd },
      { name: 'files', filename: 'rd.pdf', data: rd },
      { name: 'registry', filename: 'r.json', data: registry([
        { file_id: 'PD-A', file_name: 'pd.pdf', object_id: 'OBJ-A', doc_stage: 'PD', discipline: 'АР',
          document_code: 'A-PD', revision: '1', approval_status: 'APPROVED', approval_date: '2026-01-10' },
        { file_id: 'RD-A', file_name: 'rd.pdf', object_id: 'OBJ-A', doc_stage: 'RD', discipline: 'АР',
          document_code: 'A-RD', revision: '1', approval_status: 'APPROVED', approval_date: '2026-01-11' }],
      { 'pd.pdf': pd, 'rd.pdf': rd }) },
    ])
    const processId = (await s.call('POST', '/api/v1/documents/upload', token, body.payload, body.headers))
      .json().process_id
    await answerParse(s)
    await answerInspect(s, [check('M-001', 'CANDIDATE')])
    const url = `/api/v1/processes/${processId}/findings/${encodeURIComponent('M-001:matrix')}/split`
    const part = (expected: string, actual: string, evidence = [0, 1]) =>
      ({ expected_value: expected, actual_value: actual, evidence_indexes: evidence })

    const single = await s.call('POST', url, token, { reason: 'два расхождения', expected_version: 0,
      parts: [part('100', '120')] })
    expect(single.statusCode).toBe(422)
    const oneSide = await s.call('POST', url, token, { reason: 'два расхождения', expected_version: 0,
      parts: [part('100', '120'), part('50', '40', [0])] })
    expect(oneSide.statusCode).toBe(422)
    const split = await s.call('POST', url, token, { reason: 'два расхождения в одной находке',
      expected_version: 0, parts: [part('100', '120'), part('50', '40')] })
    expect(split.statusCode, split.body).toBe(200)
    const checks = split.json().result.checks
    expect(checks.map((item: { finding_id: string }) => item.finding_id))
      .toEqual(['M-001:matrix/1', 'M-001:matrix/2'])
    expect(checks[1]).toMatchObject({ split_from: 'M-001:matrix', expected_value: '50', actual_value: '40',
      finding_status: 'CANDIDATE' })
    expect(checks[1].evidence).toHaveLength(2)
    expect((await s.call('POST', url, token, { reason: 'ещё раз', expected_version: 0,
      parts: [part('1', '2'), part('3', '4')] })).statusCode).toBe(409)

    const decide = (findingId: string, status: string, extra: Record<string, unknown> = {}) =>
      s.call('POST', `/api/v1/processes/${processId}/decisions`, token,
        { finding_id: findingId, status, reason: 'проверено', expected_version: 0, ...extra })
    let finalize = await s.call('POST', `/api/v1/processes/${processId}/finalize`, token, {})
    expect(finalize.statusCode).toBe(409)
    expect(finalize.json().detail ?? finalize.body).toMatch(/M-001:matrix\/1.*M-001:matrix\/2/)
    expect((await decide('M-001:matrix/1', 'CONFIRMED_VIOLATION')).statusCode).toBe(200)
    expect((await decide('M-001:matrix/2', 'NEGATIVE_VERIFIED', { reason_code: 'OCR_ERROR',
      expected_version: 1 })).statusCode).toBe(200)
    finalize = await s.call('POST', `/api/v1/processes/${processId}/finalize`, token, {})
    expect(finalize.statusCode, finalize.body).toBe(200)
    const tables = finalize.json().protocol.tables
    expect(tables.confirmed_violations.map((item: { finding_id: string }) => item.finding_id))
      .toEqual(['M-001:matrix/1'])
    expect(tables.negative_verified.map((item: { finding_id: string }) => item.finding_id))
      .toEqual(['M-001:matrix/2'])
  })
})

describe('решения по гипотезам (ТЗ 9.5)', () => {
  let s: Stand
  beforeEach(async () => { s = await stand() })
  afterEach(async () => { await s.close() })

  it('в кандидаты — только с координатами, нарушение — решением инспектора', async () => {
    const token = await s.as('inspector')
    const pd = await pdf(['PD'])
    const rd = await pdf(['RD'])
    const body = multipart([
      { name: 'files', filename: 'pd.pdf', data: pd },
      { name: 'files', filename: 'rd.pdf', data: rd },
      { name: 'registry', filename: 'r.json', data: registry([
        { file_id: 'PD-S', file_name: 'pd.pdf', object_id: 'OBJ-S', doc_stage: 'PD', discipline: 'АР',
          document_code: 'S-PD', revision: '1', approval_status: 'APPROVED', approval_date: '2026-01-10' },
        { file_id: 'RD-S', file_name: 'rd.pdf', object_id: 'OBJ-S', doc_stage: 'RD', discipline: 'АР',
          document_code: 'S-RD', revision: '1', approval_status: 'APPROVED', approval_date: '2026-01-11' }],
      { 'pd.pdf': pd, 'rd.pdf': rd }) },
    ])
    const processId = (await s.call('POST', '/api/v1/documents/upload', token, body.payload, body.headers))
      .json().process_id
    await answerParse(s)
    const coordinates = check('M-001', 'CANDIDATE').evidence
    await answerInspect(s, [check('M-001', 'NEGATIVE_VERIFIED')], [
      { discovery_method: 'LOGICAL_RULE', confidence: 0.7, description: 'Если A, то B', pd_reference: 'S-PD',
        rd_reference: 'S-RD', review_priority: 'HIGH', normative_base: '', parameter_code: 'M-001',
        evidence: coordinates }])
    const items = (await s.call('GET', `/api/v1/processes/${processId}/suspicions`, token)).json()
    expect(items).toHaveLength(1)
    const url = `/api/v1/processes/${processId}/suspicions/${items[0].suspicion_id}`

    const noCoords = await s.call('POST', url, token, { action: 'promote',
      evidence: [{ stage: 'PD', document_id: 1, page: 1, bbox: null }] })
    expect(noCoords.statusCode).toBe(422)
    const promoted = await s.call('POST', url, token, { action: 'promote' })
    expect(promoted.statusCode, promoted.body).toBe(200)
    expect(promoted.json().finding_status).toBe('CANDIDATE')
    let status = (await s.call('GET', `/api/v1/processes/${processId}/status`, token)).json()
    expect(status.status).toBe('READY')
    expect((await s.call('POST', url, token, { action: 'reject', comment: 'нет' })).statusCode).toBe(422)
    const confirmed = await s.call('POST', url, token, { action: 'confirm', comment: 'подтверждаю' })
    expect(confirmed.json().finding_status).toBe('CONFIRMED_VIOLATION')
    expect((await s.call('POST', url, token, { action: 'dismiss', comment: 'x' })).statusCode).toBe(409)
    status = (await s.call('GET', `/api/v1/processes/${processId}/status`, token)).json()
    expect(status.status).toBe('COMPLETED')
  })

  it('дозагрузка не сбрасывает решения по гипотезам (ТЗ 9.3, п.3)', async () => {
    const token = await s.as('inspector')
    const pd = await pdf(['PD'])
    const rd = await pdf(['RD'])
    const first = multipart([
      { name: 'files', filename: 'pd.pdf', data: pd },
      { name: 'files', filename: 'rd.pdf', data: rd },
      { name: 'registry', filename: 'r.json', data: registry([
        { file_id: 'PD-K', file_name: 'pd.pdf', object_id: 'OBJ-K', doc_stage: 'PD', discipline: 'АР',
          document_code: 'K-PD', revision: '1', approval_status: 'APPROVED', approval_date: '2026-01-10' },
        { file_id: 'RD-K', file_name: 'rd.pdf', object_id: 'OBJ-K', doc_stage: 'RD', discipline: 'АР',
          document_code: 'K-RD', revision: '1', approval_status: 'APPROVED', approval_date: '2026-01-11' }],
      { 'pd.pdf': pd, 'rd.pdf': rd }) },
    ])
    const processId = (await s.call('POST', '/api/v1/documents/upload', token, first.payload, first.headers))
      .json().process_id
    await answerParse(s)
    const hypothesis = (description: string) => ({ discovery_method: 'LOGICAL_RULE', confidence: 0.7, description,
      pd_reference: 'K-PD', rd_reference: 'K-RD', review_priority: 'HIGH', normative_base: '',
      parameter_code: 'M-001', evidence: check('M-001', 'CANDIDATE').evidence })
    await answerInspect(s, [check('M-001', 'NEGATIVE_VERIFIED')], [hypothesis('Если A, то B'),
      hypothesis('Если C, то D')])
    const before = (await s.call('GET', `/api/v1/processes/${processId}/suspicions`, token)).json()
    const reviewed = before.find((item: { description: string }) => item.description === 'Если A, то B')
    const promoted = await s.call('POST', `/api/v1/processes/${processId}/suspicions/${reviewed.suspicion_id}`,
      token, { action: 'promote' })
    expect(promoted.statusCode, promoted.body).toBe(200)

    const idPdf = await pdf(['ID'])
    const more = multipart([
      { name: 'files', filename: 'id.pdf', data: idPdf },
      { name: 'registry', filename: 'r.json', data: registry([{ file_id: 'ID-K', file_name: 'id.pdf',
        object_id: 'OBJ-K', doc_stage: 'ID', discipline: 'АР', document_code: 'K-ID', revision: '1',
        approval_status: 'APPROVED', approval_date: '2026-01-12' }], { 'id.pdf': idPdf }) },
      { name: 'process_id', data: String(processId) },
    ])
    expect((await s.call('POST', '/api/v1/documents/upload', token, more.payload, more.headers)).statusCode)
      .toBe(200)
    await answerParse(s)
    await answerInspect(s, [check('M-001', 'NEGATIVE_VERIFIED')], [hypothesis('Если A, то B'),
      hypothesis('Если C, то D'), hypothesis('Если E, то F')])

    const after = (await s.call('GET', `/api/v1/processes/${processId}/suspicions`, token)).json()
    expect(after.map((item: { description: string }) => item.description).sort())
      .toEqual(['Если A, то B', 'Если C, то D', 'Если E, то F'])
    const kept = after.find((item: { description: string }) => item.description === 'Если A, то B')
    expect(kept).toMatchObject({ suspicion_id: reviewed.suspicion_id, finding_status: 'CANDIDATE',
      inspector_status: 'PROMOTED' })
  })

  it('координаты РД и ИД достаточны для сценария RD_ID_ONLY', async () => {
    const { hasCoordinates } = await import('../src/domain/processes.js')
    expect(hasCoordinates([
      { stage: 'RD', document_id: 1, page: 2, bbox: [0.1, 0.1, 0.2, 0.2] },
      { stage: 'ID', document_id: 2, page: 3, bbox: [0.2, 0.2, 0.3, 0.3] },
    ])).toBe(true)
  })
})
