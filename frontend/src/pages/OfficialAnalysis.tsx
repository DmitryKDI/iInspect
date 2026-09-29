import { useEffect, useMemo, useRef, useState } from 'react'
import { can } from '../authApi'
import { Chip, Empty, SectionCard, Skeleton } from '../components/ui'
import { useApp } from '../store'
import { FreeSearchCard } from './FreeSearchCard'
import { SplitFindingForm } from './SplitFindingForm'
import {
  type DecisionStatus,
  findingLabel,
  isActive,
  officialApi,
  REASON_CODES,
  type ApprovalStatus,
  type OfficialCheck,
  type OfficialDocument,
  type OfficialDocumentMetadata,
  type OfficialEvidence,
  type OfficialParameter,
  type OfficialRun,
  type OfficialStage,
  type ProviderCheck,
  type SplitPart,
  type ProviderSettings,
} from '../officialApi'

const STAGES: Array<{ key: OfficialStage; title: string; subtitle: string; side: 'before' | 'after' }> = [
  { key: 'PD', title: 'Проектная документация', subtitle: 'Эталон проектных решений', side: 'before' },
  { key: 'RD', title: 'Рабочая документация', subtitle: 'Детализация проектных решений', side: 'after' },
  { key: 'ID', title: 'Исполнительная документация', subtitle: 'Подтверждение фактического исполнения', side: 'after' },
]

const APPROVALS: Array<{ value: ApprovalStatus; label: string }> = [
  { value: 'DRAFT', label: 'Черновик' },
  { value: 'APPROVED', label: 'Утверждён' },
  { value: 'FOR_CONSTRUCTION', label: 'Для производства работ' },
  { value: 'SUPERSEDED', label: 'Заменён' },
  { value: 'CANCELLED', label: 'Отменён' },
]

type MetadataDraft = Omit<OfficialDocumentMetadata, 'stage' | 'predecessor_id' | 'file_id' | 'discipline'> & {
  predecessor_id: string
  file_id: string
  discipline: string
}

const SYNC_TITLES: Record<string, string> = {
  NOT_SENT: 'не выполнялась',
  LOCAL_ONLY: 'не включена, пакет сформирован локально',
  SENT: 'принято внешней системой',
  PENDING_SYNC: 'внешняя система недоступна, отправка будет повторена',
  SEND_FAILED: 'не выполнена',
  SEND_REFUSED: 'адрес приёма вне контура',
}

function blankMetadata(): MetadataDraft {
  return {
    object_id: '', file_id: '', discipline: '', document_code: '', revision: '', approval_status: 'DRAFT',
    approval_date: null, predecessor_id: '', signature_status: null, sheet_page_range: null,
  }
}

function metadataForStage(stage: OfficialStage, draft: MetadataDraft): OfficialDocumentMetadata {
  return {
    ...draft,
    stage,
    predecessor_id: draft.predecessor_id.trim() ? Number(draft.predecessor_id) : null,
    approval_date: draft.approval_date || null,
    signature_status: draft.signature_status || null,
    sheet_page_range: draft.sheet_page_range || null,
  }
}

function stageLabel(stage: OfficialStage): string {
  return STAGES.find((item) => item.key === stage)?.title ?? stage
}

function statusTone(status: string): 'neutral' | 'accent' | 'warn' {
  if (status === 'completed' || status === 'ok') return 'accent'
  if (status === 'error' || status === 'cancelled' || status === 'not_run') return 'warn'
  return 'neutral'
}

