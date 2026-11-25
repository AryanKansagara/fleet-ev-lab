import { test as base, expect, type Locator, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

/** Hosts the app is documented to contact. None is reached: fonts get an empty stylesheet, the rest are refused, so the app runs on its offline fallbacks. */
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com'])
export const DOCUMENTED = new Set(['tile.openstreetmap.org', 'archive-api.open-meteo.com'])

/** Known bug: Leaflet's zoom timer fires after the map is removed. Only this exact error is tolerated, and known-bugs.spec.ts pins it. */
const LEAFLET_TIMER = "TypeError: Cannot read properties of undefined (reading '_leaflet_pos')"

export const test = base.extend<{ external: string[]; strictMap: boolean }>({
  external: async ({}, use) => { await use([]) },
  strictMap: [false, { option: true }],

  // Any request to an undocumented host fails the test, and so does any uncaught page error.
  context: async ({ context, baseURL, external, strictMap }, use) => {
    const errors: string[] = []
    const origin = new URL(baseURL!).origin
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url())
      if (url.origin === origin) return route.continue()
      if (FONT_HOSTS.has(url.host)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' })
      if (!DOCUMENTED.has(url.host)) external.push(url.host)
      return route.abort('blockedbyclient')
    })
    context.on('weberror', (e) => {
      const message = String(e.error())
      if (strictMap || message !== LEAFLET_TIMER) errors.push(message)
    })
    await use(context)
    expect(errors, 'uncaught page errors').toEqual([])
    expect(external, 'requests to undocumented hosts').toEqual([])
  },
})

export { expect }

export type Upload = { name: string; data: string }
export type TabName = 'Overview' | 'Vehicles' | 'Charging' | 'Costs' | 'Rollout' | 'Assumptions' | 'Your data'

export const tab = (page: Page, name: TabName) => page.getByRole('tab', { name, exact: true }).click()
export const kpi = (page: Page, name: string | RegExp) => page.locator('.kpi').filter({ hasText: name }).locator('b')
export const status = (page: Page) => page.locator('.status-line')
export const fleetPick = (page: Page) => page.locator('.fleet-pick select')
export const alert = (page: Page) => page.locator('.import').getByRole('alert')

/** Opens the lab and waits for the first simulation. */
export async function openLab(page: Page, path = '/app') {
  await page.goto(path)
  await expect(status(page)).toBeVisible()
}

/** Feeds files to the import control on the Your data tab. */
export async function upload(page: Page, files: Upload[]) {
  await openLab(page)
  await tab(page, 'Your data')
  await page.locator('input[type=file]').setInputFiles(files.map((f) => ({ name: f.name, mimeType: 'text/plain', buffer: Buffer.from(f.data) })))
}

export const analyse = (page: Page) => page.getByRole('button', { name: 'Analyse this fleet' }).click()

/** Uploads one file, accepts the guessed mapping and waits for the results. MyGeotab trip files skip the mapping step. */
export async function importFleet(page: Page, name: string, data: string, mapped = true) {
  await upload(page, [{ name, data }])
  if (mapped) await analyse(page)
  await expect(status(page)).toContainText('Your data, in this browser only')
}

/** Fixed temperature from the slider. */
export async function setTemp(page: Page, c: number) {
  // The slider rests at 21 while observed weather is on, so step off that value first.
  await page.locator('#temp-slider').fill(String(c - 1))
  await page.locator('#temp-slider').fill(String(c))
  await expect(kpi(page, 'Days completed')).toBeVisible()
  await expect(page.locator('.kpi-main')).toContainText(`at ${c > 0 ? '+' : '−'}${Math.abs(c)}°C`)
}

export async function pickModel(page: Page, vehicle: string, model: string) {
  await tab(page, 'Vehicles')
  await page.getByLabel(`${vehicle} EV model`).selectOption({ label: model })
}

export async function download(page: Page, trigger: Locator): Promise<[string, string]> {
  const [d] = await Promise.all([page.waitForEvent('download'), trigger.click()])
  return [d.suggestedFilename(), await readFile((await d.path())!, 'utf8')]
}

export async function exportCsv(page: Page, name: 'Results CSV' | 'Failure days CSV'): Promise<[string, string]> {
  await page.locator('summary', { hasText: 'Export' }).click()
  return download(page, page.getByRole('button', { name, exact: true }))
}

/** One vehicle's row of the results CSV as column name to cell. Cells in these tests contain no quotes. */
export async function result(page: Page, vehicle: string): Promise<Record<string, string>> {
  const [, csv] = await exportCsv(page, 'Results CSV')
  const [head, ...rows] = csv.split('\n').map((l) => l.split(','))
  const row = rows.find((r) => r[0] === vehicle)
  expect(row, `row for ${vehicle}`).toBeTruthy()
  return Object.fromEntries(head.map((h, i) => [h, row![i]]))
}

// ---------- Synthetic data ----------

const pad = (n: number) => String(n).padStart(2, '0')

/** One fix a minute from 08:00 on 2026-01-05, positions given by the caller. */
export function track(n: number, at: (i: number) => [number, number], vehicle = 'Van 1', suffix = ''): string[][] {
  return Array.from({ length: n }, (_, i) => {
    const [lat, lng] = at(i)
    return [vehicle, `2026-01-05T${pad(8 + Math.floor(i / 60))}:${pad(i % 60)}:00${suffix}`, lat.toFixed(6), lng.toFixed(6)]
  })
}
export const pointsCsv = (rows: string[][]) => ['vehicle,timestamp,lat,lng', ...rows.map((r) => r.join(','))].join('\n')
export const gpx = (rows: string[][], name = 'Van 1') =>
  `<?xml version="1.0"?><gpx version="1.1"><trk><name>${name}</name><trkseg>${rows.map((r) => `<trkpt lat="${r[2]}" lon="${r[3]}"><time>${r[1]}Z</time></trkpt>`).join('')}</trkseg></trk></gpx>`
/** 31 fixes due north, 0.01 degree apart: 30 x 6371 x pi/180 x 0.01 = 33.36 km in 30 minutes. */
export const north = () => track(31, (i) => [43 + i * 0.01, -79.5])
export const TRIP = 'vehicle,start,end,distance_km,load_kg\nVan 1,2026-01-05 08:00,2026-01-05 12:00,160,0\n'
