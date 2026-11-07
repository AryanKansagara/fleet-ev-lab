import type { CurvePoint, EvModel, Settings, Trip } from './types.ts'

/** Observed range as a fraction of rated at temperature t. Piecewise linear between knots, flat beyond the ends. */
export function curveAt(curve: CurvePoint[], t: number): number {
  if (t <= curve[0].t) return curve[0].r
  for (let i = 1; i < curve.length; i++) {
    if (t <= curve[i].t) {
      const a = curve[i - 1]
      const b = curve[i]
      return a.r + ((t - a.t) / (b.t - a.t)) * (b.r - a.r)
    }
  }
  return curve[curve.length - 1].r
}

/** Cabin climate draw while stationary or crawling. Linear from hvacOffC down to hvacMinC. */
export function hvacKw(t: number, e: Settings['energy']): number {
  if (t >= 28) return e.coolKw
  if (t >= e.hvacOffC) return 0
  return Math.max(0, ((e.hvacOffC - t) / (e.hvacOffC - e.hvacMinC)) * e.hvacKwAtMin)
}

/**
 * Battery kWh for one trip.
 * The range curve is observed over mixed real driving, so it already contains typical HVAC while moving at normal
 * speed. To avoid counting that twice, HVAC is only added for hours beyond what the reference speed would need,
 * and for idling. That is why slow urban routes suffer more in the cold than the curve alone suggests.
 */
export function tripKwh(trip: Pick<Trip, 'start' | 'end' | 'km' | 'idleH' | 'speedKm'>, model: EvModel, tempC: number, loadKg: number, s: Settings): number {
  const e = s.energy
  const base = model.usableKwh / model.ratedKm
  const k = trip.speedKm
  const weightedKm = k[0] * e.speedMult[0] + k[1] * e.speedMult[1] + k[2] * e.speedMult[2] + k[3] * e.speedMult[3]
  const payload = 1 + (e.payloadPctPer1000kg / 100) * (loadKg / 1000)
  const drive = (base * weightedKm * payload) / curveAt(s.curve, tempC)
  const movingH = Math.max(0, (trip.end - trip.start) / 3600e3 - trip.idleH)
  const extraH = Math.max(0, movingH - trip.km / e.refKph) + trip.idleH
  return drive + hvacKw(tempC, e) * extraH
}

/** Wall-to-battery efficiency. Cold packs spend more on thermal conditioning. */
export function chargeEff(tempC: number, c: Settings['charging']): number {
  const cold = Math.max(0, Math.min(1, (10 - tempC) / 35))
  return Math.max(0.3, (c.effPct - c.coldEffLossPct * cold) / 100)
}

/** Plug power for a charger and vehicle pair: AC is limited by the onboard charger, DC by the vehicle's DC limit. */
export function plugKw(chargerKw: number, m: EvModel): number {
  return Math.min(chargerKw, chargerKw > 22 ? m.dcKw : m.acKw)
}
