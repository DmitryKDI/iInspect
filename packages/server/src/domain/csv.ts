/** CSV: таблица проверок протокола и выгрузка набора GOLD. */
import type { Json } from './protocol.js'
import { allFindings } from './protocol.js'

function cell(value: unknown): string {
  const text = value === null || value === undefined ? ''
    : typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function csv(columns: readonly string[], rows: Json[]): Buffer {
  const lines = [columns.join(','), ...rows.map((row) => columns.map((column) => cell(row[column])).join(','))]
  // BOM — чтобы Excel на русской локали открыл файл в UTF-8.
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8')
}

const CHECK_COLUMNS = ['finding_id', 'parameter_code', 'parameter_name', 'priority', 'completeness_status',
  'finding_status', 'technical_status', 'expected_value', 'actual_value', 'explanation']

export function toCsv(body: Json): Buffer {
  return csv(CHECK_COLUMNS, allFindings(body.result))
}
