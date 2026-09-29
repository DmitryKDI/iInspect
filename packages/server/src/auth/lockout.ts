/**
 * Защита входа от подбора пароля (ТЗ 12, п.1 и п.9): после серии неудачных
 * попыток для пары «логин + IP» вход временно закрывается. Счётчик в памяти
 * процесса: сервер один, после перезапуска счёт начинается заново.
 */
export const MAX_FAILURES = 5
export const WINDOW_MINUTES = 15
export const LOCK_MINUTES = 15

interface Entry { failures: number; firstAt: number; lockedUntil: number }

export class LoginLockout {
  private entries = new Map<string, Entry>()

  /** Минут до снятия блокировки или 0, если вход разрешён. */
  lockedFor(key: string, now: Date): number {
    const entry = this.entries.get(key)
    if (!entry || entry.lockedUntil <= now.getTime()) return 0
    return Math.ceil((entry.lockedUntil - now.getTime()) / 60_000)
  }

  /** Учесть неудачу; true — после неё вход закрыт. */
  fail(key: string, now: Date): boolean {
    const at = now.getTime()
    const current = this.entries.get(key)
    const entry = current && at - current.firstAt <= WINDOW_MINUTES * 60_000 && current.lockedUntil <= at
      ? current : { failures: 0, firstAt: at, lockedUntil: 0 }
    entry.failures += 1
    if (entry.failures >= MAX_FAILURES) entry.lockedUntil = at + LOCK_MINUTES * 60_000
    this.entries.set(key, entry)
    return entry.lockedUntil > at
  }

  succeed(key: string): void {
    this.entries.delete(key)
  }
}
