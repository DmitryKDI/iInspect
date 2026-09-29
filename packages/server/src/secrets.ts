/**
 * Ключи шифрования данных в покое (ТЗ 12, п.3).
 *
 * В промышленном контуре ключи обязаны прийти из окружения или каталога
 * секретов: без них сервер не стартует, потому что незашифрованная база
 * нарушала бы требование ТЗ молча. На стенде разработки ключи создаются
 * один раз и сохраняются отдельно от данных, о чём пишется предупреждение.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Config } from './config.js'

const KEY_BYTES = 32

function devKey(dir: string, file: string): string {
  const target = path.join(dir, file)
  if (existsSync(target)) return readFileSync(target, 'utf8').trim()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const value = randomBytes(KEY_BYTES).toString('base64')
  writeFileSync(target, value, { mode: 0o600 })
  return value
}

export function ensureKeys(config: Config, warn: (message: string) => void): Config {
  const missing = (['dbKey', 'storageKey', 'internalToken'] as const).filter((key) => !config[key])
  if (!missing.length) return config
  if (config.env === 'production') {
    throw new Error(`не заданы секреты: ${missing.join(', ')} — задайте INSPECTOR_DB_KEY, ` +
      'INSPECTOR_STORAGE_KEY, INSPECTOR_INTERNAL_TOKEN или положите файлы в каталог секретов')
  }
  const dir = path.join(path.dirname(config.dataDir), 'dev-secrets')
  warn(`секреты не заданы (${missing.join(', ')}): созданы ключи стенда разработки в ${dir}`)
  return {
    ...config,
    dbKey: config.dbKey || devKey(dir, 'db.key'),
    storageKey: config.storageKey || devKey(dir, 'storage.key'),
    internalToken: config.internalToken || devKey(dir, 'internal.token'),
  }
}
