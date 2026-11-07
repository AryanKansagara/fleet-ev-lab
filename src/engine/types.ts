export type VClass = 'van' | 'pickup' | 'car'
export type LatLng = [number, number]

/** All times in the engine are "fleet-local" milliseconds: wall-clock time stored as if it were UTC. */
export interface GpsPoint {
  vehicle: string
  t: number
  lat: number
  lng: number
  speedKph?: number
  odoKm?: number
  loadKg?: number
}

export interface Trip {
  vehicle: string
  start: number
  end: number
  km: number
  idleH: number
  /** km driven in each speed band: under 30, 30-60, 60-90, over 90 km/h */
  speedKm: [number, number, number, number]
  loadKg?: number
  path?: LatLng[]
  from?: LatLng
  to?: LatLng
  /** Observed temperature for this trip, once weather or a climate profile has been applied. */
  tempC?: number
  endsAtDepot?: boolean
}

export interface Depot {
  id: string
  lat: number
  lng: number
  inferred: boolean
}

export interface Vehicle {
  id: string
  cls: VClass
  /** Default load for trips with no load reading. */
  loadKg: number
  depot: string
  /** Share of operating days that end at the depot, null when the data has no coordinates. */
  rtbPct: number | null
}

export interface Fleet {
  name: string
  synthetic: boolean
  description?: string
  vehicles: Vehicle[]
  trips: Trip[]
  depots: Depot[]
  /** Import diagnostics. */
  stats?: { points: number; droppedJumps: number; droppedInvalid: number }
}

export interface EvModel {
  id: string
  name: string
  cls: VClass
  usableKwh: number
  ratedKm: number
  payloadKg: number
  acKw: number
  dcKw: number
  priceAmount: number
  priceCurrency: 'USD' | 'CAD'
  status: 'on-sale' | 'ended' | 'limited'
  statusNote: string
  sources: string[]
  /** Which figures could not be confirmed from a source and are estimates. */
  estimated?: string
  custom?: boolean
}

export interface CurvePoint {
  t: number
  r: number
}

export interface Settings {
  curve: CurvePoint[]
  energy: {
    speedMult: [number, number, number, number]
    refKph: number
    hvacKwAtMin: number
    hvacOffC: number
    hvacMinC: number
    coolKw: number
    payloadPctPer1000kg: number
    batteryHealthPct: number
  }
  charging: {
    chargerKw: number
    /** 0 means size automatically. */
    chargers: number
    startHour: number
    siteCapKw: number
    targetPct: number
    bufferPct: number
    effPct: number
    coldEffLossPct: number
    middayOn: boolean
    middayKw: number
    middayMinDwell: number
    middayPublic: boolean
  }
  fit: {
    minCompletionPct: number
    includeEnded: boolean
  }
  tco: {
    years: number
    currency: string
    fxUsd: number
    fuelPrice: number
    electricity: number
    demandChargeKwMonth: number
    maintEvKm: number
    maintIceKm: number
    discountPct: number
    evDepreciationPct: number
    iceDepreciationPct: number
    icePrice: Record<VClass, number>
    fuelLPer100: Record<VClass, number>
    idleLPerH: number
    incentive: Record<VClass, number>
    chargerCapexAc: number
    chargerCapexDc: number
    fuelKgCo2PerL: number
    gridGPerKwh: number
  }
  modelEdits: Record<string, Partial<EvModel>>
  customModels: EvModel[]
  climate: { name: string; monthly: number[] }
}

export type Reason = 'payload' | 'range' | 'cold' | 'charging' | 'no-depot'

export const REASON_LABEL: Record<Reason, string> = {
  payload: 'Load exceeds payload',
  range: 'Beyond range, any weather',
  cold: 'Cold-weather range',
  charging: 'Not enough overnight charge',
  'no-depot': 'Away from depot overnight',
}

export interface DayResult {
  day: number
  failed: boolean
  reason?: Reason
  km: number
  kwh: number
  tempC: number
  startPct: number
  endPct: number
  minPct: number
  shortfallKwh: number
  /** Battery percent at the start and end of each trip that day. */
  tripSoc: [number, number][]
}

export interface Session {
  vehicle: string
  charger: number
  startSlot: number
  endSlot: number
  kwh: number
}

export interface NightPlan {
  day: number
  sessions: Session[]
  /** Grid kW in each 15-minute slot, starting at noon. */
  load: number[]
  gridKwh: number
  swaps: number
  unmetKwh: number
}

export interface DepotResult {
  id: string
  lat: number
  lng: number
  vehicles: string[]
  chargers: number
  autoSized: boolean
  peakKw: number
  unmanagedPeakKw: number
  nights: NightPlan[]
  worstNight: number
}

export interface TcoResult {
  years: number
  evSeries: number[]
  iceSeries: number[]
  /** Interpolated year where the EV becomes cheaper, null if it never does in the horizon. */
  crossoverYear: number | null
  savings: number
  annualKm: number
  annualKwh: number
  annualEnergyCost: number
  annualFuelCost: number
  annualCo2Tonnes: number
  upfrontEv: number
  upfrontIce: number
}

export type Verdict = 'ready' | 'close' | 'change' | 'hold'

export interface Candidate {
  modelId: string
  pct: number
  savings: number
}

export interface VehicleResult {
  id: string
  cls: VClass
  depot: string
  model: EvModel | null
  pct: number
  opDays: number
  failDays: number
  reasons: Partial<Record<Reason, number>>
  days: DayResult[]
  avgKm: number
  maxKm: number
  rtbPct: number | null
  verdict: Verdict
  tco: TcoResult | null
  candidates: Candidate[]
  middayPct: number | null
}

export interface FleetResult {
  vehicles: VehicleResult[]
  depots: DepotResult[]
  firstDay: number
  lastDay: number
  pct: number
  opDays: number
  failDays: number
  readyCount: number
  chargers: number
  peakKw: number
  savings: number
  co2Tonnes: number
  ms: number
}

export interface Phase {
  name: string
  blurb: string
  vehicles: VehicleResult[]
  chargers: number
  peakKw: number
  capex: number
  savings: number
  co2Tonnes: number
}
