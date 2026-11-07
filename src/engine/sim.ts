import { chargeEff, plugKw, tripKwh } from './energy.ts'
import { scheduleNight, SLOTS, type ChargeRequest } from './schedule.ts'
import { dayOf, DAY_MS } from './segment.ts'
import { candidateModels } from './settings.ts'
import { computeTco, dutyProfile, type DutyProfile } from './tco.ts'
import type { Candidate, DayResult, DepotResult, EvModel, Fleet, FleetResult, NightPlan, Phase, Reason, Settings, Trip, Vehicle, VehicleResult, Verdict } from './types.ts'

export type TempMode = { mode: 'observed' } | { mode: 'fixed'; c: number } | { mode: 'stress'; week: number[] }

export function tempFn(t: TempMode, s: Settings): (trip: Trip) => number {
  if (t.mode === 'fixed') return () => t.c
  if (t.mode === 'stress') return (trip) => t.week[((dayOf(trip.start) % 7) + 7) % 7]
  return (trip) => trip.tempC ?? s.climate.monthly[new Date(trip.start).getUTCMonth()]
}

interface VIndex {
  v: Vehicle
  trips: Trip[]
  byDay: Map<number, Trip[]>
  duty: DutyProfile
}
interface FleetIndex {
  first: number
  last: number
  vehicles: VIndex[]
}

const indexCache = new WeakMap<Fleet, FleetIndex>()

function indexFleet(f: Fleet): FleetIndex {
  const cached = indexCache.get(f)
  if (cached) return cached
  const vs = new Map<string, VIndex>()
  for (const v of f.vehicles) vs.set(v.id, { v, trips: [], byDay: new Map(), duty: null as unknown as DutyProfile })
  let first = Infinity
  let last = -Infinity
  for (const t of f.trips) {
    const x = vs.get(t.vehicle)
    if (!x) continue
    x.trips.push(t)
    const d = dayOf(t.start)
    const list = x.byDay.get(d)
    if (list) list.push(t)
    else x.byDay.set(d, [t])
    if (d < first) first = d
    if (d > last) last = d
  }
  for (const x of vs.values()) {
    for (const list of x.byDay.values()) list.sort((a, b) => a.start - b.start)
    x.duty = dutyProfile(x.trips, x.v)
  }
  const out = { first: first === Infinity ? 0 : first, last: last === -Infinity ? 0 : last, vehicles: [...vs.values()] }
  indexCache.set(f, out)
  return out
}

/** The vehicle's duty changes when a user edits its class or load, so the cache must be dropped. */
export function invalidateFleet(f: Fleet) {
  indexCache.delete(f)
}

interface DayRun {
  endKwh: number
  minKwh: number
  kwh: number
  km: number
  failed: boolean
  shortfall: number
  tripSoc?: [number, number][]
  overloaded: boolean
}

/** Runs one operating day from a starting charge, with optional mid-day top-ups. */
function runDay(trips: Trip[], m: EvModel, v: Vehicle, startKwh: number, s: Settings, temp: (t: Trip) => number, record: boolean): DayRun {
  const usable = (m.usableKwh * s.energy.batteryHealthPct) / 100
  const floor = (usable * s.charging.bufferPct) / 100
  const ceil = (usable * s.charging.targetPct) / 100
  let soc = startKwh
  let minKwh = startKwh
  let kwh = 0
  let km = 0
  let shortfall = 0
  let overloaded = false
  const tripSoc: [number, number][] | undefined = record ? [] : undefined
  for (let i = 0; i < trips.length; i++) {
    const t = trips[i]
    if (i > 0 && s.charging.middayOn) {
      const prev = trips[i - 1]
      const dwellMin = (t.start - prev.end) / 60e3
      if (dwellMin >= s.charging.middayMinDwell && (s.charging.middayPublic || prev.endsAtDepot)) {
        const gain = (plugKw(s.charging.middayKw, m) * dwellMin) / 60 * chargeEff(temp(t), s.charging)
        soc = Math.min(ceil, soc + gain)
      }
    }
    const load = t.loadKg ?? v.loadKg
    if (load > m.payloadKg) overloaded = true
    const use = tripKwh(t, m, temp(t), load, s)
    const before = soc
    soc -= use
    kwh += use
    km += t.km
    if (soc < floor) shortfall = Math.max(shortfall, floor - soc)
    if (soc < 0) soc = 0
    if (soc < minKwh) minKwh = soc
    tripSoc?.push([(before / usable) * 100, (soc / usable) * 100])
  }
  return { endKwh: soc, minKwh, kwh, km, failed: shortfall > 1e-6 || overloaded, shortfall, tripSoc, overloaded }
}

