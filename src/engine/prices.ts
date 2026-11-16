import { haversineKm } from './segment.ts'

/**
 * Official price feeds, both free, keyless and CORS-open:
 * - Bank of Canada Valet API, series FXUSDCAD (daily USD/CAD).
 * - Statistics Canada table 18-10-0001-01, monthly average retail pump prices by city, in cents per litre.
 */
export const BOC_URL = 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1'
export const STATCAN_URL = 'https://www150.statcan.gc.ca/t1/wds/rest/getDataFromCubePidCoordAndLatestNPeriods'
export const STATCAN_TABLE = 'https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=1810000101'

/** Geography member ids in table 18-10-0001-01. */
export const FUEL_CITIES: { id: number; name: string; lat: number; lng: number }[] = [
  { id: 2, name: "St. John's", lat: 47.56, lng: -52.71 },
  { id: 4, name: 'Halifax', lat: 44.65, lng: -63.58 },
  { id: 5, name: 'Saint John', lat: 45.27, lng: -66.06 },
  { id: 6, name: 'Québec', lat: 46.81, lng: -71.21 },
  { id: 7, name: 'Montréal', lat: 45.5, lng: -73.57 },
  { id: 8, name: 'Ottawa-Gatineau', lat: 45.42, lng: -75.7 },
  { id: 9, name: 'Toronto', lat: 43.65, lng: -79.38 },
  { id: 10, name: 'Thunder Bay', lat: 48.38, lng: -89.25 },
  { id: 11, name: 'Winnipeg', lat: 49.9, lng: -97.14 },
  { id: 12, name: 'Regina', lat: 50.45, lng: -104.61 },
  { id: 13, name: 'Saskatoon', lat: 52.13, lng: -106.67 },
  { id: 14, name: 'Edmonton', lat: 53.55, lng: -113.49 },
  { id: 15, name: 'Calgary', lat: 51.05, lng: -114.07 },
  { id: 16, name: 'Vancouver', lat: 49.28, lng: -123.12 },
  { id: 17, name: 'Victoria', lat: 48.43, lng: -123.37 },
]

/** Nearest StatCan city within 400 km, or null (US fleets, the far north). */
export function nearestFuelCity(lat: number, lng: number) {
  let best = null as (typeof FUEL_CITIES)[number] | null
  let bestKm = 400
  for (const c of FUEL_CITIES) {
    const d = haversineKm(lat, lng, c.lat, c.lng)
    if (d < bestKm) [best, bestKm] = [c, d]
  }
  return best
}

export function parseBoc(json: unknown): { rate: number; date: string } | null {
  const o = (json as { observations?: { d: string; FXUSDCAD?: { v: string } }[] })?.observations?.at(-1)
  const rate = Number(o?.FXUSDCAD?.v)
  return o && Number.isFinite(rate) && rate > 0 ? { rate, date: o.d } : null
}

/** Latest non-empty month from a WDS response, converted from cents to dollars per litre. */
export function parseStatcan(json: unknown): { perL: number; month: string } | null {
  const pts = (json as { object?: { vectorDataPoint?: { refPer: string; value: number | null }[] } })?.object?.vectorDataPoint ?? []
  for (let i = pts.length - 1; i >= 0; i--) {
    if (typeof pts[i].value === 'number') return { perL: Math.round(pts[i].value! * 10) / 1000, month: pts[i].refPer.slice(0, 7) }
  }
  return null
}

export interface LivePrices {
  fx: { rate: number; date: string } | null
  city: string | null
  gasoline: { perL: number; month: string } | null
  diesel: { perL: number; month: string } | null
}

export async function fetchLivePrices(lat: number, lng: number): Promise<LivePrices> {
  const city = nearestFuelCity(lat, lng)
  const fxP = fetch(BOC_URL).then((r) => r.json()).then(parseBoc).catch(() => null)
  const fuelP = city
    ? fetch(STATCAN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Fuel type 2 is regular unleaded, self service; 6 is diesel, self service.
        body: JSON.stringify([2, 6].map((f) => ({ productId: 18100001, coordinate: `${city.id}.${f}.0.0.0.0.0.0.0.0`, latestN: 3 }))),
      })
        .then((r) => r.json())
        .then((a: unknown[]) => a.map(parseStatcan))
        .catch(() => [null, null])
    : Promise.resolve([null, null])
  const [fx, [gasoline, diesel]] = await Promise.all([fxP, fuelP])
  return { fx, city: city?.name ?? null, gasoline, diesel }
}
