import { useRef, useState, type DragEvent } from 'react'
import { DEFAULT_UNITS, guessMapping, parseCsv, parseGpx, POINT_FIELDS, rowsToPoints, rowsToTrips, TRIP_FIELDS, type ColumnMap, type Field, type Units } from './engine/parse.ts'
import { assembleFleet, DEFAULT_SEGMENT, fleetFromPoints } from './engine/segment.ts'
import type { Fleet, GpsPoint, VClass } from './engine/types.ts'
import { NumField } from './ui.tsx'

const LABEL: Record<Field, string> = {
  vehicle: 'Vehicle', timestamp: 'Timestamp', lat: 'Latitude', lng: 'Longitude', speed: 'Speed (optional)', odometer: 'Odometer (optional)', load: 'Load (optional)',
  start: 'Trip start', end: 'Trip end', distance: 'Distance', idle: 'Idle minutes (optional)', startLat: 'Start lat (optional)', startLng: 'Start lng (optional)', endLat: 'End lat (optional)', endLng: 'End lng (optional)',
}
const REQUIRED: Record<'points' | 'trips', Field[]> = { points: ['timestamp', 'lat', 'lng'], trips: ['start', 'end', 'distance'] }

interface Pending {
  name: string
  header: string[]
  rows: string[][]
  kind: 'points' | 'trips'
  map: ColumnMap
}

