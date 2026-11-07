import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CATALOGUE, CATALOGUE_AS_OF } from './catalogue.ts'
import { chargeEff, curveAt, plugKw, tripKwh } from './energy.ts'
import { csvCell, resultsCsv } from './export.ts'
import { bandKm, guessMapping, parseCsv, parseGpx, parseTime, rowsToPoints, rowsToTrips } from './parse.ts'
import { buildSample, samplePointsCsv, type RouteFile } from './samples.ts'
import { scheduleNight, type ChargeRequest } from './schedule.ts'
import { assembleFleet, DAY_MS, DEFAULT_SEGMENT, filterPoints, fleetFromPoints, haversineKm, inferDepots, segmentTrips } from './segment.ts'
import { allModels, defaultCurve, defaultSettings, fittedRange, nearestClimate, PUBLISHED_ANCHORS } from './settings.ts'
import { decodeSettings, encodeSettings, mergeSettings, shareable } from './share.ts'
import { analyzeFleet, pickBest, planRollout } from './sim.ts'
import { computeTco, dutyProfile } from './tco.ts'
import type { EvModel, Fleet, GpsPoint, Settings, Trip } from './types.ts'
import { climateStressWeek, coldestWeek, coarse } from './weather.ts'

const T0 = Date.UTC(2026, 0, 5)
const H = 3600e3
const DEPOT: [number, number] = [43.68, -79.56]

const VAN: EvModel = CATALOGUE.find((m) => m.id === 'e-transit')!

function trip(p: Partial<Trip> & { day?: number; startH?: number; hours?: number; km?: number } = {}): Trip {
  const { day = 0, startH = 8, hours = 4, km = 100, ...rest } = p
  const start = T0 + day * DAY_MS + startH * H
  return { vehicle: 'A', start, end: start + hours * H, km, idleH: 0, speedKm: [0, km, 0, 0], from: DEPOT, to: DEPOT, ...rest }
}

function fleet(trips: Trip[], extra: Partial<Fleet['vehicles'][number]> = {}): Fleet {
  const f = assembleFleet(trips, { name: 'test', defaultCls: 'van', defaultLoadKg: 200 })
  f.vehicles = f.vehicles.map((v) => ({ ...v, ...extra }))
  return f
}

const onlyVan = (s: Settings): Settings => ({ ...s, modelEdits: {}, customModels: [], fit: { ...s.fit, includeEnded: false } })
const routesOf = (id: string) => JSON.parse(readFileSync(new URL(`../samples/routes-${id}.json`, import.meta.url), 'utf8')) as RouteFile

test('CSV parser handles quotes, CRLF, BOM and semicolons', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n'), [['a', 'b'], ['x, y', 'he said "hi"']])
  assert.deepEqual(parseCsv('a;b\n1;2'), [['a', 'b'], ['1', '2']])
})

test('column mapping recognises telematics headers and picks the file kind', () => {
  const pts = guessMapping(['Device', 'DateTime', 'Latitude', 'Longitude', 'Speed', 'Odometer'])
  assert.equal(pts.kind, 'points')
  assert.deepEqual([pts.map.vehicle, pts.map.timestamp, pts.map.lat, pts.map.lng, pts.map.speed, pts.map.odometer], [0, 1, 2, 3, 4, 5])
  const trips = guessMapping(['unit', 'start_time', 'end_time', 'distance_km', 'start_lat', 'start_lon', 'end_lat', 'end_lon', 'idle_minutes'])
  assert.equal(trips.kind, 'trips')
  assert.equal(trips.map.startLat, 4)
  assert.equal(trips.map.start, 1)
  assert.equal(trips.map.idle, 8)
})

