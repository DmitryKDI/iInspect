import { useEffect, useState, type ReactNode } from 'react'
import { adminApi, type AdminUser, type AuditRow, type IntegrityRow, type Norm, type Param, type Rule } from '../adminApi'
import type { Role } from '../authApi'
import { Chip, Empty, SectionCard } from '../components/ui'

const ROLES: Record<Role, string> = {
  inspector: 'инспектор', supervisor: 'инспектор-супервизор', admin: 'администратор',
  ml_engineer: 'ML-инженер', service: 'внешняя система',
}
const TABS = ['Пользователи', 'Матрица', 'Нормативная база', 'Логические правила', 'Журнал аудита', 'Целостность и копии'] as const
const input = 'rounded-lg border border-surface-line px-2 py-1.5 text-xs'
const cell = 'px-3 py-2'

function useLoad<T>(load: () => Promise<T>): [T | null, () => void, string] {
  const [value, setValue] = useState<T | null>(null)
  const [error, setError] = useState('')
  const reload = () => { load().then((data) => { setValue(data); setError('') }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Ошибка запроса.')) }
  useEffect(reload, [])
  return [value, reload, error]
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return <div className="overflow-x-auto"><table className="w-full min-w-[800px] text-left text-sm">
    <thead className="bg-surface-muted text-xs text-ink-muted"><tr>{head.map((title) => <th key={title} className={cell}>{title}</th>)}</tr></thead>
    <tbody>{children}</tbody></table></div>
}

/** Администрирование (ТЗ 7, модули 8 и 9; ТЗ 12). */
export default function Admin() {
  const [tab, setTab] = useState<(typeof TABS)[number]>(TABS[0])
  const [message, setMessage] = useState('')
  const act = async (action: () => Promise<unknown>, done: string, after?: () => void) => {
    try { await action(); setMessage(done); after?.() } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Не выполнено.') }
  }
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2">{TABS.map((name) => <button key={name} className={name === tab ? 'btn-primary px-3 py-1.5 text-xs' : 'btn-ghost px-3 py-1.5 text-xs'} onClick={() => { setTab(name); setMessage('') }}>{name}</button>)}</div>
    {message && <p className="text-sm text-ink-muted">{message}</p>}
    {tab === 'Пользователи' && <Users act={act} />}
    {tab === 'Матрица' && <Params act={act} />}
    {tab === 'Нормативная база' && <Norms act={act} />}
    {tab === 'Логические правила' && <Rules act={act} />}
    {tab === 'Журнал аудита' && <Audit />}
    {tab === 'Целостность и копии' && <Integrity act={act} />}
  </div>
}

type Act = (action: () => Promise<unknown>, done: string, after?: () => void) => Promise<void>

function Users({ act }: { act: Act }) {
  const [users, reload, error] = useLoad<AdminUser[]>(adminApi.users)
  const [draft, setDraft] = useState({ login: '', password: '', role: 'inspector' as Role, full_name: '' })
  return <SectionCard title="Пользователи" subtitle="Вход по логину и паролю; права определяются ролью (ТЗ 12, п.1–2).">
    {error && <p className="text-sm text-critical">{error}</p>}
    <div className="mb-3 flex flex-wrap gap-2">
      <input className={input} placeholder="Логин" value={draft.login} onChange={(event) => setDraft({ ...draft, login: event.target.value })} />
      <input className={input} placeholder="ФИО" value={draft.full_name} onChange={(event) => setDraft({ ...draft, full_name: event.target.value })} />
      <input className={input} type="password" placeholder="Пароль (от 8 символов)" value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} />
      <select className={input} value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value as Role })}>{Object.entries(ROLES).map(([role, title]) => <option key={role} value={role}>{title}</option>)}</select>
      <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => void act(() => adminApi.createUser(draft), 'Пользователь создан.', () => { setDraft({ ...draft, login: '', password: '', full_name: '' }); reload() })}>Создать</button>
    </div>
    <Table head={['Логин', 'ФИО', 'Роль', 'Последний вход', 'Состояние', 'Пароль']}>{(users ?? []).map((user) => <tr key={user.id} className="border-t border-surface-line">
      <td className={cell}>{user.login}</td><td className={cell}>{user.full_name}</td>
      <td className={cell}><select className={input} value={user.role} onChange={(event) => void act(() => adminApi.updateUser(user.id, { role: event.target.value as Role }), 'Роль изменена.', reload)}>{Object.entries(ROLES).map(([role, title]) => <option key={role} value={role}>{title}</option>)}</select></td>
      <td className={`${cell} text-xs`}>{user.last_login_at?.slice(0, 16) ?? '—'}</td>
      <td className={cell}><button className="btn-ghost px-2 py-1 text-xs" onClick={() => void act(() => adminApi.updateUser(user.id, { is_active: !user.is_active }), user.is_active ? 'Учётная запись отключена, сессии закрыты.' : 'Учётная запись включена.', reload)}>{user.is_active ? 'Отключить' : 'Включить'}</button></td>
      <td className={cell}><button className="btn-ghost px-2 py-1 text-xs" onClick={() => {
        const password = window.prompt(`Новый пароль для «${user.login}» (не короче 8 символов). Действующие сессии пользователя будут закрыты.`)
        if (password) void act(() => adminApi.updateUser(user.id, { password }), `Пароль пользователя «${user.login}» изменён.`, reload)
      }}>Задать пароль</button></td>
    </tr>)}</Table>
  </SectionCard>
}