/** Finds why a failed day failed by testing what would have changed the outcome. */
function failureReason(run: DayRun, trips: Trip[], m: EvModel, v: Vehicle, s: Settings, temp: (t: Trip) => number, wasAway: boolean): Reason {
  if (run.overloaded) return 'payload'
  const full = (m.usableKwh * s.energy.batteryHealthPct * s.charging.targetPct) / 1e4
  const fromFull = runDay(trips, m, v, full, s, temp, false)
  if (fromFull.shortfall > 1e-6) {
    const mild = runDay(trips, m, v, full, s, () => 21, false)
    return mild.shortfall > 1e-6 ? 'range' : 'cold'
  }
  return wasAway ? 'no-depot' : 'charging'
}

function slotOf(t: number, day: number): number {
  return Math.floor((t - (day * DAY_MS + DAY_MS / 2)) / (DAY_MS / SLOTS))
}

/** Fast single-vehicle sim with a dedicated charger, used to rank candidate models. */
function standalonePct(x: VIndex, m: EvModel, s: Settings, temp: (t: Trip) => number, first: number, last: number): number {
  const usable = (m.usableKwh * s.energy.batteryHealthPct) / 100
  const ceil = (usable * s.charging.targetPct) / 100
  const kw = plugKw(s.charging.chargerKw, m)
  const startSlot = startSlotOf(s)
  let soc = ceil
  let ok = 0
  let op = 0
  let lastTrip: Trip | null = null
  for (let d = first; d <= last; d++) {
    const trips = x.byDay.get(d)
    if (trips) {
      const run = runDay(trips, m, x.v, soc, s, temp, false)
      op++
      if (!run.failed) ok++
      soc = run.endKwh
      lastTrip = trips[trips.length - 1]
    }
    if (lastTrip && !lastTrip.endsAtDepot) continue
    const next = x.byDay.get(d + 1)
    const arrive = Math.max(startSlot, trips ? slotOf(trips[trips.length - 1].end, d) : 0)
    const depart = next ? Math.min(SLOTS, slotOf(next[0].start, d)) : SLOTS
    if (depart <= arrive) continue
    const t = trips ? temp(trips[trips.length - 1]) : s.climate.monthly[new Date(d * DAY_MS).getUTCMonth()]
    soc = Math.min(ceil, soc + ((depart - arrive) / 4) * kw * chargeEff(t, s.charging))
  }
  return op ? (ok / op) * 100 : 0
}

const startSlotOf = (s: Settings) => {
  const h = s.charging.startHour
  return (h >= 12 ? h - 12 : h + 12) * 4
}

interface DepotSimOut {
  dayResults: Map<string, DayResult[]>
  nights: NightPlan[]
  chargingFails: number
  peakKw: number
}

