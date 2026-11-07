import { DAY_MS } from './segment.ts'
import type { Fleet, FleetResult, Settings } from './types.ts'
import { REASON_LABEL } from './types.ts'

/** Quotes a CSV cell, and neutralises leading formula characters so a spreadsheet will not run an imported vehicle name. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  let s = String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10)

export function resultsCsv(f: Fleet, r: FleetResult, s: Settings): string {
  const rows: (string | number | null)[][] = [[
    'vehicle', 'class', 'depot', 'best_fit_model', 'days_completed_pct', 'operating_days', 'failure_days', 'failure_reasons', 'avg_day_km', 'max_day_km', 'return_to_base_pct',
    'depot_chargers', 'depot_peak_kw', `tco_saving_${s.tco.years}y`, 'crossover_year', 'annual_km', 'annual_kwh', 'annual_co2_tonnes_avoided', 'verdict', 'data_is_synthetic',
  ]]
  for (const v of r.vehicles) {
    const d = r.depots.find((x) => x.id === v.depot)
    rows.push([
      v.id, v.cls, v.depot, v.model?.name ?? '', +v.pct.toFixed(1), v.opDays, v.failDays,
      Object.entries(v.reasons).map(([k, n]) => `${REASON_LABEL[k as keyof typeof REASON_LABEL]}: ${n}`).join('; '),
      +v.avgKm.toFixed(1), +v.maxKm.toFixed(1), v.rtbPct === null ? '' : +v.rtbPct.toFixed(0),
      d?.chargers ?? '', d ? +d.peakKw.toFixed(1) : '', v.tco ? Math.round(v.tco.savings) : '',
      v.tco?.crossoverYear === null || v.tco === null ? '' : +v.tco.crossoverYear.toFixed(1),
      v.tco ? Math.round(v.tco.annualKm) : '', v.tco ? Math.round(v.tco.annualKwh) : '', v.tco ? +v.tco.annualCo2Tonnes.toFixed(2) : '', v.verdict, f.synthetic ? 'yes' : 'no',
    ])
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\n')
}

export function failuresCsv(r: FleetResult): string {
  const rows: (string | number)[][] = [['vehicle', 'date', 'reason', 'km', 'kwh', 'temp_c', 'start_soc_pct', 'shortfall_kwh']]
  for (const v of r.vehicles) {
    for (const d of v.days) {
      if (d.failed) rows.push([v.id, dateOf(d.day), d.reason ? REASON_LABEL[d.reason] : '', +d.km.toFixed(1), +d.kwh.toFixed(1), +d.tempC.toFixed(1), +d.startPct.toFixed(0), +d.shortfallKwh.toFixed(1)])
    }
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\n')
}
