import { assembleFleet } from './segment.ts'
import type { Fleet, LatLng, Trip, VClass } from './types.ts'

export interface RouteLeg {
  km: number
  min: number
  path: LatLng[]
}
export interface RouteFile {
  loops: { depot: LatLng; legs: RouteLeg[] }[]
}

export type SampleId = 'toronto' | 'rural' | 'mixed'

export const SAMPLES: { id: SampleId; name: string; blurb: string; climate: string }[] = [
  { id: 'toronto', name: 'Urban delivery vans, Toronto', blurb: 'Synthetic. 12 multi-drop vans, slow stop-go routes, one depot in Etobicoke.', climate: 'Toronto' },
  { id: 'rural', name: 'Rural service trucks, central Alberta', blurb: 'Synthetic. 8 pickups on long highway days, two depots, some nights away.', climate: 'Red Deer' },
  { id: 'mixed', name: 'Mixed fleet, Hamilton', blurb: 'Synthetic. 10 vans, pickups and cars. Some carry more than any EV in their class can.', climate: 'Toronto' },
]

interface Spec {
  id: string
  cls: VClass
  loadKg: number
  dayKm: number
  kph: number
  days: number[]
  away?: number
}

const SPECS: Record<SampleId, Spec[]> = {
  toronto: [
    { id: 'Van 01', cls: 'van', loadKg: 500, dayKm: 75, kph: 24, days: [1, 2, 3, 4, 5] },
    { id: 'Van 02', cls: 'van', loadKg: 550, dayKm: 85, kph: 26, days: [1, 2, 3, 4, 5] },
    { id: 'Van 03', cls: 'van', loadKg: 600, dayKm: 95, kph: 25, days: [1, 2, 3, 4, 5] },
    { id: 'Van 04', cls: 'van', loadKg: 450, dayKm: 100, kph: 28, days: [1, 2, 3, 4, 5, 6] },
    { id: 'Van 05', cls: 'van', loadKg: 700, dayKm: 105, kph: 24, days: [1, 2, 3, 4, 5] },
    { id: 'Van 06', cls: 'van', loadKg: 650, dayKm: 110, kph: 27, days: [1, 2, 3, 4, 5, 6] },
    { id: 'Van 07', cls: 'van', loadKg: 500, dayKm: 118, kph: 30, days: [1, 2, 3, 4, 5] },
    { id: 'Van 08', cls: 'van', loadKg: 800, dayKm: 125, kph: 26, days: [1, 2, 3, 4, 5, 6] },
    { id: 'Van 09', cls: 'van', loadKg: 600, dayKm: 135, kph: 31, days: [1, 2, 3, 4, 5] },
    { id: 'Van 10', cls: 'van', loadKg: 900, dayKm: 145, kph: 28, days: [1, 2, 3, 4, 5, 6] },
    { id: 'Van 11', cls: 'van', loadKg: 750, dayKm: 165, kph: 34, days: [1, 2, 3, 4, 5, 6] },
    { id: 'Van 12', cls: 'van', loadKg: 1000, dayKm: 195, kph: 36, days: [1, 2, 3, 4, 5, 6] },
  ],
  rural: [
    { id: 'Truck 01', cls: 'pickup', loadKg: 350, dayKm: 150, kph: 68, days: [1, 2, 3, 4, 5] },
    { id: 'Truck 02', cls: 'pickup', loadKg: 400, dayKm: 185, kph: 72, days: [1, 2, 3, 4, 5] },
    { id: 'Truck 03', cls: 'pickup', loadKg: 300, dayKm: 210, kph: 76, days: [1, 2, 3, 4, 5] },
    { id: 'Truck 04', cls: 'pickup', loadKg: 450, dayKm: 240, kph: 80, days: [1, 2, 3, 4, 5] },
    { id: 'Truck 05', cls: 'pickup', loadKg: 500, dayKm: 275, kph: 84, days: [1, 2, 3, 4, 5], away: 0.06 },
    { id: 'Truck 06', cls: 'pickup', loadKg: 400, dayKm: 320, kph: 88, days: [1, 2, 3, 4, 5], away: 0.1 },
    { id: 'Truck 07', cls: 'pickup', loadKg: 550, dayKm: 370, kph: 90, days: [1, 2, 3, 4, 5, 6], away: 0.12 },
    { id: 'Truck 08', cls: 'pickup', loadKg: 450, dayKm: 430, kph: 92, days: [1, 2, 3, 4, 5, 6], away: 0.15 },
  ],
  mixed: [
    { id: 'Car 01', cls: 'car', loadKg: 120, dayKm: 110, kph: 48, days: [1, 2, 3, 4, 5] },
    { id: 'Car 02', cls: 'car', loadKg: 100, dayKm: 165, kph: 62, days: [1, 2, 3, 4, 5] },
    { id: 'Van 01', cls: 'van', loadKg: 700, dayKm: 90, kph: 30, days: [1, 2, 3, 4, 5] },
    { id: 'Van 02', cls: 'van', loadKg: 1000, dayKm: 110, kph: 33, days: [1, 2, 3, 4, 5] },
    { id: 'Van 03 (heavy)', cls: 'van', loadKg: 1750, dayKm: 95, kph: 30, days: [1, 2, 3, 4, 5, 6] },
    { id: 'Van 04 (heavy)', cls: 'van', loadKg: 1650, dayKm: 120, kph: 36, days: [1, 2, 3, 4, 5, 6] },
    { id: 'Pickup 01', cls: 'pickup', loadKg: 300, dayKm: 120, kph: 44, days: [1, 2, 3, 4, 5] },
    { id: 'Pickup 02', cls: 'pickup', loadKg: 500, dayKm: 150, kph: 52, days: [1, 2, 3, 4, 5] },
    { id: 'Pickup 03 (heavy)', cls: 'pickup', loadKg: 950, dayKm: 135, kph: 46, days: [1, 2, 3, 4, 5, 6] },
    { id: 'Pickup 04 (heavy)', cls: 'pickup', loadKg: 1100, dayKm: 175, kph: 55, days: [1, 2, 3, 4, 5, 6] },
  ],
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const START = Date.UTC(2025, 8, 1)
const WEEKS = 26
const DAY = 86400e3

/** Builds a synthetic fleet, deterministically, from baked road geometry. Every trip here is made up. */
export function buildSample(id: SampleId, routes: RouteFile): Fleet {
  const meta = SAMPLES.find((x) => x.id === id)!
  const trips: Trip[] = []
  const classes: Record<string, VClass> = {}
  const loads: Record<string, number> = {}
  SPECS[id].forEach((spec, vi) => {
    classes[spec.id] = spec.cls
    loads[spec.id] = spec.loadKg
    const r = rng(9973 * (vi + 1) + id.length)
    const loop = routes.loops[vi % routes.loops.length]
    const loopKm = loop.legs.reduce((sum, l) => sum + l.km, 0)
    for (let d = 0; d < WEEKS * 7; d++) {
      const date = START + d * DAY
      if (!spec.days.includes(new Date(date).getUTCDay())) continue
      if (r() < 0.02) continue
      const dayKm = spec.dayKm * (0.82 + r() * 0.36)
      const scale = dayKm / loopKm
      let clock = date + (6.75 + r() * 1.25) * 3600e3
      const stayAway = spec.away !== undefined && r() < spec.away
      const legCount = stayAway ? loop.legs.length - 1 : loop.legs.length
      for (let k = 0; k < legCount; k++) {
        const leg = loop.legs[k]
        const km = leg.km * scale
        const movingH = (km / spec.kph) * (0.93 + r() * 0.14)
        const idleH = movingH * (0.03 + r() * 0.04)
        const hours = movingH + idleH
        const end = clock + hours * 3600e3
        const v = spec.kph
        const sl = v < 40 ? 0.42 : v < 60 ? 0.2 : 0.06
        const mid = v < 40 ? 0.5 : v < 60 ? 0.5 : 0.2
        const hwy = v < 70 ? 0 : (v - 70) / 25
        const speedKm: Trip['speedKm'] = [km * sl, km * mid, km * Math.max(0, 1 - sl - mid - hwy), km * Math.min(hwy, 1 - sl - mid)]
        trips.push({
          vehicle: spec.id,
          start: clock,
          end,
          km,
          idleH,
          speedKm,
          loadKg: Math.round(spec.loadKg * (0.92 + r() * 0.16)),
          path: leg.path,
          from: leg.path[0],
          to: leg.path[leg.path.length - 1],
        })
        clock = end + (12 + r() * 28) * 60e3
      }
    }
  })
  return assembleFleet(trips, { name: meta.name, synthetic: true, description: meta.blurb, classes, loads })
}

export async function loadSample(id: SampleId): Promise<Fleet> {
  const mod = id === 'toronto' ? await import('../samples/routes-toronto.json') : id === 'rural' ? await import('../samples/routes-rural.json') : await import('../samples/routes-mixed.json')
  return buildSample(id, mod.default as unknown as RouteFile)
}

/** Sample as a GPS CSV for the first N operating days, so the import path can be tried end to end. */
export function samplePointsCsv(f: Fleet, days: number): string {
  const lines = ['vehicle,timestamp,lat,lng,speed_kph,load_kg']
  const first = Math.min(...f.trips.map((t) => t.start))
  const cutoff = first + days * DAY
  const fmt = (t: number) => new Date(t).toISOString().slice(0, 19)
  const sorted = f.trips.filter((t) => t.start < cutoff).sort((a, b) => a.start - b.start)
  for (const t of sorted) {
    const path = t.path ?? []
    if (path.length < 2) continue
    const dur = t.end - t.start
    const kph = t.km / (dur / 3600e3)
    path.forEach((p, i) => {
      lines.push(`${t.vehicle},${fmt(t.start + (i / (path.length - 1)) * dur)},${p[0]},${p[1]},${kph.toFixed(1)},${t.loadKg ?? ''}`)
    })
  }
  return lines.join('\n')
}
