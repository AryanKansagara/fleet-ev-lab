// Bakes road-following geometry for the synthetic sample fleets, so the demo routes sit on real streets.
// Only random waypoints are sent to the router; no real vehicle data is involved. Run once: node scripts/bake-routes.mjs
import { writeFileSync } from 'node:fs'

const FLEETS = {
  toronto: { depots: [[43.6815, -79.5605]], box: [43.672, 43.8, -79.62, -79.24], loops: 12, stops: 5, maxLegKm: 30 },
  rural: { depots: [[52.2681, -113.8112], [52.3275, -112.7116]], box: [51.75, 52.75, -114.55, -112.3], loops: 8, stops: 3, maxLegKm: 110 },
  mixed: { depots: [[43.2455, -79.8312]], box: [43.15, 43.262, -80.05, -79.55], loops: 10, stops: 4, maxLegKm: 40 },
}
let seed = 20261105
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const distKm = (a, b) => Math.hypot((a[0] - b[0]) * 111, (a[1] - b[1]) * 111 * Math.cos((a[0] * Math.PI) / 180))

function rdp(p, eps) {
  if (p.length < 3) return p
  const [a, b] = [p[0], p[p.length - 1]]
  let max = 0, at = 0
  for (let i = 1; i < p.length - 1; i++) {
    const dx = b[1] - a[1], dy = b[0] - a[0], len = Math.hypot(dx, dy) || 1e-9
    const d = Math.abs(dy * (p[i][1] - a[1]) - dx * (p[i][0] - a[0])) / len
    if (d > max) { max = d; at = i }
  }
  return max <= eps ? [a, b] : [...rdp(p.slice(0, at + 1), eps).slice(0, -1), ...rdp(p.slice(at), eps)]
}

async function leg(a, b) {
  const url = `https://router.project-osrm.org/route/v1/driving/${a[1]},${a[0]};${b[1]},${b[0]}?overview=full&geometries=geojson`
  for (let tries = 0; tries < 3; tries++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'fleet-ev-lab sample bake' } })
      if (r.ok) {
        const j = await r.json()
        const rt = j.routes[0]
        const path = rdp(rt.geometry.coordinates.map(([lng, lat]) => [+lat.toFixed(5), +lng.toFixed(5)]), 0.00018)
        return { km: +(rt.distance / 1000).toFixed(2), min: +(rt.duration / 60).toFixed(1), path }
      }
    } catch { /* retry */ }
    await sleep(1500)
  }
  throw new Error('router failed')
}

for (const [name, f] of Object.entries(FLEETS)) {
  const loops = []
  for (let i = 0; i < f.loops; i++) {
    const depot = f.depots[i % f.depots.length === 0 || f.depots.length === 1 ? 0 : i % 3 === 2 ? 1 : 0]
    const pts = [depot]
    while (pts.length <= f.stops) {
      const c = [f.box[0] + rnd() * (f.box[1] - f.box[0]), f.box[2] + rnd() * (f.box[3] - f.box[2])]
      if (distKm(c, pts[pts.length - 1]) <= f.maxLegKm && distKm(c, pts[pts.length - 1]) > f.maxLegKm * 0.2) pts.push(c)
    }
    pts.push(depot)
    const legs = []
    for (let k = 0; k < pts.length - 1; k++) { legs.push(await leg(pts[k], pts[k + 1])); await sleep(250) }
    legs[0].path[0] = depot; legs[legs.length - 1].path[legs[legs.length - 1].path.length - 1] = depot
    loops.push({ depot, legs })
    console.log(name, i, legs.reduce((s, l) => s + l.km, 0).toFixed(0), 'km')
  }
  writeFileSync(new URL(`../src/samples/routes-${name}.json`, import.meta.url), JSON.stringify({ loops }))
}
console.log('done')
