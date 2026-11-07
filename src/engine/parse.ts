import type { GpsPoint, Trip, VClass } from './types.ts'

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
  vehicle: ['vehicle', 'vehicle id', 'vehicleid', 'device', 'device name', 'devicename', 'asset', 'unit', 'unit id', 'vin', 'truck', 'van', 'name', 'id'],
  timestamp: ['timestamp', 'datetime', 'date time', 'date/time', 'time', 'gps time', 'gpstime', 'recorded at', 'date'],
  lat: ['lat', 'latitude', 'y', 'gps lat'],
  lng: ['lng', 'lon', 'long', 'longitude', 'x', 'gps lon', 'gps lng'],
  speed: ['speed', 'speed kph', 'speed km/h', 'speed (km/h)', 'kph', 'kmh', 'speed mph', 'mph', 'velocity'],
  odometer: ['odometer', 'odo', 'odometer km', 'odometer (km)', 'mileage'],
  load: ['load', 'load kg', 'payload', 'payload kg', 'cargo', 'cargo kg', 'weight'],
  start: ['start', 'start time', 'starttime', 'start date', 'trip start', 'departure', 'start datetime'],
  end: ['end', 'stop', 'end time', 'endtime', 'stop time', 'end date', 'trip end', 'arrival', 'end datetime'],
  distance: ['distance', 'distance km', 'distance (km)', 'km', 'distance mi', 'miles', 'trip distance', 'driving distance'],
  idle: ['idle', 'idle min', 'idle minutes', 'idling', 'idle time', 'idling duration', 'idle duration'],
  startLat: ['start lat', 'start latitude', 'startlat', 'from lat'],
  startLng: ['start lng', 'start lon', 'start longitude', 'startlng', 'startlon', 'from lng', 'from lon'],
  endLat: ['end lat', 'end latitude', 'endlat', 'stop lat', 'stop latitude', 'to lat'],
  endLng: ['end lng', 'end lon', 'end longitude', 'endlng', 'endlon', 'stop lng', 'stop lon', 'stop longitude', 'to lng', 'to lon'],
}

const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()

export type ColumnMap = Partial<Record<Field, number>>

export function guessMapping(header: string[]): { kind: 'points' | 'trips'; map: ColumnMap } {
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
  const kind = map.lat !== undefined && map.lng !== undefined && map.timestamp !== undefined ? 'points' : 'trips'
  return { kind, map }
}

const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ')

/**
 * Parses a timestamp to fleet-local milliseconds. Wall-clock stamps are kept as written. Stamps with an offset
 * or Z are shifted by the longitude-derived zone.
 * longitude approximates the zone and ignores DST. Good enough to find "overnight"; use a tz database if hour-level precision matters.
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
  const n = Number(s.trim().replace(/[^0-9.+-eE]/g, ''))
  return Number.isFinite(n) ? n : undefined
}

export interface Units {
  distance: 'km' | 'mi'
  speed: 'kph' | 'mph'
  load: 'kg' | 'lb'
}
export const DEFAULT_UNITS: Units = { distance: 'km', speed: 'kph', load: 'kg' }

export function rowsToPoints(rows: string[][], map: ColumnMap, units: Units = DEFAULT_UNITS, fallbackVehicle = 'Vehicle 1'): { points: GpsPoint[]; bad: number } {
  const points: GpsPoint[] = []
  let bad = 0
  const dk = units.distance === 'mi' ? 1.60934 : 1
  const sk = units.speed === 'mph' ? 1.60934 : 1
  const lk = units.load === 'lb' ? 0.453592 : 1
  for (const r of rows) {
    const lat = num(r[map.lat ?? -1])
    const lng = num(r[map.lng ?? -1])
    const t = parseTime(r[map.timestamp ?? -1] ?? '', lng)
    if (lat === undefined || lng === undefined || t === null) {
      bad++
      continue
    }
    const speed = num(r[map.speed ?? -1])
    const odo = num(r[map.odometer ?? -1])
    const load = num(r[map.load ?? -1])
    points.push({
      vehicle: r[map.vehicle ?? -1]?.trim() || fallbackVehicle,
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
  for (const r of rows) {
    const startLng = num(r[map.startLng ?? -1])
    const endLng = num(r[map.endLng ?? -1])
    const start = parseTime(r[map.start ?? -1] ?? '', startLng)
    const end = parseTime(r[map.end ?? -1] ?? '', endLng ?? startLng)
    const dist = num(r[map.distance ?? -1])
    if (start === null || end === null || dist === undefined || end <= start || dist < 0) {
      bad++
      continue
    }
    const km = dist * dk
    const idleMin = num(r[map.idle ?? -1]) ?? 0
    const hours = (end - start) / 3600e3
    const idleH = Math.min(idleMin / 60, hours * 0.95)
    const load = num(r[map.load ?? -1])
    const startLat = num(r[map.startLat ?? -1])
    const endLat = num(r[map.endLat ?? -1])
    trips.push({
      vehicle: r[map.vehicle ?? -1]?.trim() || fallbackVehicle,
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

/** Minimal GPX reader for tracks and routes. Each track name becomes a vehicle unless one is provided. */
export function parseGpx(xml: string, fallbackVehicle = 'Vehicle 1'): GpsPoint[] {
  const points: GpsPoint[] = []
  const tracks = xml.match(/<trk[\s>][\s\S]*?<\/trk>/g) ?? [xml]
  for (const trk of tracks) {
    const name = trk.match(/<name>\s*(?:<!\[CDATA\[)?([^<\]]+)/)?.[1]?.trim() ?? fallbackVehicle
    for (const m of trk.matchAll(/<(?:trkpt|rtept|wpt)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:trkpt|rtept|wpt)>)/g)) {
      const lat = Number(m[1].match(/lat=["']([^"']+)/)?.[1])
      const lng = Number(m[1].match(/lon=["']([^"']+)/)?.[1])
      const body = m[2] ?? ''
      const t = parseTime(body.match(/<time>([^<]+)/)?.[1] ?? '', lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || t === null) continue
      const speedMs = Number(body.match(/<(?:\w+:)?speed>([^<]+)/)?.[1])
      points.push({ vehicle: name, t, lat, lng, speedKph: Number.isFinite(speedMs) ? speedMs * 3.6 : undefined })
    }
  }
  return points
}

export const guessClass = (id: string): VClass => {
  const s = id.toLowerCase()
  if (/pickup|truck|f-?150|silverado|ram 1500/.test(s)) return 'pickup'
  if (/car|sedan|suv|model y|civic|corolla/.test(s)) return 'car'
  return 'van'
}
