import { defaultSettings } from './settings.ts'
import type { Settings } from './types.ts'

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

/** Unknown or malformed hashes fall back to defaults rather than failing the page. */
export async function decodeSettings(hash: string): Promise<Settings | null> {
  try {
    const bytes = await pipe(unb64url(hash), new DecompressionStream('deflate-raw'))
    return mergeSettings(JSON.parse(new TextDecoder().decode(bytes)))
  } catch {
    return null
  }
}

export function mergeSettings(raw: Partial<Settings> | null | undefined): Settings {
  const d = defaultSettings()
  if (!raw || typeof raw !== 'object') return d
  return {
    curve: Array.isArray(raw.curve) && raw.curve.length >= 2 && raw.curve.every((p) => Number.isFinite(p?.t) && Number.isFinite(p?.r) && p.r > 0) ? raw.curve : d.curve,
    energy: { ...d.energy, ...raw.energy },
    charging: { ...d.charging, ...raw.charging },
    fit: { ...d.fit, ...raw.fit },
    tco: {
      ...d.tco,
      ...raw.tco,
      icePrice: { ...d.tco.icePrice, ...raw.tco?.icePrice },
      fuelLPer100: { ...d.tco.fuelLPer100, ...raw.tco?.fuelLPer100 },
      incentive: { ...d.tco.incentive, ...raw.tco?.incentive },
    },
    modelEdits: raw.modelEdits && typeof raw.modelEdits === 'object' ? raw.modelEdits : {},
    customModels: Array.isArray(raw.customModels) ? raw.customModels : [],
    climate: raw.climate && Array.isArray(raw.climate.monthly) && raw.climate.monthly.length === 12 ? raw.climate : d.climate,
  }
}