function Params({ act }: { act: Act }) {
  const [data, reload, error] = useLoad(adminApi.params)
  const [filter, setFilter] = useState('')
  const [edit, setEdit] = useState<Param | null>(null)
  const rows = (data?.parameters ?? []).filter((item) => !filter || `${item.code} ${item.parameter_name} ${item.section}`.toLowerCase().includes(filter.toLowerCase()))
  const number = (value: string) => value.trim() === '' ? null : Number(value.replace(',', '.'))
  const save = () => {
    if (!edit) return
    const body: Record<string, unknown> = {
      trigger_logic: edit.trigger_logic, review_priority: edit.review_priority, sp_reference: edit.sp_reference,
      gost_reference: edit.gost_reference, fz_reference: edit.fz_reference, other_normative: edit.other_normative,
      data_type: edit.data_type, regex_pattern: edit.regex_pattern, is_active: edit.is_active,
    }
    if (edit.min_value === null) body.clear_min_value = true; else body.min_value = edit.min_value
    if (edit.max_value === null) body.clear_max_value = true; else body.max_value = edit.max_value
    void act(() => adminApi.updateParam(edit.code, body), `Параметр ${edit.code} сохранён; версия матрицы увеличена.`, () => { setEdit(null); reload() })
  }
  return <SectionCard title={`Матрица контроля ${data?.matrix_version ?? ''}`} subtitle="Пороги, ссылки на нормы и активность параметров меняются без перекодирования (ТЗ 7, модуль 8).">
    {error && <p className="text-sm text-critical">{error}</p>}
    <input className={`${input} mb-3`} placeholder="Поиск по коду, названию, разделу" value={filter} onChange={(event) => setFilter(event.target.value)} />
    {edit && <div className="mb-3 grid gap-2 rounded-lg border border-surface-line p-3 text-xs md:grid-cols-3">
      <div className="md:col-span-3 font-medium">{edit.code} {edit.parameter_name}</div>
      <label>Минимум<input className={`${input} block w-full`} value={edit.min_value ?? ''} onChange={(event) => setEdit({ ...edit, min_value: number(event.target.value) })} /></label>
      <label>Максимум<input className={`${input} block w-full`} value={edit.max_value ?? ''} onChange={(event) => setEdit({ ...edit, max_value: number(event.target.value) })} /></label>
      <label>Приоритет<select className={`${input} block w-full`} value={edit.review_priority} onChange={(event) => setEdit({ ...edit, review_priority: event.target.value })}>{['HIGH', 'MEDIUM', 'LOW'].map((p) => <option key={p}>{p}</option>)}</select></label>
      <label>СП<input className={`${input} block w-full`} value={edit.sp_reference} onChange={(event) => setEdit({ ...edit, sp_reference: event.target.value })} /></label>
      <label>ГОСТ<input className={`${input} block w-full`} value={edit.gost_reference} onChange={(event) => setEdit({ ...edit, gost_reference: event.target.value })} /></label>
      <label>ФЗ<input className={`${input} block w-full`} value={edit.fz_reference} onChange={(event) => setEdit({ ...edit, fz_reference: event.target.value })} /></label>
      <label>Тип значения<select className={`${input} block w-full`} value={edit.data_type} onChange={(event) => setEdit({ ...edit, data_type: event.target.value })}>{['number', 'string', 'boolean', 'coordinate', 'enum'].map((t) => <option key={t}>{t}</option>)}</select></label>
      <label className="md:col-span-2">Шаблон разбора (регулярное выражение)<input className={`${input} block w-full`} value={edit.regex_pattern} onChange={(event) => setEdit({ ...edit, regex_pattern: event.target.value })} /></label>
      <label className="md:col-span-3">Логика срабатывания<input className={`${input} block w-full`} value={edit.trigger_logic} onChange={(event) => setEdit({ ...edit, trigger_logic: event.target.value })} /></label>
      <label className="inline-flex items-center gap-2"><input type="checkbox" checked={edit.is_active} onChange={(event) => setEdit({ ...edit, is_active: event.target.checked })} />Параметр активен</label>
      <div className="flex gap-2 md:col-span-2"><button className="btn-primary px-3 py-1.5" onClick={save}>Сохранить</button><button className="btn-ghost px-3 py-1.5" onClick={() => setEdit(null)}>Отмена</button></div>
    </div>}
    <div className="max-h-[480px] overflow-auto"><Table head={['Код', 'Параметр', 'Раздел', 'Приоритет', 'Мин', 'Макс', 'Активен', '']}>{rows.map((item) => <tr key={item.code} className="border-t border-surface-line">
      <td className={`${cell} whitespace-nowrap`}>{item.code}</td><td className={cell}>{item.parameter_name}</td><td className={cell}>{item.section}</td>
      <td className={cell}><Chip tone={item.review_priority === 'HIGH' ? 'warn' : 'neutral'}>{item.review_priority}</Chip></td>
      <td className={cell}>{item.min_value ?? '—'}</td><td className={cell}>{item.max_value ?? '—'}</td><td className={cell}>{item.is_active ? 'да' : 'нет'}</td>
      <td className={cell}><button className="btn-ghost px-2 py-1 text-xs" onClick={() => setEdit(item)}>Изменить</button></td>
    </tr>)}</Table></div>
  </SectionCard>
}

