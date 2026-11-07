import { guessClass } from './parse.ts'
import type { Depot, Fleet, GpsPoint, LatLng, Trip, VClass, Vehicle } from './types.ts'

export const DAY_MS = 86400e3
export const dayOf = (t: number) => Math.floor(t / DAY_MS)

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180
  const dLat = (bLat - aLat) * rad
  const dLng = (bLng - aLng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface SegmentOptions {
  stopMinutes: number
  maxKph: number
  noiseMeters: number
  idleSeconds: number
}
export const DEFAULT_SEGMENT: SegmentOptions = { stopMinutes: 10, maxKph: 180, noiseMeters: 40, idleSeconds: 60 }

/** Drops invalid coordinates and GPS jumps. A jump that persists for three points is a real relocation, so it is accepted. */
export function filterPoints(points: GpsPoint[], maxKph: number): { kept: GpsPoint[]; jumps: number; invalid: number } {
  const kept: GpsPoint[] = []
  let jumps = 0
  let invalid = 0
  let pending: GpsPoint[] = []
  for (const p of points) {
    if (Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180 || (p.lat === 0 && p.lng === 0)) {
      invalid++
      continue
    }
    const last = kept[kept.length - 1]
    if (last) {
      const hours = Math.max((p.t - last.t) / 3600e3, 1 / 3600)
      if (p.t === last.t || haversineKm(last.lat, last.lng, p.lat, p.lng) / hours > maxKph) {
        pending.push(p)
        const a = pending[pending.length - 2]
        if (a && haversineKm(a.lat, a.lng, p.lat, p.lng) / Math.max((p.t - a.t) / 3600e3, 1 / 3600) > maxKph) {
          jumps += pending.length - 1
          pending = [p]
        } else if (pending.length >= 3) {
          kept.push(...pending)
          pending = []
        }
        continue
      }
      jumps += pending.length
      pending = []
    }
    kept.push(p)
  }
  jumps += pending.length
  return { kept, jumps, invalid }
}

// Every-Nth downsampling for the map line only. Douglas-Peucker if corners look wrong at high zoom.
function thin(path: LatLng[], max = 120): LatLng[] {
  if (path.length <= max) return path
  const step = (path.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, i) => path[Math.round(i * step)])
}

/** Splits one vehicle's sorted, filtered points into trips by stop duration, measuring idling inside each trip. */
export function segmentTrips(points: GpsPoint[], opts: SegmentOptions = DEFAULT_SEGMENT): Trip[] {
  if (points.length < 2) return []
  const trips: Trip[] = []
  const stopMs = opts.stopMinutes * 60e3
  const noiseKm = opts.noiseMeters / 1000
  let anchor = points[0]
  let prev = points[0]
  let trip: { start: number; end: number; km: number; idleMs: number; bands: Trip['speedKm']; path: LatLng[]; load?: number; odoStart?: number; odoEnd?: number } | null = null

  const close = () => {
    if (trip && trip.km >= 0.2 && trip.end > trip.start) {
      // Prefer the odometer over summed GPS when it is present and agrees within a factor of two.
      const odo = trip.odoStart !== undefined && trip.odoEnd !== undefined ? trip.odoEnd - trip.odoStart : undefined
      const km = odo !== undefined && odo > trip.km / 2 && odo < trip.km * 2 ? odo : trip.km
      const scale = km / trip.km
      trips.push({
        vehicle: points[0].vehicle,
        start: trip.start,
        end: trip.end,
        km,
        idleH: trip.idleMs / 3600e3,
        speedKm: trip.bands.map((b) => b * scale) as Trip['speedKm'],
        loadKg: trip.load,
        path: thin(trip.path),
        from: trip.path[0],
        to: trip.path[trip.path.length - 1],
      })
    }
    trip = null
  }

  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    const d = haversineKm(anchor.lat, anchor.lng, p.lat, p.lng)
    if (d < noiseKm) {
      prev = p
      continue
    }
    const stationaryMs = prev.t - anchor.t
    const silentMs = p.t - prev.t
    const legKph = silentMs > 0 ? d / (silentMs / 3600e3) : 0
    // Silent gap: implausibly slow means it parked and moved on, otherwise it is a telemetry dropout mid-trip.
    const silentStop = silentMs >= stopMs && legKph < 15
    if (stationaryMs >= stopMs || silentStop) close()
    if (trip && stationaryMs >= opts.idleSeconds * 1000) trip.idleMs += stationaryMs
    if (!trip) {
      const start = silentStop ? Math.max(prev.t, p.t - (d / 30) * 3600e3) : prev.t
      trip = { start, end: p.t, km: 0, idleMs: 0, bands: [0, 0, 0, 0], path: [[anchor.lat, anchor.lng]], odoStart: anchor.odoKm }
    }
    trip.km += d
    trip.end = p.t
    const speed = p.speedKph ?? legKph
    trip.bands[speed < 30 ? 0 : speed < 60 ? 1 : speed < 90 ? 2 : 3] += d
    trip.path.push([p.lat, p.lng])
    if (p.odoKm !== undefined) trip.odoEnd = p.odoKm
    if (p.loadKg !== undefined) trip.load = Math.max(trip.load ?? 0, p.loadKg)
    anchor = p
    prev = p
  }
  close()
  return trips
}

