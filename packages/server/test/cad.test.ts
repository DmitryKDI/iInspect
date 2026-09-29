/**
 * Чертежи DWG/DXF (ТЗ 11, п.8): приём приводит чертёж к DXF AC1032 в UTF-8,
 * кириллица подписей не искажается ни из DWG, ни из DXF 2007+.
 */
import * as A from '@node-projects/acad-ts'
import { describe, expect, it } from 'vitest'
import { convertCad, normalizeDxfEncoding } from '../src/domain/cad.js'

function drawing(version: number) {
  const doc = new A.CadDocument()
  doc.header.version = version
  // Русский AutoCAD до 2007 хранит текст в кодовой странице Windows-1251.
  doc.header.codePage = 'ANSI_1251'
  const line = new A.Line()
  line.startPoint = new A.XYZ(0, 0, 0)
  line.endPoint = new A.XYZ(6000, 0, 0)
  doc.modelSpace.entities.add(line)
  const text = new A.TextEntity()
  text.value = 'План этажа'
  text.insertPoint = new A.XYZ(0, 3500, 0)
  text.height = 250
  doc.modelSpace.entities.add(text)
  return doc
}

function dxfOf(version: number): Buffer {
  let out = ''
  A.DxfWriter.writeToStream({ write: (chunk: string) => { out += chunk } }, drawing(version), false)
  return Buffer.from(out, 'utf8')
}

describe('приём чертежей', () => {
  it('DXF 2007+ читается как UTF-8, кириллица сохраняется', async () => {
    const source = dxfOf(A.ACadVersion.AC1032)
    const converted = await convertCad(source, 'DXF')
    const text = converted.dxf.toString('utf8')
    expect(text).toContain('План этажа')
    expect(text).not.toContain('Ð')
    expect(text).toMatch(/\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*AC1032/)
  })

  it('DWG приводится к DXF AC1032 с кириллицей', async () => {
    const dwg = Buffer.from(A.DwgWriter.writeToBuffer(drawing(A.ACadVersion.AC1018)))
    const converted = await convertCad(dwg, 'DWG')
    expect(converted.version).toBe('AC1018')
    expect(converted.entities).toBeGreaterThanOrEqual(2)
    expect(converted.dxf.toString('utf8')).toContain('План этажа')
  })

  it('повреждённый чертёж отклоняется с причиной', async () => {
    await expect(convertCad(Buffer.from('AC1032 это не чертёж'), 'DWG')).rejects.toThrow(/DWG/)
  })

  it('кодовая страница старых DXF не трогается', () => {
    const r12 = Buffer.from('0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n9\n$DWGCODEPAGE\n3\nANSI_1251\n0\nENDSEC\n')
    expect(normalizeDxfEncoding(r12).equals(r12)).toBe(true)
  })
})