test('timestamps: ISO wall clock stays put, offsets shift to the longitude zone, US format and epoch parse', () => {
  assert.equal(parseTime('2026-01-05 08:00:00'), Date.UTC(2026, 0, 5, 8))
  // 13:00Z in Toronto (about UTC-5) reads as 08:00 fleet-local.
  assert.equal(parseTime('2026-01-05T13:00:00Z', -79.4), Date.UTC(2026, 0, 5, 8))
  assert.equal(parseTime('01/05/2026 2:30 PM'), Date.UTC(2026, 0, 5, 14, 30))
  assert.equal(parseTime('31/01/2026 08:00'), Date.UTC(2026, 0, 31, 8))
  assert.equal(parseTime('1767600000', 0), 1767600000000)
  assert.equal(parseTime('nope'), null)
})

test('GPX tracks parse into points with track name as vehicle and speed in km/h', () => {
  const pts = parseGpx(`<gpx><trk><name>Van 7</name><trkseg>
    <trkpt lat="43.7" lon="-79.4"><time>2026-01-05T13:00:00Z</time><speed>10</speed></trkpt>
    <trkpt lon="-79.41" lat="43.71"><time>2026-01-05T13:01:00Z</time></trkpt>
    <trkpt lat="43.8" lon="-79.5"></trkpt></trkseg></trk></gpx>`)
  assert.equal(pts.length, 2)
  assert.equal(pts[0].vehicle, 'Van 7')
  assert.equal(pts[0].speedKph, 36)
  assert.equal(pts[1].lat, 43.71)
})

test('row conversion applies units and counts bad rows', () => {
  const { map } = guessMapping(['vehicle', 'timestamp', 'lat', 'lng', 'speed'])
  const { points, bad } = rowsToPoints([['A', '2026-01-05 08:00', '43.7', '-79.4', '10'], ['A', 'garbage', '43.7', '-79.4', '10']], map, { distance: 'mi', speed: 'mph', load: 'kg' })
  assert.equal(bad, 1)
  assert.ok(Math.abs(points[0].speedKph! - 16.0934) < 1e-6)
  const t = guessMapping(['vehicle', 'start', 'end', 'distance', 'idle minutes'])
  const out = rowsToTrips([['A', '2026-01-05 08:00', '2026-01-05 10:00', '50', '30'], ['A', '2026-01-05 12:00', '2026-01-05 11:00', '50', '0']], t.map, { distance: 'mi', speed: 'kph', load: 'kg' })
  assert.equal(out.bad, 1)
  assert.ok(Math.abs(out.trips[0].km - 80.467) < 0.01)
  assert.equal(out.trips[0].idleH, 0.5)
})

function line(vehicle: string, start: number, n: number, stepS: number, stepDeg: number, lat = 43.7, lng = -79.4): GpsPoint[] {
  return Array.from({ length: n }, (_, i) => ({ vehicle, t: start + i * stepS * 1000, lat: lat + i * stepDeg, lng }))
}

test('jump filter removes a teleport but keeps a persistent relocation', () => {
  const clean = line('A', T0, 5, 60, 0.005)
  const spike: GpsPoint = { vehicle: 'A', t: clean[2].t + 5000, lat: 50, lng: -100 }
  const withSpike = [...clean.slice(0, 3), spike, ...clean.slice(3)]
  const filtered = filterPoints(withSpike, 180)
  assert.equal(filtered.jumps, 1)
  assert.equal(filtered.kept.length, 5)
  const towed = [...clean, ...line('A', clean[4].t + 60000, 4, 60, 0.002, 45.5, -73.5)]
  assert.equal(filterPoints(towed, 180).kept.length, 9)
  assert.equal(filterPoints([{ vehicle: 'A', t: T0, lat: 0, lng: 0 }, { vehicle: 'A', t: T0 + 1, lat: 99, lng: 0 }], 180).invalid, 2)
})