function FileStage({
  stage, documents, onUploaded, onMetadataSaved, onDeleted, busy,
}: {
  stage: (typeof STAGES)[number]
  documents: OfficialDocument[]
  onUploaded: (file: File, metadata: OfficialDocumentMetadata) => Promise<void>
  onMetadataSaved: (id: number, metadata: OfficialDocumentMetadata) => Promise<void>
  onDeleted: (id: number) => Promise<void>
  busy: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<MetadataDraft>(blankMetadata)
  const [saving, setSaving] = useState<number | null>(null)
  const [openEditor, setOpenEditor] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const apply = (key: keyof MetadataDraft, value: string) => setDraft((current) => ({ ...current, [key]: value }))
  const approved = draft.approval_status === 'APPROVED' || draft.approval_status === 'FOR_CONSTRUCTION'
  const valid = Boolean(
    draft.object_id.trim() && draft.file_id.trim() && draft.discipline.trim() && draft.document_code.trim()
    && draft.revision.trim() && draft.signature_status?.trim() && draft.sheet_page_range?.trim()
    && (!approved || draft.approval_date),
  )

  const upload = async (files: FileList | null) => {
    if (!files?.length || !valid) {
      if (!valid) setError('Заполните обязательные поля карточки документа и дату утверждения, когда она нужна.')
      return
    }
    if (files.length > 1) {
      setError('Для каждого файла задаются собственные шифр и редакция. Загружайте файлы по одному.')
      return
    }
    setError(null)
    try {
      for (const file of Array.from(files)) await onUploaded(file, metadataForStage(stage.key, draft))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить файл.')
    }
  }

  const saveExisting = async (document: OfficialDocument) => {
    setSaving(document.id)
    try {
      await onMetadataSaved(document.id, metadataForStage(stage.key, draft))
      setOpenEditor(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось сохранить метаданные.')
    } finally {
      setSaving(null)
    }
  }

  return (
    <SectionCard title={stage.title} subtitle={stage.subtitle}>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-ink-muted">Объект *
          <input className="mt-1 w-full rounded-lg border border-surface-line px-2 py-1.5 text-sm" value={draft.object_id}
            onChange={(event) => apply('object_id', event.target.value)} placeholder="Идентификатор объекта" />
        </label>
        <label className="text-xs text-ink-muted">Идентификатор файла *
          <input className="mt-1 w-full rounded-lg border border-surface-line px-2 py-1.5 text-sm" value={draft.file_id}
            onChange={(event) => apply('file_id', event.target.value)} placeholder="Уникальный file_id" />
        </label>
        <label className="text-xs text-ink-muted">Раздел / марка *
          <input className="mt-1 w-full rounded-lg border border-surface-line px-2 py-1.5 text-sm" value={draft.discipline}
            onChange={(event) => apply('discipline', event.target.value)} placeholder="Например, АР" />
        </label>
        <label className="text-xs text-ink-muted">Шифр документа *
          <input className="mt-1 w-full rounded-lg border border-surface-line px-2 py-1.5 text-sm" value={draft.document_code}
            onChange={(event) => apply('document_code', event.target.value)} placeholder="Шифр" />
        </label>
        <label className="text-xs text-ink-muted">Редакция *
          <input className="mt-1 w-full rounded-lg border border-surface-line px-2 py-1.5 text-sm" value={draft.revision}
            onChange={(event) => apply('revision', event.target.value)} placeholder="Например, 2" />
        </label>
        <label className="text-xs text-ink-muted">Статус утверждения
          <select className="mt-1 w-full rounded-lg border border-surface-line px-2 py-1.5 text-sm" value={draft.approval_status}
            onChange={(event) => apply('approval_status', event.target.value)}>
            {APPROVALS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="text-xs text-ink-muted">Дата утверждения
          <input type="date" className="mt-1 w-full rounded-lg border border-surface-line px-2 py-1.5 text-sm" value={draft.approval_date ?? ''}
            onChange={(event) => apply('approval_date', event.target.value)} />
        </label>
        <label className="text-xs text-ink-muted">Подпись / ЭП *
          <input className="mt-1 w-full rounded-lg border border-surface-line px-2 py-1.5 text-sm" value={draft.signature_status ?? ''}
            onChange={(event) => apply('signature_status', event.target.value)} placeholder="Не задано" />
        </label>
        <label className="text-xs text-ink-muted">Предыдущая редакция
          <select className="mt-1 w-full rounded-lg border border-surface-line px-2 py-1.5 text-sm" value={draft.predecessor_id}
            onChange={(event) => apply('predecessor_id', event.target.value)}>
            <option value="">Нет или не установлена</option>
            {documents.filter((item) => item.id !== openEditor
              && item.metadata.object_id === draft.object_id
              && item.metadata.document_code === draft.document_code)
              .map((item) => <option key={item.id} value={item.id}>{item.metadata.revision} · {item.name}</option>)}
          </select>
        </label>
      </div>
      <label className="mt-2 block text-xs text-ink-muted">Листы или диапазон листов *
        <input className="mt-1 w-full rounded-lg border border-surface-line px-2 py-1.5 text-sm" value={draft.sheet_page_range ?? ''}
          onChange={(event) => apply('sheet_page_range', event.target.value)} placeholder="Не задано" />
      </label>
      <div className="mt-3 rounded-xl border border-dashed border-surface-line bg-surface-muted/50 p-4 text-center">
        <p className="text-sm font-medium text-ink">Перетащите PDF, DOCX или XML либо выберите файл</p>
        <button className="btn-ghost mt-2" type="button" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? 'Загружаю…' : 'Выбрать файл'}
        </button>
        <input ref={input} hidden type="file" accept=".pdf,.docx,.xml" onChange={(event) => {
          void upload(event.target.files)
          event.target.value = ''
        }} />
      </div>
      {error && <p className="mt-2 text-xs text-critical">{error}</p>}
      <div className="mt-3 space-y-2">
        {documents.length === 0 && <p className="text-xs text-ink-faint">Файлы этой стадии пока не загружены.</p>}
        {documents.map((document) => (
          <div key={document.id} className="rounded-lg border border-surface-line bg-surface px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0"><p className="truncate text-sm font-medium text-ink">{document.name}</p>
                <p className="mt-1 text-xs text-ink-faint">{document.pages} л. · {document.metadata.document_code || 'шифр не задан'} · ред. {document.metadata.revision || 'не задана'}</p>
              </div>
              <Chip tone={statusTone(document.status)}>{document.status}</Chip>
            </div>
            <div className="mt-2 flex gap-3"><button className="text-xs text-accent hover:underline" type="button" onClick={() => {
              setDraft({ ...document.metadata, file_id: document.metadata.file_id ?? '',
                discipline: document.metadata.discipline ?? '',
                predecessor_id: document.metadata.predecessor_id?.toString() ?? '' })
              setOpenEditor(openEditor === document.id ? null : document.id)
            }}>Изменить метаданные</button><button className="text-xs text-critical hover:underline" type="button" disabled={busy}
              onClick={() => void onDeleted(document.id)}>Удалить</button></div>
            {openEditor === document.id && <div className="mt-2 flex items-center gap-2 text-xs">
              <span>Изменения применяются к этому документу.</span>
              <button type="button" className="btn-primary px-2 py-1 text-xs" disabled={saving === document.id || !valid}
                onClick={() => void saveExisting(document)}>{saving === document.id ? 'Сохраняю…' : 'Сохранить'}</button>
            </div>}
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

function EvidencePreview({ evidence, onClose }: { evidence: OfficialEvidence[]; onClose: () => void }) {
  const [failedImages, setFailedImages] = useState<string[]>([])
  const order: Record<OfficialStage, number> = { PD: 0, RD: 1, ID: 2 }
  const sources = [...evidence].sort((left, right) => order[left.stage] - order[right.stage])
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4" role="dialog" aria-modal="true" aria-label="Доказательство">
      <div className="max-h-full w-full max-w-[1500px] overflow-auto rounded-xl bg-surface p-4 shadow-card">
        <div className="mb-3 flex items-start justify-between gap-3"><div><h3 className="font-semibold text-ink">Доказательства ПД, РД и ИД</h3>
          <p className="text-xs text-ink-muted">Источники показаны рядом. Рамка отмечает фрагмент, использованный в машинной оценке.</p></div>
          <button className="btn-ghost px-2 py-1 text-xs" onClick={onClose}>Закрыть</button></div>
        <div className="grid gap-4 lg:grid-cols-3">{sources.map((source, index) => {
          const key = `${source.document_id}-${source.page}-${index}`
          const bbox = source.bbox
          const overlay = bbox ? {
            left: `${bbox[0] * 100}%`, top: `${bbox[1] * 100}%`,
            width: `${(bbox[2] - bbox[0]) * 100}%`, height: `${(bbox[3] - bbox[1]) * 100}%`,
          } : undefined
          return <section className="rounded-xl border border-surface-line p-3" key={key}>
            <h4 className="font-medium text-ink">{stageLabel(source.stage)} · лист {source.page}</h4>
            <p className="mt-1 break-all text-[11px] text-ink-faint">{source.sha256 ? `SHA-256 ${source.sha256}` : 'Отпечаток не указан'}</p>
            {source.quote && <blockquote className="my-3 rounded-lg border-l-4 border-accent bg-surface-muted p-3 text-xs text-ink">{source.quote}</blockquote>}
            {failedImages.includes(key) ? <Empty title="Лист не удалось открыть" hint="Ссылка на источник сохранена, но изображение сейчас недоступно." /> : <div className="relative mx-auto w-fit max-w-full overflow-hidden">
              <img className="max-h-[58vh] max-w-full" src={officialApi.pageImageUrl(source.document_id, source.page)} alt={`${stageLabel(source.stage)}, лист ${source.page}`}
                onError={() => setFailedImages((current) => [...current, key])} />
              {overlay && <span aria-label="Граница доказательства" className="pointer-events-none absolute border-2 border-critical bg-critical/10" style={overlay} />}
            </div>}
            {!bbox && <p className="mt-3 text-xs text-critical">Координаты фрагмента не получены — доказательство неполное.</p>}
          </section>
        })}</div>
      </div>
    </div>
  )
}

function runForObject(runs: OfficialRun[], objectId: string): OfficialRun | null {
  const matching = runs.filter((item) => item.object_id === objectId)
  return matching.find((item) => isActive(item))
    ?? matching[0] ?? null
}

function CheckRow({ check, run, onDecision, onSplit, onEvidence }: {
  check: OfficialCheck; run: OfficialRun
  onDecision: (check: OfficialCheck, status: DecisionStatus, reason: string, reasonCode: string) => Promise<void>
  onSplit: (check: OfficialCheck, parts: SplitPart[], reason: string) => Promise<boolean>
  onEvidence: (evidence: OfficialEvidence[]) => void
}) {
  const user = useApp((state) => state.user)
  const [expanded, setExpanded] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonCode, setReasonCode] = useState('')
  const [saving, setSaving] = useState(false)
  const [splitting, setSplitting] = useState(false)
  // ТЗ 9.3: три действия инспектора, не более трёх кликов на нарушение.
  // Решение подписывается учётной записью, выполнившей вход.
  const save = async (status: DecisionStatus) => {
    if (!reason.trim() || (status === 'NEGATIVE_VERIFIED' && !reasonCode)) return
    setSaving(true)
    try { await onDecision(check, status, reason, reasonCode); setReason(''); setReasonCode('') } finally { setSaving(false) }
  }
  const mayDecide = can(user, 'inspector', 'supervisor') && run.process_status !== 'FINALIZED'
  const maySplit = mayDecide && check.finding_status === 'CANDIDATE' && !check.split_from && check.evidence.length > 1
  return <>
    <tr className="border-t border-surface-line text-sm">
      <td className="px-3 py-2 align-top font-medium text-ink">{check.parameter_code}</td>
      <td className="px-3 py-2 align-top"><div className="font-medium text-ink">{check.parameter_name}</div><div className="mt-1 text-xs text-ink-faint">{check.completeness_status}{check.split_from && ` · часть кандидата ${check.split_from}`}</div></td>
      <td className="px-3 py-2 align-top"><Chip tone={check.priority === 'HIGH' ? 'warn' : 'neutral'}>{check.priority}</Chip></td>
      <td className="px-3 py-2 align-top"><Chip tone={statusTone(check.technical_status)}>{findingLabel(check.finding_status, check.technical_status)}</Chip></td>
      <td className="px-3 py-2 align-top"><button className="text-xs text-accent hover:underline" onClick={() => setExpanded(!expanded)}>{expanded ? 'Свернуть' : 'Подробнее'}</button></td>
    </tr>
    {expanded && <tr className="border-t border-surface-line bg-surface-muted/40"><td colSpan={5} className="px-3 py-3">
      <p className="text-sm text-ink">{check.explanation || 'Пояснение не сформировано.'}</p>
      <div className="mt-2 grid gap-2 text-xs md:grid-cols-2"><div><span className="text-ink-faint">Ожидалось: </span>{check.expected_value || 'не извлечено'}</div><div><span className="text-ink-faint">Получено: </span>{check.actual_value || 'не извлечено'}</div></div>
      {check.confidence != null && <p className="mt-2 text-xs text-ink-faint">Уверенность модели: {Math.round(check.confidence * 100)}%</p>}
      <div className="mt-3 flex flex-wrap gap-2">{check.evidence.length === 0 ? <span className="text-xs text-ink-faint">Доказательства не получены: результат требует уточнения.</span> : <button className="btn-ghost px-2 py-1 text-xs" onClick={() => onEvidence(check.evidence)}>Открыть доказательства ПД/РД/ИД ({check.evidence.length})</button>}</div>
      {check.technical_status === 'completed' && <div className="mt-4 rounded-lg border border-surface-line bg-surface p-3"><p className="text-xs font-medium text-ink">Решение инспектора</p><p className="mt-1 text-xs text-ink-faint">Машинный результат и история решений сохраняются отдельно.</p>
        {mayDecide ? <>
          <div className="mt-2 grid gap-2 md:grid-cols-2"><input className="rounded-lg border border-surface-line px-2 py-1.5 text-xs" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Комментарий инспектора *" /><select aria-label="Причина отклонения" className="rounded-lg border border-surface-line px-2 py-1.5 text-xs" value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}><option value="">Причина отклонения (для «Отклонить»)</option>{Object.entries(REASON_CODES).map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select></div>
          <div className="mt-2 flex flex-wrap gap-2">
            <button className="btn-primary px-3 py-1.5 text-xs" disabled={saving || !reason.trim()} onClick={() => void save('CONFIRMED_VIOLATION')}>Подтвердить нарушение</button>
            <button className="btn-ghost px-3 py-1.5 text-xs" disabled={saving || !reason.trim() || !reasonCode} onClick={() => void save('NEGATIVE_VERIFIED')}>Отклонить</button>
            <button className="btn-ghost px-3 py-1.5 text-xs" disabled={saving || !reason.trim()} onClick={() => void save('CLARIFICATION_REQUIRED')}>Требует уточнения</button>
            {maySplit && !splitting && <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setSplitting(true)}>Разделить…</button>}
          </div>
          {splitting && <SplitFindingForm check={check} onCancel={() => setSplitting(false)}
            onSplit={async (parts, splitReason) => { if (await onSplit(check, parts, splitReason)) setSplitting(false) }} />}
        </> : <p className="mt-2 text-xs text-ink-faint">{run.process_status === 'FINALIZED' ? 'Протокол финализирован: решения закрыты.' : 'Решения принимает инспектор.'}</p>}
        {check.review_history.length > 0 && <details className="mt-3 text-xs"><summary className="cursor-pointer text-ink-muted">История решений ({check.review_history.length})</summary><ul className="mt-2 space-y-1 text-ink-faint">{check.review_history.map((item, index) => <li key={`${item.author}-${index}`}>{item.created_at || 'время не указано'} · {item.author}: {findingLabel(item.status, 'completed')} — {item.reason}</li>)}</ul></details>}
      </div>}
    </td></tr>}
  </>
}

export default function OfficialAnalysis() {
  const [documents, setDocuments] = useState<OfficialDocument[]>([])
  const [parameters, setParameters] = useState<OfficialParameter[]>([])
  const [matrixVersion, setMatrixVersion] = useState('—')
  const [run, setRun] = useState<OfficialRun | null>(null)
  const [selected, setSelected] = useState<number[]>([])
  const [activeObject, setActiveObject] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [evidence, setEvidence] = useState<OfficialEvidence[] | null>(null)
  const [provider, setProvider] = useState<ProviderSettings | null>(null)
  const [providerCheck, setProviderCheck] = useState<ProviderCheck | null>(null)
  const [checkingProvider, setCheckingProvider] = useState(false)
  const selectionInitialized = useRef(false)

  const reload = async (preferredObject = '') => {
    const [documentData, parameterData, runs, providerData] = await Promise.all([officialApi.documents(), officialApi.parameters(), officialApi.runs(), officialApi.settings()])
    setDocuments(documentData); setParameters(parameterData.parameters); setMatrixVersion(parameterData.matrix_version)
    setProvider(providerData)
    const firstObject = documentData.find((item) => item.metadata.object_id)?.metadata.object_id ?? ''
    const requestedObject = preferredObject || activeObject
    const objectForSelection = requestedObject
      && documentData.some((item) => item.metadata.object_id === requestedObject)
      ? requestedObject : firstObject
    setActiveObject(objectForSelection)
    const matchingRun = runForObject(runs, objectForSelection)
    setRun((current) => isActive(current)
      && current?.object_id === objectForSelection ? current : matchingRun)
    setSelected((current) => {
      if (!selectionInitialized.current) {
        selectionInitialized.current = true
        return documentData.filter((item) => item.metadata.object_id === objectForSelection).map((item) => item.id)
      }
      return current.filter((id) => documentData.some((item) => item.id === id))
    })
  }
  // Переход с дашборда: объект передаётся в адресе (?object=…).
  useEffect(() => { void reload(new URLSearchParams(window.location.search).get('object') ?? '').catch((cause) => setMessage(cause instanceof Error ? cause.message : 'Не удалось получить данные.')).finally(() => setLoading(false)) }, [])
  useEffect(() => {
    if (!run || !isActive(run)) return
    const timer = window.setTimeout(() => { void officialApi.run(run.id).then(setRun).catch((cause) => setMessage(cause instanceof Error ? cause.message : 'Не удалось обновить ход проверки.')) }, 1500)
    return () => window.clearTimeout(timer)
  }, [run])

  const objectIds = useMemo(() => Array.from(new Set(
    documents.map((item) => item.metadata.object_id).filter(Boolean),
  )).sort(), [documents])
  const objectDocuments = documents.filter((item) => !activeObject || item.metadata.object_id === activeObject)
  const byStage = (stage: OfficialStage) => objectDocuments.filter((item) => item.metadata.stage === stage)
  const allSelected = useMemo(() => documents.filter((item) => selected.includes(item.id)), [documents, selected])
  const selectedObject = allSelected[0]?.metadata.object_id ?? ''
  const stagesDefined = allSelected.every((item) => STAGES.some((stage) => stage.key === item.metadata.stage))
  const eligible = allSelected.length > 0 && Boolean(selectedObject) && stagesDefined
    && allSelected.every((item) => item.metadata.object_id === selectedObject)
  const checks = run?.result?.checks ?? []
  const graphicAnalysis = run?.result?.graphic_analysis ?? {
    status: 'not_run' as const,
    reason: 'Графическая проверка отсутствует в сохранённом прогоне.',
    candidates: [],
    performance: {},
  }
  const graphicChecks = graphicAnalysis.candidates
  const progress = run && run.total > 0 ? Math.min(100, Math.round((run.completed / run.total) * 100)) : 0

  const upload = async (file: File, metadata: OfficialDocumentMetadata) => {
    setBusy(true)
    try { const created = await officialApi.upload(file); await officialApi.saveMetadata(created.id, metadata); await reload(metadata.object_id); setSelected([created.id]); setMessage(`Файл «${file.name}» загружен и описан.`) } finally { setBusy(false) }
  }
  const saveMetadata = async (id: number, metadata: OfficialDocumentMetadata) => { setBusy(true); try { await officialApi.saveMetadata(id, metadata); await reload(metadata.object_id); setSelected([id]); setMessage('Метаданные сохранены.') } finally { setBusy(false) } }
  const deleteDocument = async (id: number) => { setBusy(true); try { await officialApi.deleteDocument(id); setSelected((current) => current.filter((item) => item !== id)); await reload(); setMessage('Документ удалён из рабочего комплекта.') } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Не удалось удалить документ.') } finally { setBusy(false) } }
  const verifyProvider = async () => { setCheckingProvider(true); try { setProviderCheck(await officialApi.checkProvider()) } catch (cause) { setProviderCheck({ reachable: false, provider: provider?.provider ?? 'local', message: cause instanceof Error ? cause.message : 'Проверка связи не выполнена.' }) } finally { setCheckingProvider(false) } }
  const launch = async () => { setBusy(true); try { const created = await officialApi.createRun(selectedObject, selected); setRun(created); setMessage('Официальная проверка запущена. Машинные кандидаты требуют подтверждения инспектором.') } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Не удалось запустить проверку.') } finally { setBusy(false) } }
  const cancel = async () => { if (!run) return; setBusy(true); try { setRun(await officialApi.cancelRun(run.id)); setMessage('Остановка запрошена: обработка завершится на безопасной точке.') } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Не удалось остановить проверку.') } finally { setBusy(false) } }
  const split = async (check: OfficialCheck, parts: SplitPart[], reason: string): Promise<boolean> => {
    if (!run) return false
    try {
      const updated = await officialApi.split(run.id, check.finding_id, { reason, parts, expected_version: run.version ?? 0 })
      setRun(updated)
      setMessage(`Кандидат ${check.finding_id} разделён на ${parts.length} части: решение принимается по каждой.`)
      return true
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Не удалось разделить кандидата.')
      return false
    }
  }
  const decide = async (check: OfficialCheck, status: DecisionStatus, reason: string, reasonCode: string) => { if (!run) return; try { const updated = await officialApi.decide(run.id, { finding_id: check.finding_id, status, reason, expected_version: run.version ?? 0, reason_code: status === 'NEGATIVE_VERIFIED' ? reasonCode : undefined }); setRun(updated); setMessage(updated.system_comment || 'Решение инспектора сохранено отдельной версией.') } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Не удалось сохранить решение.') } }
  const user = useApp((state) => state.user)
  const [unfinalizeReason, setUnfinalizeReason] = useState('')
  const finalize = async () => { if (!run) return; try { setRun(await officialApi.finalize(run.id)); setMessage('Протокол финализирован: решения и дозагрузка закрыты.') } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Не удалось финализировать протокол.') } }
  const unfinalize = async () => { if (!run || !unfinalizeReason.trim()) return; try { setRun(await officialApi.unfinalize(run.id, unfinalizeReason.trim())); setUnfinalizeReason(''); setMessage('Финализация отменена; отмена записана в журнал аудита.') } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Не удалось отменить финализацию.') } }

/**
 * Загружена ли выбранная модель на сервере модели.
 *
 * Карточка и раньше обещала, что модель меняется «только после проверки её
 * доступности», но проверить было нечем: перечень моделей никто не
 * запрашивал. Состояний три, а не два: «перечень не получен» — это не
 * «модели нет», и чинится оно по-другому.
 */
function ModelAvailability({ check }: { check: ProviderCheck }) {
  if (check.model_available === true) {
    return <p className="mt-2 text-xs text-accent">Модель {check.model} загружена на сервере.</p>
  }
  if (check.model_available === false) {
    return <p className="mt-2 text-xs text-critical">
      Модель {check.model} на сервере не загружена. Загружены: {(check.models_available || []).join(', ') || 'перечень пуст'}.
    </p>
  }
  return <p className="mt-2 text-xs text-ink-faint">
    Доступность модели не проверена: {check.models_message || 'перечень моделей не получен'}.
  </p>
}

  if (loading) return <Skeleton rows={10} />
  return <div className="mx-auto max-w-[1700px] space-y-5">
    <section className="rounded-2xl border border-surface-line bg-surface p-5 shadow-sm"><div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between"><div><h2 className="text-xl font-semibold text-ink">Проверка ПД → РД → ИД</h2><p className="mt-1 max-w-3xl text-sm text-ink-muted">ПД — источник проектных решений; РД и ИД сопоставляются с ним по матрице {matrixVersion}. Программа формирует гипотезы для инспектора, а не заключение о нарушении.</p></div><button className="btn-primary" disabled={!eligible || busy || isActive(run)} onClick={() => void launch()}>{busy ? 'Выполняю…' : 'Запустить проверку'}</button></div>
      {!eligible && <p className="mt-3 text-xs text-ink-faint">Для запуска выберите хотя бы один документ одного объекта. У каждого выбранного документа должна быть задана стадия.</p>}{message && <p className="mt-3 rounded-lg bg-surface-muted px-3 py-2 text-sm text-ink-muted">{message}</p>}</section>
    <SectionCard title="Модель ИИ" subtitle="Модель работает внутри контура на сервере комплекса: документы и их фрагменты никуда не передаются. Перед запуском можно убедиться, что модель загружена и отвечает."><div className="flex flex-wrap items-center gap-3 text-sm"><Chip tone={provider?.provider === 'local' ? 'accent' : 'warn'}>{provider?.provider === 'local' ? 'Локальная модель' : 'не настроена'}</Chip><span>Модель: <strong>{provider?.model || 'не задана'}</strong></span><button className="btn-ghost px-3 py-1.5 text-xs" disabled={checkingProvider} onClick={() => void verifyProvider()}>{checkingProvider ? 'Проверяю…' : 'Проверить связь'}</button>{providerCheck && <span className={providerCheck.reachable ? 'text-accent' : 'text-critical'}>{providerCheck.message}</span>}</div>
      {providerCheck && <ModelAvailability check={providerCheck} />}</SectionCard>
    <div className="grid gap-4 xl:grid-cols-3">{STAGES.map((stage) => <FileStage key={stage.key} stage={stage} documents={byStage(stage.key)} onUploaded={upload} onMetadataSaved={saveMetadata} onDeleted={deleteDocument} busy={busy} />)}</div>
    <SectionCard title="Комплект для проверки" subtitle="Сначала выберите объект, затем документы его комплекта. Неоднозначные и неутверждённые редакции программа отметит как неполноту."><div className="flex flex-wrap items-end gap-3"><label className="text-xs text-ink-muted">Объект<select className="mt-1 block min-w-64 rounded-lg border border-surface-line px-2 py-1.5 text-sm" value={activeObject} onChange={(event) => { const value = event.target.value; setActiveObject(value); setSelected(documents.filter((item) => item.metadata.object_id === value).map((item) => item.id)); setRun(null); void reload(value) }}><option value="">Объект не выбран</option>{objectIds.map((objectId) => <option key={objectId} value={objectId}>{objectId}</option>)}</select></label><span className="pb-1.5 text-xs text-ink-muted">Проверяются все активные параметры матрицы</span><span className="pb-1.5 text-xs text-ink-faint">Выбрано: {selected.length} документов</span></div><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="bg-surface-muted text-xs text-ink-muted"><tr><th className="px-3 py-2">Выбор</th><th className="px-3 py-2">Стадия</th><th className="px-3 py-2">Документ</th><th className="px-3 py-2">Шифр</th><th className="px-3 py-2">Редакция</th><th className="px-3 py-2">Статус</th></tr></thead><tbody>{objectDocuments.map((document) => <tr className="border-t border-surface-line" key={document.id}><td className="px-3 py-2"><input type="checkbox" checked={selected.includes(document.id)} onChange={() => setSelected((current) => current.includes(document.id) ? current.filter((id) => id !== document.id) : [...current, document.id])} /></td><td className="px-3 py-2"><Chip>{document.metadata.stage}</Chip></td><td className="px-3 py-2">{document.name}</td><td className="px-3 py-2">{document.metadata.document_code}</td><td className="px-3 py-2">{document.metadata.revision || 'не задана'}</td><td className="px-3 py-2">{document.metadata.approval_status}</td></tr>)}</tbody></table></div></SectionCard>
    <SectionCard title="Ход официальной проверки" subtitle="Пустой результат, невыполненная проверка, ошибка и остановка показываются раздельно." right={isActive(run) ? <button className="btn-ghost text-critical" disabled={busy} onClick={() => void cancel()}>Остановить</button> : undefined}>{run ? <div><div className="flex justify-between text-sm"><span>{run.stage || 'Проверка параметров'}</span><span>{run.completed} из {run.total}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-line"><div className="h-full bg-accent" style={{ width: `${progress}%` }} /></div><p className="mt-2 text-xs text-ink-faint">Статус: {run.process_status ?? run.status}{run.error ? ` · ${run.error}` : ''}</p>{run.result?.document_selection && Object.keys(run.result.document_selection.problems).length > 0 && <div className="mt-3 rounded-lg border border-critical/30 bg-critical/5 px-3 py-2 text-xs text-critical">{Object.entries(run.result.document_selection.problems).map(([stage, problem]) => <p key={stage}>{stage}: {problem}</p>)}</div>}</div> : <Empty title="Проверка ещё не запускалась" hint="После выбора документов одного объекта станет доступен запуск." />}</SectionCard>
    <SectionCard title="Матрица параметров" subtitle={`Матрица ${matrixVersion}: ${parameters.length} параметров. Результат по каждому параметру появится после прогона.`}><div className="max-h-80 overflow-auto"><table className="w-full min-w-[800px] text-left text-sm"><thead className="sticky top-0 bg-surface-muted text-xs text-ink-muted"><tr><th className="px-3 py-2">Код</th><th className="px-3 py-2">Параметр</th><th className="px-3 py-2">Раздел</th><th className="px-3 py-2">Приоритет</th><th className="px-3 py-2">Триггер</th></tr></thead><tbody>{parameters.map((parameter) => <tr className="border-t border-surface-line" key={parameter.code}><td className="px-3 py-2 font-medium">{parameter.code}</td><td className="px-3 py-2">{parameter.name}</td><td className="px-3 py-2">{parameter.section}</td><td className="px-3 py-2"><Chip tone={parameter.priority === 'HIGH' ? 'warn' : 'neutral'}>{parameter.priority}</Chip></td><td className="px-3 py-2 text-xs text-ink-muted">{parameter.trigger}</td></tr>)}</tbody></table></div></SectionCard>
    {run?.result && run.protocol && <SectionCard title="Протокол" subtitle={`Статус: ${run.process_status} · Тип проверки: ${run.protocol.scenario} · Модель: ${run.protocol.versions.model_version || 'не указана'}`} right={<div className="flex gap-2">{(['pdf', 'docx', 'xml'] as const).map((format) => <a key={format} className="btn-ghost px-2 py-1 text-xs" href={officialApi.protocolUrl(run.id, format)}>{format.toUpperCase()}</a>)}</div>}>
      <div className="flex flex-wrap gap-2 text-xs">{Object.entries(run.protocol.upload_status).map(([stage, value]) => <Chip key={stage} tone={value.endsWith('_UPLOADED') ? 'accent' : 'warn'}>{value}</Chip>)}</div>
      <p className="mt-2 text-xs text-ink-faint">Кандидатов без решения инспектора: {run.protocol.pending_candidates.length}. Финализация закрывает решения и дозагрузку; отменить её может только администратор или супервизор.</p>
      {run.process_status !== 'FINALIZED'
        ? (can(user, 'inspector', 'supervisor') && <div className="mt-2 flex flex-wrap gap-2"><button className="btn-primary px-3 py-1.5 text-xs" disabled={run.protocol.pending_candidates.length > 0} onClick={() => void finalize()}>Завершить</button></div>)
        : <div className="mt-2"><p className="text-xs text-accent">Протокол финализирован {run.finalized_at || ''}{run.finalized_by ? ` · ${run.finalized_by}` : ''}.</p>
          <p className="mt-1 text-xs text-ink-muted">Передача во внешнюю систему: {SYNC_TITLES[run.sync_status || ''] || run.sync_status}{run.sync_next_at ? `, повтор в ${run.sync_next_at}` : ''}.</p>
          {(run.pending_documents?.length ?? 0) > 0 && <p className="mt-1 rounded-lg bg-surface-muted px-2 py-1 text-xs">Поступили новые документы ({run.pending_documents!.map((item) => `${item.metadata.stage || '?'} ${item.metadata.document_code || ''}`.trim()).join(', ')}). Проверка по ним не запускалась: создайте новую проверку.</p>}
          {can(user, 'supervisor') && <div className="mt-2 flex flex-wrap gap-2"><input className="rounded-lg border border-surface-line px-2 py-1.5 text-xs" value={unfinalizeReason} onChange={(event) => setUnfinalizeReason(event.target.value)} placeholder="Причина отмены финализации *" /><button className="btn-ghost px-3 py-1.5 text-xs" disabled={!unfinalizeReason.trim()} onClick={() => void unfinalize()}>Отменить финализацию</button></div>}</div>}
    </SectionCard>}
    {run?.result && <SectionCard title="Текстовая сверка по матрице" subtitle={`Покрытие: выполнено ${run.result.coverage.completed} из ${run.result.coverage.total}; не выполнено ${run.result.coverage.not_run}.`} right={<div className="flex gap-2"><a className="btn-ghost px-2 py-1 text-xs" href={officialApi.exportUrl(run.id, 'json')}>JSON</a><a className="btn-ghost px-2 py-1 text-xs" href={officialApi.exportUrl(run.id, 'csv')}>CSV</a></div>}>{checks.length === 0 ? <Empty title="Завершённых параметров пока нет" hint={run.result.coverage.not_run > 0 ? 'Часть проверки не выполнялась или требует уточнения. Это не означает отсутствие расхождений.' : 'Сервер не вернул параметров для выбранного комплекта; проверьте статус прогона и метаданные.'} /> : <div className="overflow-x-auto"><table className="w-full min-w-[920px] text-left"><thead className="bg-surface-muted text-xs text-ink-muted"><tr><th className="px-3 py-2">Код</th><th className="px-3 py-2">Параметр</th><th className="px-3 py-2">Приоритет</th><th className="px-3 py-2">Состояние</th><th className="px-3 py-2">Действие</th></tr></thead><tbody>{checks.map((check) => <CheckRow key={check.finding_id} check={check} run={run} onDecision={decide} onSplit={split} onEvidence={setEvidence} />)}</tbody></table></div>}</SectionCard>}
    {run?.result && <SectionCard title="Графическая сверка листов" subtitle={`Статус: ${graphicAnalysis.status}. ${graphicAnalysis.reason || 'Кандидаты формируются отдельно от текстовой матрицы и требуют решения инспектора.'}`}>{graphicChecks.length === 0 ? <Empty title="Графические кандидаты не сформированы" hint={graphicAnalysis.status === 'completed' ? 'Просмотр завершён без наблюдаемых кандидатов. Это не является выводом об отсутствии нарушения.' : 'Графическая проверка не завершена; отсутствие кандидатов нельзя считать чистым результатом.'} /> : <div className="overflow-x-auto"><table className="w-full min-w-[920px] text-left"><thead className="bg-surface-muted text-xs text-ink-muted"><tr><th className="px-3 py-2">Вид</th><th className="px-3 py-2">Кандидат</th><th className="px-3 py-2">Приоритет</th><th className="px-3 py-2">Состояние</th><th className="px-3 py-2">Действие</th></tr></thead><tbody>{graphicChecks.map((check) => <CheckRow key={check.finding_id} check={check} run={run} onDecision={decide} onSplit={split} onEvidence={setEvidence} />)}</tbody></table></div>}</SectionCard>}
    {run?.result && run.status === 'completed' && <FreeSearchCard runId={run.id} finalized={run.process_status === 'FINALIZED'} user={user} status={run.result.free_search?.status} reason={run.result.free_search?.reason} onChanged={() => { void officialApi.run(run.id).then(setRun) }} />}
    {evidence && <EvidencePreview evidence={evidence} onClose={() => setEvidence(null)} />}
  </div>
}
