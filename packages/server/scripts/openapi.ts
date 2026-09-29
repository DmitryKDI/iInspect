/**
 * Выгрузка схемы внешнего API (OpenAPI 3.0.3) в docs/openapi.json.
 *
 * Схема собирается из тех же JSON-схем маршрутов, которыми сервер проверяет
 * запросы, поэтому документ и поведение не расходятся. Сервер поднимается
 * во временном каталоге без брокера и ML-модулей: нужны только маршруты.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.js'
import { MemoryBroker } from '../src/queue/broker.js'
import { MemoryFlags } from '../src/queue/flags.js'
import { Logger } from '../src/observability/logging.js'
import { start } from '../src/server.js'

const dir = mkdtempSync(path.join(tmpdir(), 'inspector-openapi-'))
const config = loadConfig({ env: 'test', dataDir: dir, dbPath: path.join(dir, 'db.sqlite'),
  storageDir: path.join(dir, 'storage'), dbKey: 'openapi', storageKey: 'openapi',
  internalToken: 'openapi', backupDir: '', cookieSecure: false })
const unused = async (): Promise<never> => { throw new Error('ML-модули не нужны для схемы') }
const running = await start(config, {
  broker: new MemoryBroker(), flags: new MemoryFlags(), log: new Logger('error', false, '', () => undefined),
  ml: { renderPage: unused, llmCheck: unused, evaluate: unused, validateRule: unused },
}, false)
const response = await running.app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
const target = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/openapi.json')
writeFileSync(target, `${JSON.stringify(response.json(), null, 2)}\n`)
await running.stop()
rmSync(dir, { recursive: true, force: true })
console.log(`схема записана: ${target}`)
