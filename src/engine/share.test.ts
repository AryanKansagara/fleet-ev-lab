import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CATALOGUE } from './catalogue.ts'
import { buildSample, type RouteFile } from './samples.ts'
import { assembleFleet } from './segment.ts'
import { defaultSettings } from './settings.ts'
import { decodeSettings, mergeSettings, readFleet } from './share.ts'
import { analyzeFleet } from './sim.ts'
import type { Settings, Trip } from './types.ts'

const VAN = CATALOGUE.find((m) => m.id === 'e-transit')!
const T0 = Date.UTC(2026, 0, 5, 8)
const trip: Trip = { vehicle: 'A', start: T0, end: T0 + 4 * 3600e3, km: 100, idleH: 0, speedKm: [0, 100, 0, 0], from: [43.68, -79.56], to: [43.68, -79.56] }
const fleet = (trips: Trip[]) => assembleFleet(trips, { name: 'test', defaultCls: 'van', defaultLoadKg: 200 })
const routesOf = (id: string) => JSON.parse(readFileSync(new URL(`../samples/routes-${id}.json`, import.meta.url), 'utf8')) as RouteFile

test('settings from links and storage: each wrong value falls back to its default', async () => {
  const d = defaultSettings()
  const bad: unknown[] = [
    { energy: { speedMult: null, batteryHealthPct: 'abc', refKph: 0, hvacOffC: NaN }, charging: { chargers: 1e9, targetPct: -5, middayOn: 'yes' } },
    { tco: { years: 50, currency: {}, icePrice: null, fuelLPer100: { van: 'x' } }, fit: [] }, { tco: { years: 7.5 } },
    { customModels: [null, {}, { id: 'a', name: 'half' }], modelEdits: { 'e-transit': null, x: { usableKwh: 'x', name: {} } } },
    { climate: { name: 'x', monthly: Array(12).fill('a') } }, { climate: { name: {}, monthly: Array(12).fill(1) } },
    { curve: [{ t: 20, r: 1 }, { t: -10, r: 1 }] }, { curve: [{ t: 1, r: 1 }, null] }, { curve: 'x' }, null, 'x', 5, [],
  ]
  for (const b of bad) assert.deepEqual(mergeSettings(b), d, JSON.stringify(b))
  const f = fleet([trip])
  for (const b of bad) assert.ok(Number.isFinite(analyzeFleet(f, mergeSettings(b), { mode: 'observed' }).savings))
  // Good values beside bad ones are kept, and a whole valid document is unchanged.
  const some = mergeSettings({ energy: { batteryHealthPct: 80, speedMult: null }, modelEdits: { 'e-transit': { usableKwh: 70, ratedKm: 'x' } } })
  assert.equal(some.energy.batteryHealthPct, 80)
  assert.deepEqual(some.modelEdits, { 'e-transit': { usableKwh: 70 } })
  const mine: Settings = { ...d, customModels: [{ ...VAN, id: 'custom-1', sources: [], custom: true }], modelEdits: { 'e-transit': { priceAmount: 60000 } }, tco: { ...d.tco, years: 10 } }
  assert.deepEqual(mergeSettings(JSON.parse(JSON.stringify(mine))), mine)
  const [m] = mergeSettings({ customModels: [{ ...VAN, sources: ['javascript:alert(1)', 'https://example.com/'] }] }).customModels
  assert.deepEqual(m.sources, ['https://example.com/'])
  assert.equal(await decodeSettings('not-a-link'), null)
  assert.equal(await decodeSettings(''), null)
})

test('saved fleets: a good one is kept, a damaged one is refused', () => {
  const f = fleet([trip])
  const copy = () => JSON.parse(JSON.stringify(f))
  assert.deepEqual(readFleet(copy()), copy())
  for (const id of ['toronto', 'rural'] as const) assert.ok(readFleet(JSON.parse(JSON.stringify(buildSample(id, routesOf(id))))))
  for (const b of [null, {}, [], { ...copy(), trips: [] }, { ...copy(), trips: [null] }, { ...copy(), vehicles: [{}] }, { ...copy(), trips: [{ ...copy().trips[0], km: null }] }, { ...copy(), trips: [{ ...copy().trips[0], speedKm: [1] }] }]) assert.equal(readFleet(b), null)
})
