import { defaultSettings } from './settings.ts'
import type { EvModel, Fleet, Settings } from './types.ts'

/**
 * Share links carry settings only. This whitelist is what guarantees it: trips, points, depots and vehicle IDs
 * are not reachable from the object below, so they cannot end up in a URL.
 */
export function shareable(s: Settings) {
  const { curve, energy, charging, fit, tco, modelEdits, customModels, climate } = s
  return { curve, energy, charging, fit, tco, modelEdits, customModels, climate }
}

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function unb64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

async function pipe(bytes: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(t as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function encodeSettings(s: Settings): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(shareable(s)))
  return b64url(await pipe(json, new CompressionStream('deflate-raw')))
}

/** Null when the link is not settings at all, so the page can say so. */
export async function decodeSettings(hash: string): Promise<Settings | null> {
  try {
    const bytes = await pipe(unb64url(hash), new DecompressionStream('deflate-raw'))
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return isObj(raw) ? mergeSettings(raw) : null
  } catch {
    return null
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && v >= min && v <= max
const text = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length <= max
const oneOf = <T extends string>(v: unknown, all: readonly T[]): v is T => all.includes(v as T)

/** Ranges of every number outside the ones that only need to be finite and not negative. They match the inputs. */
const RANGE: Record<string, [number, number]> = {
  refKph: [10, 120], hvacOffC: [0, 25], hvacMinC: [-60, -1], hvacKwAtMin: [0, 30], coolKw: [0, 30], payloadPctPer1000kg: [0, 60], batteryHealthPct: [40, 100],
  chargerKw: [1, 400], chargers: [0, 500], startHour: [0, 23], targetPct: [50, 100], bufferPct: [0, 50], effPct: [50, 100], coldEffLossPct: [0, 40], middayKw: [1, 400], middayMinDwell: [5, 240],
  minCompletionPct: [50, 100], years: [5, 10], fxUsd: [0.01, 1e6], discountPct: [0, 30], evDepreciationPct: [0, 60], iceDepreciationPct: [0, 60],
}

/** Takes each value of `raw` that has the type and range of its default, and the default for the rest. */
function pick<T extends object>(d: T, raw: unknown): T {
  const out = { ...d } as Record<string, unknown>
  if (!isObj(raw)) return d
  for (const [k, def] of Object.entries(d)) {
    const v = Object.hasOwn(raw, k) ? raw[k] : undefined
    if (typeof def === 'number') {
      const [min, max] = RANGE[k] ?? [0, 1e9]
      if (num(v, min, max) && (k !== 'years' || Number.isInteger(v))) out[k] = v
    } else if (typeof def === 'boolean') {
      if (typeof v === 'boolean') out[k] = v
    } else if (typeof def === 'string') {
      if (text(v, 8)) out[k] = v
    } else if (Array.isArray(def)) {
      if (Array.isArray(v) && v.length === def.length && v.every((x) => num(x, 0.3, 3))) out[k] = v
    } else if (isObj(def)) out[k] = pick(def, v)
  }
  return out as T
}

/** The fields of an EV model that are valid. An edit may hold only some of them. */
function modelFields(raw: unknown): Partial<EvModel> {
  if (!isObj(raw)) return {}
  const out: Partial<EvModel> = {}
  for (const k of ['usableKwh', 'ratedKm', 'acKw', 'dcKw'] as const) if (num(raw[k], 0.1, 1e5)) out[k] = raw[k]
  for (const k of ['payloadKg', 'priceAmount'] as const) if (num(raw[k], 0, 1e9)) out[k] = raw[k]
  for (const k of ['name', 'statusNote', 'estimated'] as const) if (text(raw[k])) out[k] = raw[k]
  if (oneOf(raw.cls, ['van', 'pickup', 'car'])) out.cls = raw.cls
  if (oneOf(raw.priceCurrency, ['USD', 'CAD'])) out.priceCurrency = raw.priceCurrency
  if (oneOf(raw.status, ['on-sale', 'ended', 'limited'])) out.status = raw.status
  return out
}

function customModel(raw: unknown): EvModel[] {
  const m = modelFields(raw)
  if (!isObj(raw) || !text(raw.id) || !raw.id || m.name === undefined || !m.cls || !m.usableKwh || !m.ratedKm || m.payloadKg === undefined || !m.acKw || !m.dcKw || m.priceAmount === undefined || !m.priceCurrency) return []
  // Links shown for a model must be web addresses, so a settings link cannot carry a script.
  const sources = Array.isArray(raw.sources) ? raw.sources.filter((u): u is string => text(u) && /^https?:\/\//i.test(u)) : []
  return [{ status: 'on-sale', statusNote: '', ...m, id: raw.id, sources, custom: true } as EvModel]
}

/** Settings come from links and browser storage, so every value is checked: a wrong one falls back to its default. */
export function mergeSettings(raw: unknown): Settings {
  const d = defaultSettings()
  if (!isObj(raw)) return d
  const curve = raw.curve
  const goodCurve = Array.isArray(curve) && curve.length >= 2 && curve.length <= 100 &&
    curve.every((p, i) => isObj(p) && num(p.t, -100, 100) && num(p.r, 0.01, 5) && (i === 0 || p.t > curve[i - 1].t))
  const c = raw.climate
  const custom = Array.isArray(raw.customModels) ? raw.customModels.flatMap(customModel) : []
  return {
    curve: goodCurve ? curve.map(({ t, r }) => ({ t, r })) : d.curve,
    energy: pick(d.energy, raw.energy),
    charging: pick(d.charging, raw.charging),
    fit: pick(d.fit, raw.fit),
    tco: pick(d.tco, raw.tco),
    modelEdits: isObj(raw.modelEdits) ? Object.fromEntries(Object.entries(raw.modelEdits).map(([id, e]) => [id, modelFields(e)] as const).filter(([, e]) => Object.keys(e).length)) : {},
    customModels: custom.filter((m, i) => custom.findIndex((x) => x.id === m.id) === i),
    climate: isObj(c) && text(c.name) && Array.isArray(c.monthly) && c.monthly.length === 12 && c.monthly.every((t) => num(t, -100, 100)) ? { name: c.name, monthly: c.monthly, ...(c.chosen === true ? { chosen: true } : {}) } : d.climate,
  }
}

const latLng = (v: unknown) => v === undefined || v === null || (Array.isArray(v) && v.length === 2 && num(v[0], -90, 90) && num(v[1], -180, 180))

/** A fleet saved in this browser, or null when it is damaged. It is checked because a broken one would stop the lab from ever opening. */
export function readFleet(raw: unknown): Fleet | null {
  if (!isObj(raw) || typeof raw.name !== 'string' || !Array.isArray(raw.vehicles) || !Array.isArray(raw.trips) || !Array.isArray(raw.depots) || !raw.trips.length) return null
  const ok =
    raw.vehicles.every((v) => isObj(v) && typeof v.id === 'string' && oneOf(v.cls, ['van', 'pickup', 'car']) && Number.isFinite(v.loadKg) && typeof v.depot === 'string' && (v.rtbPct === null || Number.isFinite(v.rtbPct))) &&
    raw.depots.every((x) => isObj(x) && typeof x.id === 'string' && Number.isFinite(x.lat) && Number.isFinite(x.lng)) &&
    raw.trips.every((t) => isObj(t) && typeof t.vehicle === 'string' && Number.isFinite(t.start) && Number.isFinite(t.end) && Number.isFinite(t.km) && Number.isFinite(t.idleH) &&
      Array.isArray(t.speedKm) && t.speedKm.length === 4 && t.speedKm.every(Number.isFinite) && (t.loadKg === undefined || Number.isFinite(t.loadKg)) && latLng(t.from) && latLng(t.to) && (t.path === undefined || (Array.isArray(t.path) && t.path.every((p) => p && latLng(p)))))
  return ok ? (raw as unknown as Fleet) : null
}