function simDepot(xs: { x: VIndex; m: EvModel }[], s: Settings, temp: (t: Trip) => number, first: number, last: number, chargers: number, startSlot: number, record: boolean): DepotSimOut {
  const state = xs.map(({ x, m }) => {
    const ceil = (m.usableKwh * s.energy.batteryHealthPct * s.charging.targetPct) / 1e4
    return { x, m, soc: ceil, away: false, plugged: true, kw: plugKw(s.charging.chargerKw, m) }
  })
  const dayResults = new Map<string, DayResult[]>(xs.map(({ x }) => [x.v.id, []]))
  const nights: NightPlan[] = []
  let chargingFails = 0
  let peakKw = 0
  const usableOf = (m: EvModel) => (m.usableKwh * s.energy.batteryHealthPct) / 100
  for (let d = first; d <= last; d++) {
    const reqs: ChargeRequest[] = []
    for (const st of state) {
      const trips = st.x.byDay.get(d)
      if (trips) {
        const startKwh = st.soc
        const run = runDay(trips, st.m, st.x.v, startKwh, s, temp, record)
        if (run.failed) {
          const reason = failureReason(run, trips, st.m, st.x.v, s, temp, st.away)
          if (reason === 'charging') chargingFails++
          if (record) dayResults.get(st.x.v.id)!.push(dayRecord(d, run, trips, temp, usableOf(st.m), startKwh, reason))
        } else if (record) dayResults.get(st.x.v.id)!.push(dayRecord(d, run, trips, temp, usableOf(st.m), startKwh))
        st.soc = run.endKwh
        st.away = !trips[trips.length - 1].endsAtDepot
      }
      if (st.away) continue
      const next = st.x.byDay.get(d + 1)
      const ceil = (usableOf(st.m) * s.charging.targetPct) / 100
      const need = ceil - st.soc
      if (need <= 1e-6) continue
      const lastEnd = trips ? trips[trips.length - 1].end : 0
      const carriedTemp = trips ? temp(trips[trips.length - 1]) : next ? temp(next[0]) : s.climate.monthly[new Date(d * DAY_MS).getUTCMonth()]
      reqs.push({
        vehicle: st.x.v.id,
        arrive: trips ? Math.max(0, slotOf(lastEnd, d) + 1) : 0,
        depart: next ? Math.min(SLOTS, slotOf(next[0].start, d)) : SLOTS,
        needKwh: need,
        kw: st.kw,
        eff: chargeEff(carriedTemp, s.charging),
      })
    }
    if (!reqs.length) {
      if (record) nights.push({ day: d, sessions: [], load: new Array(SLOTS).fill(0), gridKwh: 0, swaps: 0, unmetKwh: 0 })
      continue
    }
    const { plan, delivered } = scheduleNight(reqs, { chargers, capKw: s.charging.siteCapKw, startSlot }, d)
    for (const st of state) {
      const got = delivered.get(st.x.v.id)
      if (got) st.soc += got
    }
    for (const kw of plan.load) if (kw > peakKw) peakKw = kw
    if (record) nights.push(plan)
  }
  return { dayResults, nights, chargingFails, peakKw }
}

function dayRecord(d: number, run: DayRun, trips: Trip[], temp: (t: Trip) => number, usable: number, startKwh: number, reason?: Reason): DayResult {
  let tempSum = 0
  for (const t of trips) tempSum += temp(t)
  return {
    day: d,
    failed: run.failed,
    reason,
    km: run.km,
    kwh: run.kwh,
    tempC: tempSum / trips.length,
    startPct: (startKwh / usable) * 100,
    endPct: (run.endKwh / usable) * 100,
    minPct: (run.minKwh / usable) * 100,
    shortfallKwh: run.shortfall,
    tripSoc: run.tripSoc ?? [],
  }
}

/** Smallest charger count that adds no charging failures compared with one charger per vehicle. */
function sizeChargers(xs: { x: VIndex; m: EvModel }[], s: Settings, temp: (t: Trip) => number, first: number, last: number): number {
  const startSlot = startSlotOf(s)
  const base = simDepot(xs, s, temp, first, last, xs.length, startSlot, false).chargingFails
  let lo = 1
  let hi = xs.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (simDepot(xs, s, temp, first, last, mid, startSlot, false).chargingFails <= base) hi = mid
    else lo = mid + 1
  }
  return lo
}

function verdictOf(pct: number, savings: number, min: number, reasons: Partial<Record<Reason, number>>, opDays: number): Verdict {
  const payloadShare = (reasons.payload ?? 0) / Math.max(1, opDays)
  if (payloadShare > 0.02 || pct < 70) return 'hold'
  if (pct >= min) return savings >= 0 ? 'ready' : 'close'
  return pct >= min - 10 ? 'close' : 'change'
}

export function pickBest(cands: (Candidate & { model: EvModel })[], minPct: number) {
  const passing = cands.filter((c) => c.pct >= minPct)
  const pool = passing.length ? passing : cands
  return [...pool].sort((a, b) => (passing.length ? b.savings - a.savings : b.pct - a.pct || b.savings - a.savings))[0]
}

