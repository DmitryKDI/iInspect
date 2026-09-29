import { useEffect, useState } from 'react'
import { can, type SessionUser } from '../authApi'
import { Chip, Empty, SectionCard } from '../components/ui'
import { officialApi, REASON_CODES, type Suspicion, type SuspicionReview } from '../officialApi'

const METHOD_TITLES: Record<Suspicion['discovery_method'], string> = {
  LOGICAL_ANALYSIS: 'Логический анализ',
  SEMANTIC_DISSONANCE: 'Семантический диссонанс',
  NORMATIVE_ANALYSIS: 'Нормативный анализ',
  ML_PATTERN_ANALYSIS: 'Аномалия по другим объектам',
}

const STATUS_TITLES: Record<string, string> = {
  PENDING: 'ожидает проверки',
  PROMOTED: 'переведена в кандидаты',
  DISMISSED: 'отклонена',
  CONFIRMED: 'нарушение подтверждено',
  REJECTED: 'кандидат отклонён',
}

interface Props {
  runId: number
  finalized: boolean
  user: SessionUser | null
  status: string | undefined
  reason: string | undefined
  onChanged: () => void
}

/** Гипотезы свободного поиска (ТЗ 9.5): не нарушения, пока инспектор не решит иначе. */
export function FreeSearchCard({ runId, finalized, user, status, reason, onChanged }: Props) {
  const [items, setItems] = useState<Suspicion[]>([])
  const [comment, setComment] = useState('')
  const [reasonCode, setReasonCode] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    officialApi.suspicions(runId).then(setItems).catch(() => setItems([]))
  }, [runId, status])

  const act = async (item: Suspicion, action: SuspicionReview['action']) => {
    try {
      const updated = await officialApi.reviewSuspicion(runId, item.suspicion_id, {
        action, comment: comment.trim(), reason_code: reasonCode,
      })
      setItems((current) => current.map((entry) => entry.suspicion_id === updated.suspicion_id ? updated : entry))
      setMessage('')
      onChanged()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Решение не сохранено.')
    }
  }

  const mayDecide = !finalized && can(user, 'inspector', 'supervisor')
  const subtitle = status === 'error'
    ? `Свободный поиск не выполнен: ${reason || 'причина не указана'}. Отсутствие гипотез нельзя считать чистым результатом.`
    : 'Гипотезы вне матрицы. Это не нарушения: в кандидаты — только с листом и координатами в ПД и РД/ИД.'

  return <SectionCard title="Гипотезы свободного поиска" subtitle={subtitle}>
    {items.length === 0
      ? <Empty title="Гипотез нет" hint="Логические правила и нормы заводит администратор; без них подходы 1 и 3 не срабатывают." />
      : <>
        {mayDecide && <div className="mb-3 flex flex-wrap gap-2">
          <input className="min-w-64 rounded-lg border border-surface-line px-2 py-1.5 text-xs" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Основание решения" />
          <select aria-label="Причина отклонения кандидата" className="rounded-lg border border-surface-line px-2 py-1.5 text-xs" value={reasonCode} onChange={(event) => setReasonCode(event.target.value)}>
            <option value="">Причина отклонения</option>
            {Object.entries(REASON_CODES).map(([code, title]) => <option key={code} value={code}>{title}</option>)}
          </select>
        </div>}
        {message && <p className="mb-2 text-xs text-critical">{message}</p>}
        <div className="overflow-x-auto"><table className="w-full min-w-[920px] text-left text-sm">
          <thead className="bg-surface-muted text-xs text-ink-muted"><tr>
            <th className="px-3 py-2">Подход</th><th className="px-3 py-2">Гипотеза</th><th className="px-3 py-2">Источники</th><th className="px-3 py-2">Статус</th><th className="px-3 py-2">Действие</th>
          </tr></thead>
          <tbody>{items.map((item) => <tr className="border-t border-surface-line align-top" key={item.suspicion_id}>
            <td className="px-3 py-2"><Chip tone={item.review_priority === 'HIGH' ? 'warn' : 'neutral'}>{METHOD_TITLES[item.discovery_method]}</Chip></td>
            <td className="px-3 py-2">{item.description}{item.normative_base && <div className="text-xs text-ink-muted">Норма: {item.normative_base}</div>}</td>
            <td className="px-3 py-2 text-xs text-ink-muted">{item.pd_reference && <div>ПД: {item.pd_reference}</div>}{item.rd_reference && <div>РД/ИД: {item.rd_reference}</div>}</td>
            <td className="px-3 py-2 text-xs">{STATUS_TITLES[item.inspector_status] || item.inspector_status}{item.inspector_comment && <div className="text-ink-muted">{item.inspector_comment}</div>}</td>
            <td className="px-3 py-2">{mayDecide && <div className="flex flex-wrap gap-1">
              {item.finding_status === 'SUSPICION' && item.inspector_status === 'PENDING' && <>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => void act(item, 'promote')}>В кандидаты</button>
                <button className="btn-ghost px-2 py-1 text-xs" disabled={!comment.trim()} onClick={() => void act(item, 'dismiss')}>Отклонить гипотезу</button>
              </>}
              {item.finding_status === 'CANDIDATE' && <>
                <button className="btn-primary px-2 py-1 text-xs" disabled={!comment.trim()} onClick={() => void act(item, 'confirm')}>Подтвердить нарушение</button>
                <button className="btn-ghost px-2 py-1 text-xs" disabled={!comment.trim() || !reasonCode} onClick={() => void act(item, 'reject')}>Отклонить</button>
              </>}
            </div>}</td>
          </tr>)}</tbody>
        </table></div>
      </>}
  </SectionCard>
}
