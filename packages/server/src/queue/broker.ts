/**
 * Очередь сообщений RabbitMQ (ТЗ 1.5) и её замена для тестов.
 *
 * Очереди устойчивые, сообщения помечены persistent: задача, поставленная до
 * перезапуска брокера, не теряется. Обработчик подтверждает сообщение только
 * после успешной записи результата; сбой обработчика возвращает сообщение в
 * очередь.
 */
import amqp from 'amqplib'

export type Handler = (message: unknown) => Promise<void>

export interface Broker {
  publish(queue: string, message: unknown): Promise<void>
  consume(queue: string, handler: Handler): Promise<void>
  /** Число сообщений в очереди — метрика ТЗ 13, п.4. */
  queueSize(queue: string): Promise<number>
  close(): Promise<void>
}

export class AmqpBroker implements Broker {
  private constructor(private readonly connection: amqp.ChannelModel,
    private readonly channel: amqp.ConfirmChannel) {}

  static async connect(url: string, queues: string[]): Promise<AmqpBroker> {
    const connection = await amqp.connect(url)
    const channel = await connection.createConfirmChannel()
    await channel.prefetch(4)
    for (const queue of queues) await channel.assertQueue(queue, { durable: true })
    return new AmqpBroker(connection, channel)
  }

  async publish(queue: string, message: unknown): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)),
        { persistent: true, contentType: 'application/json' },
        (error) => (error ? reject(error) : resolve()))
    })
  }

  async consume(queue: string, handler: Handler): Promise<void> {
    await this.channel.consume(queue, (message) => {
      if (!message) return
      let body: unknown
      try {
        body = JSON.parse(message.content.toString('utf8'))
      } catch {
        this.channel.nack(message, false, false) // нечитаемое сообщение не зациклить
        return
      }
      handler(body).then(() => this.channel.ack(message),
        () => this.channel.nack(message, false, true))
    })
  }

  async queueSize(queue: string): Promise<number> {
    const info = await this.channel.checkQueue(queue)
    return info.messageCount
  }

  async close(): Promise<void> {
    await this.channel.close().catch(() => undefined)
    await this.connection.close().catch(() => undefined)
  }
}

/** Очередь в памяти: только для тестов, сообщения доставляются синхронно по вызову drain(). */
export class MemoryBroker implements Broker {
  readonly queues = new Map<string, unknown[]>()
  private readonly handlers = new Map<string, Handler>()

  async publish(queue: string, message: unknown): Promise<void> {
    const list = this.queues.get(queue) ?? []
    list.push(JSON.parse(JSON.stringify(message)))
    this.queues.set(queue, list)
  }

  async consume(queue: string, handler: Handler): Promise<void> {
    this.handlers.set(queue, handler)
  }

  async queueSize(queue: string): Promise<number> {
    return (this.queues.get(queue) ?? []).length
  }

  /** Забрать сообщения очереди (роль ML-воркера в тестах). */
  take(queue: string): unknown[] {
    const list = this.queues.get(queue) ?? []
    this.queues.set(queue, [])
    return list
  }

  /** Доставить сообщения очереди её обработчику. */
  async drain(queue: string): Promise<void> {
    const handler = this.handlers.get(queue)
    if (!handler) return
    for (const message of this.take(queue)) await handler(message)
  }

  async close(): Promise<void> {}
}
