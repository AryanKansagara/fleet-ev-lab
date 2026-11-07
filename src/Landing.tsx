import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { ChargingGantt, CurveChart, TcoChart } from './Charts.tsx'
import { loadSample } from './engine/samples.ts'
import { defaultCurve, defaultSettings } from './engine/settings.ts'
import { analyzeFleet } from './engine/sim.ts'
import type { Fleet, FleetResult } from './engine/types.ts'
import { Footer, fmtT, Header, Link, money, socColor, SyntheticTag } from './ui.tsx'

const FleetMap = lazy(() => import('./FleetMap.tsx'))

const SOURCE_G = 'https://www.geotab.com/blog/5-ev-myths-fleet-costs/'
const SOURCE_E = 'https://electricdrives.tv/five-ev-myths-that-are-costing-fleets-money-and-what-the-data-actually-says/'
const settings = defaultSettings()
const HERO_DAY = Math.floor(Date.UTC(2026, 0, 14) / 864e5)

function fleetPeakDay(r: FleetResult): number {
  // The Wednesday in deep January, or the busiest day if an edit moves the data.
  return r.vehicles.some((v) => v.days.some((d) => d.day === HERO_DAY)) ? HERO_DAY : r.vehicles[0]?.days[0]?.day ?? r.firstDay
}

