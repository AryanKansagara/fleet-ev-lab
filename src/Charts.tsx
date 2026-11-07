import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react'
import { curveAt } from './engine/energy.ts'
import { SLOTS } from './engine/schedule.ts'
import { PUBLISHED_ANCHORS } from './engine/settings.ts'
import type { CurvePoint, DayResult, FleetResult, NightPlan, TcoResult } from './engine/types.ts'
import { REASON_LABEL } from './engine/types.ts'
import { fmtDate, fmtT, money, useThemeMode } from './ui.tsx'

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(720)
  useLayoutEffect(() => {
    if (!ref.current) return
    setW(ref.current.clientWidth || 720)
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/* ---------- Range curve: draggable knots, published anchors drawn apart ---------- */

export function CurveChart({ curve, onChange, marker, height = 300 }: { curve: CurvePoint[]; onChange?: (c: CurvePoint[]) => void; marker?: number; height?: number }) {
  const [ref, w] = useWidth()
  const [drag, setDrag] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const pad = { l: 44, r: 16, t: 16, b: 34 }
  const tMin = -30
  const tMax = 40
  const rMax = 1.3
  const x = (t: number) => pad.l + ((t - tMin) / (tMax - tMin)) * (w - pad.l - pad.r)
  const y = (r: number) => pad.t + (1 - r / rMax) * (height - pad.t - pad.b)
  const toR = (py: number) => Math.max(0.1, Math.min(rMax, (1 - (py - pad.t) / (height - pad.t - pad.b)) * rMax))
  const line = curve.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.r).toFixed(1)}`).join(' ')
  const area = `${line} L${x(curve[curve.length - 1].t)} ${y(0)} L${x(curve[0].t)} ${y(0)} Z`
  const setKnot = (i: number, r: number) => onChange?.(curve.map((p, k) => (k === i ? { ...p, r: Math.round(r * 1000) / 1000 } : p)))
  const move = (e: RPointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect()
    if (drag !== null) setKnot(drag, toR(e.clientY - box.top))
    else setHover(Math.round(tMin + ((e.clientX - box.left - pad.l) / (w - pad.l - pad.r)) * (tMax - tMin)))
  }
  const hovT = hover !== null && hover >= tMin && hover <= tMax ? hover : null
  return (
    <div ref={ref} className="chart">
      <svg width={w} height={height} role="img" aria-label="Observed range as a share of rated range, by temperature" onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerLeave={() => { setDrag(null); setHover(null) }}>
        {[0.25, 0.5, 0.75, 1, 1.25].map((r) => (
          <g key={r}>
            <line x1={pad.l} x2={w - pad.r} y1={y(r)} y2={y(r)} className={r === 1 ? 'grid strong' : 'grid'} />
            <text x={pad.l - 8} y={y(r) + 4} textAnchor="end" className="tick">{Math.round(r * 100)}%</text>
          </g>
        ))}
        {[-30, -20, -10, 0, 10, 20, 30, 40].map((t) => <text key={t} x={x(t)} y={height - 12} textAnchor="middle" className="tick">{fmtT(t)}</text>)}
        <path d={area} className="curve-area" />
        <path d={line} className="curve-line" />
        {marker !== undefined ? <line x1={x(marker)} x2={x(marker)} y1={pad.t} y2={y(0)} className="marker-line" /> : null}
        {hovT !== null ? (
          <g pointerEvents="none">
            <line x1={x(hovT)} x2={x(hovT)} y1={pad.t} y2={y(0)} className="grid strong" />
            <text x={Math.min(x(hovT) + 8, w - 90)} y={pad.t + 12} className="label">{fmtT(hovT)}: {Math.round(curveAt(curve, hovT) * 100)}% of rated</text>
          </g>
        ) : null}
        {onChange ? curve.map((p, i) => (
          <circle
            key={p.t}
            cx={x(p.t)}
            cy={y(p.r)}
            r={7}
            className="knot"
            tabIndex={0}
            role="slider"
            aria-label={`Range at ${p.t} degrees`}
            aria-valuenow={Math.round(p.r * 100)}
            aria-valuemin={10}
            aria-valuemax={130}
            onPointerDown={(e) => { e.preventDefault(); setDrag(i) }}
            onKeyDown={(e: RKeyboardEvent) => {
              if (e.key === 'ArrowUp') { e.preventDefault(); setKnot(i, Math.min(rMax, p.r + 0.01)) }
              if (e.key === 'ArrowDown') { e.preventDefault(); setKnot(i, Math.max(0.1, p.r - 0.01)) }
            }}
          />
        )) : null}
        {PUBLISHED_ANCHORS.map((a) => (
          <g key={a.t} pointerEvents="none">
            <rect x={x(a.t) - 6} y={y(a.r) - 6} width={12} height={12} transform={`rotate(45 ${x(a.t)} ${y(a.r)})`} className="anchor" />
            <text x={x(a.t) + (a.t > 0 ? 12 : 12)} y={y(a.r) + (a.t > 0 ? -12 : 20)} className="label">Published: {Math.round(a.r * 100)}% at {fmtT(a.t)}</text>
          </g>
        ))}
      </svg>
    </div>
  )
}

/* ---------- Vehicle by day calendar heatmap ---------- */

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

export function SuitabilityGrid({ result, selectedDay, selectedVehicle, onPick }: { result: FleetResult; selectedDay?: number; selectedVehicle?: string | null; onPick?: (vehicle: string, day: number) => void }) {
  const [ref, w] = useWidth()
  const canvas = useRef<HTMLCanvasElement>(null)
  const mode = useThemeMode()
  const [tip, setTip] = useState<{ x: number; y: number; v: string; d?: DayResult; day: number } | null>(null)
  const [cursor, setCursor] = useState({ r: 0, c: 0 })
  const LABEL = w < 560 ? 76 : 130
  const days = result.lastDay - result.firstDay + 1
  const rowH = 20
  const HEAD = 24
  const height = HEAD + result.vehicles.length * rowH
  const cell = (w - LABEL) / Math.max(days, 1)
  const maps = useMemo(() => result.vehicles.map((v) => new Map(v.days.map((d) => [d.day, d]))), [result])

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const dpr = Math.min(devicePixelRatio || 1, 2)
    c.width = w * dpr
    c.height = height * dpr
    c.style.width = `${w}px`
    c.style.height = `${height}px`
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, height)
    const col = { rest: css('--cell-rest'), ok: css('--cell-ok'), tight: css('--cell-tight'), bad: css('--cell-bad'), ink: css('--text'), muted: css('--muted'), line: css('--line') }
    g.font = '500 11px Roboto, Arial, sans-serif'
    let lastMonth = -1
    for (let i = 0; i < days; i++) {
      const date = new Date((result.firstDay + i) * 864e5)
      if (date.getUTCMonth() !== lastMonth) {
        lastMonth = date.getUTCMonth()
        g.fillStyle = col.muted
        g.fillText(date.toLocaleDateString('en-CA', { month: 'short', timeZone: 'UTC' }), LABEL + i * cell + 1, 14)
        g.fillStyle = col.line
        g.fillRect(LABEL + i * cell, 18, 1, height - 18)
      }
    }
    const inner = Math.max(1, cell - (cell > 4 ? 1 : 0))
    result.vehicles.forEach((v, r) => {
      const y = HEAD + r * rowH
      g.fillStyle = selectedVehicle === v.id ? css('--blue') : col.ink
      g.font = `${selectedVehicle === v.id ? 700 : 500} 11.5px Roboto, Arial, sans-serif`
      g.fillText(v.id.length > 20 && w < 800 ? `${v.id.slice(0, 10)}...` : v.id, 0, y + 13)
      for (const d of v.days) {
        const i = d.day - result.firstDay
        const x = LABEL + i * cell
        g.fillStyle = d.failed ? col.bad : d.minPct < 30 ? col.tight : col.ok
        g.fillRect(x, y + 1, inner, rowH - 2)
        if (d.failed && cell >= 3.5) {
          // Failures also carry a mark, so red does not rely on colour alone.
          g.fillStyle = 'rgba(255,255,255,.75)'
          g.fillRect(x + inner / 2 - 0.5, y + rowH / 2 - 3, 1, 6)
        }
      }
      for (let i = 0; i < days; i++) {
        if (!maps[r].has(result.firstDay + i)) {
          g.fillStyle = col.rest
          g.fillRect(LABEL + i * cell, y + 1, inner, rowH - 2)
        }
      }
    })
    if (selectedDay !== undefined) {
      const x = LABEL + (selectedDay - result.firstDay) * cell
      g.strokeStyle = css('--blue')
      g.lineWidth = 1.5
      g.strokeRect(x - 0.5, HEAD - 2, inner + 1, height - HEAD + 2)
    }
  }, [result, w, height, cell, days, LABEL, selectedDay, selectedVehicle, maps, mode])

  const at = (cx: number, cy: number) => {
    const r = Math.floor((cy - HEAD) / rowH)
    const c = Math.floor((cx - LABEL) / cell)
    if (r < 0 || r >= result.vehicles.length || c < 0 || c >= days) return null
    return { r, c }
  }
  const show = (r: number, c: number, x: number, y: number) => {
    const day = result.firstDay + c
    setTip({ x, y, v: result.vehicles[r].id, d: maps[r].get(day), day })
  }
  const onKey = (e: RKeyboardEvent) => {
    const m: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }
    if (m[e.key]) {
      e.preventDefault()
      const r = Math.max(0, Math.min(result.vehicles.length - 1, cursor.r + m[e.key][0]))
      const c = Math.max(0, Math.min(days - 1, cursor.c + m[e.key][1]))
      setCursor({ r, c })
      show(r, c, LABEL + c * cell, HEAD + r * rowH)
    } else if (e.key === 'Enter') onPick?.(result.vehicles[cursor.r].id, result.firstDay + cursor.c)
    else if (e.key === 'Escape') setTip(null)
  }
  return (
    <div ref={ref} className="grid-wrap">
      <canvas
        ref={canvas}
        tabIndex={0}
        role="img"
        aria-label={`Suitability calendar for ${result.vehicles.length} vehicles over ${days} days. ${result.failDays} of ${result.opDays} operating days fail. Use arrow keys to read a day, Enter to open it on the map.`}
        onKeyDown={onKey}
        onBlur={() => setTip(null)}
        onPointerMove={(e) => {
          const b = e.currentTarget.getBoundingClientRect()
          const hit = at(e.clientX - b.left, e.clientY - b.top)
          if (hit) show(hit.r, hit.c, e.clientX - b.left, e.clientY - b.top)
          else setTip(null)
        }}
        onPointerLeave={() => setTip(null)}
        onClick={(e) => {
          const b = e.currentTarget.getBoundingClientRect()
          const hit = at(e.clientX - b.left, e.clientY - b.top)
          if (hit) onPick?.(result.vehicles[hit.r].id, result.firstDay + hit.c)
        }}
      />
      {tip ? (
        <div className="tip" style={{ left: Math.min(tip.x + 14, w - 230), top: tip.y + 14 }}>
          <strong>{tip.v}</strong> · {fmtDate(tip.day)}
          {tip.d ? (
            <>
              <div>{tip.d.km.toFixed(0)} km · {tip.d.kwh.toFixed(0)} kWh · {fmtT(tip.d.tempC)}</div>
              <div>Battery {tip.d.startPct.toFixed(0)}% to {tip.d.minPct.toFixed(0)}%</div>
              {tip.d.failed ? <div className="tip-bad">{tip.d.reason ? REASON_LABEL[tip.d.reason] : 'Failed'}</div> : <div>Completed</div>}
            </>
          ) : <div>Not operating</div>}
        </div>
      ) : null}
      <div className="legend" aria-hidden="true">
        <span><i style={{ background: 'var(--cell-ok)' }} />Completed</span>
        <span><i style={{ background: 'var(--cell-tight)' }} />Completed, under 30% left</span>
        <span><i className="fail-swatch" />Failed</span>
        <span><i style={{ background: 'var(--cell-rest)' }} />Not operating</span>
      </div>
    </div>
  )
}

/* ---------- Depot charging Gantt with load curve ---------- */

const slotLabel = (slot: number) => {
  const h = (12 + Math.floor(slot / 4)) % 24
  return `${String(h).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}`
}

export function ChargingGantt({ night, chargers, capKw, unmanagedKw }: { night: NightPlan; chargers: number; capKw?: number; unmanagedKw?: number }) {
  const [ref, w] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const from = 16 // 16:00
  const to = SLOTS - 4 // 11:00
  const L = 76
  const R = 14
  const rowH = 26
  const rows = Math.max(chargers, 1)
  const ganttH = rows * rowH + 8
  const chartH = 130
  const axisH = 24
  const x = (slot: number) => L + ((slot - from) / (to - from)) * (w - L - R)
  const peak = Math.max(1, ...night.load, capKw ?? 0, unmanagedKw ?? 0)
  const yTop = ganttH + axisH + 24
  const y = (kw: number) => yTop + chartH - (kw / peak) * chartH
  const inView = night.load.slice(from, to)
  const area = `M${x(from)} ${y(0)} ${inView.map((kw, i) => `L${x(from + i)} ${y(kw)} L${x(from + i + 1)} ${y(kw)}`).join(' ')} L${x(to)} ${y(0)} Z`
  const realPeak = Math.max(...night.load)
  const peakSlot = night.load.indexOf(realPeak)
  const height = yTop + chartH + 24
  const hoverSlot = hover !== null && hover >= from && hover <= to ? hover : null
  return (
    <div ref={ref} className="chart">
      <svg
        width={w}
        height={height}
        role="img"
        aria-label={`Charging plan: ${night.sessions.length} sessions on ${chargers} chargers, peak ${realPeak.toFixed(0)} kW, ${night.swaps} plug swaps.`}
        onPointerMove={(e) => {
          const b = e.currentTarget.getBoundingClientRect()
          setHover(Math.floor(from + ((e.clientX - b.left - L) / (w - L - R)) * (to - from)))
        }}
        onPointerLeave={() => setHover(null)}
      >
        {Array.from({ length: rows }, (_, i) => (
          <g key={i}>
            <rect x={L} y={i * rowH + 2} width={w - L - R} height={rowH - 4} className="lane" rx={3} />
            <text x={0} y={i * rowH + 18} className="tick strong">Charger {i + 1}</text>
          </g>
        ))}
        {Array.from({ length: 10 }, (_, i) => from + i * 8).filter((s) => s <= to).map((s) => (
          <g key={s}>
            <line x1={x(s)} x2={x(s)} y1={0} y2={ganttH} className="grid" />
            <text x={x(s)} y={ganttH + 16} textAnchor="middle" className="tick">{slotLabel(s)}</text>
            <line x1={x(s)} x2={x(s)} y1={yTop} y2={y(0)} className="grid" />
          </g>
        ))}
        {night.sessions.map((s, i) => {
          const a = Math.max(s.startSlot, from)
          const b = Math.min(s.endSlot, to)
          if (b <= a) return null
          const bw = x(b) - x(a)
          return (
            <g key={i}>
              <rect x={x(a) + 1} y={s.charger * rowH + 3} width={Math.max(2, bw - 2)} height={rowH - 6} rx={4} className="bar">
                <title>{`${s.vehicle}: ${slotLabel(s.startSlot)} to ${slotLabel(s.endSlot)}, ${s.kwh.toFixed(0)} kWh from the grid`}</title>
              </rect>
              {bw > 56 ? <text x={x(a) + 8} y={s.charger * rowH + 17} className="bar-label">{s.vehicle}</text> : null}
            </g>
          )
        })}
        <text x={0} y={y(realPeak) + 4} className="tick strong">{realPeak.toFixed(0)} kW</text>
        <line x1={L} x2={w - R} y1={y(0)} y2={y(0)} className="grid strong" />
        <path d={area} className="load-area" />
        {unmanagedKw && unmanagedKw > realPeak ? (
          <g>
            <line x1={L} x2={w - R} y1={y(unmanagedKw)} y2={y(unmanagedKw)} className="ref-line" />
            <text x={w - R} y={y(unmanagedKw) - 5} textAnchor="end" className="label">Everyone plugs in on arrival: {unmanagedKw.toFixed(0)} kW</text>
          </g>
        ) : null}
        {capKw ? (
          <g>
            <line x1={L} x2={w - R} y1={y(capKw)} y2={y(capKw)} className="cap-line" />
            <text x={L + 6} y={y(capKw) - 5} className="label">Site cap {capKw} kW</text>
          </g>
        ) : null}
        {peakSlot >= from && peakSlot <= to ? <circle cx={x(peakSlot + 0.5)} cy={y(realPeak)} r={4} className="peak-dot" /> : null}
        {hoverSlot !== null ? (
          <g pointerEvents="none">
            <line x1={x(hoverSlot)} x2={x(hoverSlot)} y1={0} y2={y(0)} className="marker-line" />
            <text x={Math.min(x(hoverSlot) + 8, w - 120)} y={yTop + 12} className="label">{slotLabel(hoverSlot)}: {night.load[hoverSlot].toFixed(1)} kW</text>
          </g>
        ) : null}
        <text x={L} y={height - 4} className="tick">Depot load by 15-minute slot</text>
      </svg>
    </div>
  )
}

/* ---------- TCO crossover ---------- */

export function TcoChart({ tco, cur, height = 320 }: { tco: Pick<TcoResult, 'evSeries' | 'iceSeries' | 'years' | 'crossoverYear'>; cur: string; height?: number }) {
  const [ref, w] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const pad = { l: 62, r: 96, t: 20, b: 34 }
  const ev = tco.evSeries.slice(0, tco.years + 1)
  const ice = tco.iceSeries.slice(0, tco.years + 1)
  const all = [...ev, ...ice]
  const max = Math.max(...all) * 1.05
  const min = Math.min(0, ...all)
  const x = (i: number) => pad.l + (i / tco.years) * (w - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min)) * (height - pad.t - pad.b)
  const path = (s: number[]) => s.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')
  const ticks = 4
  const hov = hover !== null ? Math.max(0, Math.min(tco.years, hover)) : null
  const crossY = tco.crossoverYear
  let crossV = 0
  if (crossY !== null) {
    const i = Math.floor(crossY)
    const f = crossY - i
    crossV = ev[i] + ((ev[Math.min(i + 1, tco.years)] ?? ev[i]) - ev[i]) * f
  }
  return (
    <div ref={ref} className="chart">
      <svg
        width={w}
        height={height}
        role="img"
        aria-label={`Cost of ownership over ${tco.years} years. ${crossY === null ? 'The EV does not become cheaper in this horizon.' : `The EV becomes cheaper in year ${crossY.toFixed(1)}.`}`}
        onPointerMove={(e) => {
          const b = e.currentTarget.getBoundingClientRect()
          setHover(Math.round(((e.clientX - b.left - pad.l) / (w - pad.l - pad.r)) * tco.years))
        }}
        onPointerLeave={() => setHover(null)}
      >
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const v = min + ((max - min) * i) / ticks
          return (
            <g key={i}>
              <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} className="grid" />
              <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="tick">{money(v, cur)}</text>
            </g>
          )
        })}
        {ev.map((_, i) => <text key={i} x={x(i)} y={height - 12} textAnchor="middle" className="tick">{i === 0 ? 'Start' : `Yr ${i}`}</text>)}
        <path d={path(ice)} className="line-ice" />
        <path d={path(ev)} className="line-ev" />
        <text x={x(tco.years) + 8} y={y(ev[tco.years]) + 4} className="label">Electric</text>
        <text x={x(tco.years) + 8} y={y(ice[tco.years]) + 4} className="label">Current</text>
        {crossY !== null ? (
          <g>
            <circle cx={x(crossY)} cy={y(crossV)} r={6} className="cross-dot" />
            <text x={Math.min(x(crossY) + 10, w - pad.r - 110)} y={y(crossV) + 26} className="label strong">Cheaper from year {crossY.toFixed(1)}</text>
          </g>
        ) : null}
        {hov !== null ? (
          <g pointerEvents="none">
            <line x1={x(hov)} x2={x(hov)} y1={pad.t} y2={height - pad.b} className="marker-line" />
            <circle cx={x(hov)} cy={y(ev[hov])} r={4} className="dot-ev" />
            <circle cx={x(hov)} cy={y(ice[hov])} r={4} className="dot-ice" />
            <text x={Math.min(x(hov) + 8, w - 190)} y={pad.t + 12} className="label">EV {money(ev[hov], cur)} · Current {money(ice[hov], cur)}</text>
          </g>
        ) : null}
      </svg>
      <div className="legend" aria-hidden="true">
        <span><i className="sw-ev" />Electric</span>
        <span><i className="sw-ice" />Current vehicle</span>
      </div>
    </div>
  )
}
