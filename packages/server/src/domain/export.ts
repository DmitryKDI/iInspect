/**
 * Выгрузка протокола в XML, DOCX и PDF (ТЗ 7, модуль 7; 9.2, п.4).
 *
 * Содержимое одно во всех форматах — собранный протокол: статус загрузки,
 * сценарий, версии и пять таблиц с карточками доказательств. Формат меняет
 * только оформление, поэтому протокол в PDF не может разойтись с JSON.
 */
import { existsSync } from 'node:fs'
import {
  Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, WidthType,
} from 'docx'
import PDFDocument from 'pdfkit'
import type { Json } from './protocol.js'

export const TABLE_TITLES: Record<string, string> = {
  completeness: '1. Комплектность и сопоставимость',
  candidates: '2. Предварительные кандидаты',
  confirmed_violations: '3. Подтверждённые инспектором нарушения',
  negative_verified: '4. Проверенные отрицательные результаты',
  suspicions: '5. Гипотезы свободного поиска',
}

const FONT_CANDIDATES = ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf']

function header(table: string): string[] {
  return table === 'completeness' ? ['Параметр', 'Полнота', 'Причина']
    : ['Параметр', 'Ожидается', 'Факт', 'Источники (стадия, шифр, редакция, лист, bbox)', 'Решение инспектора']
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

function rows(table: string, items: Json[]): string[][] {
  if (table === 'completeness') {
    return items.map((item) => [`${text(item.parameter_code)} ${text(item.parameter_name)}`.trim(),
      text(item.completeness_status), text(item.reason)])
  }
  return items.map((card) => {
    const sources = (card.sources ?? []).map((source: Json) =>
      `${text(source.stage)} ${text(source.document_code)} ред.${text(source.revision) || '?'} ` +
      `стр.${text(source.page)}${source.bbox_polygon ? ` [${(source.bbox_polygon as number[]).map((n) =>
        Number(n).toFixed(3)).join(', ')}]` : ''}`).join('; ')
    const decision = [text(card.inspector_decision), text(card.inspector_reason_code),
      text(card.inspector_comment)].filter(Boolean).join(' — ')
    return [`${text(card.parameter_code)} ${text(card.parameter_name)}`.trim(),
      text(card.expected_value), text(card.actual_value), sources, decision]
  })
}

function summary(payload: Json): string[] {
  const proto = payload.protocol
  const versions = proto.versions
  return [
    `Процесс: ${payload.process_id}   Объект: ${text(payload.object_id)}`,
    `Статус: ${proto.status}   Верификация: ${proto.verification_status}`,
    `Статус загрузки документов: ${Object.values(proto.upload_status).join(', ')}`,
    `Тип проверки: ${proto.scenario}`,
    `Версии: матрица ${versions.matrix_version}, модель ${versions.model_version}, ` +
      `набор данных ${versions.dataset_version}`,
    `Входной манифест: ${versions.input_manifest_hash}`,
    'Результаты — гипотезы для проверки инспектором, а не заключение о нарушении.',
  ]
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

function attributes(record: Json): string {
  return Object.entries(record).filter(([, value]) => value !== null && value !== undefined &&
    typeof value !== 'object').map(([key, value]) => ` ${key}="${escapeXml(String(value))}"`).join('')
}

export function toXml(payload: Json): Buffer {
  const proto = payload.protocol
  const lines = ['<?xml version="1.0" encoding="utf-8"?>',
    `<protocol${attributes({ process_id: payload.process_id, object_id: payload.object_id ?? '',
      status: proto.status, verification_status: proto.verification_status, scenario: proto.scenario })}>`,
    `  <versions${attributes(proto.versions)}/>`, '  <upload_status>',
    ...Object.entries(proto.upload_status).map(([stage, status]) =>
      `    <stage code="${stage}" status="${status}"/>`), '  </upload_status>']
  for (const [table, items] of Object.entries(proto.tables as Record<string, Json[]>)) {
    lines.push(`  <${table}>`)
    for (const item of items) {
      const sources = (item.sources ?? []) as Json[]
      const plain = Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'sources'))
      if (!sources.length) {
        lines.push(`    <item${attributes(plain)}/>`)
        continue
      }
      lines.push(`    <item${attributes(plain)}>`)
      for (const source of sources) {
        const bbox = source.bbox_polygon ? { bbox_polygon: JSON.stringify(source.bbox_polygon) } : {}
        lines.push(`      <source${attributes({ ...source, ...bbox })}/>`)
      }
      lines.push('    </item>')
    }
    lines.push(`  </${table}>`)
  }
  lines.push('</protocol>')
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8')
}

export async function toDocx(payload: Json): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ text: 'Протокол проверки ПД / РД / ИД', heading: HeadingLevel.HEADING_1 }),
    ...summary(payload).map((line) => new Paragraph(line)),
  ]
  for (const [table, items] of Object.entries(payload.protocol.tables as Record<string, Json[]>)) {
    children.push(new Paragraph({ text: TABLE_TITLES[table], heading: HeadingLevel.HEADING_2 }))
    if (!items.length) {
      children.push(new Paragraph('Записей нет.'))
      continue
    }
    const make = (cells: string[]) => new TableRow({ children: cells.map((cell) =>
      new TableCell({ children: [new Paragraph(cell)] })) })
    children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [make(header(table)), ...rows(table, items).map(make)] }))
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }))
}

function font(): string {
  const found = FONT_CANDIDATES.find((file) => existsSync(file))
  // Без шрифта с кириллицей PDF вышел бы пустыми квадратами — честнее отказать.
  if (!found) throw new Error('шрифт с кириллицей не найден: установите fonts-dejavu-core')
  return found
}

export function toPdf(payload: Json): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 })
    const chunks: Buffer[] = []
    document.on('data', (chunk: Buffer) => chunks.push(chunk))
    document.on('end', () => resolve(Buffer.concat(chunks)))
    document.on('error', reject)
    try {
      document.registerFont('Sans', font())
      document.font('Sans')
    } catch (error) {
      reject(error)
      return
    }
    const width = document.page.width - 72
    document.fontSize(16).text('Протокол проверки ПД / РД / ИД')
    document.moveDown(0.5).fontSize(9)
    for (const line of summary(payload)) document.text(line)
    for (const [table, items] of Object.entries(payload.protocol.tables as Record<string, Json[]>)) {
      document.moveDown().fontSize(12).text(TABLE_TITLES[table]).fontSize(8)
      if (!items.length) {
        document.text('Записей нет.')
        continue
      }
      const head = header(table)
      const column = width / head.length
      const drawRow = (cells: string[]) => {
        const heights = cells.map((cell) => document.heightOfString(cell || ' ', { width: column - 6 }))
        const height = Math.max(...heights) + 6
        if (document.y + height > document.page.height - 36) document.addPage()
        const top = document.y
        cells.forEach((cell, index) => {
          const left = 36 + index * column
          document.rect(left, top, column, height).lineWidth(0.25).stroke('#888888')
          document.fillColor('#000000').text(cell || ' ', left + 3, top + 3, { width: column - 6 })
        })
        document.x = 36
        document.y = top + height
      }
      drawRow(head)
      for (const row of rows(table, items)) drawRow(row)
    }
    document.end()
  })
}
