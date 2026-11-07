import { useEffect, useMemo, useRef, useState } from 'react'
import type { Map as LeafletMap } from 'leaflet'
import { dayOf } from './engine/segment.ts'
import type { Fleet, FleetResult, LatLng, Trip } from './engine/types.ts'
import { socColor, useThemeMode } from './ui.tsx'

// CARTO's free basemaps now watermark tiles without an API key, so this uses OSM's own tiles. CSS tints them per theme.
// OSM's public server suits light use only. Swap TILES for a hosted provider if traffic grows.
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

type Props = {
  fleet: Fleet
  result: FleetResult
  day: number
  selected?: string | null
  onSelect?: (id: string | null) => void
  height?: number | string
  cycleSeconds?: number
  scrollZoom?: boolean
  forceDark?: boolean
  playing?: boolean
}

const pathOf = (t: Trip): LatLng[] | null => t.path ?? (t.from && t.to ? [t.from, t.to] : null)

interface Item {
  id: string
  trips: Trip[]
  soc: [number, number][]
  failed: boolean
}

function buildItems(byVehicle: Map<string, Map<number, Trip[]>>, result: FleetResult, day: number): Item[] {
  const out: Item[] = []
  for (const v of result.vehicles) {
    const trips = byVehicle.get(v.id)?.get(day)
    const d = v.days.find((x) => x.day === day)
    if (trips && d) out.push({ id: v.id, trips, soc: d.tripSoc, failed: d.failed })
  }
  return out
}