test('segmentation ignores parked jitter, splits on long stops, and measures idling', () => {
  const a = line('A', T0, 11, 60, 0.005) // about 5.5 km in 10 min
  const lastA = a[a.length - 1]
  // 20 minutes parked with jitter under the noise threshold.
  const parked: GpsPoint[] = Array.from({ length: 20 }, (_, i) => ({ vehicle: 'A', t: lastA.t + (i + 1) * 60e3, lat: lastA.lat + (i % 2 ? 0.0001 : -0.0001), lng: lastA.lng }))
  const b = line('A', parked[parked.length - 1].t + 60e3, 11, 60, 0.005, lastA.lat + 0.005)
  const trips = segmentTrips([...a, ...parked, ...b])
  assert.equal(trips.length, 2)
  assert.ok(Math.abs(trips[0].km - 5.56) < 0.2, `km ${trips[0].km}`)
  // A 3 minute wait inside a trip is idling, not a stop.
  const c = line('A', T0, 6, 60, 0.005)
  const wait: GpsPoint[] = [1, 2, 3].map((i) => ({ vehicle: 'A', t: c[5].t + i * 60e3, lat: c[5].lat, lng: c[5].lng }))
  const d = line('A', wait[2].t + 60e3, 6, 60, 0.005, c[5].lat + 0.005)
  const one = segmentTrips([...c, ...wait, ...d])
  assert.equal(one.length, 1)
  assert.ok(Math.abs(one[0].idleH - 3 / 60) < 1e-9)
})

test('segmentation treats a telemetry dropout at speed as the same trip, and prefers a sane odometer', () => {
  const a = line('A', T0, 4, 60, 0.01)
  const after = line('A', a[3].t + 15 * 60e3, 4, 60, 0.01, a[3].lat + 0.3)
  assert.equal(segmentTrips([...a, ...after]).length, 1)
  const withOdo = line('A', T0, 6, 60, 0.01).map((p, i) => ({ ...p, odoKm: 1000 + i * 1.3 }))
  assert.ok(Math.abs(segmentTrips(withOdo)[0].km - 6.5) < 0.01)
})

test('depot inference picks the most common overnight location and scores return to base', () => {
  const home: [number, number] = [43.7, -79.5]
  const away: [number, number] = [44.5, -78.5]
  const trips: Trip[] = []
  for (let d = 0; d < 10; d++) trips.push(trip({ day: d, startH: 8, hours: 9, from: home, to: d === 3 ? away : home }))
  const { depots, home: homes, rtb } = inferDepots(['A'], trips)
  assert.equal(depots.length, 1)
  assert.ok(haversineKm(depots[0].lat, depots[0].lng, home[0], home[1]) < 0.5)
  assert.equal(homes.get('A'), depots[0].id)
  assert.equal(rtb.get('A'), 90)
  assert.equal(trips[3].endsAtDepot, false)
  assert.equal(trips[4].endsAtDepot, true)
})

test('curve passes through both published points and stays editable', () => {
  for (const a of PUBLISHED_ANCHORS) assert.ok(Math.abs(fittedRange(a.t) - a.r) < 1e-9)
  const c = defaultCurve()
  assert.ok(Math.abs(curveAt(c, 21) - 1.15) < 0.002)
  assert.ok(Math.abs(curveAt(c, -15) - 0.54) < 0.002)
  // Peak at 21, loss on each side.
  assert.ok(curveAt(c, 30) < curveAt(c, 21) && curveAt(c, 0) < curveAt(c, 21))
  assert.equal(curveAt(c, -60), curveAt(c, -30))
  assert.equal(curveAt([{ t: 0, r: 0.5 }, { t: 10, r: 1 }], 5), 0.75)
})

test('energy: cold, payload and slow-crawl HVAC each add consumption, and rated efficiency anchors it', () => {
  const s = defaultSettings()
  const t = trip({ km: 100, hours: 2 })
  const warm = tripKwh(t, VAN, 21, 0, s)
  const cold = tripKwh(t, VAN, -15, 0, s)
  // At 50 km/h there are no extra HVAC hours, so only the curve applies.
  assert.ok(Math.abs(cold / warm - 1.15 / 0.54) < 0.01)
  assert.ok(tripKwh(t, VAN, 21, 1000, s) > warm * 1.11)
  const crawl = trip({ km: 100, hours: 6 })
  assert.ok(tripKwh(crawl, VAN, -15, 0, s) > cold + 4 * 3.5)
  assert.equal(tripKwh(crawl, VAN, 21, 0, s), warm)
  assert.ok(chargeEff(-25, s.charging) < chargeEff(21, s.charging))
  assert.equal(plugKw(50, VAN), 50)
  assert.equal(plugKw(11.5, VAN), VAN.acKw)
})

