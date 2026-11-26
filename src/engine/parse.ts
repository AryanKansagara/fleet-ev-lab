import type { GpsPoint, LatLng, Trip, VClass } from './types.ts'

export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '')
  const firstLine = clean.slice(0, clean.indexOf('\n') + 1 || clean.length)
  const delims = [',', ';', '\t', '|']
  const d = delims.reduce((best, c) => (firstLine.split(c).length > firstLine.split(best).length ? c : best), ',')
  const rows: string[][] = []
  let row: string[] = []
  let f = ''
  let q = false
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i]
    if (q) {
      if (c === '"') {
        if (clean[i + 1] === '"') {
          f += '"'
          i++
        } else q = false
      } else f += c
    } else if (c === '"') q = true
    else if (c === d) {
      row.push(f)
      f = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++
      row.push(f)
      f = ''
      if (row.length > 1 || row[0].trim()) rows.push(row)
      row = []
    } else f += c
  }
  if (f || row.length) {
    row.push(f)
    if (row.length > 1 || row[0].trim()) rows.push(row)
  }
  return rows
}

export type Field =
  | 'vehicle' | 'timestamp' | 'lat' | 'lng' | 'speed' | 'odometer' | 'load'
  | 'start' | 'end' | 'distance' | 'idle' | 'startLat' | 'startLng' | 'endLat' | 'endLng'

export const POINT_FIELDS: Field[] = ['vehicle', 'timestamp', 'lat', 'lng', 'speed', 'odometer', 'load']
export const TRIP_FIELDS: Field[] = ['vehicle', 'start', 'end', 'distance', 'idle', 'load', 'startLat', 'startLng', 'endLat', 'endLng']

const SYN: Record<Field, string[]> = {
  vehicle: ['vehicle', 'vehicle id', 'vehicleid', 'device', 'device name', 'devicename', 'device id', 'deviceid', 'asset', 'unit', 'unit id', 'vin', 'truck', 'van', 'name', 'id'],
  timestamp: ['timestamp', 'datetime', 'date time', 'date/time', 'time', 'gps time', 'gpstime', 'recorded at', 'date'],
  lat: ['lat', 'latitude', 'y', 'gps lat'],
  lng: ['lng', 'lon', 'long', 'longitude', 'x', 'gps lon', 'gps lng'],
  speed: ['speed', 'speed kph', 'speed km/h', 'speed (km/h)', 'kph', 'kmh', 'speed mph', 'speed (mph)', 'mph', 'speed m/s', 'speed (m/s)', 'velocity'],
  odometer: ['odometer', 'odo', 'odometer km', 'odometer (km)', 'mileage'],
  load: ['load', 'load kg', 'payload', 'payload kg', 'cargo', 'cargo kg', 'weight'],
  start: ['start', 'start time', 'starttime', 'start date', 'trip start', 'departure', 'start datetime'],
  end: ['end', 'stop', 'end time', 'endtime', 'stop time', 'end date', 'trip end', 'arrival', 'end datetime'],
  distance: ['distance', 'distance km', 'distance (km)', 'km', 'distance mi', 'distance (mi)', 'distance miles', 'distance (miles)', 'miles', 'trip distance', 'driving distance'],
  idle: ['idle', 'idle min', 'idle minutes', 'idling', 'idle time', 'idling duration', 'idlingduration', 'idle duration', 'idle seconds', 'idle sec', 'idle (s)', 'idling duration ticks', 'idlingdurationticks'],
  startLat: ['start lat', 'start latitude', 'startlat', 'from lat'],
  startLng: ['start lng', 'start lon', 'start longitude', 'startlng', 'startlon', 'from lng', 'from lon'],
  endLat: ['end lat', 'end latitude', 'endlat', 'stop lat', 'stop latitude', 'to lat', 'stop point y', 'stoppointy'],
  endLng: ['end lng', 'end lon', 'end longitude', 'endlng', 'endlon', 'stop lng', 'stop lon', 'stop longitude', 'to lng', 'to lon', 'stop point x', 'stoppointx'],
}

const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()

export type ColumnMap = Partial<Record<Field, number>>

