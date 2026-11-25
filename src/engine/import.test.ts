import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CATALOGUE } from './catalogue.ts'
import { tripKwh } from './energy.ts'
import { gpxCutOff, guessHeaderless, guessMapping, isDayFirst, parseCsv, parseDurationMin, parseGeotabJson, parseGpx, parseTime, readCsv, rowsToPoints, rowsToTrips } from './parse.ts'
import { nearestFuelCity, parseBoc, parseStatcan } from './prices.ts'
import { assembleFleet, fleetFromPoints } from './segment.ts'
import { defaultSettings } from './settings.ts'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

test('real Garmin eTrex GPX: date-named track falls back to the file name and yields one short car trip', () => {
  const pts = parseGpx(fx('etrex-car.gpx'), 'Van 3')
  assert.equal(pts.length, 104)
  assert.ok(pts.every((p) => p.vehicle === 'Van 3'))
  const fleet = fleetFromPoints(pts, { name: 'etrex', defaultCls: 'car', defaultLoadKg: 0 })
  assert.equal(fleet.trips.length, 1)
  assert.ok(fleet.trips[0].km > 2.4 && fleet.trips[0].km < 2.8, String(fleet.trips[0].km))
})

test('GPX track names: a real name is kept, a segment point name is not mistaken for it', () => {
  const gpx = '<gpx><trk><name>Truck 12</name><trkseg><trkpt lat="43.7" lon="-79.4"><time>2026-01-05T13:00:00Z</time><name>stop</name></trkpt></trkseg></trk>' +
    '<trk><trkseg><trkpt lat="43.7" lon="-79.4"><name>pt 1</name><time>2026-01-05T13:00:00Z</time></trkpt></trkseg></trk></gpx>'
  assert.deepEqual(parseGpx(gpx, 'file').map((p) => p.vehicle), ['Truck 12', 'file'])
})

test('GPSLogger CSV with semicolons and decimal commas reads coordinates and m/s speed', () => {
  const rows = parseCsv(fx('gpslogger-eu.csv'))
  const { kind, map, units } = guessMapping(rows[0])
  assert.equal(kind, 'points')
  assert.equal(rows[0][map.lng!], 'lon')
  const { points, bad } = rowsToPoints(rows.slice(1), map, { ...units, speed: 'mps' }, 'Phone')
  assert.equal(bad, 0)
  near(points[0].lat, 43.6581)
  near(points[0].lng, -79.405)
  near(points[0].speedKph!, 37.8)
  assert.equal(points[0].vehicle, 'Phone')
})

test('header units are detected: mph, m/s, miles, lb, ticks and seconds', () => {
  assert.deepEqual(guessMapping(['vehicle', 'timestamp', 'lat', 'lng', 'Speed (mph)', 'Load lb']).units, { distance: 'km', speed: 'mph', load: 'lb', idle: 'min' })
  assert.equal(guessMapping(['time', 'lat', 'lon', 'speed m/s']).units.speed, 'mps')
  assert.equal(guessMapping(['vehicle', 'start', 'end', 'Distance (mi)', 'idle seconds']).units.distance, 'mi')
  assert.equal(guessMapping(['vehicle', 'start', 'end', 'distance', 'idle seconds']).units.idle, 's')
})

test('MyGeotab API Adapter LogRecords2 CSV uses DeviceId as the vehicle, not the row id', () => {
  const rows = parseCsv(fx('adapter-logrecords2.csv'))
  const { kind, map } = guessMapping(rows[0])
  assert.equal(kind, 'points')
  assert.equal(rows[0][map.vehicle!], 'DeviceId')
  const { points } = rowsToPoints(rows.slice(1), map)
  assert.deepEqual([...new Set(points.map((p) => p.vehicle))], ['27', '31'])
})

test('MyGeotab API Adapter Trips2 CSV: ticks for idling and StopPoint X/Y as the end coordinate', () => {
  const rows = parseCsv(fx('adapter-trips2.csv'))
  const { kind, map, units } = guessMapping(rows[0])
  assert.equal(kind, 'trips')
  assert.equal(units.idle, 'ticks')
  const { trips } = rowsToTrips(rows.slice(1), map, units)
  assert.equal(trips[0].vehicle, '27')
  near(trips[0].km, 18.4)
  near(trips[0].idleH, 192 / 3600)
  assert.deepEqual(trips[0].to, [43.6561, -79.4102])
})

