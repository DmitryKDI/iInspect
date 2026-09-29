import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SessionUser } from './authApi'

/** Состояние оболочки интерфейса. Данные проверки живут на сервере и
 *  запрашиваются экраном напрямую: в браузере хранится только вид и то,
 *  кто вошёл (сам токен — в HttpOnly-cookie, скрипту он недоступен). */
interface AppState {
  menuCollapsed: boolean
  toggleMenu: () => void
  user: SessionUser | null
  setUser: (user: SessionUser | null) => void
}

export const useApp = create<AppState>()(
  persist(
    (set) => ({
      menuCollapsed: false,
      toggleMenu: () => set((s) => ({ menuCollapsed: !s.menuCollapsed })),
      user: null,
      setUser: (user) => set({ user }),
    }),
    {
      name: 'nadzor.app',
      version: 3,
      // Пользователь не сохраняется в браузере: после перезагрузки страницы
      // сессия проверяется сервером заново.
      partialize: (state) => ({ menuCollapsed: state.menuCollapsed }),
    },
  ),
)