export function guessMapping(header: string[]): { kind: 'points' | 'trips'; map: ColumnMap; units: Units } {
  const cols = header.map(norm)
  const map: ColumnMap = {}
  const fields = Object.keys(SYN) as Field[]
  // Exact matches first, in synonym order, so "start lat" never claims "start".
  for (const f of fields) {
    for (const syn of SYN[f]) {
      const at = cols.indexOf(syn)
      if (at >= 0 && !Object.values(map).includes(at)) {
        map[f] = at
        break
      }
    }
  }
  // Second pass with a trailing unit dropped, so "Load (lb)" or "Odometer mi" still map; units are read from the original name.
  const bare = cols.map((c) => c.replace(/\s*\(?\b(km\/h|kph|mph|m\/s|km|mi|miles|kg|lbs?|min|minutes|s|sec|seconds)\)?$/, ''))
  for (const f of fields) {
    if (map[f] !== undefined) continue
    const at = bare.findIndex((c, i) => SYN[f].includes(c) && !Object.values(map).includes(i))
    if (at >= 0) map[f] = at
  }
  const kind = map.lat !== undefined && map.lng !== undefined && map.timestamp !== undefined ? 'points' : 'trips'
  return { kind, map, units: unitsFromHeader(cols, map) }
}

/** Reads units off the mapped column names, e.g. "Speed (mph)", "Distance mi", "IdlingDurationTicks". */
export function unitsFromHeader(cols: string[], map: ColumnMap): Units {
  const h = (f: Field) => (map[f] === undefined ? '' : cols[map[f]!])
  const speed = h('speed')
  const idle = h('idle')
  return {
    distance: /\b(mi|miles?)\b/.test(h('distance')) ? 'mi' : 'km',
    speed: /mph/.test(speed) ? 'mph' : /m\/s/.test(speed) ? 'mps' : 'kph',
    load: /\b(lb|lbs)\b/.test(h('load')) ? 'lb' : 'kg',
    idle: /ticks/.test(idle) ? 'ticks' : /\b(s|sec|secs|seconds)\b/.test(idle) ? 's' : 'min',
  }
}

/**
 * A file with no header row, such as the T-Drive taxi layout "id,datetime,lng,lat". Returns a mapping guessed
 * from the values, or null when the first row looks like a header.
 */
export function guessHeaderless(row: string[]): ColumnMap | null {
  if (row.some((c) => /[a-z]{4,}/i.test(c) && parseTime(c) === null)) return null
  const map: ColumnMap = {}
  const ts = row.findIndex((c) => !/^-?\d+(\.\d+)?$/.test(c.trim()) && parseTime(c) !== null)
  if (ts < 0) return null
  map.timestamp = ts
  const dec = row.map((c, i) => (i !== ts && /^-?\d{1,3}\.\d{3,}$/.test(c.trim()) ? i : -1)).filter((i) => i >= 0)
  if (dec.length < 2) return null
  const [a, b] = dec
  // Longitude is the one outside +-90; otherwise assume latitude comes first.
  if (Math.abs(+row[a]) > 90) [map.lng, map.lat] = [a, b]
  else [map.lat, map.lng] = [a, b]
  const v = row.findIndex((_, i) => i < Math.min(ts, a))
  if (v >= 0) map.vehicle = v
  return map
}

const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ')

/**
 * Parses a timestamp to fleet-local milliseconds. Wall-clock stamps are kept as written. Stamps with an offset
 * or Z are shifted by the longitude-derived zone.
 * Longitude approximates the zone and ignores DST. Good enough to find "overnight"; use a tz database if hour-level precision matters.
 */
