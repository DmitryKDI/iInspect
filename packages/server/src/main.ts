/** Точка входа сервера «Инспектор ИИ». */
import { loadConfig } from './config.js'
import { start } from './server.js'

const config = loadConfig()
const running = await start(config)
await running.app.listen({ host: config.host, port: config.port })
running.ctx.log.info(`сервер слушает ${config.host}:${config.port}`, { event: 'startup' })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    running.ctx.log.info(`остановка по сигналу ${signal}`, { event: 'shutdown' })
    running.stop().finally(() => process.exit(0))
  })
}
