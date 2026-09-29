import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Убийца устаревшего сервис-воркера (Г.111).
//
// Симптом, ради которого это написано: в браузере открывается СТАРАЯ версия
// приложения — экраны, которых в коде уже нет. Причина не в сборке: рабочую
// версию подменяет сервис-воркер, установленный прошлой сборкой. Он отдаёт
// свой кэш и переживает и перезапуск сервера, и обновление кода, и обычное
// обновление страницы.
//
// Само по себе это не чинится: пока по адресу /sw.js ничего нет, браузер
// оставляет прежнего воркера. Поэтому в режиме разработки по этому адресу
// отдаётся воркер-самоликвидатор: он чистит все кэши, снимает регистрацию и
// перезагружает открытые вкладки. После одного обновления страницы окно
// показывает то, что действительно лежит в коде.
function killStaleServiceWorker(): Plugin {
  const script = [
    "self.addEventListener('install', () => self.skipWaiting())",
    "self.addEventListener('activate', (event) => event.waitUntil((async () => {",
    "  for (const key of await caches.keys()) await caches.delete(key)",
    "  await self.registration.unregister()",
    "  for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url)",
    "})()))",
  ].join('\n')
  return {
    name: 'kill-stale-service-worker',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/sw.js') return next()
        res.setHeader('Content-Type', 'application/javascript')
        res.setHeader('Cache-Control', 'no-store')
        res.end(script)
      })
    },
  }
}

// Мобильный режим: офлайн обязателен — связь на стройке нестабильна.
export default defineConfig({
  plugins: [
    react(),
    killStaleServiceWorker(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        // Новая сборка обязана вытеснять предыдущую сразу, а не ждать,
        // пока пользователь закроет все вкладки: иначе он смотрит на старое
        // приложение и не понимает, почему правки не появились.
        clientsClaim: true,
        skipWaiting: true,
        cleanupOutdatedCaches: true,
        // Обращения к серверу сервис-воркер не перехватывает: это данные
        // проверки, а не оболочка приложения, и отдавать их из кэша значит
        // показывать инспектору вчерашний результат как сегодняшний.
        navigateFallbackDenylist: [/^\/api\//],
      },
      manifest: {
        name: 'Инспектор ИИ — сверка ПД, РД и ИД',
        short_name: 'Инспектор ИИ',
        description: 'Сверка ПД, РД и ИД по матрице параметров с решениями инспектора',
        theme_color: '#5B5BD6',
        background_color: '#F5F6F8',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
    }),
  ],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // REST API сервера (ТЗ 1.5). В контуре тот же путь проксирует nginx.
      '/api': {
        target: process.env.VITE_SERVER_URL || 'http://localhost:8010',
        changeOrigin: true,
      },
    },
  },
})
