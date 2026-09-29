/**
 * Чертежи DWG и DXF (ТЗ 11, п.8: CV-анализ одного чертежа DWG).
 *
 * При приёме чертёж читается целиком: повреждённый файл отклоняется сразу,
 * как повреждённый PDF (ТЗ 9.1). Прочитанный чертёж приводится к DXF версии
 * AC1032 в UTF-8 — одному формату для ML-модулей, где из него извлекаются
 * тексты, размеры и линии с координатами. Чтение идёт в отдельном потоке:
 * разбор большого чертежа не должен останавливать ответы другим
 * пользователям.
 *
 * Библиотека чтения и записи DWG/DXF — acad-ts (MIT), без внешних программ.
 */
import { Worker } from 'node:worker_threads'

export interface CadConversion {
  dxf: Buffer
  entities: number
  version: string
}

// Сколько ждать разбора одного чертежа, мс: ТЗ 11, п.8 — не более 30 секунд
// на CV-анализ чертежа; приём файла не должен занимать больше этого бюджета.
const CONVERT_TIMEOUT_MS = 30_000

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
import(workerData.module).then((A) => {
  try {
    const bytes = Buffer.from(workerData.data)
    const doc = workerData.format === 'DWG'
      ? A.DwgReader.readFromStream(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), () => {})
      : A.DxfReader.readFromStream(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), () => {})
    const version = String(A.ACadVersion[doc.header.version] ?? doc.header.version)
    const entities = doc.modelSpace ? [...doc.modelSpace.entities].length : 0
    doc.header.version = A.ACadVersion.AC1032
    let dxf = ''
    A.DxfWriter.writeToStream({ write: (chunk) => { dxf += chunk } }, doc, false)
    parentPort.postMessage({ ok: true, dxf, entities, version })
  } catch (error) {
    parentPort.postMessage({ ok: false, error: String(error && error.message || error) })
  }
}, (error) => parentPort.postMessage({ ok: false, error: String(error) }))
`

// Версии DXF, текст которых по спецификации всегда в UTF-8 (AutoCAD 2007+).
const UTF8_DXF_VERSIONS = new Set(['AC1021', 'AC1024', 'AC1027', 'AC1032'])

/**
 * DXF 2007+ хранит текст в UTF-8 независимо от $DWGCODEPAGE, а acad-ts
 * декодирует его по кодовой странице из заголовка (обычно ANSI_1252) — и
 * кириллица превращается в «ÐŸÐ»Ð°Ð½». Для таких файлов кодовая страница в
 * заголовке заменяется меткой utf-8 до чтения; байты текста не меняются.
 */
export function normalizeDxfEncoding(data: Buffer): Buffer {
  if (data.subarray(0, 22).toString('latin1').startsWith('AutoCAD Binary DXF')) return data
  const text = data.toString('latin1')
  const version = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d{4})/.exec(text.slice(0, 65_536))?.[1]
  if (!version || !UTF8_DXF_VERSIONS.has(version)) return data
  return Buffer.from(text.replace(/(\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n)[^\r\n]*/, '$1utf-8'), 'latin1')
}

export function convertCad(data: Buffer, format: 'DWG' | 'DXF'): Promise<CadConversion> {
  const source = format === 'DXF' ? normalizeDxfEncoding(data) : data
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true,
      workerData: { data: source, format, module: import.meta.resolve('@node-projects/acad-ts') } })
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error(`чертёж не прочитан за ${CONVERT_TIMEOUT_MS / 1000} с`))
    }, CONVERT_TIMEOUT_MS)
    worker.once('message', (message: { ok: boolean; dxf?: string; entities?: number;
      version?: string; error?: string }) => {
      clearTimeout(timer)
      void worker.terminate()
      if (!message.ok) {
        reject(new Error(`чертёж ${format} повреждён или не поддерживается: ${message.error}`))
        return
      }
      if (!message.entities) {
        reject(new Error(`в чертеже ${format} нет объектов пространства модели`))
        return
      }
      resolve({ dxf: Buffer.from(message.dxf ?? '', 'utf8'), entities: message.entities,
        version: message.version ?? '' })
    })
    worker.once('error', (error: Error) => {
      clearTimeout(timer)
      reject(new Error(`чертёж ${format} не прочитан: ${error.message}`))
    })
  })
}
