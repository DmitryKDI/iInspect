/**
 * Пароли и токены сессий (ТЗ 12, п.1).
 *
 * Пароль хранится только хешем scrypt с солью; сравнение — за постоянное
 * время. Токен сессии — случайная строка, в базе лежит его SHA-256, поэтому
 * утечка базы не даёт действующих токенов.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

// Параметры scrypt: стоимость перебора пароля при утечке базы.
const SCRYPT_N = 2 ** 14
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_BYTES = 64
// Минимальная длина пароля — политика доступа, а не порог правды.
export const MIN_PASSWORD_LENGTH = 8

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const digest = scryptSync(password, salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'),
    digest.toString('base64')].join('$')
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, salt, digest] = parts
  try {
    const expected = Buffer.from(digest, 'base64')
    const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length,
      { N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024 })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
