import { useEffect, useState } from 'react'
import { adminApi, type DatasetItem, type DatasetVersion, type Dispute, type ModelRow, type Rejection, type Report } from '../adminApi'
import { can } from '../authApi'
import { Chip, Empty, SectionCard } from '../components/ui'
import { useApp } from '../store'

const cell = 'px-3 py-2'
const LABELS: Record<string, string> = { POSITIVE: 'нарушение', NEGATIVE: 'не нарушение' }

/** Данные дообучения, модели и еженедельный отчёт (ТЗ 7, модули 4 и 10; 9.4). */
export default function Ml() {
  const user = useApp((state) => state.user)
  const [items, setItems] = useState<DatasetItem[]>([])
  const [versions, setVersions] = useState<DatasetVersion[]>([])
  const [models, setModels] = useState<{ published: string | null; models: ModelRow[] }>({ published: null, models: [] })
  const [report, setReport] = useState<Report | null>(null)
  const [rejections, setRejections] = useState<Rejection[]>([])
  const [disputes, setDisputes] = useState<Dispute[]>([])
  const [message, setMessage] = useState('')

  const load = () => {
    const fail = (cause: unknown) => setMessage(cause instanceof Error ? cause.message : 'Ошибка запроса.')
    adminApi.datasetItems('DRAFT').then(setItems).catch(fail)
    adminApi.datasetVersions().then(setVersions).catch(fail)
    adminApi.models().then(setModels).catch(fail)
    adminApi.report(7).then(setReport).catch(fail)
    adminApi.rejections().then(setRejections).catch(fail)
    adminApi.disputes().then(setDisputes).catch(fail)
  }
  useEffect(load, [])
  const act = async (action: () => Promise<unknown>, done: string) => {
    try { await action(); setMessage(done); load() } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Не выполнено.') }
  }
  const curator = can(user, 'ml_engineer')
  const signer = can(user)  // подпись публикации — только администратор

  return <div className="space-y-4">
    {message && <p className="text-sm text-ink-muted">{message}</p>}
    <SectionCard title="Еженедельный отчёт" subtitle={report ? `${report.period_start.slice(0, 10)} — ${report.period_end.slice(0, 10)}` : 'формируется автоматически раз в неделю'}>
      {!report ? <Empty title="Отчёт недоступен" /> : <div className="grid gap-3 text-sm md:grid-cols-2">
        <div>Решений: {report.decisions.total} (подтверждено {report.decisions.confirmed}, отклонено {report.decisions.rejected}, уточнение {report.decisions.clarification})<br />
          Доля отклонений: {report.rejection_share === null ? '—' : `${Math.round(report.rejection_share * 100)} %`}<br />
          Открытых спорных случаев: {report.open_disputes} · в черновике набора: {report.dataset_drafts}<br />
          Опубликованная модель: {report.published_model ?? 'нет (используется базовая)'}</div>
        <div><div className="text-xs font-medium text-ink-muted">Рекомендации</div>
          {report.recommendations.length === 0 ? <p className="text-xs text-ink-faint">нет</p> :
            <ul className="list-disc pl-5 text-xs">{report.recommendations.map((line) => <li key={line}>{line}</li>)}</ul>}</div>
      </div>}
    </SectionCard>

    <SectionCard title="Черновик GOLD-набора" subtitle="В выпуск идут только записи, одобренные куратором, из финализированных протоколов." right={curator && <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => void act(adminApi.release, 'Выпущена новая версия набора.')}>Выпустить dataset_version</button>}>
      {items.length === 0 ? <Empty title="Черновик пуст" hint="Записи появляются после решений инспектора: подтверждение и отклонение кандидата." /> :
        <div className="overflow-x-auto"><table className="w-full min-w-[800px] text-left text-sm"><thead className="bg-surface-muted text-xs text-ink-muted"><tr>
          <th className={cell}>Объект</th><th className={cell}>Находка</th><th className={cell}>Метка</th><th className={cell}>Причина</th><th className={cell}>Решение куратора</th></tr></thead>
          <tbody>{items.map((item) => <tr key={item.id} className="border-t border-surface-line">
            <td className={cell}>{item.object_id}</td><td className={cell}>{item.finding_id}</td>
            <td className={cell}><Chip tone={item.label === 'POSITIVE' ? 'warn' : 'neutral'}>{LABELS[item.label] ?? item.label}</Chip></td>
            <td className={`${cell} text-xs`}>{[item.reason_code, item.reason].filter(Boolean).join(': ')}</td>
            <td className={cell}>{curator && <div className="flex gap-1"><button className="btn-ghost px-2 py-1 text-xs" onClick={() => void act(() => adminApi.curate(item.id, true), 'Запись одобрена.')}>Одобрить</button><button className="btn-ghost px-2 py-1 text-xs" onClick={() => void act(() => adminApi.curate(item.id, false), 'Запись исключена.')}>Исключить</button></div>}</td>
          </tr>)}</tbody></table></div>}
    </SectionCard>

    <SectionCard title="Выпуски набора данных" subtitle="Разбиение по объектам; SHA-256 каждого набора фиксируется при выпуске.">
      {versions.length === 0 ? <Empty title="Выпусков нет" /> : <ul className="space-y-1 text-xs">{versions.map((row) =>
        <li key={row.version}><span className="font-medium">{row.version}</span> · матрица {row.matrix_version} · записей {row.items} · {Object.entries(row.counts).map(([split, counts]) => `${split}: ${JSON.stringify(counts)}`).join('; ')} · выгрузка по схеме GOLD: <a className="text-accent" href={`/api/v1/ml/dataset/versions/${row.version}/export?format=json`}>JSON</a> / <a className="text-accent" href={`/api/v1/ml/dataset/versions/${row.version}/export?format=csv`}>CSV</a></li>)}</ul>}
    </SectionCard>

    <SectionCard title="Модели" subtitle={`Опубликована: ${models.published ?? 'нет'}. Публикация — только после приёмки по ТЗ 14.3 и подписи администратора; откат возвращает предыдущую.`}>
      {models.models.length === 0 ? <Empty title="Итераций дообучения нет" hint="Результат обучения на стенде регистрируется через POST /api/v1/ml/models." /> :
        <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-surface-muted text-xs text-ink-muted"><tr>
          <th className={cell}>Модель</th><th className={cell}>Набор</th><th className={cell}>P / R / F1 / FPR</th><th className={cell}>Приёмка</th><th className={cell}>Статус</th><th className={cell} /></tr></thead>
          <tbody>{models.models.map((row) => <tr key={row.id} className="border-t border-surface-line">
            <td className={cell}>{row.model_version}</td><td className={cell}>{row.dataset_version}</td>
            <td className={`${cell} text-xs`}>{[row.precision, row.recall, row.f1, row.false_positive_rate].map((value) => value ?? '—').join(' / ')}</td>
            <td className={`${cell} text-xs`}>{row.acceptance.passed ? <Chip tone="accent">пройдена</Chip> : <span title={(row.acceptance.failures ?? []).join('\n')}><Chip tone="warn">не пройдена</Chip></span>}</td>
            <td className={cell}>{row.approval_status}{row.approved_by && <div className="text-xs text-ink-muted">{row.approved_by}</div>}</td>
            <td className={cell}>{signer && <div className="flex gap-1">
              {row.approval_status === 'PENDING' && <><button className="btn-primary px-2 py-1 text-xs" disabled={!row.acceptance.passed} onClick={() => void act(() => adminApi.modelAction(row.id, 'approve'), 'Публикация подписана.')}>Опубликовать</button>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => void act(() => adminApi.modelAction(row.id, 'reject'), 'Модель отклонена.')}>Отклонить</button></>}
              {row.approval_status === 'APPROVED' && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => void act(() => adminApi.modelAction(row.id, 'rollback'), 'Модель откатана.')}>Откатить</button>}
            </div>}</td>
          </tr>)}</tbody></table></div>}
    </SectionCard>

    <SectionCard title="Лог отклонений" collapsible defaultOpen={false}>
      {rejections.length === 0 ? <Empty title="Отклонений нет" /> : <ul className="space-y-1 text-xs">{rejections.map((row) =>
        <li key={row.id}>{row.created_at.slice(0, 10)} · {row.violation_id} · <b>{row.rejection_reason}</b> — {row.inspector_comment} → {row.suggested_fix}</li>)}</ul>}
    </SectionCard>
    <SectionCard title="Спорные случаи" collapsible defaultOpen={false}>
      {disputes.length === 0 ? <Empty title="Спорных случаев нет" /> : <ul className="space-y-1 text-xs">{disputes.map((row) =>
        <li key={row.id}>{row.created_at.slice(0, 10)} · {row.violation_id} · {row.resolution_status} — {row.inspector_comment}</li>)}</ul>}
    </SectionCard>
  </div>
}
