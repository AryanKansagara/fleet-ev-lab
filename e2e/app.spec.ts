import { test, expect, fleetPick, openLab, tab, kpi, status, setTemp, pickModel, exportCsv, download, importFleet, result, TRIP } from './fixtures.ts'

test('landing: slider drives the live engine, and links reach the lab and docs', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Which of your vehicles could go electric')
  const done = page.locator('.hero-kpis div', { hasText: 'Days completed' }).locator('dd')
  await expect(done).toHaveText(/^\d+%$/)
  const pct = async (c: number) => {
    await page.getByLabel('Outside temperature in degrees Celsius').fill(String(c))
    await expect(page.locator('.temp-readout')).toContainText(String(Math.abs(c)))
    return parseInt((await done.textContent())!)
  }
  expect(await pct(21)).toBeGreaterThan(await pct(-25))
  await page.getByRole('link', { name: 'Formats and data sources' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Formats, data sources and limits')
  await page.getByRole('link', { name: 'Open the lab' }).first().click()
  await expect(status(page)).toContainText('Synthetic sample data')
})

test('the three samples are labelled synthetic and analyse offline', async ({ page }) => {
  await openLab(page)
  for (const [id, n] of [['toronto', 12], ['rural', 8], ['mixed', 10]] as const) {
    await fleetPick(page).selectOption(id)
    await expect(status(page)).toContainText(`${n} vehicles`)
    await expect(status(page)).toContainText('Synthetic sample data')
    await expect(status(page)).toContainText('Weather archive unavailable')
  }
  await tab(page, 'Vehicles')
  await expect(page.locator('#panel tr', { hasText: 'Van 03 (heavy)' })).toContainText('Hold')
})

test('every tab renders, by mouse and by arrow key', async ({ page }) => {
  await openLab(page)
  for (const [name, text] of [
    ['Vehicles', 'Per-vehicle results'], ['Charging', 'Depot charging'], ['Costs', 'Cost of ownership'], ['Rollout', 'Phase 1: go first'],
    ['Assumptions', 'Range curve: independent fit'], ['Your data', 'Drop GPS trips here'], ['Overview', 'Why days fail'],
  ] as const) {
    await tab(page, name)
    await expect(page.locator('#panel').getByRole('heading', { name: text })).toBeVisible()
  }
  await page.getByRole('tab', { name: 'Overview' }).press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'Vehicles' })).toHaveAttribute('aria-selected', 'true')
})

test('winter stress test falls back to the climate profile offline and says so', async ({ page }) => {
  await openLab(page)
  const before = parseFloat((await kpi(page, 'Days completed').textContent())!)
  await page.getByRole('button', { name: 'Winter stress test' }).click()
  await expect(status(page)).toContainText('Stress week: estimated from the climate profile')
  await expect.poll(async () => parseFloat((await kpi(page, 'Days completed').textContent())!)).toBeLessThan(before)
})

test('weather: the archive gets a rounded location and its temperatures are used', async ({ page }) => {
  const urls: URL[] = []
  await page.route('https://archive-api.open-meteo.com/**', (route) => {
    urls.push(new URL(route.request().url()))
    const time = Array.from({ length: 24 }, (_, h) => `2026-01-05T${String(h).padStart(2, '0')}:00`)
    return route.fulfill({ json: { hourly: { time, temperature_2m: time.map(() => -15) } }, headers: { 'access-control-allow-origin': '*' } })
  })
  await importFleet(page, 't.csv', 'vehicle,start,end,distance,load,start lat,start lng,end lat,end lng\nVan 1,2026-01-05 08:00,2026-01-05 12:00,160,0,43.6789,-79.5678,43.6789,-79.5678\n')
  await expect(status(page)).toContainText('Open-Meteo temperatures on 1 of 1 trips')
  const own = urls.filter((u) => u.searchParams.get('start_date') === '2026-01-05')
  expect(own.length).toBeGreaterThan(0)
  for (const u of own) expect([u.searchParams.get('latitude'), u.searchParams.get('longitude')]).toEqual(['43.7', '-79.6'])
  await pickModel(page, 'Van 1', 'Ford E-Transit 350')
  const [, csv] = await exportCsv(page, 'Failure days CSV')
  expect(csv.split('\n')[1]).toBe('Van 1,2026-01-05,Cold-weather range,160,101.8,-15,100,25.4')
})

test('official prices are fetched only on request, sending a city id, and applied', async ({ page }) => {
  let sent = ''
  await page.route('https://www150.statcan.gc.ca/**', (route) => {
    sent = route.request().postData() ?? ''
    return route.fulfill({ json: [1.5, 2].map((v) => ({ object: { vectorDataPoint: [{ refPer: '2026-10-01', value: v * 100 }] } })), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } })
  })
  await page.route('https://www.bankofcanada.ca/**', (route) => route.fulfill({ json: { observations: [{ d: '2026-11-20', FXUSDCAD: { v: '1.4' } }] }, headers: { 'access-control-allow-origin': '*' } }))
  await openLab(page)
  await tab(page, 'Costs')
  expect(sent).toBe('')
  await page.getByRole('button', { name: 'Use latest official prices' }).click()
  await expect(page.getByText('Regular gasoline, Toronto, 2026-10')).toBeVisible()
  expect(JSON.parse(sent).map((x: { coordinate: string }) => x.coordinate)).toEqual(['9.2.0.0.0.0.0.0.0.0', '9.6.0.0.0.0.0.0.0.0'])
  await expect(page.getByLabel(/^Fuel, C\$/)).toHaveValue('1.5')
  await expect(page.getByLabel(/^USD to local rate/)).toHaveValue('1.4')
})