const req = (vehicle: string, needKwh: number, arrive = 0, depart = 96): ChargeRequest => ({ vehicle, arrive, depart, needKwh, kw: 10, eff: 1 })

test('scheduler respects charger count, power and the site cap', () => {
  const { plan, delivered } = scheduleNight([req('A', 20), req('B', 20), req('C', 20)], { chargers: 1, capKw: 0, startSlot: 0 })
  assert.equal(Math.max(...plan.load), 10)
  assert.equal(plan.swaps, 2)
  assert.equal(plan.unmetKwh, 0)
  assert.equal(delivered.get('C'), 20)
  const two = scheduleNight([req('A', 20), req('B', 20), req('C', 20)], { chargers: 3, capKw: 20, startSlot: 0 })
  assert.equal(Math.max(...two.plan.load), 20)
  const sharedSpots = new Set(plan.sessions.map((x) => x.charger))
  assert.equal(sharedSpots.size, 1)
})

test('scheduler gives the free charger to the vehicle with least slack, and honours arrival and departure', () => {
  // B must leave by slot 12, so it goes first even though A is listed first.
  const { plan } = scheduleNight([req('A', 20, 0, 96), req('B', 20, 0, 12)], { chargers: 1, capKw: 0, startSlot: 0 })
  assert.equal(plan.sessions[0].vehicle, 'B')
  assert.equal(plan.unmetKwh, 0)
  // Off-peak start delays charging, and a vehicle gone before then gets nothing.
  const late = scheduleNight([req('A', 10, 0, 96), req('B', 10, 0, 4)], { chargers: 2, capKw: 0, startSlot: 28 })
  assert.equal(late.plan.sessions[0].startSlot, 28)
  assert.equal(late.delivered.get('B'), undefined)
  assert.equal(late.plan.unmetKwh, 10)
})

test('simulation: an easy route completes in the cold, a long one fails with the right reason', () => {
  const s = onlyVan(defaultSettings())
  const days = (km: number) => Array.from({ length: 10 }, (_, d) => trip({ day: d, km, hours: km / 45, startH: 8 }))
  const easy = analyzeFleet(fleet(days(60)), s, { mode: 'fixed', c: -15 })
  assert.equal(easy.vehicles[0].failDays, 0)
  assert.equal(easy.vehicles[0].pct, 100)
  const cold = analyzeFleet(fleet(days(175)), s, { mode: 'fixed', c: -25 }, { A: 'e-transit' })
  assert.equal(cold.vehicles[0].failDays, 10)
  assert.equal(cold.vehicles[0].reasons.cold, 10)
  const warm = analyzeFleet(fleet(days(175)), s, { mode: 'fixed', c: 21 }, { A: 'e-transit' })
  assert.equal(warm.vehicles[0].failDays, 0)
  const far = analyzeFleet(fleet(days(500)), s, { mode: 'fixed', c: 21 }, { A: 'e-transit' })
  assert.equal(far.vehicles[0].reasons.range, 10)
})

test('simulation: colder is never better, and a heavy load fails on payload', () => {
  const s = onlyVan(defaultSettings())
  const f = fleet(Array.from({ length: 14 }, (_, d) => trip({ day: d, km: 110, hours: 3 })))
  let prev = 101
  for (const c of [21, 5, -5, -15, -25]) {
    const pct = analyzeFleet(f, s, { mode: 'fixed', c }, { A: 'e-transit' }).pct
    assert.ok(pct <= prev)
    prev = pct
  }
  const heavy = analyzeFleet(fleet([trip({ day: 0, km: 20, hours: 1, loadKg: 1800 }), trip({ day: 1, km: 20, hours: 1, loadKg: 300 })]), s, { mode: 'fixed', c: 21 }, { A: 'e-transit' })
  assert.equal(heavy.vehicles[0].reasons.payload, 1)
  assert.equal(heavy.vehicles[0].failDays, 1)
})