test('headerless T-Drive layout: longitude is the coordinate outside 90 degrees', () => {
  const rows = parseCsv(fx('tdrive-headerless.csv'))
  const map = guessHeaderless(rows[0])!
  assert.deepEqual(map, { timestamp: 1, lng: 2, lat: 3, vehicle: 0 })
  assert.equal(guessHeaderless(['vehicle', 'timestamp', 'lat', 'lng']), null)
  const { points } = rowsToPoints(rows, map)
  near(points[0].lat, 39.92123)
  assert.equal(points[0].vehicle, '1')
})

test('durations: hh:mm:ss spans, day spans, .NET ticks, seconds and minutes', () => {
  near(parseDurationMin('00:03:12')!, 3.2)
  near(parseDurationMin('00:29:21.0040000')!, 29 + 21.004 / 60)
  near(parseDurationMin('1.02:00:00')!, 26 * 60)
  near(parseDurationMin('1920000000', 'ticks')!, 3.2)
  near(parseDurationMin('90', 's')!, 1.5)
  assert.equal(parseDurationMin('12'), 12)
  assert.equal(parseDurationMin(''), undefined)
})

test('number cells: decimal comma, European thousands and a quoted thousands comma', () => {
  const t = guessMapping(['vehicle', 'start', 'end', 'distance'])
  const km = (d: string) => rowsToTrips([['A', '2026-01-05 08:00', '2026-01-05 10:00', d]], t.map).trips[0].km
  near(km('12,5'), 12.5)
  near(km('1.234,5'), 1234.5)
  near(km('1,234'), 1234)
  near(km('48.25'), 48.25)
})

test('MyGeotab Trip JSON-RPC result: km, idling span capped at trip length, start chained from previous stop', () => {
  const geo = parseGeotabJson(fx('geotab-trips.json'))
  assert.ok(geo && 'trips' in geo)
  const [a, b, c] = geo.trips
  assert.equal(a.vehicle, 'b2A')
  near(a.km, 18.4)
  near(a.idleH, 3.2 / 60)
  assert.equal(a.from, undefined)
  assert.deepEqual(b.from, a.to)
  // A one-day idling span on a 45-minute trip is clamped.
  assert.ok(c.idleH < 0.75)
  // Longitude -79.4 rounds to UTC-5: 12:02 Z is 07:02 local.
  assert.equal(new Date(a.start).getUTCHours(), 7)
  const fleet = assembleFleet(geo.trips, { name: 'geotab' })
  assert.deepEqual(fleet.vehicles.map((v) => v.id), ['b2A', 'b2B'])
  // Multicall shape (array of arrays) and non-Geotab JSON.
  assert.ok(parseGeotabJson(JSON.stringify([[JSON.parse(fx('geotab-trips.json')).result[0]]])))
  assert.equal(parseGeotabJson('{"foo": 1}'), null)
  assert.equal(parseGeotabJson('not json'), null)
})

test('MyGeotab LogRecord JSON segments into one trip after a 30-minute stop', () => {
  const geo = parseGeotabJson(fx('geotab-logrecords.json'))
  assert.ok(geo && 'points' in geo)
  assert.equal(geo.points.length, 8)
  const fleet = fleetFromPoints(geo.points, { name: 'lr', defaultCls: 'van', defaultLoadKg: 300 })
  assert.equal(fleet.trips.length, 1)
  assert.ok(fleet.trips[0].km > 2.5 && fleet.trips[0].km < 3.5)
})

test('official price feeds: Bank of Canada and StatCan response shapes, nearest city', () => {
  assert.deepEqual(parseBoc({ observations: [{ d: '2026-11-13', FXUSDCAD: { v: '1.4257' } }] }), { rate: 1.4257, date: '2026-11-13' })
  assert.equal(parseBoc({ observations: [] }), null)
  // Shape captured from getDataFromCubePidCoordAndLatestNPeriods on 2026-11-15; trailing null months are skipped.
  const wds = { status: 'SUCCESS', object: { vectorDataPoint: [{ refPer: '2026-08-01', value: 170.3 }, { refPer: '2026-09-01', value: 183.7 }, { refPer: '2026-10-01', value: null }] } }
  assert.deepEqual(parseStatcan(wds), { perL: 1.837, month: '2026-09' })
  assert.equal(parseStatcan({ status: 'FAILED', object: {} }), null)
  assert.equal(nearestFuelCity(51.0, -114.1)?.name, 'Calgary')
  assert.equal(nearestFuelCity(41.88, -87.63), null)
})

