import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './index.css'

// Скрипт запуска открывает приложение с уникальным ?started=... на каждый
// запуск. Это граница рабочей сессии: старые id прогонов, фильтры и отметки
// из Zustand persist не должны переноситься в новый комплект документов.
// Обычный F5 внутри уже запущенной сессии состояние не стирает.
const launchParams = new URLSearchParams(window.location.search)
if (launchParams.has('started')) {
  window.localStorage.removeItem('nadzor.app')
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
