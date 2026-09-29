/**
 * Файловое хранилище оригиналов (ТЗ 9.1; 12, п.3, 7).
 *
 * Ключ записи — SHA-256 исходного файла: тот же файл, загруженный повторно,
 * места не занимает, а контрольная сумма и есть имя. Содержимое на диске
 * зашифровано AES-256-GCM: метка GCM не даёт незаметно изменить файл, а
 * сверка SHA-256 после расшифровки — подменить его целиком (ежедневная
 * проверка целостности, ТЗ 13, п.8).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'

const MAGIC = Buffer.from('INSP1')
const IV_BYTES = 12
const TAG_BYTES = 16

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

export class FileStore {
  private readonly key: Buffer

  constructor(private readonly root: string, secret: string) {
    if (!secret) throw new Error('ключ шифрования хранилища не задан')
    this.key = createHash('sha256').update(`inspector-storage:${secret}`).digest()
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }

  private location(digest: string): string {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('некорректный отпечаток файла')
    return path.join(this.root, digest.slice(0, 2), `${digest}.bin`)
  }

  has(digest: string): boolean {
    return existsSync(this.location(digest))
  }

  /** Сохранить файл; возвращает его SHA-256. Повторная запись того же содержимого не нужна. */
  put(data: Buffer): string {
    const digest = sha256(data)
    const target = this.location(digest)
    if (existsSync(target)) return digest
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(digest))
    const body = Buffer.concat([cipher.update(data), cipher.final()])
    const partial = `${target}.partial-${process.pid}`
    writeFileSync(partial, Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]), { mode: 0o600 })
    renameSync(partial, target) // файл появляется целиком или не появляется
    return digest
  }

  /** Расшифрованное содержимое; null — файла нет. Порча — исключение с причиной. */
  read(digest: string): Buffer | null {
    const target = this.location(digest)
    if (!existsSync(target)) return null
    const raw = readFileSync(target)
    if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('неизвестный формат записи')
    const iv = raw.subarray(MAGIC.length, MAGIC.length + IV_BYTES)
    const tag = raw.subarray(raw.length - TAG_BYTES)
    const body = raw.subarray(MAGIC.length + IV_BYTES, raw.length - TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAAD(Buffer.from(digest))
    decipher.setAuthTag(tag)
    let data: Buffer
    try {
      data = Buffer.concat([decipher.update(body), decipher.final()])
    } catch {
      throw new Error('метка шифрования не совпала: файл изменён или повреждён')
    }
    if (sha256(data) !== digest) throw new Error('SHA-256 содержимого не совпадает с отпечатком')
    return data
  }

  remove(digest: string): boolean {
    const target = this.location(digest)
    if (!existsSync(target)) return false
    rmSync(target)
    return true
  }

  digests(): string[] {
    if (!existsSync(this.root)) return []
    const found: string[] = []
    for (const shard of readdirSync(this.root)) {
      const folder = path.join(this.root, shard)
      if (!statSync(folder).isDirectory()) continue
      for (const name of readdirSync(folder)) {
        const match = /^([0-9a-f]{64})\.bin$/.exec(name)
        if (match) found.push(match[1])
      }
    }
    return found.sort()
  }

  /** Проверка каждого файла: расшифровка и сверка SHA-256 (ТЗ 13, п.8). */
  verifyAll(): { checked: number; failures: { digest: string; reason: string }[] } {
    const failures: { digest: string; reason: string }[] = []
    const all = this.digests()
    for (const digest of all) {
      try {
        this.read(digest)
      } catch (error) {
        failures.push({ digest, reason: (error as Error).message })
      }
    }
    return { checked: all.length, failures }
  }
}
