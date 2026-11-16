import { CATALOGUE_AS_OF } from './engine/catalogue.ts'
import { BOC_URL, STATCAN_TABLE } from './engine/prices.ts'
import { Footer, Header, Link } from './ui.tsx'

export default function Docs() {
  return (
    <>
      <Header>
        <Link href="/">Home</Link>
      </Header>
      <main className="docs">
        <h1>Formats, data sources and limits</h1>
        <p>What the importer reads, where every reference figure comes from and when it was checked.</p>

        <h2 id="formats">Import formats</h2>
        <h3>GPX 1.0 and 1.1</h3>
        <p>Tracks, routes and timestamped waypoints. A track name becomes the vehicle, unless it is a date or a generic label such as "ACTIVE LOG" (Garmin names tracks by date), in which case the file name is used. Speed is read from GPX 1.0 <code>&lt;speed&gt;</code> and Garmin <code>gpxtpx:speed</code>, both in m/s. Several GPX files can be dropped at once. Tested against the public GPX test files of the gpxpy project (Apache 2.0), including a Garmin eTrex 20x car track, a file with a byte-order mark and a track with an empty segment.</p>
        <h3>GPS point CSV</h3>
        <p>One row per fix: vehicle, timestamp, latitude, longitude, and optionally speed, odometer and load. Comma, semicolon, tab and pipe delimiters are detected, and decimal commas (<code>43,6532</code>) are read correctly. Units are guessed from the header (<code>Speed (mph)</code>, <code>speed m/s</code>, <code>Distance mi</code>) and can be changed before import. Layouts checked:</p>
        <ul>
          <li><strong>MyGeotab API Adapter <code>LogRecords2</code></strong>: <code>id, GeotabId, DateTime, DeviceId, Latitude, Longitude, Speed</code> with speed in km/h. <code>DeviceId</code> is used as the vehicle, never the row <code>id</code>. Columns from the adapter's <a href="https://github.com/Geotab/mygeotab-api-adapter/blob/master/MyGeotabAPIAdapter/SCHEMA_REFERENCE.md" rel="noreferrer">schema reference</a>.</li>
          <li><strong>GPSLogger for Android</strong>: <code>time, lat, lon, elevation, accuracy, bearing, speed, ...</code> with speed in m/s, and its optional semicolon delimiter with decimal commas. Columns from the app's <a href="https://github.com/mendhak/gpslogger/blob/master/gpslogger/src/main/java/com/mendhak/gpslogger/loggers/csv/CSVFileLogger.java" rel="noreferrer">CSV writer</a>.</li>
          <li><strong>Files with no header row</strong>, such as the T-Drive taxi layout <code>id,datetime,longitude,latitude</code>. Columns are guessed from the values: the coordinate outside ±90 is the longitude.</li>
        </ul>
        <h3>Trip-summary CSV</h3>
        <p>One row per trip: vehicle, start, end, distance, and optionally idle time, load and start or end coordinates. Idle time can be minutes, seconds, .NET ticks, or an <code>hh:mm:ss</code> span as MyGeotab writes it. The adapter's <code>Trips2</code> table maps directly: <code>DeviceId, Start, Stop, Distance</code> (km), <code>IdlingDurationTicks</code>, <code>StopPointX</code> (longitude) and <code>StopPointY</code> (latitude).</p>
        <h3>MyGeotab API results as JSON</h3>
        <p>The result of <code>Get</code> for <code>LogRecord</code> or <code>Trip</code>, saved as a JSON array or the raw JSON-RPC body <code>{"{"}"result": [...]{"}"}</code>. Multicall results (an array of arrays) are flattened. A trip only carries where it stopped, so each trip starts where that device's previous trip stopped.</p>
        <pre>{`[{"device":{"id":"b2A"},"start":"2026-01-14T12:02:11.000Z","stop":"2026-01-14T12:31:40.000Z",
  "distance":18.4,"idlingDuration":"00:03:12","stopPoint":{"x":-79.41,"y":43.66}}]`}</pre>
        <p>Times with a Z or an offset are moved to the fleet's local time using longitude (no daylight saving), which is enough to find overnight charging windows.</p>

        <h2 id="sources">Reference data</h2>
        <ul>
          <li><strong>Range curve</strong>: an independent fit through two points Geotab published from 5.2 million trips: about 115% of rated range at 21°C and 54% at −15°C (<a href="https://www.geotab.com/blog/5-ev-myths-fleet-costs/" rel="noreferrer">Geotab</a>). The shape between and beyond them is an assumption, and every knot is editable.</li>
          <li><strong>Trip temperatures</strong>: <a href="https://open-meteo.com/en/docs/historical-weather-api" rel="noreferrer">Open-Meteo historical archive</a>, hourly, fetched live per depot and cached in the browser.</li>
          <li><strong>Pump prices</strong>: Statistics Canada <a href={STATCAN_TABLE} rel="noreferrer">table 18-10-0001-01</a>, monthly average retail price by city. The default fuel price is Toronto regular self-serve for September 2026, 183.7 ¢/L (diesel 249.4 ¢/L), retrieved 2026-11-15. The Costs tab can fetch the latest month for the nearest of 15 cities.</li>
          <li><strong>Exchange rate</strong>: Bank of Canada <a href={BOC_URL} rel="noreferrer">Valet API</a>, series FXUSDCAD. Default 1.4257 for 2026-11-13; the Costs tab can fetch the latest.</li>
          <li><strong>EV catalogue and incentives</strong>: checked {CATALOGUE_AS_OF}, with sources per model in the lab's Assumptions tab.</li>
          <li><strong>Electricity, demand charges, maintenance, depreciation</strong>: round assumptions, not tariffs. Replace them with your utility's rates.</li>
        </ul>

        <h2 id="network">What touches the network</h2>
        <p>GPS data never leaves the browser. Open-Meteo receives each depot rounded to about 10 km plus a date range. When you press "Use latest official prices", Statistics Canada receives only a city id and the Bank of Canada receives nothing beyond the request. The map tile server sees the area you view.</p>

        <h2 id="limits">Known limits</h2>
        <ul>
          <li>The range curve rests on two published fleet averages.</li>
          <li>Time zones come from longitude, without daylight saving.</li>
          <li>Depot plugs are not preempted once a session starts.</li>
          <li>Pump prices exist only for Canadian cities; US fleets keep the editable default.</li>
          <li>MyGeotab Excel reports (.xlsx) need saving as CSV first.</li>
        </ul>
        <p><Link href="/app" className="btn btn-primary">Open the lab</Link></p>
      </main>
      <Footer />
    </>
  )
}
