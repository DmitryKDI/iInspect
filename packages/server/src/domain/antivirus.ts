/**
 * Антивирусная проверка загружаемых файлов (ТЗ 12, п.11).
 *
 * Каждый файл проверяется ДО сохранения в хранилище антивирусом контура по
 * протоколу clamd (команда INSTREAM). Если антивирус задан, но недоступен,
 * файл не принимается: пропустить его без проверки значило бы выдать
 * отсутствие проверки за её успех. В промышленном контуре антивирус
 * обязателен — без адреса сервер файлы не принимает.
 */
import { createConnection } from 'node:net'

export const CLEAN = 'CLEAN'
export const INFECTED = 'INFECTED'
export const UNAVAILABLE = 'UNAVAILABLE'
export const NOT_CONFIGURED = 'NOT_CONFIGURED'

export interface ScanResult {
  status: typeof CLEAN | typeof INFECTED | typeof UNAVAILABLE | typeof NOT_CONFIGURED
  detail: string
}

// Размер куска потока INSTREAM, байт, и предельное время проверки.
const CHUNK = 1 << 16
const TIMEOUT_MS = 60_000

export function clamdScanner(host: string, port: number, required: boolean) {
  return (data: Buffer): Promise<ScanResult> => {
    if (!host) {
      return Promise.resolve(required
        ? { status: UNAVAILABLE, detail: 'антивирус контура не подключён (INSPECTOR_CLAMD_HOST)' }
        : { status: NOT_CONFIGURED, detail: 'антивирус контура не подключён' })
    }
    return new Promise((resolve) => {
      const socket = createConnection({ host, port })
      const chunks: Buffer[] = []
      const fail = (error: Error) => {
        socket.destroy()
        resolve({ status: UNAVAILABLE, detail: `антивирус недоступен: ${error.message}` })
      }
      socket.setTimeout(TIMEOUT_MS, () => fail(new Error('превышено время ожидания')))
      socket.on('error', fail)
      socket.on('data', (part: Buffer) => chunks.push(part))
      socket.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8').replace(/\0+$/, '').trim()
        if (text.endsWith('OK')) resolve({ status: CLEAN, detail: '' })
        else if (text.endsWith('FOUND')) {
          resolve({ status: INFECTED, detail: text.split(':').slice(1).join(':').trim() })
        } else resolve({ status: UNAVAILABLE, detail: `неожиданный ответ антивируса: ${text.slice(0, 200)}` })
      })
      socket.on('connect', () => {
        socket.write('zINSTREAM\0')
        for (let start = 0; start < data.length; start += CHUNK) {
          const piece = data.subarray(start, start + CHUNK)
          const size = Buffer.alloc(4)
          size.writeUInt32BE(piece.length)
          socket.write(size)
          socket.write(piece)
        }
        socket.write(Buffer.alloc(4))
      })
    })
  }
}
