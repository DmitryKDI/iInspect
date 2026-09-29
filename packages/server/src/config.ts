/**
 * Настройки сервера из окружения развёртывания.
 *
 * Все адреса — внутри закрытого контура: база, файловое хранилище, очередь
 * сообщений (RabbitMQ), кэш (Redis), ML-сервис и антивирус. Секреты (ключи
 * шифрования, служебный токен) читаются из переменной окружения или из файла
 * в каталоге секретов — в репозиторий они не попадают.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

function env(name: string, fallback = ''): string {
  const value = process.env[name]
  return value === undefined ? fallback : value.trim()
}

function intEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(env(name, ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Секрет из переменной окружения или из файла `<secretsDir>/<file>`. */
function secret(name: string, file: string, secretsDir: string): string {
  const direct = env(name)
  if (direct) return direct
  const candidate = path.join(secretsDir, file)
  return existsSync(candidate) ? readFileSync(candidate, 'utf8').trim() : ''
}

export interface Config {
  env: 'production' | 'test' | 'development'
  host: string
  port: number
  dataDir: string
  dbPath: string
  storageDir: string
  backupDir: string
  logDir: string
  logLevel: string
  dbKey: string
  storageKey: string
  internalToken: string
  amqpUrl: string
  redisUrl: string
  mlUrl: string
  clamdHost: string
  clamdPort: number
  rinUrl: string
  rinToken: string
  rinClientCert: string
  rinClientKey: string
  rinCa: string
  allowedHosts: string[]
  cookieSecure: boolean
  adminLogin: string
  adminPassword: string
  catalogPath: string
  datasetVersion: string
  taskTimeoutS: number
  inspectTimeoutS: number
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const root = path.resolve(env('INSPECTOR_ROOT', path.resolve(import.meta.dirname, '../../..')))
  const dataDir = env('INSPECTOR_DATA_DIR', path.join(root, 'packages/server/data'))
  const secretsDir = env('INSPECTOR_SECRETS_DIR', path.join(root, 'secrets'))
  const mode = env('INSPECTOR_ENV', env('NODE_ENV', 'development'))
  const base: Config = {
    env: mode === 'production' ? 'production' : mode === 'test' ? 'test' : 'development',
    host: env('INSPECTOR_HOST', '0.0.0.0'),
    port: intEnv('INSPECTOR_PORT', 8010),
    dataDir,
    dbPath: env('INSPECTOR_DB_PATH', path.join(dataDir, 'inspector.db')),
    storageDir: env('INSPECTOR_STORAGE_DIR', path.join(dataDir, 'storage')),
    backupDir: env('INSPECTOR_BACKUP_DIR'),
    logDir: env('INSPECTOR_LOG_DIR'),
    logLevel: env('INSPECTOR_LOG_LEVEL', 'info').toLowerCase(),
    dbKey: secret('INSPECTOR_DB_KEY', 'db.key', secretsDir),
    storageKey: secret('INSPECTOR_STORAGE_KEY', 'storage.key', secretsDir),
    internalToken: secret('INSPECTOR_INTERNAL_TOKEN', 'internal.token', secretsDir),
    amqpUrl: env('INSPECTOR_AMQP_URL'),
    redisUrl: env('INSPECTOR_REDIS_URL'),
    mlUrl: env('INSPECTOR_ML_URL'),
    clamdHost: env('INSPECTOR_CLAMD_HOST'),
    clamdPort: intEnv('INSPECTOR_CLAMD_PORT', 3310),
    rinUrl: env('INSPECTOR_RIN_URL'),
    rinToken: secret('INSPECTOR_RIN_TOKEN', 'rin.token', secretsDir),
    rinClientCert: env('INSPECTOR_RIN_CLIENT_CERT'),
    rinClientKey: env('INSPECTOR_RIN_CLIENT_KEY'),
    rinCa: env('INSPECTOR_RIN_CA'),
    allowedHosts: env('INSPECTOR_ALLOWED_HOSTS').split(',').map((item) => item.trim().toLowerCase())
      .filter(Boolean),
    cookieSecure: ['1', 'true', 'yes'].includes(env('INSPECTOR_COOKIE_SECURE', '1').toLowerCase()),
    adminLogin: env('INSPECTOR_ADMIN_LOGIN', 'admin'),
    adminPassword: env('INSPECTOR_ADMIN_PASSWORD', 'admin'),
    catalogPath: env('INSPECTOR_CATALOG_PATH', path.join(root, 'data/parameter_catalog_v1_1.json')),
    datasetVersion: env('INSPECTOR_DATASET_VERSION', 'none'),
    // ТЗ 9.1: таймаут обработки файла — повтор до двух раз, затем уведомление
    // администратора. Разбор тома и проверка комплекта длятся разное время.
    taskTimeoutS: intEnv('INSPECTOR_PARSE_TIMEOUT_S', 900),
    inspectTimeoutS: intEnv('INSPECTOR_INSPECT_TIMEOUT_S', 3600),
  }
  return { ...base, ...overrides }
}