test('trip energy by hand: 50 km at 50 km/h, 21 C, no load equals usable/rated x 47.5 / 1.15', () => {
  const s = defaultSettings()
  const m = CATALOGUE[0]
  const trip = { start: 0, end: 3600e3, km: 50, idleH: 0, speedKm: [0, 50, 0, 0] as [number, number, number, number] }
  near(tripKwh(trip, m, 21, 0, s), ((m.usableKwh / m.ratedKm) * 47.5) / 1.15, 1e-9)
  // 1000 kg adds 12%, and a 30-minute idle at -25 C adds 0.5 h x 5 kW of cabin heat.
  const cold = tripKwh({ ...trip, end: 5400e3, idleH: 0.5 }, m, -25, 1000, s)
  const r = s.curve[1].r
  near(cold, ((m.usableKwh / m.ratedKm) * 47.5 * 1.12) / r + 2.5, 1e-9)
})

test('one clock per vehicle: crossing a 15-degree line keeps length, duration and order in every importer', () => {
  const utc = (i: number) => new Date(Date.UTC(2026, 0, 5, 13, i)).toISOString()
  const fixes = Array.from({ length: 61 }, (_, i) => ({ t: utc(i), lat: 43, lng: +(-81.9 - i * 0.02).toFixed(4) }))
  const csv = ['vehicle,timestamp,lat,lng', ...fixes.map((f) => `A,${f.t},${f.lat},${f.lng}`)].join('\n')
  const rows = parseCsv(csv)
  const gpx = `<gpx><trk><name>A</name><trkseg>${fixes.map((f) => `<trkpt lat="${f.lat}" lon="${f.lng}"><time>${f.t}</time></trkpt>`).join('')}</trkseg></trk></gpx>`
  const json = parseGeotabJson(JSON.stringify(fixes.map((f) => ({ device: { id: 'A' }, dateTime: f.t, latitude: f.lat, longitude: f.lng, speed: 98 }))))
  assert.ok(json && 'points' in json)
  for (const points of [rowsToPoints(rows.slice(1), guessMapping(rows[0]).map).points, parseGpx(gpx), json.points]) {
    const [t, ...rest] = fleetFromPoints(points, { name: 'x' }).trips
    assert.equal(rest.length, 0)
    // 6371 x cos(43) x pi/180 x 1.2 degrees
    near(t.km, 97.587, 0.01)
    assert.equal(t.end - t.start, 3600e3)
  }
})

test('trips: both ends use the vehicle clock, with one, both or no coordinates, and vehicles keep their own zone', () => {
  const read = (text: string) => {
    const rows = parseCsv(text)
    const g = guessMapping(rows[0])
    return rowsToTrips(rows.slice(1), g.map, g.units)
  }
  const cross = read('vehicle,start,end,distance,start lat,start lng,end lat,end lng\nA,2026-01-05T13:00:00Z,2026-01-05T13:40:00Z,60,43,-82,43,-83\nA,2026-01-05T15:00:00Z,2026-01-05T15:40:00Z,60,43,-83,43,-82\nV,2026-01-05T17:00:00Z,2026-01-05T18:00:00Z,20,49.2,-123.1,49.2,-123.1')
  assert.equal(cross.bad, 0)
  assert.deepEqual(cross.trips.map((t) => (t.end - t.start) / 60e3), [40, 40, 60])
  assert.equal(new Date(cross.trips[2].start).getUTCHours(), 9)
  const stopOnly = read('DeviceId,Start,Stop,Distance,StopPointX,StopPointY\n27,2026-01-14T12:02:11Z,2026-01-14T12:31:32Z,18.4,-79.4102,43.6561')
  assert.equal(stopOnly.bad, 0)
  assert.equal(new Date(stopOnly.trips[0].start).getUTCHours(), 7)
  const geo = parseGeotabJson(JSON.stringify([-82.4, -82.6].map((x, i) => ({ device: { id: 'A' }, start: `2026-01-05T1${3 + i}:00:00Z`, stop: `2026-01-05T1${3 + i}:50:00Z`, distance: 30, stopPoint: { x, y: 43 } }))))
  assert.ok(geo && 'trips' in geo)
  assert.equal(geo.trips[1].start - geo.trips[0].start, 3600e3)
  // A bad first fix does not set the zone.
  const rows = parseCsv('vehicle,timestamp,lat,lng\nA,2026-01-05T13:00:00Z,0,0\nA,2026-01-05T13:01:00Z,43,-79\nA,2026-01-05T13:02:00Z,43,-79')
  assert.equal(new Date(rowsToPoints(rows.slice(1), guessMapping(rows[0]).map).points[1].t).getUTCHours(), 8)
})

