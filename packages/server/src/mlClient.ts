/**
 * Синхронные вызовы ML-модулей по внутреннему REST API (ТЗ 1.5).
 *
 * Долгие операции (разбор тома, проверка комплекта) идут через очередь
 * сообщений; здесь — короткие запросы с ответом сразу: изображение листа
 * для карточки доказательства, проверка связи с моделью, расчёт метрик по
 * эталонной разметке. Запросы подписываются служебным токеном контура.
 */
import { HttpError } from './errors.js'

export interface LlmCheck {
  reachable: boolean
  message: string
  model: string
  [key: string]: unknown
}

/** Файл для отрисовки листа: у чертежа DWG/DXF рисуется производный DXF. */
export interface RenderSource {
  sha256: string
  sourceFormat: string
  derivedSha256: string | null
}

export interface MlClient {
  renderPage(file: RenderSource, page: number, dpi: number): Promise<Buffer>
  llmCheck(): Promise<LlmCheck>
  evaluate(body: unknown): Promise<unknown>
  validateRule(expression: string): Promise<{ ok: boolean; error?: string }>
}

// Сколько ждать ответа ML-модуля, мс: изображение листа и расчёт метрик —
// короткие операции; долгие идут через очередь.
const TIMEOUT_MS = 120_000

export class HttpMlClient implements MlClient {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.baseUrl) throw new HttpError(503, 'ML-модуль не подключён: не задан INSPECTOR_ML_URL')
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), 'X-Internal-Token': this.token },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      throw new HttpError(503, `ML-модуль недоступен: ${(error as Error).message}`)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new HttpError(response.status >= 500 ? 502 : response.status,
        `ML-модуль ответил ошибкой ${response.status}: ${text.slice(0, 300)}`)
    }
    return response
  }

  async renderPage(file: RenderSource, page: number, dpi: number): Promise<Buffer> {
    const query = new URLSearchParams({ sha256: file.sha256, source_format: file.sourceFormat,
      page: String(page), dpi: String(dpi), ...(file.derivedSha256 ? { derived_sha256: file.derivedSha256 } : {}) })
    const response = await this.call(`/render?${query}`)
    return Buffer.from(await response.arrayBuffer())
  }

  async llmCheck(): Promise<LlmCheck> {
    return (await (await this.call('/llm-check')).json()) as LlmCheck
  }

  async evaluate(body: unknown): Promise<unknown> {
    const response = await this.call('/evaluate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return response.json()
  }

  async validateRule(expression: string): Promise<{ ok: boolean; error?: string }> {
    const response = await this.call('/rules/validate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression }),
    })
    return (await response.json()) as { ok: boolean; error?: string }
  }
}
