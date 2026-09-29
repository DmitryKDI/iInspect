/**
 * Флаги в Redis: остановка проверки инспектором.
 *
 * Флаг ставит сервер, читает ML-воркер на безопасных точках проверки. Срок
 * жизни ограничен: забытый флаг не должен останавливать будущие процессы.
 */
import { Redis } from 'ioredis'

const CANCEL_TTL_S = 24 * 3600

export interface Flags {
  set(key: string): Promise<void>
  clear(key: string): Promise<void>
  close(): Promise<void>
}

export class RedisFlags implements Flags {
  private constructor(private readonly client: Redis) {}

  static connect(url: string): RedisFlags {
    return new RedisFlags(new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 }))
  }

  async set(key: string): Promise<void> {
    await this.client.set(key, '1', 'EX', CANCEL_TTL_S)
  }

  async clear(key: string): Promise<void> {
    await this.client.del(key)
  }

  async close(): Promise<void> {
    this.client.disconnect()
  }
}

export class MemoryFlags implements Flags {
  readonly values = new Set<string>()
  async set(key: string): Promise<void> { this.values.add(key) }
  async clear(key: string): Promise<void> { this.values.delete(key) }
  async close(): Promise<void> {}
}
