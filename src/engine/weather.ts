import { dayOf, DAY_MS } from './segment.ts'
import type { Fleet, Settings } from './types.ts'

/** Coordinates are rounded to 0.1 degree (about 10 km) before leaving the browser. Nothing else is sent. */
export const coarse = (x: number) => Math.round(x * 10) / 10
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const API = 'https://archive-api.open-meteo.com/v1/archive'

function cached<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Quota is not worth failing the analysis for; the next visit fetches again.
  }
}

async function getJson(url: string, signal?: AbortSignal) {
  const r = await fetch(url, { signal })
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`)
  return r.json()
}

/** Hour key in the location's local time, matching the fleet-local trip clock. */
export const hourKey = (t: number) => new Date(t).toISOString().slice(0, 13)

export async function fetchHourly(lat: number, lng: number, startMs: number, endMs: number, signal?: AbortSignal): Promise<Record<string, number>> {
  const a = iso(startMs)
  const b = iso(endMs)
  const key = `fel-wx-${coarse(lat)},${coarse(lng)}-${a}-${b}`
  const hit = cached<Record<string, number>>(key)
  if (hit) return hit
  const j = await getJson(`${API}?latitude=${coarse(lat)}&longitude=${coarse(lng)}&start_date=${a}&end_date=${b}&hourly=temperature_2m&timezone=auto`, signal)
  const out: Record<string, number> = {}
  const times: string[] = j.hourly?.time ?? []
  const temps: (number | null)[] = j.hourly?.temperature_2m ?? []
  for (let i = 0; i < times.length; i++) {
    const v = temps[i]
    if (v !== null && v !== undefined) out[times[i].slice(0, 13)] = v
  }
  store(key, out)
  return out
}

/** Coldest seven consecutive days by mean temperature. */
export function coldestWeek(dates: string[], means: (number | null)[]): { start: string; temps: number[]; mean: number } | null {
  let best: { start: string; temps: number[]; mean: number } | null = null
  for (let i = 0; i + 7 <= means.length; i++) {
    const slice = means.slice(i, i + 7)
    if (slice.some((v) => v === null || v === undefined)) continue
    const temps = slice as number[]
    const mean = temps.reduce((s, v) => s + v, 0) / 7
    if (!best || mean < best.mean) best = { start: dates[i], temps, mean }
  }
  return best
}

export interface StressWeek {
  start: string | null
  temps: number[]
  mean: number
  source: 'archive' | 'climate'
}

export async function fetchColdestWeek(lat: number, lng: number, signal?: AbortSignal): Promise<StressWeek> {
  const end = new Date(Date.now() - 7 * DAY_MS)
  const start = new Date(Date.UTC(end.getUTCFullYear() - 5, end.getUTCMonth(), end.getUTCDate()))
  const key = `fel-cold-${coarse(lat)},${coarse(lng)}-${iso(end.getTime()).slice(0, 7)}`
  const hit = cached<StressWeek>(key)
  if (hit) return hit
  const j = await getJson(`${API}?latitude=${coarse(lat)}&longitude=${coarse(lng)}&start_date=${iso(start.getTime())}&end_date=${iso(end.getTime())}&daily=temperature_2m_mean&timezone=auto`, signal)
  const week = coldestWeek(j.daily?.time ?? [], j.daily?.temperature_2m_mean ?? [])
  if (!week) throw new Error('No archive data for this location')
  const out: StressWeek = { start: week.start, temps: week.temps.map((t) => Math.round(t * 10) / 10), mean: week.mean, source: 'archive' }
  store(key, out)
  return out
}

/** Offline stand-in: a week about 12C below the coldest monthly normal, in the range of real cold snaps. */
export function climateStressWeek(s: Settings): StressWeek {
  const cold = Math.min(...s.climate.monthly) - 12
  const temps = [2, 0, -2, -3, -1, 1, 3].map((d) => cold + d)
  return { start: null, temps, mean: temps.reduce((a, b) => a + b, 0) / 7, source: 'climate' }
}

export interface WeatherResult {
  fleet: Fleet
  matched: number
  total: number
  failed: boolean
}

/** Returns a fleet with tempC set from the archive for each trip, keyed to its depot's coarse location. */
export async function applyWeather(f: Fleet, signal?: AbortSignal): Promise<WeatherResult> {
  if (!f.trips.length) return { fleet: f, matched: 0, total: 0, failed: false }
  let first = Infinity
  let last = -Infinity
  for (const t of f.trips) {
    if (t.start < first) first = t.start
    if (t.start > last) last = t.start
  }
  const today = Date.now() - 6 * DAY_MS
  if (first > today) return { fleet: f, matched: 0, total: f.trips.length, failed: false }
  const endMs = Math.min(last, today)
  const hours = new Map<string, Record<string, number>>()
  let failed = false
  for (const d of f.depots) {
    if (!d.lat && !d.lng) continue
    try {
      hours.set(d.id, await fetchHourly(d.lat, d.lng, dayOf(first) * DAY_MS, dayOf(endMs) * DAY_MS, signal))
    } catch {
      failed = true
    }
  }
  const depotOf = new Map(f.vehicles.map((v) => [v.id, v.depot]))
  let matched = 0
  const trips = f.trips.map((t) => {
    const h = hours.get(depotOf.get(t.vehicle) ?? '')
    const c = h?.[hourKey(t.start)]
    if (c === undefined) return t.tempC === undefined ? t : { ...t, tempC: undefined }
    matched++
    return { ...t, tempC: c }
  })
  return { fleet: { ...f, trips }, matched, total: f.trips.length, failed }
}
