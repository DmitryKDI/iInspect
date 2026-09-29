import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { SESSION_EXPIRED, authApi, can } from './authApi'
import Shell from './layout/Shell'
import Admin from './pages/Admin'
import Dashboard from './pages/Dashboard'
import Login from './pages/Login'
import Ml from './pages/Ml'
import OfficialAnalysis from './pages/OfficialAnalysis'
import { useApp } from './store'

export default function App() {
  const location = useLocation()
  const { user, setUser } = useApp()
  const [checked, setChecked] = useState(false)
  useEffect(() => { window.scrollTo(0, 0) }, [location.pathname])

  // Сессия проверяется сервером при каждом открытии: в браузере хранится
  // только cookie, и её срок знает сервер, а не интерфейс.
  useEffect(() => {
    authApi.session().then((state) => setUser(state.user)).catch(() => setUser(null)).finally(() => setChecked(true))
    const expired = () => setUser(null)
    window.addEventListener(SESSION_EXPIRED, expired)
    return () => window.removeEventListener(SESSION_EXPIRED, expired)
  }, [setUser])

  if (!checked) return null
  if (!user) return <Login onLogin={setUser} />

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<OfficialAnalysis />} />
        <Route path="/objects" element={<Dashboard />} />
        {can(user) && <Route path="/admin" element={<Admin />} />}
        {can(user, 'ml_engineer', 'supervisor') && <Route path="/ml" element={<Ml />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  )
}