const blankNorm: Omit<Norm, 'id'> = { document_name: '', document_number: '', section: '', parameter_name: '', min_value: null, max_value: null, effective_from: null, effective_to: null, is_active: true }

function Norms({ act }: { act: Act }) {
  const [rows, reload, error] = useLoad<Norm[]>(adminApi.norms)
  const [draft, setDraft] = useState<Omit<Norm, 'id'>>(blankNorm)
  const number = (value: string) => value.trim() === '' ? null : Number(value.replace(',', '.'))
  return <SectionCard title="Нормативная база" subtitle="Нормы с диапазоном значений и сроком действия; используются нормативным анализом свободного поиска.">
    {error && <p className="text-sm text-critical">{error}</p>}
    <div className="mb-3 flex flex-wrap gap-2">
      <input className={input} placeholder="Наименование документа" value={draft.document_name} onChange={(event) => setDraft({ ...draft, document_name: event.target.value })} />
      <input className={input} placeholder="Номер" value={draft.document_number} onChange={(event) => setDraft({ ...draft, document_number: event.target.value })} />
      <input className={input} placeholder="Пункт" value={draft.section} onChange={(event) => setDraft({ ...draft, section: event.target.value })} />
      <input className={input} placeholder="Код параметра (M-001)" value={draft.parameter_name} onChange={(event) => setDraft({ ...draft, parameter_name: event.target.value })} />
      <input className={`${input} w-20`} placeholder="мин" onChange={(event) => setDraft({ ...draft, min_value: number(event.target.value) })} />
      <input className={`${input} w-20`} placeholder="макс" onChange={(event) => setDraft({ ...draft, max_value: number(event.target.value) })} />
      <input className={input} type="date" title="Действует с" onChange={(event) => setDraft({ ...draft, effective_from: event.target.value || null })} />
      <input className={input} type="date" title="Действует по" onChange={(event) => setDraft({ ...draft, effective_to: event.target.value || null })} />
      <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => void act(() => adminApi.saveNorm(draft), 'Норма добавлена.', () => { setDraft(blankNorm); reload() })}>Добавить</button>
    </div>
    {(rows ?? []).length === 0 ? <Empty title="Норм пока нет" hint="Без норм нормативный анализ свободного поиска не срабатывает." /> :
      <Table head={['Документ', 'Пункт', 'Параметр', 'Диапазон', 'Действует', 'Состояние']}>{(rows ?? []).map((row) => <tr key={row.id} className="border-t border-surface-line">
        <td className={cell}>{row.document_number} {row.document_name}</td><td className={cell}>{row.section}</td><td className={cell}>{row.parameter_name || '—'}</td>
        <td className={cell}>{row.min_value ?? '…'} – {row.max_value ?? '…'}</td><td className={`${cell} text-xs`}>{row.effective_from ?? '…'} – {row.effective_to ?? '…'}</td>
        <td className={cell}><button className="btn-ghost px-2 py-1 text-xs" onClick={() => { const { id, ...rest } = row; void act(() => adminApi.saveNorm({ ...rest, is_active: !row.is_active }, id), row.is_active ? 'Норма деактивирована.' : 'Норма активна.', reload) }}>{row.is_active ? 'Деактивировать' : 'Активировать'}</button></td>
      </tr>)}</Table>}
  </SectionCard>
}