export default function Import({ onFleet }: { onFleet: (f: Fleet) => void }) {
  const [pending, setPending] = useState<Pending | null>(null)
  const [gpx, setGpx] = useState<{ name: string; points: GpsPoint[] } | null>(null)
  const [units, setUnits] = useState<Units>(DEFAULT_UNITS)
  const [stopMin, setStopMin] = useState(DEFAULT_SEGMENT.stopMinutes)
  const [maxKph, setMaxKph] = useState(DEFAULT_SEGMENT.maxKph)
  const [cls, setCls] = useState<VClass>('van')
  const [loadKg, setLoadKg] = useState(300)
  const [error, setError] = useState('')
  const [drag, setDrag] = useState(false)
  const [paste, setPaste] = useState('')
  const input = useRef<HTMLInputElement>(null)

  const ingestText = (name: string, text: string) => {
    setError('')
    setGpx(null)
    setPending(null)
    if (/^\s*<(\?xml|gpx)/i.test(text)) {
      const points = parseGpx(text, name.replace(/\.[^.]+$/, ''))
      if (!points.length) return setError('That GPX file has no timestamped track points. Trips need time to be segmented.')
      setGpx({ name, points })
      return
    }
    const rows = parseCsv(text)
    if (rows.length < 2) return setError('That file has no data rows. It needs a header line and at least one row.')
    const { kind, map } = guessMapping(rows[0])
    setPending({ name, header: rows[0], rows: rows.slice(1), kind, map })
  }

  const readFiles = async (files: FileList | File[]) => {
    const list = [...files]
    if (!list.length) return
    try {
      if (list.every((f) => /\.gpx$/i.test(f.name))) {
        // Several GPX files combine, with each file naming a vehicle when the track has no name.
        const points = (await Promise.all(list.map(async (f) => parseGpx(await f.text(), f.name.replace(/\.[^.]+$/, ''))))).flat()
        setError('')
        setPending(null)
        if (!points.length) return setError('Those GPX files have no timestamped track points.')
        setGpx({ name: list.length > 1 ? `${list.length} GPX files` : list[0].name, points })
      } else ingestText(list[0].name, await list[0].text())
    } catch {
      setError('Could not read that file.')
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDrag(false)
    readFiles(e.dataTransfer.files)
  }

  const finish = (fleet: Fleet) => {
    if (!fleet.trips.length) return setError('No trips came out of that data. Check the column mapping, or lower the stop duration: vehicles need to actually move between points.')
    setPending(null)
    setGpx(null)
    setPaste('')
    onFleet(fleet)
  }

  const build = () => {
    const seg = { ...DEFAULT_SEGMENT, stopMinutes: stopMin, maxKph }
    const opts = { defaultCls: cls, defaultLoadKg: loadKg }
    if (gpx) return finish(fleetFromPoints(gpx.points, { name: gpx.name, ...opts }, seg))
    if (!pending) return
    const missing = REQUIRED[pending.kind].filter((f) => pending.map[f] === undefined)
    if (missing.length) return setError(`Map these columns first: ${missing.map((f) => LABEL[f]).join(', ')}.`)
    if (pending.kind === 'points') {
      const { points, bad } = rowsToPoints(pending.rows, pending.map, units, pending.name.replace(/\.[^.]+$/, ''))
      if (!points.length) return setError(`None of the ${bad} rows could be read. Check the timestamp and coordinate columns.`)
      finish(fleetFromPoints(points, { name: pending.name, ...opts }, seg))
    } else {
      const { trips, bad } = rowsToTrips(pending.rows, pending.map, units, pending.name.replace(/\.[^.]+$/, ''))
      if (!trips.length) return setError(`None of the ${bad} rows could be read. Check the start, end and distance columns.`)
      finish(assembleFleet(trips, { name: pending.name, ...opts }))
    }
  }

  const fields = pending ? (pending.kind === 'points' ? POINT_FIELDS : TRIP_FIELDS) : []

  return (
    <div className="import">
      <div
        className={`drop ${drag ? 'drop-on' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        <h3>Drop GPS trips here</h3>
        <p>GPX, CSV of GPS points (vehicle, timestamp, lat, lng, optional speed, odometer, load), or a trip-summary CSV. Files are read in this browser and never uploaded.</p>
        <button className="btn btn-primary" onClick={() => input.current?.click()}>Choose files</button>
        <input ref={input} type="file" hidden multiple accept=".csv,.tsv,.txt,.gpx,text/csv" onChange={(e) => { if (e.target.files) readFiles(e.target.files); e.target.value = '' }} />
        <details className="paste">
          <summary>Or paste CSV</summary>
          <textarea value={paste} onChange={(e) => setPaste(e.target.value)} rows={5} aria-label="Paste CSV" placeholder="vehicle,timestamp,lat,lng,speed_kph" spellCheck={false} />
          <button className="btn btn-outline" disabled={!paste.trim()} onClick={() => ingestText('Pasted data', paste)}>Read pasted data</button>
        </details>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}

      {pending ? (
        <div className="card mapping">
          <h3>Map the columns: {pending.name}</h3>
          <p className="muted small">{pending.rows.length.toLocaleString('en-CA')} rows found. Columns were guessed from the header; correct any that are wrong.</p>
          <div className="seg" role="radiogroup" aria-label="File type">
            <button role="radio" aria-checked={pending.kind === 'points'} className={pending.kind === 'points' ? 'on' : ''} onClick={() => setPending({ ...pending, kind: 'points' })}>GPS points</button>
            <button role="radio" aria-checked={pending.kind === 'trips'} className={pending.kind === 'trips' ? 'on' : ''} onClick={() => setPending({ ...pending, kind: 'trips' })}>Trip summaries</button>
          </div>
          <div className="map-fields">
            {fields.map((f) => (
              <label className="field" key={f}>
                <span>{LABEL[f]}</span>
                <select value={pending.map[f] ?? ''} onChange={(e) => setPending({ ...pending, map: { ...pending.map, [f]: e.target.value === '' ? undefined : +e.target.value } })}>
                  <option value="">Not in file</option>
                  {pending.header.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                </select>
              </label>
            ))}
          </div>
          <div className="table-scroll">
            <table className="table compact">
              <thead><tr>{pending.header.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
              <tbody>{pending.rows.slice(0, 4).map((r, i) => <tr key={i}>{r.map((c, k) => <td key={k}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </div>
      ) : null}
      {gpx ? <div className="card mapping"><h3>{gpx.name}</h3><p className="muted small">{gpx.points.length.toLocaleString('en-CA')} track points in {new Set(gpx.points.map((p) => p.vehicle)).size} vehicle(s).</p></div> : null}

      {pending || gpx ? (
        <div className="card mapping">
          <h3>How to read it</h3>
          <div className="map-fields">
            <NumField label="A stop is at least" unit="min" value={stopMin} min={1} max={240} onChange={setStopMin} hint="Splits one drive from the next" />
            <NumField label="Reject GPS jumps over" unit="km/h" value={maxKph} min={60} max={400} onChange={setMaxKph} />
            <label className="field"><span>Vehicle class</span><select value={cls} onChange={(e) => setCls(e.target.value as VClass)}><option value="van">Van</option><option value="pickup">Pickup</option><option value="car">Car</option></select><small>Editable per vehicle later</small></label>
            <NumField label="Default load" unit="kg" value={loadKg} min={0} onChange={setLoadKg} hint="Used where a row has no load" />
            <label className="field"><span>Distance unit</span><select value={units.distance} onChange={(e) => setUnits({ ...units, distance: e.target.value as Units['distance'] })}><option value="km">km</option><option value="mi">miles</option></select></label>
            <label className="field"><span>Speed unit</span><select value={units.speed} onChange={(e) => setUnits({ ...units, speed: e.target.value as Units['speed'] })}><option value="kph">km/h</option><option value="mph">mph</option></select></label>
            <label className="field"><span>Load unit</span><select value={units.load} onChange={(e) => setUnits({ ...units, load: e.target.value as Units['load'] })}><option value="kg">kg</option><option value="lb">lb</option></select></label>
          </div>
          <button className="btn btn-primary" onClick={build}>Analyse this fleet</button>
        </div>
      ) : null}
    </div>
  )
}