test('CSV quotes: an inch mark is text, a quote that never closes is reported', () => {
  assert.deepEqual(readCsv('v,d\nVan 24" box,1\n"a ""b"", c", "x y"\n'), { rows: [['v', 'd'], ['Van 24" box', '1'], ['a "b", c', ' x y']], openAt: null })
  assert.equal(readCsv('v,d\nA,1\n"B,2\nC,3').openAt, 3)
  assert.equal(readCsv('"v","d"\n"A","1"').openAt, null)
})

test('GPX: a cut-off file is recognised, its last track is kept, unusable points are counted', () => {
  const pt = '<trkpt lat="43" lon="-79"><time>2026-01-05T13:00:00Z</time></trkpt>'
  const whole = `<gpx><trk><name>A</name>${pt}</trk><trk><name>B</name>${pt}<trkpt lat="43" lon="-79"/><trkpt lat="x" lon="-79"/></trk></gpx>`
  assert.equal(gpxCutOff(whole), false)
  const tally = { total: 0, bad: 0 }
  assert.equal(parseGpx(whole, 'f', tally).length, 2)
  assert.deepEqual(tally, { total: 4, bad: 2 })
  const cut = whole.slice(0, whole.indexOf('<trkpt lat="43" lon="-79"/>'))
  assert.equal(gpxCutOff(cut), true)
  assert.deepEqual(parseGpx(cut).map((p) => p.vehicle), ['A', 'B'])
})

test('MyGeotab JSON: unusable records are counted and a null distance or coordinate is not zero', () => {
  const t = { device: { id: 'A' }, start: '2026-01-05T13:00:00Z', stop: '2026-01-05T14:00:00Z', distance: 30 }
  const trips = parseGeotabJson(JSON.stringify([t, { ...t, distance: null }, { ...t, stop: 'x' }, null]))
  assert.ok(trips && 'trips' in trips)
  assert.deepEqual([trips.trips.length, trips.bad, trips.total], [1, 3, 4])
  const p = { dateTime: '2026-01-05T13:00:00Z', latitude: 43, longitude: -79, speed: null }
  const points = parseGeotabJson(JSON.stringify([p, { ...p, latitude: null }, { ...p, longitude: '' }]))
  assert.ok(points && 'points' in points)
  assert.deepEqual([points.points.length, points.bad, points.points[0].speedKph], [1, 2, undefined])
})

test('day-first or month-first is decided once per file', () => {
  const days = (...stamps: string[]) => {
    const rows = stamps.map((s) => ['A', `${s} 08:00`, `${s} 10:00`, '50'])
    const { trips, bad } = rowsToTrips(rows, { vehicle: 0, start: 1, end: 2, distance: 3 })
    return [...trips.map((t) => new Date(t.start).toISOString().slice(0, 10)), bad]
  }
  assert.deepEqual(days('05/11/2025', '13/11/2025'), ['2025-11-05', '2025-11-13', 0])
  assert.deepEqual(days('05/11/2025', '05/13/2025'), ['2025-05-11', '2025-05-13', 0])
  assert.deepEqual(days('05/11/2025', '06/11/2025'), ['2025-05-11', '2025-06-11', 0])
  // Both orders in one file: the more common one wins, and the rest are unreadable rather than swapped.
  assert.deepEqual(days('05/11/2025', '13/11/2025', '14/11/2025', '11/15/2025'), ['2025-11-05', '2025-11-13', '2025-11-14', 1])
  assert.equal(isDayFirst(['2025-11-13', undefined, '31/31/2025', '']), false)
  assert.equal(rowsToPoints([['13/11/2025 08:00', '43', '-79'], ['05/11/2025 08:00', '43', '-79']], { timestamp: 0, lat: 1, lng: 2 }).points[1].t, Date.UTC(2025, 10, 5, 8))
})