const blankRule: Omit<Rule, 'id'> = { rule_name: '', condition: '', expected: '', normative_base: '', review_priority: 'MEDIUM', is_active: true }

function Rules({ act }: { act: Act }) {
  const [rows, reload, error] = useLoad<Rule[]>(adminApi.rules)
  const [draft, setDraft] = useState<Omit<Rule, 'id'>>(blankRule)
  return <SectionCard title="Логические правила" subtitle={'«Если A, то B»: условие и ожидание над кодами матрицы, например M-001 > 10 и present(M-002); операторы and, or, not, contains.'}>
    {error && <p className="text-sm text-critical">{error}</p>}
    <div className="mb-3 flex flex-wrap gap-2">
      <input className={input} placeholder="Название" value={draft.rule_name} onChange={(event) => setDraft({ ...draft, rule_name: event.target.value })} />
      <input className={input} placeholder="Условие" value={draft.condition} onChange={(event) => setDraft({ ...draft, condition: event.target.value })} />
      <input className={input} placeholder="Ожидание" value={draft.expected} onChange={(event) => setDraft({ ...draft, expected: event.target.value })} />
      <input className={input} placeholder="Норма" value={draft.normative_base} onChange={(event) => setDraft({ ...draft, normative_base: event.target.value })} />
      <select className={input} value={draft.review_priority} onChange={(event) => setDraft({ ...draft, review_priority: event.target.value })}>{['HIGH', 'MEDIUM', 'LOW'].map((p) => <option key={p}>{p}</option>)}</select>
      <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => void act(() => adminApi.saveRule(draft), 'Правило добавлено.', () => { setDraft(blankRule); reload() })}>Добавить</button>
    </div>
    {(rows ?? []).length === 0 ? <Empty title="Правил пока нет" hint="Без правил логический анализ свободного поиска не срабатывает." /> :
      <Table head={['Правило', 'Если', 'То', 'Норма', 'Приоритет', 'Состояние']}>{(rows ?? []).map((row) => <tr key={row.id} className="border-t border-surface-line">
        <td className={cell}>{row.rule_name}</td><td className={`${cell} font-mono text-xs`}>{row.condition}</td><td className={`${cell} font-mono text-xs`}>{row.expected}</td>
        <td className={cell}>{row.normative_base}</td><td className={cell}>{row.review_priority}</td>
        <td className={cell}><button className="btn-ghost px-2 py-1 text-xs" onClick={() => { const { id, ...rest } = row; void act(() => adminApi.saveRule({ ...rest, is_active: !row.is_active }, id), row.is_active ? 'Правило деактивировано.' : 'Правило активно.', reload) }}>{row.is_active ? 'Деактивировать' : 'Активировать'}</button></td>
      </tr>)}</Table>}
  </SectionCard>
}

