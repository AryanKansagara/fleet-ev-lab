import { useSyncExternalStore, type MouseEvent, type ReactNode } from 'react'
import type { Verdict } from './engine/types.ts'

export function go(href: string) {
  history.pushState({}, '', href)
  dispatchEvent(new PopStateEvent('popstate'))
  scrollTo(0, 0)
}

const subPath = (cb: () => void) => {
  addEventListener('popstate', cb)
  return () => removeEventListener('popstate', cb)
}
export const usePath = () => useSyncExternalStore(subPath, () => location.pathname)

export function Link({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    go(href)
  }
  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  )
}

const subTheme = (cb: () => void) => {
  addEventListener('themechange', cb)
  return () => removeEventListener('themechange', cb)
}
export const useThemeMode = () => useSyncExternalStore(subTheme, () => document.documentElement.dataset.themeMode ?? 'light')

export function ThemeToggle() {
  const mode = useThemeMode()
  const flip = () => {
    const next = mode === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.themeMode = next
    localStorage.setItem('themeMode', next)
    dispatchEvent(new Event('themechange'))
  }
  return (
    <button className="icon-btn" onClick={flip} aria-label={`Switch to ${mode === 'dark' ? 'light' : 'dark'} mode`} title="Toggle theme">
      {mode === 'dark' ? (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
        </svg>
      )}
    </button>
  )
}

export function Header({ children }: { children?: ReactNode }) {
  return (
    <>
      <div className="utility">
        <div className="wrap utility-in">
          <span>Independent project. All sample data is synthetic. Your GPS data stays in this browser.</span>
        </div>
      </div>
      <header className="nav">
        <div className="wrap nav-in">
          <Link href="/" className="brand">
            <span className="mono" aria-hidden="true">FE</span>
            <span>Fleet EV Lab</span>
          </Link>
          <div className="nav-links">{children}</div>
          <div className="nav-actions">
            <ThemeToggle />
            <Link href="/app" className="btn btn-primary">Open the lab</Link>
          </div>
        </div>
      </header>
    </>
  )
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap footer-in">
        <p>Built by Aryan Kansagara. Independent project, not affiliated with Geotab.</p>
        <p className="muted">Map data &copy; <a href="https://www.openstreetmap.org/copyright" rel="noreferrer">OpenStreetMap</a> contributors. Weather by <a href="https://open-meteo.com/" rel="noreferrer">Open-Meteo</a>.</p>
      </div>
    </footer>
  )
}

export const VERDICT: Record<Verdict, { label: string; cls: string }> = {
  ready: { label: 'Ready', cls: 'ok' },
  close: { label: 'Close', cls: 'warn' },
  change: { label: 'Change ops', cls: 'warn' },
  hold: { label: 'Hold', cls: 'bad' },
}

export function VerdictChip({ v }: { v: Verdict }) {
  return <span className={`chip chip-${VERDICT[v].cls}`}><i aria-hidden="true" />{VERDICT[v].label}</span>
}

export function SyntheticTag({ text = 'Synthetic sample data' }: { text?: string }) {
  return <span className="synthetic">{text}</span>
}

export function money(n: number, cur = 'C$'): string {
  const a = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (a >= 1e6) return `${sign}${cur}${(a / 1e6).toFixed(2)}M`
  if (a >= 1e4) return `${sign}${cur}${Math.round(a / 1e3)}k`
  return `${sign}${cur}${Math.round(a).toLocaleString('en-CA')}`
}

export const fmtDate = (day: number) => new Date(day * 864e5).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
export const fmtT = (c: number) => `${c > 0 ? '+' : c < 0 ? '−' : ''}${Math.abs(Math.round(c))}°C`

/** Battery percent to colour: green when comfortable, amber when tight, red near empty. */
export function socColor(pct: number): string {
  const stops: [number, [number, number, number]][] = [
    [0, [217, 45, 32]],
    [15, [217, 45, 32]],
    [35, [232, 150, 20]],
    [60, [18, 161, 80]],
    [100, [18, 161, 80]],
  ]
  const p = Math.max(0, Math.min(100, pct))
  for (let i = 1; i < stops.length; i++) {
    if (p <= stops[i][0]) {
      const [a, ca] = stops[i - 1]
      const [b, cb] = stops[i]
      const f = (p - a) / (b - a || 1)
      return `rgb(${ca.map((c, k) => Math.round(c + (cb[k] - c) * f)).join(',')})`
    }
  }
  return 'rgb(18,161,80)'
}

export const NumField = ({ label, value, onChange, step = 1, min, max, unit, hint }: { label: string; value: number; onChange: (n: number) => void; step?: number; min?: number; max?: number; unit?: string; hint?: string }) => (
  <label className="field">
    <span>{label}{unit ? <em> {unit}</em> : null}</span>
    <input
      type="number"
      value={value}
      step={step}
      min={min}
      max={max}
      onChange={(e) => {
        const n = e.target.valueAsNumber
        if (Number.isFinite(n)) onChange(min !== undefined ? Math.max(min, max !== undefined ? Math.min(max, n) : n) : n)
      }}
    />
    {hint ? <small>{hint}</small> : null}
  </label>
)

export function downloadText(name: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
