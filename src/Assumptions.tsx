import { useState } from 'react'
import { CurveChart } from './Charts.tsx'
import { CATALOGUE, CATALOGUE_AS_OF } from './engine/catalogue.ts'
import { allModels, CLIMATES, defaultCurve, defaultSettings, priceLocal } from './engine/settings.ts'
import type { EvModel, Settings, VClass } from './engine/types.ts'
import { NumField } from './ui.tsx'

const STATUS: Record<EvModel['status'], string> = { 'on-sale': 'On sale', limited: 'Limited', ended: 'Production ended' }
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')

export default function Assumptions({ settings: s, onChange, marker }: { settings: Settings; onChange: (s: Settings) => void; marker?: number }) {
  const [draft, setDraft] = useState<EvModel | null>(null)
  const e = s.energy
  const setE = (p: Partial<Settings['energy']>) => onChange({ ...s, energy: { ...e, ...p } })
  const edit = (m: EvModel, p: Partial<EvModel>) => {
    if (m.custom) onChange({ ...s, customModels: s.customModels.map((x) => (x.id === m.id ? { ...x, ...p } : x)) })
    else onChange({ ...s, modelEdits: { ...s.modelEdits, [m.id]: { ...s.modelEdits[m.id], ...p } } })
  }
  const blank = (): EvModel => ({ id: `custom-${Date.now()}`, name: 'My EV', cls: 'van', usableKwh: 100, ratedKm: 300, payloadKg: 1200, acKw: 11, dcKw: 150, priceAmount: 75000, priceCurrency: 'CAD', status: 'on-sale', statusNote: 'Added by you.', sources: [], custom: true })

  return (
    <div className="stack">
      <section className="card chart-card">
        <div className="card-head">
          <div>
            <h3>Range curve: independent fit, not Geotab's curve</h3>
            <p className="muted small">Fitted through the two figures Geotab published (diamonds). Everything else is an assumption. Drag a knot, or focus one and use the arrow keys. The whole fleet reflows.</p>
          </div>
          <button className="btn btn-outline" onClick={() => onChange({ ...s, curve: defaultCurve() })}>Reset curve</button>
        </div>
        <CurveChart curve={s.curve} onChange={(curve) => onChange({ ...s, curve })} marker={marker} height={320} />
      </section>

      <section className="card">
        <h3>Energy model</h3>
        <p className="muted small">The curve comes from real driving and already contains normal HVAC. So climate power is only added for hours beyond a reference speed, and for idling.</p>
        <div className="fields">
          <NumField label="Under 30 km/h" unit="x" step={0.01} value={e.speedMult[0]} min={0.3} max={3} onChange={(v) => setE({ speedMult: [v, e.speedMult[1], e.speedMult[2], e.speedMult[3]] })} />
          <NumField label="30 to 60 km/h" unit="x" step={0.01} value={e.speedMult[1]} min={0.3} max={3} onChange={(v) => setE({ speedMult: [e.speedMult[0], v, e.speedMult[2], e.speedMult[3]] })} />
          <NumField label="60 to 90 km/h" unit="x" step={0.01} value={e.speedMult[2]} min={0.3} max={3} onChange={(v) => setE({ speedMult: [e.speedMult[0], e.speedMult[1], v, e.speedMult[3]] })} />
          <NumField label="Over 90 km/h" unit="x" step={0.01} value={e.speedMult[3]} min={0.3} max={3} onChange={(v) => setE({ speedMult: [e.speedMult[0], e.speedMult[1], e.speedMult[2], v] })} />
          <NumField label="HVAC at the coldest" unit="kW" step={0.5} value={e.hvacKwAtMin} min={0} max={30} onChange={(v) => setE({ hvacKwAtMin: v })} />
          <NumField label="HVAC off above" unit="°C" value={e.hvacOffC} min={0} max={25} onChange={(v) => setE({ hvacOffC: v })} />
          <NumField label="Reference speed" unit="km/h" value={e.refKph} min={10} max={120} onChange={(v) => setE({ refKph: v })} />
          <NumField label="Payload penalty" unit="% per 1000 kg" value={e.payloadPctPer1000kg} min={0} max={60} onChange={(v) => setE({ payloadPctPer1000kg: v })} />
          <NumField label="Battery health" unit="%" value={e.batteryHealthPct} min={40} max={100} onChange={(v) => setE({ batteryHealthPct: v })} hint="Geotab reports 2.3% a year on average" />
          <NumField label="Minimum days to pass" unit="%" value={s.fit.minCompletionPct} min={50} max={100} onChange={(v) => onChange({ ...s, fit: { ...s.fit, minCompletionPct: v } })} />
        </div>
      </section>

      <section className="card">
        <h3>Climate profile</h3>
        <p className="muted small">Used for annual energy costs, and for any trip with no archive temperature. Approximate 1991 to 2020 monthly means, rounded. Edit for your site.</p>
        <label className="field narrow"><span>Start from</span>
          <select value={CLIMATES.some((c) => c.name === s.climate.name) ? s.climate.name : ''} onChange={(ev) => { const c = CLIMATES.find((x) => x.name === ev.target.value); if (c) onChange({ ...s, climate: { name: c.name, monthly: c.monthly } }) }}>
            <option value="" disabled>Custom</option>
            {CLIMATES.map((c) => <option key={c.name}>{c.name}</option>)}
          </select>
        </label>
        <div className="fields months">
          {s.climate.monthly.map((v, i) => (
            <NumField key={MONTHS[i]} label={MONTHS[i]} unit="°C" step={0.5} value={v} onChange={(n) => onChange({ ...s, climate: { name: 'Custom', monthly: s.climate.monthly.map((x, k) => (k === i ? n : x)) } })} />
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h3>EV catalogue, specs checked {CATALOGUE_AS_OF}</h3>
            <p className="muted small">Availability changes quickly, and several figures could not be confirmed from a source: those are flagged per model. Check your dealer quote and door label, then edit here.</p>
          </div>
          <div className="row">
            <label className="check"><input type="checkbox" checked={s.fit.includeEnded} onChange={(ev) => onChange({ ...s, fit: { ...s.fit, includeEnded: ev.target.checked } })} /> Include ended-production models</label>
            <button className="btn btn-outline" onClick={() => setDraft(blank())}>Add a model</button>
          </div>
        </div>
        {draft ? (
          <div className="draft">
            <div className="fields">
              <label className="field"><span>Name</span><input value={draft.name} onChange={(ev) => setDraft({ ...draft, name: ev.target.value })} /></label>
              <label className="field"><span>Class</span><select value={draft.cls} onChange={(ev) => setDraft({ ...draft, cls: ev.target.value as VClass })}><option value="van">Van</option><option value="pickup">Pickup</option><option value="car">Car</option></select></label>
              <NumField label="Usable battery" unit="kWh" value={draft.usableKwh} min={10} onChange={(v) => setDraft({ ...draft, usableKwh: v })} />
              <NumField label="Rated range" unit="km" value={draft.ratedKm} min={20} onChange={(v) => setDraft({ ...draft, ratedKm: v })} />
              <NumField label="Payload" unit="kg" value={draft.payloadKg} min={0} onChange={(v) => setDraft({ ...draft, payloadKg: v })} />
              <NumField label="Price" unit="C$" value={draft.priceAmount} min={0} onChange={(v) => setDraft({ ...draft, priceAmount: v })} />
            </div>
            <div className="row">
              <button className="btn btn-primary" onClick={() => { onChange({ ...s, customModels: [...s.customModels, draft] }); setDraft(null) }}>Add to catalogue</button>
              <button className="btn btn-text" onClick={() => setDraft(null)}>Cancel</button>
            </div>
          </div>
        ) : null}
        <div className="table-scroll">
          <table className="table">
            <thead><tr><th>Model</th><th>Class</th><th>kWh</th><th>Rated km</th><th>Payload kg</th><th>AC kW</th><th>Price</th><th>In {s.tco.currency}</th><th>Status and sources</th></tr></thead>
            <tbody>
              {allModels(s).map((m) => (
                <tr key={m.id} className={m.status === 'ended' ? 'row-muted' : ''}>
                  <th scope="row">{m.name}</th>
                  <td>{m.cls}</td>
                  <td><input aria-label={`${m.name} kWh`} className="cell-input" type="number" value={m.usableKwh} onChange={(ev) => ev.target.valueAsNumber > 0 && edit(m, { usableKwh: ev.target.valueAsNumber })} /></td>
                  <td><input aria-label={`${m.name} rated km`} className="cell-input" type="number" value={m.ratedKm} onChange={(ev) => ev.target.valueAsNumber > 0 && edit(m, { ratedKm: ev.target.valueAsNumber })} /></td>
                  <td><input aria-label={`${m.name} payload`} className="cell-input" type="number" value={m.payloadKg} onChange={(ev) => ev.target.valueAsNumber > 0 && edit(m, { payloadKg: ev.target.valueAsNumber })} /></td>
                  <td><input aria-label={`${m.name} AC kW`} className="cell-input" type="number" value={m.acKw} onChange={(ev) => ev.target.valueAsNumber > 0 && edit(m, { acKw: ev.target.valueAsNumber })} /></td>
                  <td className="nowrap"><input aria-label={`${m.name} price`} className="cell-input wide" type="number" value={m.priceAmount} onChange={(ev) => ev.target.valueAsNumber > 0 && edit(m, { priceAmount: ev.target.valueAsNumber })} /> {m.priceCurrency}</td>
                  <td>{Math.round(priceLocal(m, s)).toLocaleString('en-CA')}</td>
                  <td className="status-cell">
                    <strong>{STATUS[m.status]}.</strong> {m.statusNote} {m.estimated ? <em>Unconfirmed: {m.estimated}</em> : null}{' '}
                    {m.sources.map((u, i) => <a key={u} href={u} rel="noreferrer">[{i + 1}]</a>)}
                    {m.custom ? <button className="btn btn-text" onClick={() => onChange({ ...s, customModels: s.customModels.filter((x) => x.id !== m.id) })}>Remove</button> : null}
                    {s.modelEdits[m.id] ? <button className="btn btn-text" onClick={() => { const { [m.id]: _, ...rest } = s.modelEdits; onChange({ ...s, modelEdits: rest }) }}>Reset to catalogue</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">{CATALOGUE.length} catalogue models. USD prices convert at {s.tco.fxUsd} (edit on the Costs tab). Prices are starting prices for comparison, not quotes.</p>
      </section>

      <button className="btn btn-text" onClick={() => { if (confirm('Reset every assumption to its default?')) onChange(defaultSettings()) }}>Reset all assumptions</button>
    </div>
  )
}
