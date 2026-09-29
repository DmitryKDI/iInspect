import { useState } from 'react'
import type { OfficialCheck, SplitPart } from '../officialApi'

const STAGE_LABEL: Record<string, string> = { PD: 'ПД', RD: 'РД', ID: 'ИД' }

const emptyPart = (check: OfficialCheck): SplitPart => ({
  expected_value: check.expected_value ?? '', actual_value: check.actual_value ?? '',
  evidence_indexes: check.evidence.map((_, index) => index),
})

/** ТЗ 9.3, п.2: составной кандидат делится на атомарные findings, у каждого — своё решение. */
export function SplitFindingForm({ check, onSplit, onCancel }: {
  check: OfficialCheck
  onSplit: (parts: SplitPart[], reason: string) => Promise<void>
  onCancel: () => void
}) {
  const [parts, setParts] = useState<SplitPart[]>(() => [emptyPart(check), emptyPart(check)])
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const change = (at: number, patch: Partial<SplitPart>) =>
    setParts((current) => current.map((part, index) => (index === at ? { ...part, ...patch } : part)))
  const toggle = (at: number, evidence: number) => {
    const chosen = parts[at].evidence_indexes
    change(at, { evidence_indexes: chosen.includes(evidence)
      ? chosen.filter((item) => item !== evidence) : [...chosen, evidence].sort((a, b) => a - b) })
  }
  const ready = reason.trim() && parts.every((part) => part.evidence_indexes.length > 0)
  const submit = async () => {
    if (!ready) return
    setSaving(true)
    try { await onSplit(parts, reason) } finally { setSaving(false) }
  }
  return <div className="mt-3 rounded-lg border border-surface-line bg-surface p-3">
    <p className="text-xs font-medium text-ink">Разделить на атомарные расхождения</p>
    <p className="mt-1 text-xs text-ink-faint">Каждая часть получает свои значения, доказательства с координатами в двух стадиях и отдельное решение.</p>
    {parts.map((part, at) => <fieldset key={at} className="mt-3 rounded-lg border border-surface-line p-2">
      <legend className="px-1 text-xs text-ink-muted">Часть {at + 1}</legend>
      <div className="grid gap-2 md:grid-cols-2">
        <input aria-label={`Ожидалось, часть ${at + 1}`} className="rounded-lg border border-surface-line px-2 py-1.5 text-xs" value={part.expected_value} onChange={(event) => change(at, { expected_value: event.target.value })} placeholder="Ожидалось" />
        <input aria-label={`Получено, часть ${at + 1}`} className="rounded-lg border border-surface-line px-2 py-1.5 text-xs" value={part.actual_value} onChange={(event) => change(at, { actual_value: event.target.value })} placeholder="Получено" />
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs">{check.evidence.map((source, index) =>
        <label key={index} className="flex items-center gap-1">
          <input type="checkbox" checked={part.evidence_indexes.includes(index)} onChange={() => toggle(at, index)} />
          {STAGE_LABEL[source.stage] ?? source.stage} · лист {source.page}{source.bbox ? '' : ' (без координат)'}
        </label>)}</div>
    </fieldset>)}
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setParts((current) => [...current, emptyPart(check)])}>Добавить часть</button>
      {parts.length > 2 && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setParts((current) => current.slice(0, -1))}>Убрать последнюю</button>}
    </div>
    <input className="mt-2 w-full rounded-lg border border-surface-line px-2 py-1.5 text-xs" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Основание разделения *" />
    <div className="mt-2 flex gap-2">
      <button className="btn-primary px-3 py-1.5 text-xs" disabled={saving || !ready} onClick={() => void submit()}>Разделить</button>
      <button className="btn-ghost px-3 py-1.5 text-xs" disabled={saving} onClick={onCancel}>Отмена</button>
    </div>
  </div>
}
