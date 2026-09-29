import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminApi, type DashboardFilters, type DashboardObject } from '../adminApi'
import { Empty, SectionCard, Skeleton } from '../components/ui'

const COLORS: Record<DashboardObject['color'], { dot: string; title: string }> = {
  red: { dot: 'bg-critical', title: 'есть подтверждённые нарушения' },
  yellow: { dot: 'bg-major', title: 'требует внимания инспектора' },
  green: { dot: 'bg-minor', title: 'открытой работы нет' },
}

const STATUSES = ['PENDING', 'PARSING', 'READY', 'VERIFYING', 'COMPLETED', 'FINALIZED', 'ERROR', 'CANCELLED']

/** Дашборд инспектора (ТЗ 7, модуль 7): объекты, цвет, фильтры, выгрузки. */
export default function Dashboard() {
  const [filters, setFilters] = useState<DashboardFilters>({})
  const [data, setData] = useState<{ objects: DashboardObject[]; sections: string[]; totals: Record<string, number> } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    adminApi.dashboard(filters).then((value) => { setData(value); setError('') })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Не удалось получить объекты.'))
  }, [filters])

  const set = (key: keyof DashboardFilters, value: string) => setFilters((current) => ({ ...current, [key]: value || undefined }))
  const field = 'mt-1 block rounded-lg border border-surface-line px-2 py-1.5 text-sm'

  return <div className="space-y-4">
    <SectionCard title="Объекты" subtitle="Зелёный — по выполненной проверке открытой работы нет; это не заключение об отсутствии нарушений.">
      <div className="flex flex-wrap items-end gap-3 text-xs text-ink-muted">
        <label>Цвет<select className={field} value={filters.color ?? ''} onChange={(event) => set('color', event.target.value)}>
          <option value="">все</option><option value="red">красный</option><option value="yellow">жёлтый</option><option value="green">зелёный</option>
        </select></label>
        <label>Раздел<select className={field} value={filters.section ?? ''} onChange={(event) => set('section', event.target.value)}>
          <option value="">все</option>{data?.sections.map((section) => <option key={section} value={section}>{section}</option>)}
        </select></label>
        <label>Статус<select className={field} value={filters.status ?? ''} onChange={(event) => set('status', event.target.value)}>
          <option value="">все</option>{STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
        </select></label>
        <label>С даты<input type="date" className={field} value={filters.date_from ?? ''} onChange={(event) => set('date_from', event.target.value)} /></label>
        <label>По дату<input type="date" className={field} value={filters.date_to ?? ''} onChange={(event) => set('date_to', event.target.value)} /></label>
        {data && <span className="pb-2">Красных: {data.totals.red ?? 0} · жёлтых: {data.totals.yellow ?? 0} · зелёных: {data.totals.green ?? 0}</span>}
      </div>
    </SectionCard>
    {error && <p className="text-sm text-critical">{error}</p>}
    {!data && !error ? <Skeleton /> : data && (data.objects.length === 0
      ? <Empty title="Объектов по фильтру нет" hint="Измените фильтры или загрузите комплект на экране проверки." />
      : <div className="card overflow-x-auto"><table className="w-full min-w-[960px] text-left text-sm">
        <thead className="bg-surface-muted text-xs text-ink-muted"><tr>
          <th className="px-3 py-2">Объект</th><th className="px-3 py-2">Статус</th><th className="px-3 py-2">Нарушения</th>
          <th className="px-3 py-2">Кандидаты</th><th className="px-3 py-2">Гипотезы</th><th className="px-3 py-2">Разделы</th>
          <th className="px-3 py-2">Дата</th><th className="px-3 py-2">Протокол</th>
        </tr></thead>
        <tbody>{data.objects.map((item) => <tr key={item.object_id} className="border-t border-surface-line">
          <td className="px-3 py-2"><span className="inline-flex items-center gap-2" title={COLORS[item.color].title}>
            <span className={`h-3 w-3 rounded-full ${COLORS[item.color].dot}`} aria-label={COLORS[item.color].title} />
            <Link className="font-medium text-accent" to={`/?object=${encodeURIComponent(item.object_id)}`}>{item.object_id}</Link>
          </span>{item.new_documents > 0 && <div className="text-xs text-ink-muted">новых документов после финализации: {item.new_documents}</div>}</td>
          <td className="px-3 py-2 text-xs">{item.status}</td>
          <td className="px-3 py-2">{item.confirmed}</td>
          <td className="px-3 py-2">{item.pending_candidates}{item.missing_evidence > 0 && <span className="text-xs text-ink-muted"> · неполных {item.missing_evidence}</span>}</td>
          <td className="px-3 py-2">{item.suspicions}</td>
          <td className="px-3 py-2 text-xs">{item.sections.join(', ') || '—'}</td>
          <td className="px-3 py-2 text-xs">{item.created_at.slice(0, 10)}</td>
          <td className="px-3 py-2"><div className="flex gap-1">{(['pdf', 'docx', 'xml'] as const).map((format) =>
            <a key={format} className="btn-ghost px-2 py-1 text-xs" href={`/api/v1/processes/${item.process_id}/export?format=${format}`}>{format.toUpperCase()}</a>)}</div></td>
        </tr>)}</tbody>
      </table></div>)}
  </div>
}