export function analyzeFleet(f: Fleet, s: Settings, tm: TempMode, assignment?: Record<string, string>): FleetResult {
  const started = performance.now()
  const idx = indexFleet(f)
  const temp = tempFn(tm, s)
  const { first, last } = idx
  const noInfra = { chargerCapex: 0, demandCostYear: 0 }
  const picks: { x: VIndex; model: EvModel | null; candidates: Candidate[] }[] = []
  for (const x of idx.vehicles) {
    const pool = candidateModels(s, x.v.cls)
    const cands = pool.map((model) => ({
      modelId: model.id,
      model,
      pct: standalonePct(x, model, s, temp, first, last),
      savings: computeTco(x.duty, model, x.v.cls, s, noInfra).savings,
    }))
    const forced = assignment?.[x.v.id]
    const best = (forced ? cands.find((c) => c.modelId === forced) : null) ?? (cands.length ? pickBest(cands, s.fit.minCompletionPct) : null)
    picks.push({ x, model: best?.model ?? null, candidates: cands.map(({ modelId, pct, savings }) => ({ modelId, pct, savings })).sort((a, b) => b.pct - a.pct) })
  }

  const depots: DepotResult[] = []
  const dayMap = new Map<string, DayResult[]>()
  const groups = new Map<string, { x: VIndex; m: EvModel }[]>()
  for (const p of picks) {
    if (!p.model) continue
    const list = groups.get(p.x.v.depot)
    if (list) list.push({ x: p.x, m: p.model })
    else groups.set(p.x.v.depot, [{ x: p.x, m: p.model }])
  }
  const startSlot = startSlotOf(s)
  const depotOf = new Map<string, { chargerCapex: number; demandCostYear: number }>()
  for (const [id, xs] of groups) {
    const auto = s.charging.chargers <= 0
    const chargers = auto ? sizeChargers(xs, s, temp, first, last) : s.charging.chargers
    const out = simDepot(xs, s, temp, first, last, chargers, startSlot, true)
    const open = simDepot(xs, s, temp, first, last, xs.length, 0, false)
    for (const [v, d] of out.dayResults) dayMap.set(v, d)
    let worst = 0
    let worstKwh = -1
    out.nights.forEach((n, i) => {
      if (n.gridKwh > worstKwh) {
        worstKwh = n.gridKwh
        worst = i
      }
    })
    const info = f.depots.find((d) => d.id === id)
    depots.push({
      id,
      lat: info?.lat ?? 0,
      lng: info?.lng ?? 0,
      vehicles: xs.map((e) => e.x.v.id),
      chargers,
      autoSized: auto,
      peakKw: out.peakKw,
      unmanagedPeakKw: open.peakKw,
      nights: out.nights,
      worstNight: worst,
    })
    const portCost = s.charging.chargerKw > 22 ? s.tco.chargerCapexDc : s.tco.chargerCapexAc
    depotOf.set(id, {
      chargerCapex: (chargers * portCost) / xs.length,
      demandCostYear: (out.peakKw * s.tco.demandChargeKwMonth * 12) / xs.length,
    })
  }

  const vehicles: VehicleResult[] = picks.map(({ x, model, candidates }) => {
    const days = dayMap.get(x.v.id) ?? []
    const reasons: Partial<Record<Reason, number>> = {}
    let failDays = 0
    let totalKm = 0
    let maxKm = 0
    for (const d of days) {
      if (d.failed) {
        failDays++
        if (d.reason) reasons[d.reason] = (reasons[d.reason] ?? 0) + 1
      }
      totalKm += d.km
      if (d.km > maxKm) maxKm = d.km
    }
    const opDays = days.length
    const pct = opDays ? ((opDays - failDays) / opDays) * 100 : 0
    const tco = model ? computeTco(x.duty, model, x.v.cls, s, depotOf.get(x.v.depot) ?? noInfra) : null
    return {
      id: x.v.id,
      cls: x.v.cls,
      depot: x.v.depot,
      model,
      pct,
      opDays,
      failDays,
      reasons,
      days,
      avgKm: opDays ? totalKm / opDays : 0,
      maxKm,
      rtbPct: x.v.rtbPct,
      verdict: model ? verdictOf(pct, tco?.savings ?? 0, s.fit.minCompletionPct, reasons, opDays) : 'hold',
      tco,
      candidates,
      middayPct: null,
    }
  })

  const opDays = vehicles.reduce((n, v) => n + v.opDays, 0)
  const failDays = vehicles.reduce((n, v) => n + v.failDays, 0)
  return {
    vehicles,
    depots,
    firstDay: first,
    lastDay: last,
    pct: opDays ? ((opDays - failDays) / opDays) * 100 : 0,
    opDays,
    failDays,
    readyCount: vehicles.filter((v) => v.verdict === 'ready').length,
    chargers: depots.reduce((n, d) => n + d.chargers, 0),
    peakKw: depots.reduce((n, d) => n + d.peakKw, 0),
    savings: vehicles.reduce((n, v) => n + (v.tco && v.verdict !== 'hold' ? v.tco.savings : 0), 0),
    co2Tonnes: vehicles.reduce((n, v) => n + (v.tco && v.verdict !== 'hold' ? v.tco.annualCo2Tonnes : 0), 0),
    ms: performance.now() - started,
  }
}

