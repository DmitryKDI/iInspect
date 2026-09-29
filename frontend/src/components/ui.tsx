import { type ReactNode, useState } from 'react'

/** Белая карточка со сворачиваемой секцией — основной строительный блок платформы. */
export function SectionCard({
  title, subtitle, right, children, collapsible = false, defaultOpen = true, className = '',
}: {
  title?: ReactNode; subtitle?: ReactNode; right?: ReactNode; children: ReactNode
  collapsible?: boolean; defaultOpen?: boolean; className?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={`card ${className}`}>
      {title && (
        <header className="flex items-start justify-between gap-3 border-b border-surface-line px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {right}
            {collapsible && (
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setOpen(!open)}
                aria-expanded={open}>
                {open ? 'Свернуть' : 'Развернуть'}
              </button>
            )}
          </div>
        </header>
      )}
      {open && <div className="p-4">{children}</div>}
    </section>
  )
}

export function Chip({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'warn' }) {
  const map = {
    neutral: 'bg-surface-muted text-ink-muted border-surface-line',
    accent: 'bg-accent-soft text-accent border-accent-line',
    warn: 'bg-major-soft text-major border-major/30',
  }
  return <span className={`chip ${map[tone]}`}>{children}</span>
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Загрузка">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-surface-muted" style={{ width: `${92 - i * 7}%` }} />
      ))}
    </div>
  )
}

/** Пустое состояние объясняет, что произошло и что делать дальше. */
export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="max-w-md text-sm text-ink-muted">{hint}</p>}
      {action}
    </div>
  )
}