function Hero({ fleet }: { fleet: Fleet | null }) {
  const [temp, setTemp] = useState(21)
  const touched = useRef(false)
  const reduced = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, [])

  // A slow sweep shows the point before anyone touches it; the first touch hands over control.
  useEffect(() => {
    if (reduced || !fleet) return
    const start = performance.now()
    let raf = 0
    const tick = (now: number) => {
      if (touched.current) return
      const f = ((now - start) / 16000) % 1
      const wave = f < 0.12 ? 0 : f < 0.55 ? (f - 0.12) / 0.43 : f < 0.67 ? 1 : 1 - (f - 0.67) / 0.33
      setTemp(Math.round(21 - wave * 46))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [fleet, reduced])

  const result = useMemo(() => (fleet ? analyzeFleet(fleet, settings, { mode: 'fixed', c: temp }) : null), [fleet, temp])
  const day = result ? fleetPeakDay(result) : HERO_DAY

  return (
    <section className="hero">
      <div className="wrap hero-copy">
        <h1>Which of your vehicles could go electric, even at {'−'}25°C?</h1>
        <p>Upload GPS trips. See which vehicles complete their real days on which EV, with what charging, at what cost. Drag the cold in and watch the answer change.</p>
        <div className="hero-cta">
          <Link href="/app" className="btn btn-primary btn-lg">Open the lab</Link>
          <a href="#method" className="btn btn-outline btn-lg">See the method</a>
        </div>
      </div>
      <div className="wrap hero-stage">
        <div className="hero-window">
          <div className="window-bar">
            <span className="window-title">Live engine · Urban delivery vans, Toronto</span>
            <SyntheticTag text="Synthetic fleet, not real vehicles" />
          </div>
          {fleet && result ? (
            <Suspense fallback={<div className="map-placeholder" style={{ height: 560 }} />}>
              <FleetMap fleet={fleet} result={result} day={day} height={560} scrollZoom={false} cycleSeconds={20} />
            </Suspense>
          ) : <div className="map-placeholder" style={{ height: 560 }} role="status">Building the sample fleet</div>}
        </div>
        <aside className="hero-card" aria-label="Temperature control">
          <div className="hero-card-head">
            <h2>Outside temperature</h2>
            <output className="temp-readout" style={{ color: result ? socColor(result.pct * 0.6) : undefined }}>{fmtT(temp)}</output>
          </div>
          <input
            className="temp-range"
            type="range"
            min={-25}
            max={21}
            value={temp}
            aria-label="Outside temperature in degrees Celsius"
            aria-valuetext={fmtT(temp)}
            onPointerDown={() => { touched.current = true }}
            onKeyDown={() => { touched.current = true }}
            onChange={(e) => { touched.current = true; setTemp(+e.target.value) }}
          />
          <div className="range-ends"><span>{'−'}25°C</span><span>Drag me</span><span>+21°C</span></div>
          <dl className="hero-kpis">
            <div><dt>Days completed</dt><dd>{result ? `${result.pct.toFixed(0)}%` : '...'}</dd></div>
            <div><dt>Ready and saving</dt><dd>{result ? `${result.readyCount} of ${result.vehicles.length}` : '...'}</dd></div>
            <div><dt>Depot chargers</dt><dd>{result ? result.chargers : '...'}</dd></div>
            <div><dt>Peak load</dt><dd>{result ? `${result.peakKw.toFixed(0)} kW` : '...'}</dd></div>
          </dl>
          <ul className="van-strip" aria-label="Vehicles and share of days completed">
            {result?.vehicles.map((v) => (
              <li key={v.id} title={`${v.id}: ${v.pct.toFixed(0)}% of days on ${v.model?.name ?? 'no model'}`}>
                <i style={{ background: socColor(v.pct * 0.6) }} />
                <span>{v.id.replace('Van ', '')}</span>
                <b>{v.pct.toFixed(0)}</b>
              </li>
            ))}
          </ul>
          <p className="engine-note">The real engine, re-simulating {result?.opDays.toLocaleString('en-CA') ?? ''} vehicle-days in {result ? result.ms.toFixed(0) : ''} ms in your browser.</p>
        </aside>
      </div>
    </section>
  )
}

export default function Landing() {
  const [fleet, setFleet] = useState<Fleet | null>(null)
  useEffect(() => {
    loadSample('toronto').then(setFleet)
  }, [])
  const curve = useMemo(defaultCurve, [])
  const winter = useMemo(() => (fleet ? analyzeFleet(fleet, settings, { mode: 'fixed', c: -5 }) : null), [fleet])
  const depot = winter?.depots[0]
  const night = depot?.nights[depot.worstNight]
  const fleetTco = useMemo(() => {
    if (!winter) return null
    const vs = winter.vehicles.filter((v) => v.tco)
    if (!vs.length) return null
    const sum = (k: 'evSeries' | 'iceSeries') => vs[0].tco![k].map((_, i) => vs.reduce((n, v) => n + v.tco![k][i], 0))
    const evSeries = sum('evSeries')
    const iceSeries = sum('iceSeries')
    let crossoverYear: number | null = null
    for (let y = 1; y <= settings.tco.years; y++) {
      if (evSeries[y] <= iceSeries[y]) {
        const a = iceSeries[y - 1] - evSeries[y - 1]
        crossoverYear = y - 1 + -a / (iceSeries[y] - evSeries[y] - a)
        break
      }
    }
    return { evSeries, iceSeries, crossoverYear, years: settings.tco.years }
  }, [winter])

  return (
    <div className="landing">
      <Header>
        <a href="#why">Why</a>
        <a href="#method">Method</a>
        <a href="#charging">Charging</a>
        <a href="#privacy">Privacy</a>
      </Header>
      <Hero fleet={fleet} />

      <section className="band">
        <div className="wrap band-grid">
          <a href={SOURCE_G} rel="noreferrer" className="stat"><b>115%</b><span>of rated range, the observed peak at 21°C</span></a>
          <a href={SOURCE_G} rel="noreferrer" className="stat"><b>54%</b><span>of rated range on average at {'−'}15°C</span></a>
          <a href={SOURCE_E} rel="noreferrer" className="stat"><b>5.2M</b><span>trips behind those figures, per Geotab's analysis</span></a>
          <a href={SOURCE_G} rel="noreferrer" className="stat"><b>1 or 2</b><span>locations, where over half of early-fleet EVs charge</span></a>
        </div>
        <p className="wrap band-note">Figures published by Geotab, September 2026. Click any figure for the source.</p>
      </section>

      <nav className="section-nav" aria-label="Page sections">
        <div className="wrap">
          <a href="#why">Why this exists</a>
          <a href="#method">The curve</a>
          <a href="#charging">Charging first</a>
          <a href="#cost">Cost</a>
          <a href="#what">What it does</a>
          <a href="#privacy">Your data</a>
        </div>
      </nav>

      <section className="section soft" id="why">
        <div className="wrap">
          <h2 className="section-title">A rated range does not survive January</h2>
          <p className="section-lede">Spec sheets answer the wrong question. A fleet manager needs to know whether Van 12 finishes its real Tuesday route in a cold snap, after a shared charger left it at 80%, with 900 kg in the back. Fleet operators name the order themselves: charging first, then payload, then daily mileage cutoffs.</p>
          <div className="three">
            <article className="card"><span className="eyebrow">1. Charging</span><h3>Who gets the plug?</h3><p>Shared chargers, a limited count, late returns and early departures. An overnight scheduler assigns every plug and shows the cost in peak kW and plug swaps.</p></article>
            <article className="card"><span className="eyebrow">2. Payload</span><h3>Does the load even fit?</h3><p>Batteries eat payload. Load readings are checked against each EV model on every trip, and the energy penalty stays configurable.</p></article>
            <article className="card"><span className="eyebrow">3. Daily mileage</span><h3>Which days fail, and why?</h3><p>Every failed day is tested against what would have saved it, so the answer reads "cold-weather range" or "not enough overnight charge", not just "no".</p></article>
          </div>
        </div>
      </section>

      <section className="section" id="method">
        <div className="wrap split">
          <div>
            <h2 className="section-title left">An open curve you can argue with</h2>
            <p>Geotab has published two points: about 115% of rated range at 21°C and about 54% at {'−'}15°C. Fleet EV Lab fits its own curve through them. <strong>This is an independent fit, not Geotab's curve.</strong> The shape between and beyond those points is an assumption, and in the lab every knot can be dragged.</p>
            <p>Energy per trip comes from distance, speed bands, this curve, payload, and HVAC for the hours a slow route or idling adds beyond what the curve already contains.</p>
            <p className="muted small">Sources: <a href={SOURCE_G} rel="noreferrer">Geotab blog</a>, <a href={SOURCE_E} rel="noreferrer">Electric Drives</a>.</p>
          </div>
          <div className="card chart-card">
            <h3>Range as a share of rated, by temperature</h3>
            <CurveChart curve={curve} height={320} />
            <p className="muted small">Line: this project's fit. Diamonds: the two published points.</p>
          </div>
        </div>
      </section>

      <section className="section soft" id="charging">
        <div className="wrap">
          <h2 className="section-title">The depot plan, from the same simulation</h2>
          <p className="section-lede">The fewest chargers that add no charging failures, and the night they work hardest. Synthetic Toronto fleet at {'−'}5°C.</p>
          <div className="card chart-card">
            {night && depot ? <ChargingGantt night={night} chargers={depot.chargers} unmanagedKw={depot.unmanagedPeakKw} /> : <div className="map-placeholder" style={{ height: 320 }} />}
          </div>
        </div>
      </section>

      <section className="section" id="cost">
        <div className="wrap split reverse">
          <div className="card chart-card">
            <h3>Fleet cost of ownership, electric vs current</h3>
            {fleetTco ? <TcoChart tco={fleetTco} cur={settings.tco.currency} /> : <div className="map-placeholder" style={{ height: 320 }} />}
            <p className="muted small">Synthetic sample with default assumptions. Discounted cost, net of resale value at each year-end.</p>
          </div>
          <div>
            <h2 className="section-title left">What it costs, with your numbers</h2>
            <p>Fuel, electricity, demand charges, maintenance, depreciation, chargers and incentives are all editable for a 5 to 10-year horizon. Incentives default to none: iZEV is closed, and Canada's EVAP covers light-duty only. The lab shows what was checked and when.</p>
            <p>The EV catalogue is a dated file with sources per model, and it flags what has changed. BrightDrop and the battery-electric F-150 Lightning have both ended production, so they are off by default.</p>
            {winter ? <p className="callout"><b>{money(winter.savings)}</b> saved over {settings.tco.years} years on the vehicles that pass, on this synthetic fleet at {'−'}5°C.</p> : null}
          </div>
        </div>
      </section>

      <section className="section soft" id="what">
        <div className="wrap">
          <h2 className="section-title">From raw GPS to a rollout plan</h2>
          <div className="four">
            <article className="card"><h3>Import</h3><p>GPX, GPS-point CSV or trip-summary CSV with column mapping. Generic exports from telematics systems work.</p></article>
            <article className="card"><h3>Clean</h3><p>Stop-based trip segmentation, GPS jump and noise filtering, idling detection, depot inference and return-to-base scoring.</p></article>
            <article className="card"><h3>Weather</h3><p>Historical temperature per trip from Open-Meteo, cached, with an offline climate profile. A winter stress test replays the coldest week.</p></article>
            <article className="card"><h3>Simulate</h3><p>Day-by-day state of charge with shared chargers, an overnight scheduler, optional mid-day top-ups and a required buffer.</p></article>
            <article className="card"><h3>Best fit</h3><p>Each vehicle against each suitable EV. Completion, failure days and reasons, saving, crossover year and CO2.</p></article>
            <article className="card"><h3>Roll out</h3><p>Phases ordered by readiness and saving, with the chargers and peak kW each phase adds.</p></article>
            <article className="card"><h3>Share</h3><p>A URL for settings only, CSV exports and a print-friendly report for the people who sign things.</p></article>
            <article className="card"><h3>Edit anything</h3><p>The curve, EV specs, energy penalties, costs and climate. Add your own model. Every assumption is on the table.</p></article>
          </div>
        </div>
      </section>

      <section className="section" id="privacy">
        <div className="wrap split">
          <div>
            <h2 className="section-title left">Your GPS data stays in this browser</h2>
            <p>There is no server and no upload. Parsing, the simulation and exports all run on your machine, and share links carry settings only.</p>
            <p>Two things do touch the network. Open-Meteo receives a depot location rounded to about 10 km plus a date range, to return temperatures. The map tile host sees which area you are viewing, as with any web map.</p>
          </div>
          <div className="card">
            <span className="eyebrow">An independent take</span>
            <h3>Not a replacement for Geotab's assessment</h3>
            <p>Geotab sells an EV suitability assessment, built on data this project does not have. Fleet EV Lab is an independent, open tool for exploring the same question: every assumption is visible and editable. If it matters to your budget, use both.</p>
          </div>
        </div>
      </section>

      <section className="cta-band">
        <div className="wrap">
          <h2>Try it on your own trips</h2>
          <p>Or start with a synthetic fleet: Toronto delivery vans, rural Alberta service trucks, or a mixed fleet with a payload problem.</p>
          <Link href="/app" className="btn btn-white btn-lg">Open the lab</Link>
        </div>
      </section>
      <Footer />
    </div>
  )
}