test('simulation: one shared charger creates charging failures that more chargers fix, and auto-sizing finds it', () => {
  const trips: Trip[] = []
  for (const v of ['A', 'B', 'C', 'D']) {
    for (let d = 0; d < 7; d++) trips.push(trip({ vehicle: v, day: d, km: 100, hours: 3, startH: 9 }))
  }
  const base = onlyVan(defaultSettings())
  const tight: Settings = { ...base, charging: { ...base.charging, chargers: 1, startHour: 22 } }
  const r1 = analyzeFleet(fleet(trips), tight, { mode: 'fixed', c: 0 }, { A: 'e-transit', B: 'e-transit', C: 'e-transit', D: 'e-transit' })
  assert.ok((r1.vehicles.reduce((n, v) => n + (v.reasons.charging ?? 0), 0)) > 0)
  const auto: Settings = { ...tight, charging: { ...tight.charging, chargers: 0 } }
  const r2 = analyzeFleet(fleet(trips), auto, { mode: 'fixed', c: 0 }, { A: 'e-transit', B: 'e-transit', C: 'e-transit', D: 'e-transit' })
  assert.equal(r2.vehicles.reduce((n, v) => n + (v.reasons.charging ?? 0), 0), 0)
  assert.ok(r2.depots[0].chargers > 1 && r2.depots[0].chargers <= 4)
  assert.ok(r2.depots[0].peakKw <= r2.depots[0].unmanagedPeakKw + 1e-6)
  assert.ok(r2.depots[0].peakKw <= r2.depots[0].chargers * VAN.acKw + 1e-6)
})

test('simulation: a vehicle stranded away from the depot fails the next long day for that reason', () => {
  const s = onlyVan(defaultSettings())
  const away: [number, number] = [44.9, -78.1]
  const trips = [
    trip({ day: 0, km: 110, hours: 3, to: DEPOT }),
    trip({ day: 1, km: 110, hours: 3, to: DEPOT }),
    trip({ day: 2, km: 110, hours: 3, to: DEPOT }),
    trip({ day: 3, km: 150, hours: 3, to: away }),
    trip({ day: 4, km: 150, hours: 3, from: away, to: DEPOT }),
    trip({ day: 5, km: 110, hours: 3, to: DEPOT }),
  ]
  const r = analyzeFleet(fleet(trips), s, { mode: 'fixed', c: 21 }, { A: 'e-transit' })
  assert.equal(r.vehicles[0].reasons['no-depot'], 1)
})

test('mid-day top-up rescues a day that otherwise fails on range', () => {
  const s = onlyVan(defaultSettings())
  const day = (d: number) => [trip({ day: d, km: 120, hours: 2.4, startH: 7 }), trip({ day: d, km: 120, hours: 2.4, startH: 11 })]
  const f = fleet([...day(0), ...day(1)])
  const off = analyzeFleet(f, s, { mode: 'fixed', c: -5 }, { A: 'e-transit' })
  assert.equal(off.vehicles[0].failDays, 2)
  const on = analyzeFleet(f, { ...s, charging: { ...s.charging, middayOn: true } }, { mode: 'fixed', c: -5 }, { A: 'e-transit' })
  assert.equal(on.vehicles[0].failDays, 0)
})

test('best fit picks the cheapest passing model, or the most capable when none pass', () => {
  const a = { modelId: 'a', model: VAN, pct: 99, savings: 100 }
  const b = { modelId: 'b', model: VAN, pct: 97, savings: 900 }
  const c = { modelId: 'c', model: VAN, pct: 50, savings: 5000 }
  assert.equal(pickBest([a, b, c], 95).modelId, 'b')
  assert.equal(pickBest([{ ...a, pct: 60 }, c], 95).modelId, 'a')
})

