import type { NightPlan, Session } from './types.ts'

export const SLOTS = 96
const SLOT_H = 0.25

export interface ChargeRequest {
  vehicle: string
  /** Slots count 15-minute steps from noon. */
  arrive: number
  depart: number
  /** Energy the battery still needs. */
  needKwh: number
  kw: number
  eff: number
}

export interface NightOptions {
  chargers: number
  capKw: number
  startSlot: number
}

/**
 * Overnight scheduler for shared chargers. When a charger is free it goes to the plugged-in vehicle with the least
 * slack (time left minus charge time needed), and that vehicle stays on until it is full or leaves. Sessions are not
 * preempted, because moving a plug means a person walking across the yard.
 */
export function scheduleNight(reqs: ChargeRequest[], o: NightOptions, day = 0): { plan: NightPlan; delivered: Map<string, number> } {
  const load = new Array<number>(SLOTS).fill(0)
  const sessions: Session[] = []
  const delivered = new Map<string, number>()
  const state = reqs.filter((r) => r.needKwh > 1e-6 && r.depart > r.arrive).map((r) => ({ r, left: r.needKwh, on: null as Session | null, done: false }))
  const free: number[] = Array.from({ length: Math.min(o.chargers, state.length) }, (_, i) => i)
  const active: typeof state = []
  let gridKwh = 0

  for (let slot = 0; slot < SLOTS; slot++) {
    for (let i = active.length - 1; i >= 0; i--) {
      const a = active[i]
      if (a.left <= 1e-6 || a.r.depart <= slot) {
        a.on!.endSlot = slot
        free.push(a.on!.charger)
        a.on = null
        active.splice(i, 1)
      }
    }
    if (slot >= o.startSlot && free.length) {
      const waiting = state.filter((a) => !a.on && a.left > 1e-6 && a.r.arrive <= slot && a.r.depart > slot)
      if (waiting.length) {
        if (waiting.length > 1) waiting.sort((x, y) => slack(x, slot) - slack(y, slot))
        free.sort((x, y) => x - y)
        let used = active.reduce((sum, a) => sum + a.r.kw, 0)
        for (const a of waiting) {
          if (!free.length) break
          if (o.capKw > 0 && used + a.r.kw > o.capKw) continue
          const charger = free.shift()!
          a.on = { vehicle: a.r.vehicle, charger, startSlot: slot, endSlot: slot, kwh: 0 }
          sessions.push(a.on)
          active.push(a)
          used += a.r.kw
        }
      }
    }
    for (const a of active) {
      const packKwh = Math.min(a.left, a.r.kw * SLOT_H * a.r.eff)
      a.left -= packKwh
      const grid = packKwh / a.r.eff
      load[slot] += grid / SLOT_H
      gridKwh += grid
      a.on!.kwh += grid
      delivered.set(a.r.vehicle, (delivered.get(a.r.vehicle) ?? 0) + packKwh)
    }
  }
  for (const a of active) a.on!.endSlot = SLOTS

  let unmetKwh = 0
  for (const a of state) unmetKwh += a.left
  // A swap is any session that starts on a charger someone else used earlier that night.
  const seen = new Set<number>()
  let swaps = 0
  for (const s of sessions) {
    if (seen.has(s.charger)) swaps++
    seen.add(s.charger)
  }
  return { plan: { day, sessions, load, gridKwh, swaps, unmetKwh }, delivered }

  function slack(a: { r: ChargeRequest; left: number }, slotNow: number) {
    return (a.r.depart - slotNow) * SLOT_H - a.left / (a.r.kw * a.r.eff)
  }
}