function Audit() {
  const [filters, setFilters] = useState({ user: '', action: '' })
  const [rows, setRows] = useState<AuditRow[]>([])
  const [error, setError] = useState('')
  useEffect(() => { adminApi.audit(filters).then(setRows).catch((cause) => setError(cause instanceof Error ? cause.message : 'Ошибка.')) }, [filters])
  return <SectionCard title="Журнал аудита" subtitle="Каждое изменяющее действие и попытка входа: время, пользователь, IP, действие, объект. Журнал только дополняется.">
    {error && <p className="text-sm text-critical">{error}</p>}
    <div className="mb-3 flex gap-2"><input className={input} placeholder="Логин" value={filters.user} onChange={(event) => setFilters({ ...filters, user: event.target.value })} /><input className={input} placeholder="Действие содержит" value={filters.action} onChange={(event) => setFilters({ ...filters, action: event.target.value })} /></div>
    <div className="max-h-[480px] overflow-auto"><Table head={['Время', 'Пользователь', 'Действие', 'Объект', 'Код', 'IP']}>{rows.map((row) => <tr key={row.id} className="border-t border-surface-line text-xs">
      <td className={cell}>{row.timestamp.slice(0, 19).replace('T', ' ')}</td><td className={cell}>{row.login}</td><td className={cell}>{row.action}</td>
      <td className={cell}>{row.object_id}</td><td className={cell}>{row.status_code}</td><td className={cell}>{row.ip_address}</td>
    </tr>)}</Table></div>
  </SectionCard>
}

function Integrity({ act }: { act: Act }) {
  const [checks, reload] = useLoad<IntegrityRow[]>(adminApi.integrity)
  const [backups, reloadBackups] = useLoad(adminApi.backups)
  return <div className="space-y-4">
    <SectionCard title="Проверка целостности" subtitle="Ежедневная сверка SHA-256 каждого оригинала и файла кэша (ТЗ 13, п.8)." right={<button className="btn-ghost px-2 py-1 text-xs" onClick={() => void act(adminApi.checkIntegrity, 'Проверка выполнена.', reload)}>Проверить сейчас</button>}>
      {(checks ?? []).length === 0 ? <Empty title="Проверок ещё не было" /> :
        <Table head={['Начата', 'Результат', 'Проверено файлов', 'Расхождения']}>{(checks ?? []).map((row) => <tr key={row.id} className="border-t border-surface-line text-xs">
          <td className={cell}>{row.started_at.slice(0, 19).replace('T', ' ')}</td><td className={cell}><Chip tone={row.status === 'OK' ? 'accent' : 'warn'}>{row.status}</Chip></td>
          <td className={cell}>{row.checked}</td><td className={cell}>{row.failures.map((item) => `${item.digest.slice(0, 12)}…: ${item.reason}`).join('; ') || '—'}</td>
        </tr>)}</Table>}
    </SectionCard>
    <SectionCard title="Резервное копирование" subtitle="База решений — каждые 15 минут, все базы — ежедневно; хранение 30 дней (ТЗ 12, п.8)." right={<button className="btn-ghost px-2 py-1 text-xs" onClick={() => void act(adminApi.backupNow, 'Резервная копия снята.', reloadBackups)}>Снять копию</button>}>
      <pre className="whitespace-pre-wrap text-xs text-ink-muted">{backups ? JSON.stringify(backups, null, 2) : '—'}</pre>
    </SectionCard>
  </div>
}