test('TCO: series starts net of resale, crossover is found, and the numbers track inputs', () => {
  const s = defaultSettings()
  const v = { id: 'A', cls: 'van' as const, loadKg: 200, depot: 'd', rtbPct: 100 }
  const trips = Array.from({ length: 365 }, (_, d) => trip({ day: d, km: 120, hours: 3 }))
  const d = dutyProfile(trips, v)
  assert.ok(Math.abs(d.annualKm - 365 * 120) < 500)
  const tco = computeTco(d, VAN, 'van', s, { chargerCapex: 5000, demandCostYear: 300 })
  assert.equal(tco.evSeries[0], 5000)
  assert.equal(tco.iceSeries[0], 0)
  assert.ok(tco.annualFuelCost > tco.annualEnergyCost)
  assert.ok(tco.annualCo2Tonnes > 5)
  const dear = computeTco(d, VAN, 'van', { ...s, tco: { ...s.tco, fuelPrice: 0.2 } }, { chargerCapex: 5000, demandCostYear: 300 })
  assert.ok(dear.savings < tco.savings)
  const cheap = computeTco(d, VAN, 'van', { ...s, tco: { ...s.tco, fuelPrice: 3 } }, { chargerCapex: 0, demandCostYear: 0 })
  assert.ok(cheap.crossoverYear !== null && cheap.crossoverYear <= s.tco.years)
  const incentive = computeTco(d, VAN, 'van', { ...s, tco: { ...s.tco, incentive: { ...s.tco.incentive, van: 5000 } } }, { chargerCapex: 5000, demandCostYear: 300 })
  assert.ok(Math.abs(incentive.savings - tco.savings - 5000) < 1)
})

test('coldest week finds the lowest seven-day mean and skips gaps', () => {
  const dates = Array.from({ length: 12 }, (_, i) => `d${i}`)
  const temps: (number | null)[] = [5, 4, null, -30, -30, -30, 0, -20, -20, -20, -20, -20]
  const w = coldestWeek(dates, temps)!
  assert.equal(w.start, 'd3')
  assert.equal(w.temps.length, 7)
  assert.equal(coldestWeek(['a'], [1]), null)
  assert.ok(climateStressWeek(defaultSettings()).mean < -10)
  assert.equal(coarse(43.6789), 43.7)
  assert.equal(nearestClimate(52, -113.8).name, 'Red Deer')
})

test('share links round-trip settings and cannot carry GPS data', async () => {
  const s = defaultSettings()
  s.tco.fuelPrice = 1.77
  s.curve[3] = { t: -15, r: 0.6 }
  const hash = await encodeSettings(s)
  const back = await decodeSettings(hash)
  assert.equal(back?.tco.fuelPrice, 1.77)
  assert.equal(back?.curve[3].r, 0.6)
  const dirty = { ...s, trips: [{ lat: 43.7, lng: -79.4 }], depots: [{ lat: 43.7 }], secret: 'x' } as unknown as Settings
  const json = JSON.stringify(shareable(dirty))
  assert.ok(!json.includes('trips') && !json.includes('depots') && !json.includes('secret'))
  assert.equal(await decodeSettings('not-valid!!'), null)
  assert.equal(mergeSettings({ curve: [{ t: 0, r: -1 }, { t: 1, r: 1 }] }).curve.length, defaultCurve().length)
})