/** What a mid-day top-up would do for each vehicle on its assigned model. Used for the fixes column, not on every drag. */
export function middayUplift(f: Fleet, s: Settings, tm: TempMode, r: FleetResult): Map<string, number> {
  const idx = indexFleet(f)
  const on = { ...s, charging: { ...s.charging, middayOn: true } }
  const temp = tempFn(tm, on)
  const out = new Map<string, number>()
  for (const v of r.vehicles) {
    const x = idx.vehicles.find((e) => e.v.id === v.id)
    if (x && v.model) out.set(v.id, standalonePct(x, v.model, on, temp, idx.first, idx.last))
  }
  return out
}

/** Orders the fleet into rollout phases and sizes the charging each cumulative phase needs. */
export function planRollout(f: Fleet, s: Settings, tm: TempMode, r: FleetResult): Phase[] {
  const defs: { name: string; blurb: string; test: (v: VehicleResult) => boolean }[] = [
    { name: 'Phase 1: go first', blurb: 'Completes the days it needs on overnight charging and saves money. Best saving first.', test: (v) => v.verdict === 'ready' },
    { name: 'Phase 2: go next', blurb: 'Close on completion, or passes but does not pay back yet. Revisit with new prices or a bigger pack.', test: (v) => v.verdict === 'close' },
    { name: 'Phase 3: change the operation', blurb: 'Needs mid-day top-ups or route changes to get there.', test: (v) => v.verdict === 'change' },
    { name: 'Hold', blurb: 'Fails too often, or the load is over payload. Keep the current vehicle for now.', test: (v) => v.verdict === 'hold' },
  ]
  const idx = indexFleet(f)
  const temp = tempFn(tm, s)
  const portCost = s.charging.chargerKw > 22 ? s.tco.chargerCapexDc : s.tco.chargerCapexAc
  const cumulative: VehicleResult[] = []
  let prevChargers = 0
  return defs.map((def) => {
    const vehicles = r.vehicles.filter(def.test).sort((a, b) => (b.tco?.savings ?? 0) - (a.tco?.savings ?? 0))
    const isHold = def.name === 'Hold'
    let chargers = prevChargers
    let peakKw = 0
    if (!isHold) {
      cumulative.push(...vehicles)
      chargers = 0
      const groups = new Map<string, { x: VIndex; m: EvModel }[]>()
      for (const v of cumulative) {
        const x = idx.vehicles.find((e) => e.v.id === v.id)
        if (!x || !v.model) continue
        const list = groups.get(v.depot)
        if (list) list.push({ x, m: v.model })
        else groups.set(v.depot, [{ x, m: v.model }])
      }
      for (const xs of groups.values()) {
        const n = s.charging.chargers > 0 ? s.charging.chargers : sizeChargers(xs, s, temp, idx.first, idx.last)
        chargers += n
        peakKw += simDepot(xs, s, temp, idx.first, idx.last, n, startSlotOf(s), false).peakKw
      }
    }
    const added = Math.max(0, chargers - prevChargers)
    const phase: Phase = {
      name: def.name,
      blurb: def.blurb,
      vehicles,
      chargers: isHold ? 0 : chargers,
      peakKw,
      capex: added * portCost,
      savings: vehicles.reduce((n, v) => n + (v.tco?.savings ?? 0), 0),
      co2Tonnes: vehicles.reduce((n, v) => n + (v.tco?.annualCo2Tonnes ?? 0), 0),
    }
    if (!isHold) prevChargers = chargers
    return phase
  })
}
