import { useState, type FormEvent } from 'react'
import { AuthError, authApi, type SessionUser } from '../authApi'

export default function Login({ onLogin }: { onLogin: (user: SessionUser) => void }) {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { user } = await authApi.login(login.trim(), password)
      onLogin(user)
    } catch (err) {
      setError(err instanceof AuthError ? err.message : 'Сервер недоступен. Повторите попытку.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-muted p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6" aria-label="Вход">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-sm font-bold text-white">ИИ</div>
          <div>
            <h1 className="text-base font-semibold text-ink">Инспектор ИИ</h1>
            <p className="text-xs text-ink-faint">сверка ПД, РД и ИД</p>
          </div>
        </div>
        <label className="block space-y-1 text-sm">
          <span className="text-ink-muted">Логин</span>
          <input className="input" name="login" autoComplete="username" value={login}
            onChange={(e) => setLogin(e.target.value)} required autoFocus />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="text-ink-muted">Пароль</span>
          <input className="input" name="password" type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p role="alert" className="text-sm text-critical">{error}</p>}
        <button className="btn-primary w-full justify-center" disabled={busy} type="submit">
          {busy ? 'Вход…' : 'Войти'}
        </button>
      </form>
    </div>
  )
}