test('CSV export neutralises spreadsheet formulas and quotes properly', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`)
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell(-5), '-5')
  assert.equal(csvCell(null), '')
})

test('catalogue is dated, sourced and flags ended production honestly', () => {
  assert.match(CATALOGUE_AS_OF, /^\d{4}-\d{2}-\d{2}$/)
  for (const m of CATALOGUE) {
    assert.ok(m.sources.length > 0, m.id)
    assert.ok(m.usableKwh > 0 && m.ratedKm > 0 && m.payloadKg > 0 && m.priceAmount > 0, m.id)
  }
  assert.equal(CATALOGUE.find((m) => m.id === 'brightdrop-400')?.status, 'ended')
  assert.equal(CATALOGUE.find((m) => m.id === 'f150-lightning')?.status, 'ended')
  const s = defaultSettings()
  assert.deepEqual(s.tco.incentive, { van: 0, pickup: 0, car: 0 })
  const edited = { ...s, modelEdits: { 'e-transit': { usableKwh: 200 } } }
  assert.equal(allModels(edited).find((m) => m.id === 'e-transit')?.usableKwh, 200)
})

test('samples are synthetic, deterministic, and a cold sweep turns the Toronto fleet from green to red', () => {
  const routes = routesOf('toronto')
  const f = buildSample('toronto', routes)
  assert.equal(f.synthetic, true)
  assert.equal(f.vehicles.length, 12)
  assert.equal(f.depots.length, 1)
  assert.equal(buildSample('toronto', routes).trips[100].km, f.trips[100].km)
  const s = defaultSettings()
  const warm = analyzeFleet(f, s, { mode: 'fixed', c: 21 })
  const frozen = analyzeFleet(f, s, { mode: 'fixed', c: -25 })
  assert.ok(warm.pct > 85, `warm ${warm.pct}`)
  assert.ok(frozen.pct < warm.pct - 20, `frozen ${frozen.pct}`)
  assert.ok(warm.ms < 400, `slow: ${warm.ms}`)
})

test('the mixed sample shows the heavy payload problem, and rollout puts those vehicles on hold', () => {
  const f = buildSample('mixed', routesOf('mixed'))
  const s = defaultSettings()
  const r = analyzeFleet(f, s, { mode: 'fixed', c: 10 })
  const heavy = r.vehicles.filter((v) => v.id.includes('heavy'))
  assert.equal(heavy.length, 4)
  assert.ok(heavy.some((v) => (v.reasons.payload ?? 0) > 0))
  const phases = planRollout(f, s, { mode: 'fixed', c: 10 }, r)
  assert.equal(phases.length, 4)
  assert.equal(phases.reduce((n, p) => n + p.vehicles.length, 0), r.vehicles.length)
  assert.ok(phases[3].vehicles.some((v) => v.id.includes('heavy')))
  const first = phases[0].vehicles
  for (let i = 1; i < first.length; i++) assert.ok(first[i - 1].tco!.savings >= first[i].tco!.savings)
  assert.match(resultsCsv(f, r, s).split('\n')[1], /yes$/)
})

test('rural sample infers two depots and sees return-to-base misses', () => {
  const f = buildSample('rural', routesOf('rural'))
  assert.equal(f.depots.length, 2)
  assert.ok(f.vehicles.some((v) => v.rtbPct !== null && v.rtbPct < 95))
})

test('end to end: sample exported as GPS CSV imports back through parsing and segmentation', () => {
  const src = buildSample('toronto', routesOf('toronto'))
  const rows = parseCsv(samplePointsCsv(src, 7))
  const { kind, map } = guessMapping(rows[0])
  assert.equal(kind, 'points')
  const { points, bad } = rowsToPoints(rows.slice(1), map)
  assert.equal(bad, 0)
  const f = fleetFromPoints(points, { name: 'reimport', defaultCls: 'van' }, DEFAULT_SEGMENT)
  assert.equal(f.vehicles.length, 12)
  assert.equal(f.depots.length, 1)
  assert.ok(haversineKm(f.depots[0].lat, f.depots[0].lng, src.depots[0].lat, src.depots[0].lng) < 1)
  const r = analyzeFleet(f, defaultSettings(), { mode: 'fixed', c: 10 })
  assert.equal(r.vehicles.length, 12)
  assert.ok(r.opDays > 40)
  assert.ok(bandKm(10, 95)[3] === 10)
})
