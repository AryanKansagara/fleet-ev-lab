import { Fragment, lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import Assumptions from './Assumptions.tsx'
import { ChargingGantt, SuitabilityGrid, TcoChart } from './Charts.tsx'
import { dateOf, failuresCsv, resultsCsv } from './engine/export.ts'
import { CATALOGUE_AS_OF, INCENTIVE_NOTES } from './engine/catalogue.ts'
import { loadSample, samplePointsCsv, SAMPLES, type SampleId } from './engine/samples.ts'
import { allModels, CLIMATES, candidateModels, defaultSettings, nearestClimate } from './engine/settings.ts'
import { decodeSettings, encodeSettings, mergeSettings } from './engine/share.ts'
import { analyzeFleet, invalidateFleet, middayUplift, planRollout, type TempMode } from './engine/sim.ts'
import { REASON_LABEL, type Fleet, type Reason, type Settings, type VClass, type VehicleResult } from './engine/types.ts'
import { applyWeather, climateStressWeek, fetchColdestWeek, type StressWeek } from './engine/weather.ts'
import Import from './Import.tsx'
import { downloadText, Footer, fmtDate, fmtT, Header, money, NumField, socColor, SyntheticTag, VerdictChip } from './ui.tsx'

const FleetMap = lazy(() => import('./FleetMap.tsx'))

const TABS = ['Overview', 'Vehicles', 'Charging', 'Costs', 'Rollout', 'Assumptions', 'Your data'] as const
type Tab = (typeof TABS)[number]
const SETTINGS_KEY = 'fel-settings-v1'
const FLEET_KEY = 'fel-fleet-v1'

function loadStoredSettings(): Settings {
  try {
    return mergeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'))
  } catch {
    return defaultSettings()
  }
}
function loadStoredFleet(): Fleet | null {
  try {
    const raw = localStorage.getItem(FLEET_KEY)
    return raw ? (JSON.parse(raw) as Fleet) : null
  } catch {
    return null
  }
}

/** Saved locally only. If the fleet is too big for localStorage, drop the map lines and keep the trips. */
function saveFleet(f: Fleet | null): 'saved' | 'no-paths' | 'too-big' | 'none' {
  if (!f) {
    localStorage.removeItem(FLEET_KEY)
    return 'none'
  }
  try {
    localStorage.setItem(FLEET_KEY, JSON.stringify(f))
    return 'saved'
  } catch {
    try {
      localStorage.setItem(FLEET_KEY, JSON.stringify({ ...f, trips: f.trips.map(({ path: _, ...t }) => t) }))
      return 'no-paths'
    } catch {
      localStorage.removeItem(FLEET_KEY)
      return 'too-big'
    }
  }
}

function worstDay(vehicles: VehicleResult[], first: number): number {
  const fails = new Map<number, number>()
  for (const v of vehicles) for (const d of v.days) fails.set(d.day, (fails.get(d.day) ?? 0) + (d.failed ? 100 : 0) + 1)
  let best = first
  let top = -1
  for (const [d, n] of fails) if (n > top) { top = n; best = d }
  return best
}

export default function Tool() {
  const [settings, setSettings] = useState<Settings>(loadStoredSettings)
  const [sample, setSample] = useState<SampleId | 'own'>(() => (localStorage.getItem(FLEET_KEY) ? 'own' : 'toronto'))
  const [ownFleet, setOwnFleet] = useState<Fleet | null>(loadStoredFleet)
  const [baseFleet, setBaseFleet] = useState<Fleet | null>(null)
  const [fleet, setFleet] = useState<Fleet | null>(null)
  const [weather, setWeather] = useState<{ state: 'loading' | 'archive' | 'climate'; matched?: number; total?: number }>({ state: 'loading' })
  const [temp, setTemp] = useState<TempMode>({ mode: 'observed' })
  const [stress, setStress] = useState<StressWeek | null>(null)
  const [tab, setTab] = useState<Tab>('Overview')
  const [day, setDay] = useState<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [assignment, setAssignment] = useState<Record<string, string>>({})
  const [toast, setToast] = useState('')
  const [storeNote, setStoreNote] = useState('')
  const [playing, setPlaying] = useState(true)
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({})

  useEffect(() => {
    const m = location.hash.match(/^#s=(.+)$/)
    if (m) decodeSettings(m[1]).then((s) => { if (s) setSettings(s) })
  }, [])

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    let cancelled = false
    setBaseFleet(null)
    if (sample === 'own') {
      setBaseFleet(ownFleet)
      return
    }
    loadSample(sample).then((f) => { if (!cancelled) setBaseFleet(f) })
    return () => { cancelled = true }
  }, [sample, ownFleet])

  // Weather upgrades the fleet in the background. The climate profile keeps the app working until then, and offline.
  useEffect(() => {
    if (!baseFleet) return
    setFleet(baseFleet)
    setDay(null)
    setSelected(null)
    setAssignment({})
    setStress(null)
    setTemp({ mode: 'observed' })
    const d = baseFleet.depots.find((x) => x.lat || x.lng)
    if (d) {
      const c = nearestClimate(d.lat, d.lng)
      setSettings((s) => (CLIMATES.some((x) => x.name === s.climate.name) ? { ...s, climate: { name: c.name, monthly: c.monthly } } : s))
    }
    setWeather({ state: 'loading' })
    const ac = new AbortController()
    applyWeather(baseFleet, ac.signal).then(
      (w) => {
        if (ac.signal.aborted) return
        setWeather(w.matched ? { state: 'archive', matched: w.matched, total: w.total } : { state: 'climate' })
        if (w.matched) setFleet(w.fleet)
      },
      () => { if (!ac.signal.aborted) setWeather({ state: 'climate' }) },
    )
    return () => ac.abort()
  }, [baseFleet])

  const deferredTemp = useDeferredValue(temp)
  const result = useMemo(() => (fleet ? analyzeFleet(fleet, settings, deferredTemp, assignment) : null), [fleet, settings, deferredTemp, assignment])
  const shownDay = result ? (day !== null && day >= result.firstDay && day <= result.lastDay ? day : worstDay(result.vehicles, result.firstDay)) : 0

  const flash = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 2600)
  }, [])

  const runStress = async () => {
    const d = fleet?.depots.find((x) => x.lat || x.lng)
    let w = climateStressWeek(settings)
    // Stress week uses the first depot's location. Per-depot weeks if a fleet spans climate zones.
    if (d) {
      try {
        w = await fetchColdestWeek(d.lat, d.lng)
      } catch {
        flash('Weather archive unavailable, so this uses the climate profile')
      }
    }
    setStress(w)
    setTemp({ mode: 'stress', week: w.temps })
  }

  const copyShare = async () => {
    const hash = await encodeSettings(settings)
    const url = `${location.origin}/app#s=${hash}`
    history.replaceState(null, '', `/app#s=${hash}`)
    try {
      await navigator.clipboard.writeText(url)
      flash('Settings link copied. It contains no GPS data.')
    } catch {
      flash('The address bar now holds the settings link. It contains no GPS data.')
    }
  }

  const onImported = (f: Fleet) => {
    const saved = saveFleet(f)
    setStoreNote(saved === 'no-paths' ? 'Too large to keep map lines between visits, so only trips were saved in this browser.' : saved === 'too-big' ? 'Too large to keep between visits. It works until you close this tab.' : '')
    setOwnFleet(f)
    setSample('own')
    setTab('Overview')
    scrollTo({ top: 0, behavior: 'smooth' })
  }

  const clearOwn = () => {
    saveFleet(null)
    setOwnFleet(null)
    setStoreNote('')
    setSample('toronto')
    flash('Your fleet was removed from this browser')
  }

  const setVehicle = (id: string, p: { cls?: VClass; loadKg?: number }) => {
    if (!fleet || !baseFleet) return
    const patch = (f: Fleet): Fleet => ({ ...f, vehicles: f.vehicles.map((v) => (v.id === id ? { ...v, ...p } : v)) })
    invalidateFleet(fleet)
    invalidateFleet(baseFleet)
    setFleet(patch(fleet))
    if (sample === 'own' && ownFleet) saveFleet(patch(ownFleet))
    if (p.cls) setAssignment(({ [id]: _, ...rest }) => rest)
  }

  const onTabKey = (e: KeyboardEvent, t: Tab) => {
    const i = TABS.indexOf(t)
    const next = e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(i - 1 + TABS.length) % TABS.length] : e.key === 'Home' ? TABS[0] : e.key === 'End' ? TABS[TABS.length - 1] : null
    if (next) {
      e.preventDefault()
      setTab(next)
      tabRefs.current[next]?.focus()
    }
  }

  const reasons = useMemo(() => {
    const total: Partial<Record<Reason, number>> = {}
    for (const v of result?.vehicles ?? []) for (const [k, n] of Object.entries(v.reasons)) total[k as Reason] = (total[k as Reason] ?? 0) + (n ?? 0)
    return Object.entries(total).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)) as [Reason, number][]
  }, [result])

  const tempLabel = temp.mode === 'fixed' ? `at ${fmtT(temp.c)}` : temp.mode === 'stress' ? `in the coldest week (mean ${fmtT(stress?.mean ?? 0)})` : weather.state === 'archive' ? 'in observed weather' : 'in the climate profile'
  const cur = settings.tco.currency
  const unmanaged = result?.depots.reduce((n, d) => n + d.unmanagedPeakKw, 0) ?? 0

  return (
    <div className="tool">
      <div className="no-print"><Header /></div>
      <div className="control-bar no-print">
        <div className="wrap control-in">
          <label className="field compact fleet-pick">
            <span>Fleet</span>
            <select value={sample} onChange={(e) => setSample(e.target.value as SampleId | 'own')}>
              {ownFleet ? <option value="own">Your data: {ownFleet.name}</option> : null}
              {SAMPLES.map((x) => <option key={x.id} value={x.id}>Synthetic: {x.name}</option>)}
            </select>
          </label>
          <div className="temp-control">
            <label htmlFor="temp-slider">
              <span>Temperature</span>
              <output style={{ color: temp.mode === 'fixed' ? socColor(((temp.c + 25) / 46) * 100) : undefined }}>{temp.mode === 'fixed' ? fmtT(temp.c) : temp.mode === 'stress' ? 'Coldest week' : 'Observed'}</output>
            </label>
            <input
              id="temp-slider"
              className="temp-range"
              type="range"
              min={-35}
              max={40}
              value={temp.mode === 'fixed' ? temp.c : 21}
              aria-valuetext={temp.mode === 'fixed' ? fmtT(temp.c) : 'Using observed weather'}
              onChange={(e) => setTemp({ mode: 'fixed', c: +e.target.value })}
            />
          </div>
          <div className="seg">
            <button className={temp.mode === 'observed' ? 'on' : ''} aria-pressed={temp.mode === 'observed'} onClick={() => setTemp({ mode: 'observed' })}>Observed</button>
            <button className={temp.mode === 'stress' ? 'on' : ''} aria-pressed={temp.mode === 'stress'} onClick={runStress}>Winter stress test</button>
          </div>
          <details className="menu">
            <summary className="btn btn-outline">Export</summary>
            <div className="menu-pop" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).open = false}>
              <button disabled={!result} onClick={() => fleet && result && downloadText('fleet-ev-results.csv', resultsCsv(fleet, result, settings))}>Results CSV</button>
              <button disabled={!result} onClick={() => result && downloadText('fleet-ev-failure-days.csv', failuresCsv(result))}>Failure days CSV</button>
              <button onClick={() => print()}>Print report</button>
              <button onClick={copyShare}>Copy settings link</button>
            </div>
          </details>
        </div>
      </div>

      <main className="wrap tool-main">
        {!fleet || !result ? (
          <div className="loading-panel" role="status"><div className="pulse" />Building the fleet and running the first simulation</div>
        ) : (
          <>
            <div className="status-line no-print">
              {fleet.synthetic ? <SyntheticTag /> : <span className="synthetic own">Your data, in this browser only</span>}
              <span>{fleet.vehicles.length} vehicles · {fleet.trips.length.toLocaleString('en-CA')} trips · {fmtDate(result.firstDay)} to {fmtDate(result.lastDay)}</span>
              <span>
                {weather.state === 'loading' ? 'Fetching historical temperatures' : weather.state === 'archive' ? `Open-Meteo temperatures on ${weather.matched?.toLocaleString('en-CA')} of ${weather.total?.toLocaleString('en-CA')} trips` : `Weather archive unavailable: using the ${settings.climate.name} climate profile`}
                {temp.mode === 'stress' && stress ? ` · Stress week: ${stress.source === 'archive' ? `from ${stress.start}, the coldest in five years` : 'estimated from the climate profile'}` : ''}
              </span>
              <span className="engine-time">Engine {result.ms.toFixed(0)} ms</span>
            </div>

            <section className="kpis" aria-label={`Fleet results ${tempLabel}`}>
              <div className="kpi kpi-main"><span>Days completed {tempLabel}</span><b style={{ color: socColor(result.pct * 0.6) }}>{result.pct.toFixed(1)}%</b><small>{result.failDays.toLocaleString('en-CA')} of {result.opDays.toLocaleString('en-CA')} fail</small></div>
              <div className="kpi"><span>Ready to switch</span><b>{result.readyCount}<em>/{result.vehicles.length}</em></b><small>{settings.fit.minCompletionPct}%+ of days, and saves money</small></div>
              <div className="kpi"><span>Depot chargers</span><b>{result.chargers}</b><small>{settings.charging.chargerKw} kW, {settings.charging.chargers ? 'set by you' : 'fewest that work'}</small></div>
              <div className="kpi"><span>Peak depot load</span><b>{result.peakKw.toFixed(0)}<em> kW</em></b><small>vs {unmanaged.toFixed(0)} kW if all plug in on arrival</small></div>
              <div className="kpi"><span>{settings.tco.years}-year saving</span><b>{money(result.savings, cur)}</b><small>Excludes vehicles on hold</small></div>
              <div className="kpi"><span>CO2 avoided a year</span><b>{result.co2Tonnes.toFixed(0)}<em> t</em></b><small>{settings.tco.gridGPerKwh} g/kWh grid</small></div>
            </section>

            <div className="tabs no-print" role="tablist" aria-label="Sections">
              {TABS.map((t) => (
                <button key={t} ref={(el) => { tabRefs.current[t] = el }} role="tab" id={`tab-${t}`} aria-selected={tab === t} aria-controls="panel" tabIndex={tab === t ? 0 : -1} className={tab === t ? 'on' : ''} onClick={() => setTab(t)} onKeyDown={(e) => onTabKey(e, t)}>{t}</button>
              ))}
            </div>

            <div id="panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="panel no-print" key={tab}>
              {tab === 'Overview' ? (
                <Overview fleet={fleet} result={result} day={shownDay} setDay={setDay} selected={selected} setSelected={setSelected} reasons={reasons} playing={playing} setPlaying={setPlaying} />
              ) : tab === 'Vehicles' ? (
                <Vehicles fleet={fleet} settings={settings} temp={deferredTemp} result={result} assignment={assignment} setAssignment={setAssignment} setVehicle={setVehicle} selected={selected} setSelected={setSelected} />
              ) : tab === 'Charging' ? (
                <Charging result={result} settings={settings} onChange={setSettings} />
              ) : tab === 'Costs' ? (
                <Costs result={result} settings={settings} onChange={setSettings} />
              ) : tab === 'Rollout' ? (
                <Rollout fleet={fleet} settings={settings} temp={deferredTemp} result={result} />
              ) : tab === 'Assumptions' ? (
                <Assumptions settings={settings} onChange={setSettings} marker={temp.mode === 'fixed' ? temp.c : undefined} />
              ) : (
                <div className="stack">
                  <Import onFleet={onImported} />
                  {storeNote ? <p className="note">{storeNote}</p> : null}
                  <section className="card">
                    <h3>Your GPS data stays in this browser</h3>
                    <p>There is no server. Files are parsed here and saved only in this browser's local storage. Share links carry settings only, never trips. Two things use the network: Open-Meteo receives each depot location rounded to about 10 km plus a date range, and the map tile host sees the area you are viewing.</p>
                    {fleet.stats ? <p className="muted small">Last import: {fleet.stats.points.toLocaleString('en-CA')} points. Dropped {fleet.stats.droppedJumps} GPS jumps and {fleet.stats.droppedInvalid} invalid coordinates.</p> : null}
                    <div className="row">
                      {ownFleet ? <button className="btn btn-outline" onClick={clearOwn}>Remove my fleet from this browser</button> : null}
                      {fleet.synthetic ? <button className="btn btn-outline" onClick={() => downloadText(`synthetic-${sample}-gps-7-days.csv`, samplePointsCsv(fleet, 7))}>Download this synthetic fleet as GPS CSV</button> : null}
                    </div>
                  </section>
                  <section className="card">
                    <h3>Synthetic samples</h3>
                    <p className="muted small">Made-up trips on real road geometry. No real vehicle, driver or customer is represented.</p>
                    <div className="sample-list">
                      {SAMPLES.map((x) => (
                        <button key={x.id} className={`sample ${sample === x.id ? 'on' : ''}`} onClick={() => { setSample(x.id); setTab('Overview') }}>
                          <strong>{x.name}</strong>
                          <span>{x.blurb}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
              )}
            </div>

            <Report fleet={fleet} settings={settings} temp={deferredTemp} result={result} tempLabel={tempLabel} reasons={reasons} />
          </>
        )}
      </main>
      {toast ? <div className="toast" role="status">{toast}</div> : null}
      <div className="no-print"><Footer /></div>
    </div>
  )
}

/* ---------- Overview ---------- */

function Overview({ fleet, result, day, setDay, selected, setSelected, reasons, playing, setPlaying }: {
  fleet: Fleet; result: ReturnType<typeof analyzeFleet>; day: number; setDay: (d: number) => void; selected: string | null; setSelected: (s: string | null) => void; reasons: [Reason, number][]; playing: boolean; setPlaying: (b: boolean) => void
}) {
  const operating = useMemo(() => {
    const s = new Set<number>()
    for (const v of result.vehicles) for (const d of v.days) s.add(d.day)
    return [...s].sort((a, b) => a - b)
  }, [result])
  const at = operating.indexOf(day)
  const sorted = useMemo(() => [...result.vehicles].sort((a, b) => a.pct - b.pct), [result])
  const maxReason = reasons[0]?.[1] ?? 1
  return (
    <div className="stack">
      <div className="overview-top">
        <section className="card map-card">
          <div className="map-bar">
            <h3>{fmtDate(day)}</h3>
            <div className="row">
              <button className="btn btn-outline btn-sm" aria-label="Previous operating day" disabled={at <= 0} onClick={() => setDay(operating[at - 1])}>Prev</button>
              <input className="day-range" type="range" min={0} max={Math.max(0, operating.length - 1)} value={Math.max(at, 0)} aria-label="Operating day" aria-valuetext={fmtDate(day)} onChange={(e) => setDay(operating[+e.target.value])} />
              <button className="btn btn-outline btn-sm" aria-label="Next operating day" disabled={at >= operating.length - 1} onClick={() => setDay(operating[at + 1])}>Next</button>
              <button className="btn btn-outline btn-sm" aria-pressed={playing} onClick={() => setPlaying(!playing)}>{playing ? 'Pause' : 'Play'}</button>
            </div>
          </div>
          <Suspense fallback={<div className="map-placeholder" style={{ height: 500 }} role="status">Loading the map</div>}>
            <FleetMap fleet={fleet} result={result} day={day} selected={selected} onSelect={setSelected} height={500} playing={playing} />
          </Suspense>
        </section>
        <section className="card vehicle-list" aria-label="Vehicles, worst first">
          <h3>Vehicles, worst first</h3>
          <ul>
            {sorted.map((v) => (
              <li key={v.id}>
                <button className={selected === v.id ? 'on' : ''} aria-pressed={selected === v.id} onClick={() => setSelected(selected === v.id ? null : v.id)}>
                  <span className="vl-top"><strong>{v.id}</strong><b>{v.pct.toFixed(0)}%</b></span>
                  <span className="vl-model">{v.model?.name ?? 'No model in this class'}</span>
                  <span className="meter" aria-hidden="true"><i style={{ width: `${v.pct}%`, background: socColor(v.pct * 0.6) }} /></span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <section className="card">
        <div className="card-head">
          <div>
            <h3>Fleet suitability: vehicle by day</h3>
            <p className="muted small">Each cell is one vehicle on one day, on its best-fit EV. Hover to read it. Click, or use the arrow keys and Enter, to open that day on the map.</p>
          </div>
        </div>
        <SuitabilityGrid result={result} selectedDay={day} selectedVehicle={selected} onPick={(v, d) => { setSelected(v); setDay(d) }} />
      </section>
      <section className="card">
        <h3>Why days fail</h3>
        {reasons.length ? (
          <ul className="reason-bars">
            {reasons.map(([r, n]) => (
              <li key={r}>
                <span>{REASON_LABEL[r]}</span>
                <span className="meter tall" aria-hidden="true"><i style={{ width: `${(n / maxReason) * 100}%` }} /></span>
                <b>{n.toLocaleString('en-CA')}</b>
              </li>
            ))}
          </ul>
        ) : <p className="good-note">No failure days. Drag the temperature down to find where this fleet breaks.</p>}
      </section>
    </div>
  )
}

/* ---------- Vehicles ---------- */

function Vehicles({ fleet, settings, temp, result, assignment, setAssignment, setVehicle, selected, setSelected }: {
  fleet: Fleet; settings: Settings; temp: TempMode; result: ReturnType<typeof analyzeFleet>; assignment: Record<string, string>; setAssignment: (a: Record<string, string>) => void; setVehicle: (id: string, p: { cls?: VClass; loadKg?: number }) => void; selected: string | null; setSelected: (s: string | null) => void
}) {
  const uplift = useMemo(() => middayUplift(fleet, settings, temp, result), [fleet, settings, temp, result])
  const cur = settings.tco.currency
  const names = useMemo(() => new Map(allModels(settings).map((m) => [m.id, m.name])), [settings])
  return (
    <section className="card">
      <h3>Per-vehicle results</h3>
      <p className="muted small">Pick a different model for any vehicle to compare. Select a row for its failure days and alternatives.</p>
      <div className="table-scroll">
        <table className="table vehicles">
          <thead>
            <tr><th>Vehicle</th><th>Class</th><th>Best-fit EV</th><th className="num">Days done</th><th>Failures</th><th className="num">Avg / max km</th><th className="num">Back at base</th><th className="num">With top-up</th><th className="num">Saving</th><th className="num">Crossover</th><th className="num">CO2 t/yr</th><th>Verdict</th></tr>
          </thead>
          <tbody>
            {result.vehicles.map((v) => {
              const open = selected === v.id
              const fails = v.days.filter((d) => d.failed)
              return (
                <Fragment key={v.id}>
                  <tr className={open ? 'row-open' : ''}>
                    <th scope="row"><button className="link" aria-expanded={open} onClick={() => setSelected(open ? null : v.id)}>{v.id}</button></th>
                    <td>
                      <select aria-label={`${v.id} class`} value={v.cls} onChange={(e) => setVehicle(v.id, { cls: e.target.value as VClass })}><option value="van">Van</option><option value="pickup">Pickup</option><option value="car">Car</option></select>
                    </td>
                    <td>
                      <select aria-label={`${v.id} EV model`} value={v.model?.id ?? ''} onChange={(e) => setAssignment({ ...assignment, [v.id]: e.target.value })}>
                        {candidateModels(settings, v.cls).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </td>
                    <td className="num"><b>{v.pct.toFixed(0)}%</b></td>
                    <td className="reason-cell">{fails.length ? Object.entries(v.reasons).map(([k, n]) => `${REASON_LABEL[k as Reason]}: ${n}`).join('; ') : 'None'}</td>
                    <td className="num">{v.avgKm.toFixed(0)} / {v.maxKm.toFixed(0)}</td>
                    <td className="num">{v.rtbPct === null ? 'Unknown' : `${v.rtbPct.toFixed(0)}%`}</td>
                    <td className="num">{uplift.has(v.id) ? `${uplift.get(v.id)!.toFixed(0)}%` : ''}</td>
                    <td className="num">{v.tco ? money(v.tco.savings, cur) : ''}</td>
                    <td className="num">{v.tco ? (v.tco.crossoverYear === null ? 'None' : `Yr ${v.tco.crossoverYear.toFixed(1)}`) : ''}</td>
                    <td className="num">{v.tco ? v.tco.annualCo2Tonnes.toFixed(1) : ''}</td>
                    <td><VerdictChip v={v.verdict} /></td>
                  </tr>
                  {open ? (
                    <tr className="row-detail">
                      <td colSpan={12}>
                        <div className="detail">
                          <div>
                            <h4>Failure days ({fails.length})</h4>
                            {fails.length ? (
                              <ul className="fail-list">
                                {fails.slice(0, 12).map((d) => <li key={d.day}><b>{dateOf(d.day)}</b> {d.reason ? REASON_LABEL[d.reason] : ''}, {d.km.toFixed(0)} km at {fmtT(d.tempC)}, short {d.shortfallKwh.toFixed(0)} kWh</li>)}
                                {fails.length > 12 ? <li className="muted">and {fails.length - 12} more (see the failure days CSV)</li> : null}
                              </ul>
                            ) : <p className="muted">None in this scenario.</p>}
                          </div>
                          <div>
                            <h4>Other models</h4>
                            <ul className="fail-list">
                              {v.candidates.map((c) => <li key={c.modelId}><b>{names.get(c.modelId)}</b> {c.pct.toFixed(0)}% of days, {money(c.savings, cur)} saved before charger costs</li>)}
                            </ul>
                          </div>
                          <div>
                            <h4>Load</h4>
                            <NumField label="Default load" unit="kg" value={fleet.vehicles.find((x) => x.id === v.id)?.loadKg ?? 0} min={0} onChange={(n) => setVehicle(v.id, { loadKg: n })} hint="Applies to trips with no load reading" />
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/* ---------- Charging ---------- */

function Charging({ result, settings, onChange }: { result: ReturnType<typeof analyzeFleet>; settings: Settings; onChange: (s: Settings) => void }) {
  const [depotId, setDepotId] = useState(result.depots[0]?.id)
  const depot = result.depots.find((d) => d.id === depotId) ?? result.depots[0]
  const [nightIdx, setNightIdx] = useState<number | null>(null)
  const c = settings.charging
  const setC = (p: Partial<Settings['charging']>) => onChange({ ...settings, charging: { ...c, ...p } })
  if (!depot) return <section className="card"><p>No vehicle in this fleet has an EV candidate, so there is nothing to charge. Check the vehicle classes.</p></section>
  const idx = nightIdx !== null && nightIdx < depot.nights.length ? nightIdx : depot.worstNight
  const night = depot.nights[idx]
  return (
    <div className="stack">
      <section className="card">
        <h3>Depot charging</h3>
        <div className="fields">
          <NumField label="Charger power" unit="kW" step={0.1} value={c.chargerKw} min={1} max={400} onChange={(v) => setC({ chargerKw: v })} hint="Up to 22 kW is treated as AC" />
          <NumField label="Chargers per depot" value={c.chargers} min={0} max={500} onChange={(v) => setC({ chargers: v })} hint="0 finds the fewest that work" />
          <NumField label="Start charging at" unit="hour" value={c.startHour} min={0} max={23} onChange={(v) => setC({ startHour: v })} hint="Off-peak start" />
          <NumField label="Site power cap" unit="kW" value={c.siteCapKw} min={0} onChange={(v) => setC({ siteCapKw: v })} hint="0 means no cap" />
          <NumField label="Charge to" unit="%" value={c.targetPct} min={50} max={100} onChange={(v) => setC({ targetPct: v })} />
          <NumField label="Required buffer" unit="%" value={c.bufferPct} min={0} max={50} onChange={(v) => setC({ bufferPct: v })} />
          <NumField label="Charging efficiency" unit="%" value={c.effPct} min={50} max={100} onChange={(v) => setC({ effPct: v })} />
          <NumField label="Cold efficiency loss" unit="pts" value={c.coldEffLossPct} min={0} max={40} onChange={(v) => setC({ coldEffLossPct: v })} />
        </div>
        <div className="row topup">
          <label className="check"><input type="checkbox" checked={c.middayOn} onChange={(e) => setC({ middayOn: e.target.checked })} /> Allow mid-day top-ups</label>
          {c.middayOn ? (
            <>
              <NumField label="Top-up power" unit="kW" value={c.middayKw} min={1} max={400} onChange={(v) => setC({ middayKw: v })} />
              <NumField label="Minimum dwell" unit="min" value={c.middayMinDwell} min={5} max={240} onChange={(v) => setC({ middayMinDwell: v })} />
              <label className="check"><input type="checkbox" checked={c.middayPublic} onChange={(e) => setC({ middayPublic: e.target.checked })} /> At any stop (public charging), not only the depot</label>
            </>
          ) : null}
        </div>
      </section>
      <section className="card chart-card">
        <div className="card-head">
          <div>
            <h3>{depot.id}: {depot.chargers} chargers for {depot.vehicles.length} vehicles, peak {depot.peakKw.toFixed(0)} kW</h3>
            <p className="muted small">Night of {fmtDate(night.day)}{idx === depot.worstNight ? ', the hardest night' : ''}. {night.gridKwh.toFixed(0)} kWh from the grid, {night.swaps} plug swaps{night.unmetKwh > 0.5 ? `, ${night.unmetKwh.toFixed(0)} kWh unmet` : ''}. Sessions are not interrupted: moving a plug means a person crossing the yard.</p>
          </div>
          <div className="row">
            {result.depots.length > 1 ? (
              <label className="field compact"><span>Depot</span>
                <select value={depot.id} onChange={(e) => { setDepotId(e.target.value); setNightIdx(null) }}>{result.depots.map((d) => <option key={d.id}>{d.id}</option>)}</select>
              </label>
            ) : null}
            <button className="btn btn-outline btn-sm" disabled={idx <= 0} onClick={() => setNightIdx(idx - 1)}>Prev night</button>
            <button className="btn btn-outline btn-sm" disabled={idx >= depot.nights.length - 1} onClick={() => setNightIdx(idx + 1)}>Next night</button>
            <button className="btn btn-outline btn-sm" onClick={() => setNightIdx(null)}>Hardest</button>
          </div>
        </div>
        <ChargingGantt night={night} chargers={depot.chargers} capKw={c.siteCapKw || undefined} unmanagedKw={depot.unmanagedPeakKw} />
      </section>
    </div>
  )
}

/* ---------- Costs ---------- */

function Costs({ result, settings, onChange }: { result: ReturnType<typeof analyzeFleet>; settings: Settings; onChange: (s: Settings) => void }) {
  const [pick, setPick] = useState('fleet')
  const t = settings.tco
  const setT = (p: Partial<Settings['tco']>) => onChange({ ...settings, tco: { ...t, ...p } })
  const cur = t.currency
  const series = useMemo(() => {
    const vs = result.vehicles.filter((v) => v.tco && (pick === 'fleet' ? v.verdict !== 'hold' : v.id === pick))
    if (!vs.length) return null
    const sum = (k: 'evSeries' | 'iceSeries') => vs[0].tco![k].map((_, i) => vs.reduce((n, v) => n + v.tco![k][i], 0))
    const evSeries = sum('evSeries')
    const iceSeries = sum('iceSeries')
    let crossoverYear: number | null = null
    for (let y = 1; y <= t.years; y++) {
      if (evSeries[y] <= iceSeries[y]) {
        const a = iceSeries[y - 1] - evSeries[y - 1]
        crossoverYear = a >= 0 ? y - 1 : y - 1 + -a / (iceSeries[y] - evSeries[y] - a)
        break
      }
    }
    const total = (k: 'annualEnergyCost' | 'annualFuelCost' | 'annualKm' | 'annualCo2Tonnes') => vs.reduce((n, v) => n + v.tco![k], 0)
    return { evSeries, iceSeries, crossoverYear, years: t.years, energy: total('annualEnergyCost'), fuel: total('annualFuelCost'), km: total('annualKm'), co2: total('annualCo2Tonnes'), count: vs.length, saving: iceSeries[t.years] - evSeries[t.years] }
  }, [result, pick, t.years])
  return (
    <div className="stack">
      <section className="card chart-card">
        <div className="card-head">
          <div>
            <h3>Cost of ownership: electric vs current</h3>
            <p className="muted small">Discounted cost to date, net of resale value at each year-end. Electric includes its share of chargers and demand charges. Annual energy uses the {settings.climate.name} climate profile, so the temperature slider does not change running costs.</p>
          </div>
          <div className="row">
            <label className="field compact"><span>Show</span>
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="fleet">Fleet, excluding holds</option>
                {result.vehicles.map((v) => <option key={v.id} value={v.id}>{v.id}</option>)}
              </select>
            </label>
            <label className="field compact horizon"><span>Horizon: {t.years} years</span><input type="range" min={5} max={10} value={t.years} onChange={(e) => setT({ years: +e.target.value })} /></label>
          </div>
        </div>
        {series ? (
          <>
            <TcoChart tco={series} cur={cur} />
            <dl className="mini-stats">
              <div><dt>{t.years}-year saving</dt><dd>{money(series.saving, cur)}</dd></div>
              <div><dt>Fuel a year today</dt><dd>{money(series.fuel, cur)}</dd></div>
              <div><dt>Electricity a year</dt><dd>{money(series.energy, cur)}</dd></div>
              <div><dt>Distance a year</dt><dd>{Math.round(series.km).toLocaleString('en-CA')} km</dd></div>
              <div><dt>CO2 avoided a year</dt><dd>{series.co2.toFixed(1)} t</dd></div>
            </dl>
          </>
        ) : <p className="note">Every vehicle in this selection is on hold, so there is no EV cost to show. Pick a vehicle, or change the scenario.</p>}
      </section>
      <section className="card">
        <h3>Prices and rates</h3>
        <p className="muted small">Defaults are rough assumptions for Ontario in late 2026, not quotes. Replace them with yours.</p>
        <div className="fields">
          <NumField label={`Fuel, ${cur}`} unit="/L" step={0.01} value={t.fuelPrice} min={0} onChange={(v) => setT({ fuelPrice: v })} />
          <NumField label={`Electricity, ${cur}`} unit="/kWh" step={0.01} value={t.electricity} min={0} onChange={(v) => setT({ electricity: v })} />
          <NumField label={`Demand charge, ${cur}`} unit="/kW-month" value={t.demandChargeKwMonth} min={0} onChange={(v) => setT({ demandChargeKwMonth: v })} />
          <NumField label={`EV maintenance, ${cur}`} unit="/km" step={0.01} value={t.maintEvKm} min={0} onChange={(v) => setT({ maintEvKm: v })} />
          <NumField label={`Current maintenance, ${cur}`} unit="/km" step={0.01} value={t.maintIceKm} min={0} onChange={(v) => setT({ maintIceKm: v })} />
          <NumField label="Discount rate" unit="%" step={0.5} value={t.discountPct} min={0} max={30} onChange={(v) => setT({ discountPct: v })} />
          <NumField label="EV depreciation" unit="%/yr" value={t.evDepreciationPct} min={0} max={60} onChange={(v) => setT({ evDepreciationPct: v })} />
          <NumField label="Current depreciation" unit="%/yr" value={t.iceDepreciationPct} min={0} max={60} onChange={(v) => setT({ iceDepreciationPct: v })} />
          <NumField label="USD to local rate" step={0.0001} value={t.fxUsd} min={0.01} onChange={(v) => setT({ fxUsd: v })} hint="1.3966 on 2026-11-05" />
          <NumField label={`AC charger installed, ${cur}`} value={t.chargerCapexAc} min={0} step={500} onChange={(v) => setT({ chargerCapexAc: v })} />
          <NumField label={`DC charger installed, ${cur}`} value={t.chargerCapexDc} min={0} step={1000} onChange={(v) => setT({ chargerCapexDc: v })} />
          <NumField label="Tailpipe CO2" unit="kg/L" step={0.01} value={t.fuelKgCo2PerL} min={0} onChange={(v) => setT({ fuelKgCo2PerL: v })} />
          <NumField label="Grid CO2" unit="g/kWh" value={t.gridGPerKwh} min={0} onChange={(v) => setT({ gridGPerKwh: v })} />
          <NumField label="Idle fuel" unit="L/h" step={0.1} value={t.idleLPerH} min={0} onChange={(v) => setT({ idleLPerH: v })} />
        </div>
        <h4 className="sub">By vehicle class</h4>
        <div className="table-scroll">
          <table className="table compact-inputs">
            <thead><tr><th>Class</th><th>Replacement price of current type, {cur}</th><th>Current fuel use, L/100 km</th><th>EV incentive per vehicle, {cur}</th></tr></thead>
            <tbody>
              {(['van', 'pickup', 'car'] as VClass[]).map((c) => (
                <tr key={c}>
                  <th scope="row">{c}</th>
                  <td><input aria-label={`${c} current price`} className="cell-input wide" type="number" min={0} value={t.icePrice[c]} onChange={(e) => e.target.valueAsNumber >= 0 && setT({ icePrice: { ...t.icePrice, [c]: e.target.valueAsNumber } })} /></td>
                  <td><input aria-label={`${c} fuel use`} className="cell-input" type="number" min={0} step={0.5} value={t.fuelLPer100[c]} onChange={(e) => e.target.valueAsNumber >= 0 && setT({ fuelLPer100: { ...t.fuelLPer100, [c]: e.target.valueAsNumber } })} /></td>
                  <td><input aria-label={`${c} incentive`} className="cell-input wide" type="number" min={0} step={500} value={t.incentive[c]} onChange={(e) => e.target.valueAsNumber >= 0 && setT({ incentive: { ...t.incentive, [c]: e.target.valueAsNumber } })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h3>Incentives: default is none, status checked {CATALOGUE_AS_OF}</h3>
        <p className="muted small">Newest source is from mid-2026 and programmes change. Confirm with Transport Canada, then enter what your vehicles actually qualify for above.</p>
        <ul className="incentives">
          {INCENTIVE_NOTES.map((n) => <li key={n.label}><strong>{n.label}: {n.status}.</strong> {n.text} <a href={n.url} rel="noreferrer">Source</a></li>)}
        </ul>
      </section>
    </div>
  )
}

/* ---------- Rollout ---------- */

function Rollout({ fleet, settings, temp, result }: { fleet: Fleet; settings: Settings; temp: TempMode; result: ReturnType<typeof analyzeFleet> }) {
  const phases = useMemo(() => planRollout(fleet, settings, temp, result), [fleet, settings, temp, result])
  const cur = settings.tco.currency
  return (
    <div className="phases">
      {phases.map((p, i) => (
        <section key={p.name} className={`card phase phase-${i}`}>
          <h3>{p.name}</h3>
          <p className="muted small">{p.blurb}</p>
          {p.vehicles.length ? (
            <>
              <ol className="phase-list">
                {p.vehicles.map((v) => (
                  <li key={v.id}><strong>{v.id}</strong><span>{v.model?.name ?? 'No model'} · {v.pct.toFixed(0)}% of days{v.tco ? ` · ${money(v.tco.savings, cur)}` : ''}</span></li>
                ))}
              </ol>
              {i < 3 ? (
                <dl className="mini-stats">
                  <div><dt>Chargers by end of phase</dt><dd>{p.chargers}</dd></div>
                  <div><dt>Peak kW by end of phase</dt><dd>{p.peakKw.toFixed(0)}</dd></div>
                  <div><dt>Charger spend this phase</dt><dd>{money(p.capex, cur)}</dd></div>
                  <div><dt>{settings.tco.years}-year saving</dt><dd>{money(p.savings, cur)}</dd></div>
                  <div><dt>CO2 avoided a year</dt><dd>{p.co2Tonnes.toFixed(1)} t</dd></div>
                </dl>
              ) : null}
            </>
          ) : <p className="empty-note">No vehicles here in this scenario.</p>}
        </section>
      ))}
    </div>
  )
}

/* ---------- Print report ---------- */

function Report({ fleet, settings, temp, result, tempLabel, reasons }: { fleet: Fleet; settings: Settings; temp: TempMode; result: ReturnType<typeof analyzeFleet>; tempLabel: string; reasons: [Reason, number][] }) {
  const [printing, setPrinting] = useState(false)
  useEffect(() => {
    const on = () => setPrinting(true)
    const off = () => setPrinting(false)
    addEventListener('beforeprint', on)
    addEventListener('afterprint', off)
    return () => {
      removeEventListener('beforeprint', on)
      removeEventListener('afterprint', off)
    }
  }, [])
  const phases = useMemo(() => (printing ? planRollout(fleet, settings, temp, result) : []), [printing, fleet, settings, temp, result])
  const cur = settings.tco.currency
  return (
    <article className="report" aria-hidden="true">
      <h1>Fleet EV Lab report</h1>
      <p>{fleet.name}. {fleet.synthetic ? 'SYNTHETIC SAMPLE DATA, not real vehicles.' : 'Customer-supplied data, processed in the browser.'} Dated {new Date().toISOString().slice(0, 10)}. Results {tempLabel}.</p>
      <p>{result.pct.toFixed(1)}% of {result.opDays.toLocaleString('en-CA')} vehicle-days completed. {result.readyCount} of {result.vehicles.length} vehicles ready. {result.chargers} chargers, {result.peakKw.toFixed(0)} kW peak. {money(result.savings, cur)} saved over {settings.tco.years} years, excluding holds. {result.co2Tonnes.toFixed(0)} t CO2 avoided a year.</p>
      {reasons.length ? <p>Failure days: {reasons.map(([r, n]) => `${REASON_LABEL[r]} ${n}`).join(', ')}.</p> : null}
      <table>
        <thead><tr><th>Vehicle</th><th>Best-fit EV</th><th>Days</th><th>Fail</th><th>Why</th><th>Saving</th><th>Crossover</th><th>CO2 t/yr</th><th>Verdict</th></tr></thead>
        <tbody>
          {result.vehicles.map((v) => (
            <tr key={v.id}>
              <td>{v.id}</td><td>{v.model?.name}</td><td>{v.pct.toFixed(0)}%</td><td>{v.failDays}</td>
              <td>{Object.entries(v.reasons).map(([k, n]) => `${REASON_LABEL[k as Reason]} ${n}`).join('; ')}</td>
              <td>{v.tco ? money(v.tco.savings, cur) : ''}</td><td>{v.tco?.crossoverYear === null || !v.tco ? 'None' : `Yr ${v.tco.crossoverYear.toFixed(1)}`}</td>
              <td>{v.tco?.annualCo2Tonnes.toFixed(1)}</td><td>{v.verdict}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Rollout</h2>
      {phases.map((p) => (
        <p key={p.name}><strong>{p.name}:</strong> {p.vehicles.map((v) => v.id).join(', ') || 'none'}{p.vehicles.length && p.name !== 'Hold' ? `. ${p.chargers} chargers and ${p.peakKw.toFixed(0)} kW by end of phase.` : '.'}</p>
      ))}
      <h2>Assumptions</h2>
      <p>Range curve: an independent fit through Geotab's published 115% at 21°C and 54% at {'−'}15°C, not Geotab's curve. Fuel {cur}{settings.tco.fuelPrice}/L, electricity {cur}{settings.tco.electricity}/kWh, charger {settings.charging.chargerKw} kW, {settings.charging.bufferPct}% buffer. EV specs checked {CATALOGUE_AS_OF}. Estimates, not quotes. Independent project, not affiliated with Geotab.</p>
    </article>
  )
}
