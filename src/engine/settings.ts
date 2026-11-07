import { CATALOGUE } from './catalogue.ts'
import type { CurvePoint, EvModel, Settings, VClass } from './types.ts'

/**
 * The only published points this app relies on: Geotab reports observed range peaking near 115% of rated
 * at 21C and falling to about 54% at -15C, across 5.2 million trips.
 */
export const PUBLISHED_ANCHORS: CurvePoint[] = [
  { t: 21, r: 1.15 },
  { t: -15, r: 0.54 },
]

/**
 * Independent fit, not Geotab's curve. A Gaussian through the two published points on the cold side; the hot
 * side width is an assumption chosen to reach about 90% at 40C, reflecting the reported loss to cooling above 25C.
 */
export function fittedRange(t: number): number {
  const peak = PUBLISHED_ANCHORS[0]
  const cold = PUBLISHED_ANCHORS[1]
  const coldWidth = (peak.t - cold.t) / Math.sqrt(Math.log(peak.r / cold.r))
  const hotWidth = 38
  const w = t < peak.t ? coldWidth : hotWidth
  return peak.r * Math.exp(-(((t - peak.t) / w) ** 2))
}

export const CURVE_KNOTS = [-30, -25, -20, -15, -10, -5, 0, 5, 10, 15, 21, 25, 30, 35, 40]

export const defaultCurve = (): CurvePoint[] => CURVE_KNOTS.map((t) => ({ t, r: Math.round(fittedRange(t) * 1000) / 1000 }))

export const CLIMATES: { name: string; lat: number; lng: number; monthly: number[] }[] = [
  { name: 'Toronto', lat: 43.65, lng: -79.38, monthly: [-3.7, -2.6, 1.4, 7.9, 14.1, 19.4, 22.3, 21.5, 17.2, 10.7, 4.9, -0.5] },
  { name: 'Montreal', lat: 45.5, lng: -73.57, monthly: [-9.2, -7.6, -1.6, 6.6, 14.1, 19.2, 21.6, 20.5, 15.7, 8.9, 2.6, -5.2] },
  { name: 'Halifax', lat: 44.65, lng: -63.58, monthly: [-5.9, -5.3, -1, 4.4, 9.9, 15, 18.7, 18.7, 14.7, 9.1, 3.7, -2.2] },
  { name: 'Winnipeg', lat: 49.9, lng: -97.14, monthly: [-16.4, -13.2, -5.8, 3.9, 11.6, 17.4, 19.7, 18.9, 12.9, 5.2, -4.5, -13.2] },
  { name: 'Calgary', lat: 51.05, lng: -114.07, monthly: [-7.1, -5.4, -1.2, 4.2, 9.4, 13.4, 16.5, 15.8, 11.2, 4.7, -2.4, -6.8] },
  { name: 'Red Deer', lat: 52.27, lng: -113.81, monthly: [-11, -9, -4, 3.7, 9.6, 13.7, 15.9, 15, 10.2, 4, -4.6, -9.9] },
  { name: 'Edmonton', lat: 53.55, lng: -113.49, monthly: [-10.4, -8.1, -3, 4.4, 10.6, 14.6, 16.6, 15.8, 10.9, 4, -4.5, -9.6] },
  { name: 'Vancouver', lat: 49.28, lng: -123.12, monthly: [4.1, 4.9, 6.8, 9.6, 13, 15.8, 18.1, 18.2, 15.3, 11, 6.6, 4] },
  { name: 'Chicago', lat: 41.88, lng: -87.63, monthly: [-3.2, -1.2, 4.4, 10.5, 16.6, 22.2, 24.8, 23.9, 19.9, 12.9, 5.8, -0.5] },
  { name: 'Minneapolis', lat: 44.98, lng: -93.27, monthly: [-9.3, -6.5, 0.2, 8.1, 15, 20.6, 23.5, 22.1, 17.3, 9.5, 1.4, -6] },
]

export function nearestClimate(lat: number, lng: number) {
  let best = CLIMATES[0]
  let bestD = Infinity
  for (const c of CLIMATES) {
    const d = (c.lat - lat) ** 2 + ((c.lng - lng) * Math.cos((lat * Math.PI) / 180)) ** 2
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  return best
}

export function defaultSettings(): Settings {
  return {
    curve: defaultCurve(),
    energy: {
      speedMult: [1.0, 0.95, 1.0, 1.2],
      refKph: 50,
      hvacKwAtMin: 5,
      hvacOffC: 15,
      hvacMinC: -25,
      coolKw: 1.5,
      payloadPctPer1000kg: 12,
      batteryHealthPct: 100,
    },
    charging: {
      chargerKw: 11.5,
      chargers: 0,
      startHour: 19,
      siteCapKw: 0,
      targetPct: 100,
      bufferPct: 15,
      effPct: 90,
      coldEffLossPct: 8,
      middayOn: false,
      middayKw: 50,
      middayMinDwell: 30,
      middayPublic: true,
    },
    fit: { minCompletionPct: 95, includeEnded: false },
    tco: {
      years: 8,
      currency: 'C$',
      fxUsd: 1.3966,
      fuelPrice: 1.45,
      electricity: 0.16,
      demandChargeKwMonth: 10,
      maintEvKm: 0.06,
      maintIceKm: 0.1,
      discountPct: 5,
      evDepreciationPct: 20,
      iceDepreciationPct: 16,
      icePrice: { van: 68000, pickup: 62000, car: 42000 },
      fuelLPer100: { van: 15.5, pickup: 14.5, car: 8.5 },
      idleLPerH: 2.5,
      // Default is none. See INCENTIVE_NOTES for what exists, then enter what your vehicles actually qualify for.
      incentive: { van: 0, pickup: 0, car: 0 },
      chargerCapexAc: 7500,
      chargerCapexDc: 70000,
      fuelKgCo2PerL: 2.31,
      gridGPerKwh: 40,
    },
    modelEdits: {},
    customModels: [],
    climate: { name: 'Toronto', monthly: CLIMATES[0].monthly },
  }
}

export function allModels(s: Settings): EvModel[] {
  return [...CATALOGUE.map((m) => (s.modelEdits[m.id] ? { ...m, ...s.modelEdits[m.id] } : m)), ...s.customModels]
}

export function candidateModels(s: Settings, cls: VClass): EvModel[] {
  return allModels(s).filter((m) => m.cls === cls && (s.fit.includeEnded || m.status !== 'ended'))
}

export function priceLocal(m: EvModel, s: Settings): number {
  return m.priceCurrency === 'USD' ? m.priceAmount * s.tco.fxUsd : m.priceAmount
}
