import { useState, type FormEvent } from 'react'
import { authApi } from '../authApi'

/** Смена собственного пароля: текущий пароль, новый и повтор. */
export default function ChangePassword({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (next.length < 8) { setError('Новый пароль — не короче 8 символов.'); return }
    if (next !== repeat) { setError('Новый пароль и повтор не совпадают.'); return }
    if (next === current) { setError('Новый пароль совпадает с текущим.'); return }
    setBusy(true)
    try {
      await authApi.changePassword(current, next)
      setDone(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Пароль не изменён.')
    } finally {
      setBusy(false)
    }
  }

  const field = 'mt-1 block w-full rounded-lg border border-surface-line px-3 py-2 text-sm'
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-labelledby="change-password-title">
    <form className="card w-full max-w-sm p-5" onSubmit={submit}>
      <h2 id="change-password-title" className="text-base font-semibold text-ink">Смена пароля</h2>
      {done ? <>
        <p className="mt-3 text-sm text-ink-muted">Пароль изменён. При следующем входе используйте новый пароль.</p>
        <div className="mt-4 flex justify-end"><button type="button" className="btn-primary px-3 py-1.5 text-sm" onClick={onClose}>Готово</button></div>
      </> : <>
        <label className="mt-3 block text-xs text-ink-muted">Текущий пароль
          <input className={field} type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} required /></label>
        <label className="mt-3 block text-xs text-ink-muted">Новый пароль (не короче 8 символов)
          <input className={field} type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} required /></label>
        <label className="mt-3 block text-xs text-ink-muted">Повторите новый пароль
          <input className={field} type="password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} required /></label>
        {error && <p className="mt-3 text-sm text-critical" role="alert">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn-ghost px-3 py-1.5 text-sm" onClick={onClose}>Отмена</button>
          <button type="submit" className="btn-primary px-3 py-1.5 text-sm" disabled={busy}>{busy ? 'Сохраняю…' : 'Сменить пароль'}</button>
        </div>
      </>}
    </form>
  </div>
}