export function parseTime(raw: string, lng?: number): number | null {
  const s = raw.trim()
  if (!s) return null
  if (/^\d{9,13}(\.\d+)?$/.test(s)) {
    const n = Number(s)
    const ms = n > 1e11 ? n : n * 1000
    return ms + (lng === undefined ? 0 : (Math.round(lng / 15) * 3600e3))
  }
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i)
  if (m) {
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
    if (!m[7]) return wall
    const abs = m[7].toUpperCase() === 'Z' ? wall : wall - offsetMs(m[7])
    return abs + (lng === undefined ? (m[7].toUpperCase() === 'Z' ? 0 : offsetMs(m[7])) : Math.round(lng / 15) * 3600e3)
  }
  // North American month-first, as most telematics CSV exports write it. 13-31 in the first slot means day-first.
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$/i)
  if (m) {
    let mo = +m[1]
    let da = +m[2]
    if (mo > 12) [mo, da] = [da, mo]
    let h = +(m[4] ?? 0)
    if (m[7]?.toUpperCase() === 'PM' && h < 12) h += 12
    if (m[7]?.toUpperCase() === 'AM' && h === 12) h = 0
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]
    return Date.UTC(y, mo - 1, da, h, +(m[5] ?? 0), +(m[6] ?? 0))
  }
  m = s.match(/^(\d{1,2})[- ]([a-z]{3})[a-z]*[- ](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/i)
  if (m && MONTHS.includes(m[2].toLowerCase())) {
    return Date.UTC(+m[3], MONTHS.indexOf(m[2].toLowerCase()), +m[1], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
  }
  return null
}

function offsetMs(z: string): number {
  const sign = z[0] === '-' ? -1 : 1
  const d = z.slice(1).replace(':', '')
  return sign * (+d.slice(0, 2) * 60 + +(d.slice(2, 4) || 0)) * 60e3
}

const num = (s: string | undefined) => {
  if (s === undefined || s.trim() === '') return undefined
  let t = s.trim()
  // Decimal comma, as GPSLogger and European exports write it: "43,6532" or "1.234,5". A lone ",ddd" is a thousands separator.
  if (/^[+-]?\d+,\d+$/.test(t) && !/^[+-]?\d{1,3},\d{3}$/.test(t)) t = t.replace(',', '.')
  else if (/^[+-]?\d{1,3}(\.\d{3})+,\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.')
  const n = Number(t.replace(/[^0-9.eE+-]/g, ''))
  return Number.isFinite(n) ? n : undefined
}

/**
 * One longitude per vehicle, the median of its positions, to take its time zone from. A zone must not change inside a
 * vehicle's data: a clock that jumps an hour at a 15-degree line reorders fixes and stretches or inverts trips.
 */
function homeLngs(at: Iterable<[vehicle: string, lat: number | undefined, lng: number | undefined]>): Map<string, number> {
  const all = new Map<string, number[]>()
  for (const [v, lat, lng] of at) {
    if (lng === undefined || !(Math.abs(lng) <= 180) || (lng === 0 && !lat)) continue
    const list = all.get(v)
    if (list) list.push(lng)
    else all.set(v, [lng])
  }
  return new Map([...all].map(([v, list]) => [v, list.sort((a, b) => a - b)[list.length >> 1]]))
}

/** Coordinates never carry a thousands separator, so any comma is a decimal comma. */
const coord = (s: string | undefined) => num(s?.replace(',', '.'))

/** Duration in minutes from a plain number in the given unit, or a "[d.]hh:mm[:ss[.fffffff]]" span as MyGeotab and .NET write it. */
export function parseDurationMin(s: string | undefined, unit: Units['idle'] = 'min'): number | undefined {
  const t = s?.trim()
  if (!t) return undefined
  const m = t.match(/^(?:(\d+)\.)?(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/)
  if (m) return +(m[1] ?? 0) * 1440 + +m[2] * 60 + +m[3] + +(m[4] ?? 0) / 60
  const n = num(t)
  if (n === undefined) return undefined
  return unit === 's' ? n / 60 : unit === 'ticks' ? n / 6e8 : n
}

export interface Units {
  distance: 'km' | 'mi'
  speed: 'kph' | 'mph' | 'mps'
  load: 'kg' | 'lb'
  idle?: 'min' | 's' | 'ticks'
}
export const DEFAULT_UNITS: Units = { distance: 'km', speed: 'kph', load: 'kg', idle: 'min' }
const SPEED_K: Record<Units['speed'], number> = { kph: 1, mph: 1.60934, mps: 3.6 }

export function rowsToPoints(rows: string[][], map: ColumnMap, units: Units = DEFAULT_UNITS, fallbackVehicle = 'Vehicle 1'): { points: GpsPoint[]; bad: number } {
  const points: GpsPoint[] = []
  let bad = 0
  const dk = units.distance === 'mi' ? 1.60934 : 1
  const sk = SPEED_K[units.speed] ?? 1
  const lk = units.load === 'lb' ? 0.453592 : 1
  const vehicleOf = (r: string[]) => r[map.vehicle ?? -1]?.trim() || fallbackVehicle
  const home = homeLngs(rows.map((r) => [vehicleOf(r), coord(r[map.lat ?? -1]), coord(r[map.lng ?? -1])]))
  for (const r of rows) {
    const vehicle = vehicleOf(r)
    const lat = coord(r[map.lat ?? -1])
    const lng = coord(r[map.lng ?? -1])
    const t = parseTime(r[map.timestamp ?? -1] ?? '', home.get(vehicle))
    if (lat === undefined || lng === undefined || t === null) {
      bad++
      continue
    }
    const speed = num(r[map.speed ?? -1])
    const odo = num(r[map.odometer ?? -1])
    const load = num(r[map.load ?? -1])
    points.push({
      vehicle,
      t,
      lat,
      lng,
      speedKph: speed === undefined ? undefined : speed * sk,
      odoKm: odo === undefined ? undefined : odo * dk,
      loadKg: load === undefined ? undefined : load * lk,
    })
  }
  return { points, bad }
}

export function bandKm(km: number, avgKph: number): Trip['speedKm'] {
  const b: Trip['speedKm'] = [0, 0, 0, 0]
  b[avgKph < 30 ? 0 : avgKph < 60 ? 1 : avgKph < 90 ? 2 : 3] = km
  return b
}

export function rowsToTrips(rows: string[][], map: ColumnMap, units: Units = DEFAULT_UNITS, fallbackVehicle = 'Vehicle 1'): { trips: Trip[]; bad: number } {
  const trips: Trip[] = []
  let bad = 0
  const dk = units.distance === 'mi' ? 1.60934 : 1
  const lk = units.load === 'lb' ? 0.453592 : 1
  const vehicleOf = (r: string[]) => r[map.vehicle ?? -1]?.trim() || fallbackVehicle
  const home = homeLngs(rows.flatMap((r) => (['start', 'end'] as const).map((e): [string, number | undefined, number | undefined] => [vehicleOf(r), coord(r[map[`${e}Lat`] ?? -1]), coord(r[map[`${e}Lng`] ?? -1])])))
  for (const r of rows) {
    const vehicle = vehicleOf(r)
    const startLng = coord(r[map.startLng ?? -1])
    const endLng = coord(r[map.endLng ?? -1])
    const start = parseTime(r[map.start ?? -1] ?? '', home.get(vehicle))
    const end = parseTime(r[map.end ?? -1] ?? '', home.get(vehicle))
    const dist = num(r[map.distance ?? -1])
    if (start === null || end === null || dist === undefined || end <= start || dist < 0) {
      bad++
      continue
    }
    const km = dist * dk
    const idleMin = parseDurationMin(r[map.idle ?? -1], units.idle) ?? 0
    const hours = (end - start) / 3600e3
    const idleH = Math.min(idleMin / 60, hours * 0.95)
    const load = num(r[map.load ?? -1])
    const startLat = coord(r[map.startLat ?? -1])
    const endLat = coord(r[map.endLat ?? -1])
    trips.push({
      vehicle,
      start,
      end,
      km,
      idleH,
      speedKm: bandKm(km, km / Math.max(hours - idleH, 0.01)),
      loadKg: load === undefined ? undefined : load * lk,
      from: startLat !== undefined && startLng !== undefined ? [startLat, startLng] : undefined,
      to: endLat !== undefined && endLng !== undefined ? [endLat, endLng] : undefined,
    })
  }
  return { trips, bad }
}

const GENERIC_TRACK = /^(active log|current track|track|untitled|\d{4}-\d{2}-\d{2}[ T][\d:]+.*|.*\b(ride|run|walk|drive|activity)\b.*)$/i

/** Minimal GPX reader for tracks and routes. Each track name becomes a vehicle unless one is provided. */
export function parseGpx(xml: string, fallbackVehicle = 'Vehicle 1'): GpsPoint[] {
  const found: (Omit<GpsPoint, 't'> & { time: string })[] = []
  const tracks = xml.match(/<trk[\s>][\s\S]*?<\/trk>/g) ?? [xml]
  for (const trk of tracks) {
    // Only the track's own name, before its first segment. Garmin and Strava name tracks by date or activity, which is not a vehicle.
    const own = trk.split(/<trkseg[\s>]/)[0].match(/<name>\s*(?:<!\[CDATA\[)?([^<\]]+)/)?.[1]?.trim()
    const name = own && !GENERIC_TRACK.test(own) && parseTime(own) === null ? own : fallbackVehicle
    for (const m of trk.matchAll(/<(?:trkpt|rtept|wpt)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:trkpt|rtept|wpt)>)/g)) {
      const lat = Number(m[1].match(/lat=["']([^"']+)/)?.[1])
      const lng = Number(m[1].match(/lon=["']([^"']+)/)?.[1])
      const body = m[2] ?? ''
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
      const speedMs = Number(body.match(/<(?:\w+:)?speed>([^<]+)/)?.[1])
      found.push({ vehicle: name, time: body.match(/<time>([^<]+)/)?.[1] ?? '', lat, lng, speedKph: Number.isFinite(speedMs) ? speedMs * 3.6 : undefined })
    }
  }
  const home = homeLngs(found.map((p) => [p.vehicle, p.lat, p.lng]))
  return found.flatMap(({ time, ...p }) => {
    const t = parseTime(time, home.get(p.vehicle))
    return t === null ? [] : [{ ...p, t }]
  })
}

export const guessClass = (id: string): VClass => {
  const s = id.toLowerCase()
  if (/pickup|truck|f-?150|silverado|ram 1500/.test(s)) return 'pickup'
  if (/car|sedan|suv|model y|civic|corolla/.test(s)) return 'car'
  return 'van'
}

type GeoItem = Record<string, unknown> & { device?: { id?: string; name?: string } | string }
const deviceName = (o: GeoItem, fallback: string) => (typeof o.device === 'string' ? o.device : o.device?.name ?? o.device?.id) ?? fallback

/**
 * MyGeotab API results saved as JSON: an array, or a JSON-RPC body {"result": [...]}, of LogRecord
 * (dateTime, latitude, longitude, speed in km/h) or Trip (start, stop, distance in km, idlingDuration as a
 * "hh:mm:ss" span, stopPoint {x: lng, y: lat}). Device ids stand in for names unless a name is included.
 * Returns null when the JSON is neither.
 */
export function parseGeotabJson(text: string, fallbackVehicle = 'Vehicle 1'): { points: GpsPoint[] } | { trips: Trip[] } | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (data && !Array.isArray(data) && typeof data === 'object') data = (data as { result?: unknown }).result
  if (!Array.isArray(data)) return null
  // Multicall results are an array of arrays.
  const items = (data.every(Array.isArray) ? data.flat() : data).filter((o): o is GeoItem => !!o && typeof o === 'object')
  if (!items.length) return null
  if ('latitude' in items[0] && 'dateTime' in items[0]) {
    const home = homeLngs(items.map((o) => [deviceName(o, fallbackVehicle), Number(o.latitude), Number(o.longitude)]))
    const points: GpsPoint[] = []
    for (const o of items) {
      const lat = Number(o.latitude)
      const lng = Number(o.longitude)
      const t = parseTime(String(o.dateTime ?? ''), home.get(deviceName(o, fallbackVehicle)))
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || t === null) continue
      const speed = Number(o.speed)
      points.push({ vehicle: deviceName(o, fallbackVehicle), t, lat, lng, speedKph: Number.isFinite(speed) && speed >= 0 ? speed : undefined })
    }
    return { points }
  }
  if ('start' in items[0] && 'stop' in items[0] && 'distance' in items[0]) {
    const stopOf = (o: GeoItem) => o.stopPoint as { x?: number; y?: number } | undefined
    const home = homeLngs(items.map((o) => [deviceName(o, fallbackVehicle), stopOf(o)?.y, stopOf(o)?.x]))
    const trips: Trip[] = []
    for (const o of items) {
      const sp = stopOf(o)
      const to: LatLng | undefined = sp && Number.isFinite(sp.x) && Number.isFinite(sp.y) ? [sp.y!, sp.x!] : undefined
      const lng = home.get(deviceName(o, fallbackVehicle))
      const start = parseTime(String(o.start ?? ''), lng)
      const end = parseTime(String(o.stop ?? ''), lng)
      const km = Number(o.distance)
      if (start === null || end === null || end <= start || !Number.isFinite(km) || km < 0) continue
      const hours = (end - start) / 3600e3
      const idleH = Math.min((parseDurationMin(typeof o.idlingDuration === 'string' ? o.idlingDuration : undefined) ?? 0) / 60, hours * 0.95)
      trips.push({ vehicle: deviceName(o, fallbackVehicle), start, end, km, idleH, speedKm: bandKm(km, km / Math.max(hours - idleH, 0.01)), to })
    }
    // A Geotab trip only carries where it stopped; it started where the previous one stopped.
    trips.sort((a, b) => a.start - b.start)
    const last = new Map<string, LatLng | undefined>()
    for (const t of trips) {
      t.from = last.get(t.vehicle)
      last.set(t.vehicle, t.to)
    }
    return { trips }
  }
  return null
}
