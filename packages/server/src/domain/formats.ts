/**
 * Формат загружаемого файла (ТЗ 9.1, «Обработка ошибок при загрузке»).
 *
 * Формат определяется по содержимому, а не по расширению: расширение
 * приходит от загружающей стороны и ничего не доказывает. Принимаются PDF,
 * DOCX и XML (ТЗ 9.1) и чертежи DWG/DXF (ТЗ 11, п.8). Повреждённый файл
 * отклоняется при приёме с причиной — пользователь узнаёт о нём сразу, а не
 * по пустому протоколу.
 */
import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import { PDFDocument } from 'pdf-lib'
import { convertCad } from './cad.js'

export const SUPPORTED = 'PDF, DOCX, XML, DWG, DXF'

export class FormatError extends Error {}

export interface Inspected {
  format: 'PDF' | 'DOCX' | 'XML' | 'DWG' | 'DXF'
  pages: number
  /** Производный файл для разбора (DXF из чертежа). */
  derived?: { format: 'DXF'; data: Buffer }
}

function startsWith(data: Buffer, text: string): boolean {
  return data.subarray(0, text.length).toString('latin1') === text
}

const DWG_VERSIONS = /^AC10(1[2-8]|2[1-7]|32)$/

export function detect(data: Buffer): Inspected['format'] | null {
  if (startsWith(data, '%PDF-')) return 'PDF'
  if (startsWith(data, 'PK\x03\x04')) return 'DOCX' // уточняется при проверке содержимого
  if (DWG_VERSIONS.test(data.subarray(0, 6).toString('latin1'))) return 'DWG'
  const head = data.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart()
  if (/^0\s*\r?\n\s*SECTION/.test(head) || startsWith(data, 'AutoCAD Binary DXF')) return 'DXF'
  if (head.startsWith('<')) return 'XML'
  return null
}

/** Проверить файл и вернуть число страниц; отказ — FormatError с причиной. */
export async function inspect(data: Buffer, maxPages: number): Promise<Inspected> {
  if (!data.length) throw new FormatError('пустой файл')
  const format = detect(data)
  if (!format) throw new FormatError(`неподдерживаемый формат; поддерживаются ${SUPPORTED}`)
  if (format === 'PDF') {
    let pages: number
    try {
      const document = await PDFDocument.load(data, { updateMetadata: false, throwOnInvalidObject: false })
      pages = document.getPageCount()
    } catch (error) {
      const message = (error as Error).message
      if (/encrypt/i.test(message)) throw new FormatError('PDF защищён паролем; загрузите файл без защиты')
      throw new FormatError('повреждённый PDF: файл не открывается, загрузите его повторно')
    }
    if (pages < 1) throw new FormatError('повреждённый PDF: в файле нет страниц')
    if (pages > maxPages) throw new FormatError(`в документе ${pages} страниц при пределе ${maxPages}`)
    return { format, pages }
  }
  if (format === 'DOCX') {
    let zip: JSZip
    try {
      zip = await JSZip.loadAsync(data)
    } catch {
      throw new FormatError('повреждённый DOCX: архив не читается')
    }
    const body = zip.file('word/document.xml')
    if (!body) throw new FormatError(`неподдерживаемый формат (ZIP без документа Word); поддерживаются ${SUPPORTED}`)
    const xml = await body.async('string')
    rejectDtd(xml)
    if (XMLValidator.validate(xml) !== true) throw new FormatError('повреждённый DOCX: текст документа не читается')
    return { format, pages: 0 }
  }
  if (format === 'XML') {
    const text = data.toString('utf8').replace(/^﻿/, '')
    rejectDtd(text)
    const result = XMLValidator.validate(text)
    if (result !== true) throw new FormatError(`повреждённый XML: ${result.err.msg} (строка ${result.err.line})`)
    return { format, pages: 0 }
  }
  try {
    const converted = await convertCad(data, format)
    return { format, pages: 1, derived: { format: 'DXF', data: converted.dxf } }
  } catch (error) {
    throw new FormatError((error as Error).message)
  }
}

/** XML с DTD не принимается: через DTD идут внешние сущности (XXE) и их раздувание. */
function rejectDtd(text: string): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new FormatError('XML с объявлением DTD/сущностей не принимается')
  }
}