test('dates and times that do not exist are unreadable', () => {
  for (const s of ['2026-02-30 08:00', '2026-13-01', '0000-00-00 00:00:00', '2026-01-05 25:00', '2026-01-05 08:61', '31/31/2026', '02/30/2026', '31-Feb-2026', '0', '1/5/2026 13:00 AM x']) assert.equal(parseTime(s), null, s)
  assert.equal(parseTime('2024-02-29'), Date.UTC(2024, 1, 29))
  assert.equal(parseTime('29 Feb 2024 23:59:59'), Date.UTC(2024, 1, 29, 23, 59, 59))
  assert.equal(parseTime('2025-02-29'), null)
  // ISO 8601 midnight at the end of a day.
  assert.equal(parseTime('2026-01-05T24:00'), Date.UTC(2026, 0, 6))
  assert.equal(parseTime('2026-01-05T24:01'), null)
})

test('number cells: text is not zero, spaces group, and one decimal comma settles the whole file', () => {
  const map = { vehicle: 0, start: 1, end: 2, distance: 3, idle: 4, load: 5 }
  const read = (cells: string[][]) => rowsToTrips(cells.map((c) => ['A', '2026-01-05 00:00', '2026-01-05 23:00', ...c]), map)
  const km = (d: string) => read([[d]]).trips[0]?.km
  for (const d of ['N/A', 'unknown', 'none', 'Infinity', '-', '', '0x10', '5-6', '1.2.3', '10:30', '1e999', '-5']) assert.equal(km(d), undefined, d)
  for (const [d, n] of [['12 km', 12], ["12'345", 12345], ['$5', 5], ['C$ 5.50', 5.5], ['(5)', 5], ['1,234', 1234], ['1,234.5', 1234.5], ['1 234.5', 1234.5], ['1 234,5', 1234.5], ['1 034,5 km', 1034.5], ['1.234,5', 1234.5], ['12,5', 12.5], ['1e2', 100], ['.5', 0.5], ['0', 0], ['+7', 7]] as const) near(km(d), n)
  assert.deepEqual(read([['12,345'], ['7,5']]).trips.map((t) => t.km), [12.345, 7.5])
  assert.deepEqual(read([['12,345'], ['7.5']]).trips.map((t) => t.km), [12345, 7.5])
  assert.deepEqual(read([['12,345'], ['999']]).trips.map((t) => t.km), [12345, 999])
  const odd = read([['10', '-30', '-500']]).trips[0]
  assert.deepEqual([odd.idleH, odd.loadKg], [0, undefined])
})

test('points: unreadable coordinates are rejected, hemispheres, odometer miles and GPSLogger m/s are read', () => {
  const map = { timestamp: 0, lat: 1, lng: 2, odometer: 3, speed: 4 }
  const one = (lat: string, lng: string) => rowsToPoints([['2026-01-05 08:00', lat, lng]], map)
  assert.equal(one('N/A', '-79').bad, 1)
  assert.deepEqual(one('43.6 N', '79.4 W').points.map((p) => [p.lat, p.lng]), [[43.6, -79.4]])
  assert.deepEqual(one('S33.9', 'E151.2').points.map((p) => [p.lat, p.lng]), [[-33.9, 151.2]])
  assert.deepEqual(one('43,653', '-79,405').points.map((p) => [p.lat, p.lng]), [[43.653, -79.405]])
  const head = guessMapping(['vehicle', 'timestamp', 'lat', 'lng', 'Odometer (mi)'])
  assert.equal(head.units.distance, 'mi')
  near(rowsToPoints([['A', '2026-01-05 08:00', '43', '-79', '100']], head.map, head.units).points[0].odoKm!, 160.934)
  assert.equal(guessMapping(['vehicle', 'timestamp', 'lat', 'lng', 'odometer km']).units.distance, 'km')
  assert.equal(guessMapping(parseCsv(fx('gpslogger-eu.csv'))[0]).units.speed, 'mps')
  assert.equal(guessMapping(['time', 'lat', 'lon', 'speed']).units.speed, 'kph')
})