/** Assigns each vehicle a depot from its most common overnight location, merges close depots, and scores return-to-base. */
export function inferDepots(vehicleIds: string[], trips: Trip[]): { depots: Depot[]; home: Map<string, string>; rtb: Map<string, number | null> } {
  const byVehicle = new Map<string, Trip[]>(vehicleIds.map((v) => [v, []]))
  for (const t of trips) byVehicle.get(t.vehicle)?.push(t)
  const homes = new Map<string, LatLng>()
  for (const [v, list] of byVehicle) {
    list.sort((a, b) => a.start - b.start)
    const cells = new Map<string, { n: number; lat: number; lng: number }>()
    const add = (at: LatLng | undefined, weight = 1) => {
      if (!at) return
      const key = `${Math.round(at[0] / 0.005)},${Math.round(at[1] / 0.005)}`
      const c = cells.get(key) ?? { n: 0, lat: 0, lng: 0 }
      c.n += weight
      c.lat += at[0] * weight
      c.lng += at[1] * weight
      cells.set(key, c)
    }
    for (let i = 0; i < list.length; i++) {
      const next = list[i + 1]
      const gap = next ? next.start - list[i].end : Infinity
      if (gap < 4 * 3600e3) continue
      const end = new Date(list[i].end)
      // Count it as overnight if the vehicle sits through 03:00.
      const threeAm = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + (end.getUTCHours() >= 3 ? 1 : 0), 3)
      if (list[i].end <= threeAm && (next ? next.start : Infinity) > threeAm) add(list[i].to)
    }
    // Short extract with no overnight gap: fall back to where the vehicle starts its days.
    if (!cells.size) add(list[0]?.from)
    let top: { n: number; lat: number; lng: number } | null = null
    for (const c of cells.values()) if (!top || c.n > top.n) top = c
    if (top) homes.set(v, [top.lat / top.n, top.lng / top.n])
  }

  const depots: (Depot & { n: number })[] = []
  const home = new Map<string, string>()
  for (const [v, at] of homes) {
    let d = depots.find((x) => haversineKm(x.lat, x.lng, at[0], at[1]) < 1)
    if (!d) {
      d = { id: `Depot ${depots.length + 1}`, lat: at[0], lng: at[1], inferred: true, n: 0 }
      depots.push(d)
    }
    d.n++
    home.set(v, d.id)
  }
  const fallback: Depot = { id: 'Depot (assumed)', lat: 0, lng: 0, inferred: false }
  const rtb = new Map<string, number | null>()
  for (const [v, list] of byVehicle) {
    const id = home.get(v)
    const depot = depots.find((d) => d.id === id)
    if (!depot) {
      home.set(v, fallback.id)
      rtb.set(v, null)
      for (const t of list) t.endsAtDepot = true
      continue
    }
    const days = new Map<number, Trip>()
    for (const t of list) {
      t.endsAtDepot = t.to ? haversineKm(depot.lat, depot.lng, t.to[0], t.to[1]) < 0.75 : true
      days.set(dayOf(t.start), t)
    }
    let back = 0
    for (const t of days.values()) if (t.endsAtDepot) back++
    rtb.set(v, days.size ? (back / days.size) * 100 : null)
  }
  const out: Depot[] = depots.map(({ id, lat, lng, inferred }) => ({ id, lat, lng, inferred }))
  if ([...home.values()].includes(fallback.id)) out.push(fallback)
  return { depots: out, home, rtb }
}

export interface FleetBuildOptions {
  name: string
  synthetic?: boolean
  description?: string
  defaultCls?: VClass
  defaultLoadKg?: number
  classes?: Record<string, VClass>
  loads?: Record<string, number>
  stats?: Fleet['stats']
}

export function assembleFleet(trips: Trip[], o: FleetBuildOptions): Fleet {
  const ids = [...new Set(trips.map((t) => t.vehicle))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const { depots, home, rtb } = inferDepots(ids, trips)
  const vehicles: Vehicle[] = ids.map((id) => ({
    id,
    cls: o.classes?.[id] ?? o.defaultCls ?? guessClass(id),
    loadKg: o.loads?.[id] ?? o.defaultLoadKg ?? 200,
    depot: home.get(id)!,
    rtbPct: rtb.get(id) ?? null,
  }))
  return { name: o.name, synthetic: !!o.synthetic, description: o.description, vehicles, trips, depots, stats: o.stats }
}

export function fleetFromPoints(points: GpsPoint[], o: FleetBuildOptions, seg: SegmentOptions = DEFAULT_SEGMENT): Fleet {
  const byVehicle = new Map<string, GpsPoint[]>()
  for (const p of points) {
    const list = byVehicle.get(p.vehicle)
    if (list) list.push(p)
    else byVehicle.set(p.vehicle, [p])
  }
  const trips: Trip[] = []
  let droppedJumps = 0
  let droppedInvalid = 0
  for (const list of byVehicle.values()) {
    list.sort((a, b) => a.t - b.t)
    const { kept, jumps, invalid } = filterPoints(list, seg.maxKph)
    droppedJumps += jumps
    droppedInvalid += invalid
    trips.push(...segmentTrips(kept, seg))
  }
  return assembleFleet(trips, { ...o, stats: { points: points.length, droppedJumps, droppedInvalid } })
}