/** Live map: real Leaflet tiles, with trips on a canvas layer so hundreds of coloured segments stay smooth. */
export default function FleetMap({ fleet, result, day, selected, onSelect, height = 520, cycleSeconds = 24, scrollZoom = true, forceDark, playing = true }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const clockEl = useRef<HTMLSpanElement>(null)
  const mode = useThemeMode()
  const dark = forceDark ?? mode === 'dark'
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const mapRef = useRef<LeafletMap | null>(null)

  const byVehicle = useMemo(() => {
    const m = new Map<string, Map<number, Trip[]>>()
    for (const t of fleet.trips) {
      const inner = m.get(t.vehicle) ?? new Map<number, Trip[]>()
      const d = dayOf(t.start)
      const list = inner.get(d)
      if (list) list.push(t)
      else inner.set(d, [t])
      m.set(t.vehicle, inner)
    }
    for (const inner of m.values()) for (const l of inner.values()) l.sort((a, b) => a.start - b.start)
    return m
  }, [fleet])

  const live = useRef({ items: [] as Item[], selected: selected ?? null, depots: fleet.depots, playing, cycleSeconds, onSelect })
  live.current.items = useMemo(() => buildItems(byVehicle, result, day), [byVehicle, result, day])
  live.current.selected = selected ?? null
  live.current.depots = fleet.depots
  live.current.playing = playing
  live.current.cycleSeconds = cycleSeconds
  live.current.onSelect = onSelect

  const hasGeo = live.current.items.some((i) => i.trips.some(pathOf))

  useEffect(() => {
    let cancelled = false
    let raf = 0
    let cleanup = () => {}
    Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')])
      .then(([mod]) => {
        if (cancelled || !host.current) return
        const L = mod.default ?? mod
        const map = L.map(host.current, { zoomControl: scrollZoom, attributionControl: true, scrollWheelZoom: scrollZoom, dragging: true, keyboard: scrollZoom })
        mapRef.current = map
        L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map)
        map.setView([43.7, -79.4], 10)
        map.attributionControl.setPrefix(false)

        const canvas = document.createElement('canvas')
        canvas.className = 'map-canvas'
        map.getContainer().appendChild(canvas)
        const ctx = canvas.getContext('2d')!
        let pts = new WeakMap<LatLng[], { x: Float32Array; y: Float32Array; frac: Float32Array }>()
        const clear = () => {
          pts = new WeakMap()
        }
        const size = () => {
          const r = map.getContainer().getBoundingClientRect()
          const dpr = Math.min(devicePixelRatio || 1, 2)
          canvas.width = r.width * dpr
          canvas.height = r.height * dpr
          canvas.style.width = `${r.width}px`
          canvas.style.height = `${r.height}px`
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          clear()
        }
        size()
        const hide = () => {
          canvas.style.opacity = '0'
        }
        const show = () => {
          clear()
          canvas.style.opacity = '1'
        }
        map.on('zoomstart', hide)
        map.on('zoomend moveend', show)
        map.on('move', clear)
        map.on('resize', size)

        const project = (path: LatLng[]) => {
          let p = pts.get(path)
          if (!p) {
            const n = path.length
            p = { x: new Float32Array(n), y: new Float32Array(n), frac: new Float32Array(n) }
            let total = 0
            for (let i = 0; i < n; i++) {
              const c = map.latLngToContainerPoint(path[i])
              p.x[i] = c.x
              p.y[i] = c.y
              if (i) {
                total += Math.hypot(path[i][0] - path[i - 1][0], (path[i][1] - path[i - 1][1]) * 0.72)
                p.frac[i] = total
              }
            }
            if (total > 0) for (let i = 0; i < n; i++) p.frac[i] /= total
            pts.set(path, p)
          }
          return p
        }

        const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
        const startedAt = performance.now()
        let markers: { id: string; x: number; y: number }[] = []
        const frame = (now: number) => {
          raf = requestAnimationFrame(frame)
          const { items, selected: sel, depots, playing: on, cycleSeconds: cycle } = live.current
          const w = canvas.clientWidth
          const h = canvas.clientHeight
          ctx.clearRect(0, 0, w, h)
          if (!items.length) return
          let t0 = Infinity
          let t1 = -Infinity
          for (const it of items) {
            t0 = Math.min(t0, it.trips[0].start)
            t1 = Math.max(t1, it.trips[it.trips.length - 1].end)
          }
          const f = reduced || !on ? 1 : ((now - startedAt) / 1000 / cycle) % 1
          const clock = t0 + (t1 - t0) * Math.min(1, f * 1.08)
          if (clockEl.current) clockEl.current.textContent = new Date(clock).toISOString().slice(11, 16)
          markers = []

          for (const pass of [0, 1]) {
            for (const it of items) {
              const isSel = sel === it.id
              if ((pass === 1) !== isSel) continue
              const dim = sel && !isSel
              ctx.lineCap = 'round'
              ctx.lineJoin = 'round'
              it.trips.forEach((trip, k) => {
                const path = pathOf(trip)
                if (!path || path.length < 2) return
                const p = project(path)
                const [a, b] = it.soc[k] ?? [100, 100]
                const prog = clock <= trip.start ? 0 : clock >= trip.end ? 1 : (clock - trip.start) / (trip.end - trip.start)
                ctx.globalAlpha = dim ? 0.12 : 0.28
                ctx.lineWidth = 1.5
                ctx.strokeStyle = dark ? '#98adbd' : '#66788c'
                ctx.beginPath()
                ctx.moveTo(p.x[0], p.y[0])
                for (let i = 1; i < p.x.length; i++) ctx.lineTo(p.x[i], p.y[i])
                ctx.stroke()
                if (prog <= 0) return
                ctx.globalAlpha = dim ? 0.25 : 1
                ctx.lineWidth = isSel ? 4.5 : 3
                let i = 1
                while (i < p.x.length && p.frac[i - 1] < prog) {
                  const colour = socColor(a + (b - a) * p.frac[i])
                  ctx.strokeStyle = colour
                  ctx.beginPath()
                  ctx.moveTo(p.x[i - 1], p.y[i - 1])
                  let j = i
                  while (j < p.x.length && p.frac[j - 1] < prog && socColor(a + (b - a) * p.frac[j]) === colour) {
                    if (p.frac[j] <= prog) ctx.lineTo(p.x[j], p.y[j])
                    else {
                      const m = (prog - p.frac[j - 1]) / (p.frac[j] - p.frac[j - 1] || 1)
                      ctx.lineTo(p.x[j - 1] + (p.x[j] - p.x[j - 1]) * m, p.y[j - 1] + (p.y[j] - p.y[j - 1]) * m)
                    }
                    j++
                  }
                  ctx.stroke()
                  i = Math.max(j, i + 1)
                }
              })
              // Vehicle marker at its position for this moment.
              let mx = NaN
              let my = NaN
              let pct = it.soc[0]?.[0] ?? 100
              for (let k = 0; k < it.trips.length; k++) {
                const trip = it.trips[k]
                const path = pathOf(trip)
                if (!path || path.length < 2) continue
                const p = project(path)
                const [a, b] = it.soc[k] ?? [100, 100]
                if (clock < trip.start) {
                  if (Number.isNaN(mx)) {
                    mx = p.x[0]
                    my = p.y[0]
                    pct = a
                  }
                  break
                }
                const prog = clock >= trip.end ? 1 : (clock - trip.start) / (trip.end - trip.start)
                let idx = 1
                while (idx < p.x.length - 1 && p.frac[idx] < prog) idx++
                const m = (prog - p.frac[idx - 1]) / (p.frac[idx] - p.frac[idx - 1] || 1)
                mx = p.x[idx - 1] + (p.x[idx] - p.x[idx - 1]) * Math.min(1, m)
                my = p.y[idx - 1] + (p.y[idx] - p.y[idx - 1]) * Math.min(1, m)
                pct = a + (b - a) * prog
              }
              if (Number.isNaN(mx)) continue
              markers.push({ id: it.id, x: mx, y: my })
              const col = socColor(pct)
              ctx.globalAlpha = dim ? 0.3 : 0.25
              ctx.fillStyle = col
              ctx.beginPath()
              ctx.arc(mx, my, isSel ? 15 : 11, 0, Math.PI * 2)
              ctx.fill()
              ctx.globalAlpha = dim ? 0.4 : 1
              ctx.beginPath()
              ctx.arc(mx, my, isSel ? 7 : 5.5, 0, Math.PI * 2)
              ctx.fill()
              ctx.lineWidth = 2
              ctx.strokeStyle = '#fff'
              ctx.stroke()
              if (isSel) {
                const label = `${it.id}  ${Math.round(pct)}%`
                ctx.font = '500 12px Roboto, Arial, sans-serif'
                const tw = ctx.measureText(label).width
                ctx.globalAlpha = 0.94
                ctx.fillStyle = '#0b2032'
                ctx.fillRect(mx + 12, my - 11, tw + 12, 22)
                ctx.globalAlpha = 1
                ctx.fillStyle = '#fff'
                ctx.fillText(label, mx + 18, my + 4)
              }
            }
          }
          ctx.globalAlpha = 1
          for (const d of depots) {
            if (!d.lat && !d.lng) continue
            const c = map.latLngToContainerPoint([d.lat, d.lng])
            ctx.fillStyle = '#0078d3'
            ctx.strokeStyle = '#fff'
            ctx.lineWidth = 2
            ctx.beginPath()
            ctx.rect(c.x - 7, c.y - 7, 14, 14)
            ctx.fill()
            ctx.stroke()
            ctx.fillStyle = '#fff'
            ctx.font = '700 10px Roboto, Arial, sans-serif'
            ctx.textAlign = 'center'
            ctx.fillText('D', c.x, c.y + 3.5)
            ctx.textAlign = 'left'
          }
        }
        raf = requestAnimationFrame(frame)

        map.on('click', (e: { containerPoint: { x: number; y: number } }) => {
          let best: string | null = null
          let dist = 18
          for (const m of markers) {
            const d = Math.hypot(m.x - e.containerPoint.x, m.y - e.containerPoint.y)
            if (d < dist) {
              dist = d
              best = m.id
            }
          }
          live.current.onSelect?.(best)
        })
        const ro = new ResizeObserver(() => map.invalidateSize())
        ro.observe(host.current)
        cleanup = () => {
          ro.disconnect()
          map.remove()
          mapRef.current = null
        }
        setReady(true)
      })
      .catch(() => setFailed(true))
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      cleanup()
    }
    // The map instance lives for the component's lifetime; live data flows through the ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Frame the fleet when the data changes, not when the temperature does.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const latlngs: LatLng[] = []
    for (const inner of byVehicle.values()) {
      for (const list of inner.values()) {
        for (const t of list.slice(0, 8)) {
          const p = pathOf(t)
          if (p) latlngs.push(p[0], p[Math.floor(p.length / 2)], p[p.length - 1])
        }
        if (latlngs.length > 4000) break
      }
    }
    if (latlngs.length) map.fitBounds(latlngs as [number, number][], { padding: [24, 24], maxZoom: 14 })
  }, [ready, byVehicle])

  return (
    <div className={`map-shell ${dark ? 'map-dark' : ''}`} style={{ height }}>
      <div ref={host} className="map-host" role="application" aria-label={`Map of ${fleet.name}. Trips are coloured by battery state of charge. The vehicle table repeats this data as text.`} />
      <div className="map-legend" aria-hidden="true">
        <span>Battery</span>
        <i className="soc-ramp" />
        <span>0</span><span className="push">100%</span>
      </div>
      <div className="map-clock" aria-hidden="true"><span ref={clockEl}>--:--</span></div>
      {failed ? <div className="map-empty">The map library could not load. Everything else still works.</div> : null}
      {ready && !hasGeo ? <div className="map-empty">No coordinates for this day. Trip-summary files without coordinates still run through the engine; they just cannot be drawn.</div> : null}
    </div>
  )
}
