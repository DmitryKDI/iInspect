/**
 * Подключение к базе: SQLite с шифрованием SQLCipher (ТЗ 12, п.3).
 *
 * Файл базы без ключа не открывается и не читается. Режим WAL даёт чтение
 * параллельно с записью — интерфейс инспектора не ждёт, пока пишется
 * результат проверки.
 */
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { MIGRATIONS } from './schema.js'

export type Db = Database.Database

export function openDatabase(file: string, key: string): Db {
  if (!key) throw new Error('ключ шифрования базы не задан')
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new Database(file)
  db.pragma(`cipher='sqlcipher'`)
  db.pragma(`key='${key.replace(/'/g, "''")}'`)
  // Проверка ключа: неверный ключ даёт «file is not a database» на первом чтении.
  db.prepare('SELECT count(*) FROM sqlite_master').get()
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let index = current; index < MIGRATIONS.length; index += 1) {
    db.transaction(() => {
      db.exec(MIGRATIONS[index])
      db.pragma(`user_version = ${index + 1}`)
    })()
  }
}

export function nowIso(date: Date = new Date()): string {
  return date.toISOString()
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

export function fromJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function bool(value: unknown): boolean {
  return value === 1 || value === true || value === '1'
}
