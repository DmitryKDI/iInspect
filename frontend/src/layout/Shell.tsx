import { type ReactNode, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { authApi, can, type Role } from '../authApi'
import ChangePassword from '../components/ChangePassword'
import { useApp } from '../store'

const MENU: { to: string; label: string; icon: string; roles?: Role[] }[] = [
  { to: '/objects', label: 'Объекты', icon: '◉' },
  { to: '/', label: 'Проверка ПД–РД–ИД', icon: '▤' },
  { to: '/ml', label: 'Дообучение', icon: '◈', roles: ['ml_engineer', 'supervisor'] },
  { to: '/admin', label: 'Администрирование', icon: '⚙', roles: [] },
]

const TITLES: Record<string, string> = {
  '/': 'Проверка комплекта по матрице ТЗ',
  '/objects': 'Дашборд объектов',
  '/ml': 'Обратная связь и дообучение',
  '/admin': 'Администрирование',
}

export default function Shell({ children }: { children: ReactNode }) {
  const location = useLocation()
  const { menuCollapsed, toggleMenu, user, setUser } = useApp()
  const title = TITLES[location.pathname] ?? 'Инспектор ИИ'
  const [changingPassword, setChangingPassword] = useState(false)

  async function logout() {
    await authApi.logout().catch(() => undefined)
    setUser(null)
  }

  return (
    <div className="flex min-h-screen bg-surface-muted">
      <aside
        className={`no-print sticky top-0 hidden h-screen shrink-0 border-r border-surface-line bg-surface transition-[width] duration-200 md:block ${
          menuCollapsed ? 'w-[72px]' : 'w-[244px]'
        }`}
      >
        <div className="flex h-[72px] items-center gap-3 border-b border-surface-line px-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-sm font-bold text-white shadow-sm">ИИ</div>
          {!menuCollapsed && (
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold tracking-wide text-ink">Инспектор ИИ</div>
              <div className="truncate text-[11px] text-ink-faint">сверка ПД, РД и ИД</div>
            </div>
          )}
          <button
            className="ml-auto rounded-md p-1.5 text-ink-faint hover:bg-surface-muted hover:text-ink"
            onClick={toggleMenu}
            aria-label={menuCollapsed ? 'Развернуть меню' : 'Свернуть меню'}
          >
            {menuCollapsed ? '›' : '‹'}
          </button>
        </div>

        <nav className="p-3">
          <ul className="space-y-1">
            {MENU.filter((item) => !item.roles || can(user, ...item.roles)).map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
                      isActive
                        ? 'bg-accent-soft font-medium text-accent'
                        : 'text-ink-muted hover:bg-surface-muted hover:text-ink'
                    }`
                  }
                  title={item.label}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center text-base">{item.icon}</span>
                  {!menuCollapsed && <span className="truncate">{item.label}</span>}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        {!menuCollapsed && (
          <div className="absolute bottom-5 left-3 right-3 rounded-xl border border-surface-line bg-surface-muted/60 p-3">
            <div className="text-xs font-medium text-ink">Режим инспектора</div>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
              ПД задаёт проектное решение. РД и ИД сопоставляются с ним по матрице ТЗ.
            </p>
          </div>
        )}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-20 flex h-[72px] items-center gap-4 border-b border-surface-line bg-surface/95 px-4 backdrop-blur md:px-6">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold text-ink">{title}</h1>
            <p className="truncate text-xs text-ink-faint">Документы, расхождения, источники и решения инспектора</p>
          </div>
          <div className="hidden items-center gap-2 lg:flex">
            <div className="rounded-lg border border-surface-line bg-surface-muted/50 px-3 py-2 text-xs text-ink-muted">
              Выводы ИИ требуют подтверждения инспектором
            </div>
          </div>
          {user && (
            <div className="flex items-center gap-3">
              <div className="text-right text-xs">
                <div className="font-medium text-ink">{user.full_name || user.login}</div>
                <div className="text-ink-faint">{user.role_title}</div>
              </div>
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setChangingPassword(true)}>Сменить пароль</button>
              <button className="btn-ghost px-2 py-1 text-xs" onClick={logout}>Выйти</button>
            </div>
          )}
        </header>

        <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
        {changingPassword && <ChangePassword onClose={() => setChangingPassword(false)} />}
      </div>

    </div>
  )
}