test('unreachable price feeds leave the defaults and say so', async ({ page, external }) => {
  await openLab(page)
  await tab(page, 'Costs')
  await page.getByRole('button', { name: 'Use latest official prices' }).click()
  await expect(page.getByRole('alert')).toContainText('Defaults are unchanged')
  await expect(page.getByLabel(/^Fuel, C\$/)).toHaveValue('1.837')
  expect(new Set(external)).toEqual(new Set(['www150.statcan.gc.ca', 'www.bankofcanada.ca']))
  external.length = 0
})

test('an imported fleet and edited settings survive a reload, and the fleet can be removed', async ({ page }) => {
  await importFleet(page, 'mine.csv', TRIP)
  await tab(page, 'Charging')
  await page.getByLabel(/^Required buffer/).fill('20')
  await tab(page, 'Assumptions')
  await page.getByLabel('Ford E-Transit 350 price').fill('60000')
  await page.reload()
  await expect(status(page)).toContainText('Your data, in this browser only')
  await expect(fleetPick(page)).toHaveValue('own')
  await tab(page, 'Charging')
  await expect(page.getByLabel(/^Required buffer/)).toHaveValue('20')
  await tab(page, 'Assumptions')
  await expect(page.getByLabel('Ford E-Transit 350 price')).toHaveValue('60000')
  await tab(page, 'Your data')
  await page.getByRole('button', { name: 'Remove my fleet from this browser' }).click()
  await expect(status(page)).toContainText('Synthetic sample data')
  await page.reload()
  await expect(status(page)).toContainText('Synthetic sample data')
})

test('a settings link carries the settings and no trips', async ({ page, browser, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await importFleet(page, 'mine.csv', TRIP.replace('Van 1', 'SECRET-VAN'))
  await tab(page, 'Charging')
  await page.getByLabel(/^Required buffer/).fill('22')
  await page.locator('summary', { hasText: 'Export' }).click()
  await page.getByRole('button', { name: 'Copy settings link' }).click()
  await expect(page.getByText('It contains no GPS data.')).toBeVisible()
  const url = await page.evaluate(() => navigator.clipboard.readText())
  const { inflateRawSync } = await import('node:zlib')
  const json = inflateRawSync(Buffer.from(url.split('#s=')[1], 'base64url')).toString()
  expect(json).toContain('"bufferPct":22')
  expect(json).not.toContain('SECRET-VAN')
  expect(Object.keys(JSON.parse(json)).sort()).toEqual(['charging', 'climate', 'curve', 'customModels', 'energy', 'fit', 'modelEdits', 'tco'])
  const other = await browser.newContext()
  await other.route('**/*', (r) => (r.request().url().startsWith(new URL(url).origin) ? r.continue() : r.abort()))
  const p2 = await other.newPage()
  await openLab(p2, url)
  await tab(p2, 'Charging')
  await expect(p2.getByLabel(/^Required buffer/)).toHaveValue('22')
  await other.close()
})

test('a custom model can be added, chosen and removed', async ({ page }) => {
  await importFleet(page, 'mine.csv', TRIP)
  await tab(page, 'Assumptions')
  await page.getByRole('button', { name: 'Add a model' }).click()
  await page.getByLabel('Name').fill('Test EV')
  await page.getByRole('button', { name: 'Add to catalogue' }).click()
  await setTemp(page, 21)
  await pickModel(page, 'Van 1', 'Test EV')
  expect((await result(page, 'Van 1')).best_fit_model).toBe('Test EV')
  await tab(page, 'Assumptions')
  await page.locator('#panel tr', { hasText: 'Test EV' }).getByRole('button', { name: 'Remove' }).click()
  await expect(page.locator('#panel tr', { hasText: 'Test EV' })).toHaveCount(0)
})

test('results CSV has one row per vehicle, and the sample GPS CSV imports back', async ({ page }) => {
  await openLab(page)
  const [name, csv] = await exportCsv(page, 'Results CSV')
  expect(name).toBe('fleet-ev-results.csv')
  expect(csv.split('\n')).toHaveLength(13)
  expect(csv.split('\n').slice(1).every((l) => l.endsWith(',yes'))).toBe(true)
  await tab(page, 'Your data')
  const [file, gps] = await download(page, page.getByRole('button', { name: 'Download this synthetic fleet as GPS CSV' }))
  expect(file).toBe('synthetic-toronto-gps-7-days.csv')
  await importFleet(page, file, gps)
  await expect(status(page)).toContainText('12 vehicles')
})

test('the printed report is complete and labelled', async ({ page }) => {
  await openLab(page)
  await page.evaluate(() => dispatchEvent(new Event('beforeprint')))
  await expect(page.locator('.report')).toContainText('SYNTHETIC SAMPLE DATA')
  await expect(page.locator('.report tbody tr')).toHaveCount(12)
  await expect(page.locator('.report')).toContainText('Phase 1: go first:')
})
