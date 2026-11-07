import { chargeEff, tripKwh } from './energy.ts'
import { priceLocal } from './settings.ts'
import type { EvModel, Settings, TcoResult, Trip, Vehicle } from './types.ts'

export interface DutyProfile {
  annualKm: number
  annualIdleH: number
  /** One representative pseudo-trip per km-weighted average, used to evaluate kWh/km cheaply. */
  perKm: Pick<Trip, 'start' | 'end' | 'km' | 'idleH' | 'speedKm'>
  avgLoadKg: number
}

/** Annualises a vehicle's observed duty. Uses the observed calendar span, so a six-month extract scales up correctly. */
export function dutyProfile(trips: Trip[], v: Vehicle): DutyProfile {
  let km = 0
  let hours = 0
  let idle = 0
  let load = 0
  const bands: Trip['speedKm'] = [0, 0, 0, 0]
  let first = Infinity
  let last = -Infinity
  for (const t of trips) {
    km += t.km
    hours += (t.end - t.start) / 3600e3
    idle += t.idleH
    load += (t.loadKg ?? v.loadKg) * t.km
    for (let i = 0; i < 4; i++) bands[i] += t.speedKm[i]
    if (t.start < first) first = t.start
    if (t.end > last) last = t.end
  }
  if (km <= 0) return { annualKm: 0, annualIdleH: 0, perKm: { start: 0, end: 0, km: 0, idleH: 0, speedKm: [0, 0, 0, 0] }, avgLoadKg: v.loadKg }
  const spanDays = Math.max(7, (last - first) / 86400e3)
  const scale = 365 / spanDays
  return {
    annualKm: km * scale,
    annualIdleH: idle * scale,
    perKm: { start: 0, end: (hours / km) * 3600e3, km: 1, idleH: idle / km, speedKm: bands.map((b) => b / km) as Trip['speedKm'] },
    avgLoadKg: load / km,
  }
}

/** Battery kWh per km averaged over the climate's twelve months, and the matching wall kWh. */
export function annualKwhPerKm(d: DutyProfile, m: EvModel, s: Settings): { batt: number; wall: number } {
  let batt = 0
  let wall = 0
  for (const t of s.climate.monthly) {
    const k = tripKwh(d.perKm, m, t, d.avgLoadKg, s)
    batt += k
    wall += k / chargeEff(t, s.charging)
  }
  return { batt: batt / 12, wall: wall / 12 }
}

export interface InfraShare {
  chargerCapex: number
  demandCostYear: number
}

/**
 * Cumulative discounted cost of owning at each year-end, net of what the vehicle could be sold for that year,
 * so the lines can honestly cross: EVs start dearer and win on running costs.
 */
export function computeTco(d: DutyProfile, m: EvModel, cls: Vehicle['cls'], s: Settings, infra: InfraShare): TcoResult {
  const t = s.tco
  const { wall } = annualKwhPerKm(d, m, s)
  const annualKwh = wall * d.annualKm
  const annualEnergyCost = annualKwh * t.electricity
  const fuelL = (d.annualKm * t.fuelLPer100[cls]) / 100 + d.annualIdleH * t.idleLPerH
  const annualFuelCost = fuelL * t.fuelPrice
  const evPrice = priceLocal(m, s)
  const evNet = evPrice - t.incentive[cls]
  const icePrice = t.icePrice[cls]
  const upfrontEv = evNet + infra.chargerCapex
  const upfrontIce = icePrice
  const evRun = annualEnergyCost + d.annualKm * t.maintEvKm + infra.demandCostYear
  const iceRun = annualFuelCost + d.annualKm * t.maintIceKm
  const r = t.discountPct / 100
  // Year 0 is net of resale too: on day one you could sell the vehicle back, so only incentives and chargers count.
  const evSeries: number[] = [upfrontEv - evPrice]
  const iceSeries: number[] = [upfrontIce - icePrice]
  let evCum = upfrontEv
  let iceCum = upfrontIce
  for (let y = 1; y <= 10; y++) {
    const disc = 1 / (1 + r) ** y
    evCum += evRun * disc
    iceCum += iceRun * disc
    evSeries.push(evCum - evPrice * (1 - t.evDepreciationPct / 100) ** y * disc)
    iceSeries.push(iceCum - icePrice * (1 - t.iceDepreciationPct / 100) ** y * disc)
  }
  let crossoverYear: number | null = null
  for (let y = 1; y <= t.years; y++) {
    if (evSeries[y] <= iceSeries[y]) {
      const a = iceSeries[y - 1] - evSeries[y - 1]
      const b = iceSeries[y] - evSeries[y]
      crossoverYear = a >= 0 ? y - 1 : y - 1 + -a / (b - a)
      break
    }
  }
  return {
    years: t.years,
    evSeries,
    iceSeries,
    crossoverYear,
    savings: iceSeries[t.years] - evSeries[t.years],
    annualKm: d.annualKm,
    annualKwh,
    annualEnergyCost,
    annualFuelCost,
    annualCo2Tonnes: (fuelL * t.fuelKgCo2PerL - (annualKwh * t.gridGPerKwh) / 1000) / 1000,
    upfrontEv,
    upfrontIce,
  }
}
