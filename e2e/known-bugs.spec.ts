// Each test states the correct behaviour of a reported bug. test.fail flips to a plain test in the PR that fixes it.
import type { Page } from '@playwright/test'
import { test, expect as slow, importFleet, analyse, fleetPick, upload, alert, status, result, tab, kpi, openLab, openExport, setTemp, pointsCsv, gpx, north, track, TRIP } from './fixtures.ts'

const expect = slow.configure({ timeout: 20_000 })

const trips = (head: string, ...rows: string[]) => [head, ...rows].join('\n') + '\n'

test.describe('clock changes at a 15-degree longitude line', () => {
  // 60 steps of 0.02 degree longitude at 43 N: 6371 x cos(43) x pi/180 x 1.2 = 97.6 km in one hour, across 82.5 W.
  test('a drive west across 82.5 W keeps its length and duration', async ({ page }) => {
    await importFleet(page, 'p.csv', pointsCsv(track(61, (i) => [43, -81.9 - i * 0.02], 'Van 1', 'Z')))
    await expect(status(page)).toContainText('1 vehicles · 1 trips')
    expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '97.6' })
  })
  test('a short trip that starts and ends in different bands is kept', async ({ page }) => {
    await importFleet(page, 't.csv', trips('vehicle,start,end,distance,start lat,start lng,end lat,end lng',
      'Van 1,2026-01-05T13:00:00Z,2026-01-05T13:40:00Z,60,43,-82,43,-83', 'Van 1,2026-01-05T15:00:00Z,2026-01-05T15:40:00Z,60,43,-83,43,-82'))
    await expect(status(page)).toContainText('1 vehicles · 2 trips')
  })
  test('a Trips2 file with Z stamps and only a stop point imports', async ({ page }) => {
    await importFleet(page, 't.csv', trips('DeviceId,Start,Stop,Distance,StopPointX,StopPointY', '27,2026-01-14T12:02:11Z,2026-01-14T12:31:32Z,18.4,-79.4102,43.6561'))
    expect(await result(page, '27')).toMatchObject({ avg_day_km: '18.4' })
  })
})

test.describe('dates', () => {
  // 13/11 can only be day-first, so 05/11 in the same file is 5 November.
  test('a day-first file is read day-first throughout', async ({ page }) => {
    await importFleet(page, 't.csv', trips('vehicle,start,end,distance', ...['05', '13'].map((d) => `Van 1,${d}/11/2025 08:00,${d}/11/2025 10:00,50`)))
    await expect(status(page)).toContainText(/Nov\.? 5, 2025 to Nov\.? 13, 2025/)
  })
  test('dates that do not exist are not turned into other days', async ({ page }) => {
    await importFleet(page, 't.csv', trips('vehicle,start,end,distance', 'Van 1,2026-01-05 08:00,2026-01-05 10:00,50', 'Van 1,2026-02-30 08:00,2026-02-30 10:00,50'))
    await expect(status(page)).toContainText('1 vehicles · 1 trips')
  })
})

// 15 steps before and 14 after a 500 km relocation, each 0.005 degree: 29 x 0.55597 = 16.1 km driven.
test('a relocation is not counted as driving', async ({ page }) => {
  await importFleet(page, 'p.csv', pointsCsv(track(31, (i) => [43 + i * 0.005 + (i > 15 ? 4.5 : 0), -79.5])))
  expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '16.1' })
})

test.describe('numbers and units', () => {
  // 33.358 km = 20.728 mi on the odometer.
  test('an odometer in miles gives the same distance as the GPS', async ({ page }) => {
    const rows = north().map((r, i) => [...r, (1000 + (i * 1.11195) / 1.60934).toFixed(3)].join(','))
    await importFleet(page, 'p.csv', ['vehicle,timestamp,lat,lng,Odometer (mi)', ...rows].join('\n'))
    expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '33.4' })
  })
  test('"N/A" is not a distance of zero', async ({ page }) => {
    await importFleet(page, 't.csv', trips('vehicle,start,end,distance', 'Van 1,2026-01-05 08:00,2026-01-05 10:00,50', 'Van 1,2026-01-06 08:00,2026-01-06 10:00,N/A'))
    await expect(status(page)).toContainText('1 vehicles · 1 trips')
  })
  test('a decimal comma with three digits is a decimal in a decimal-comma file', async ({ page }) => {
    await importFleet(page, 't.csv', trips('vehicle;start;end;distance', 'Van 1;2026-01-05 08:00;2026-01-05 10:00;12,345', 'Van 1;2026-01-05 12:00;2026-01-05 13:00;7,5'))
    expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '19.8' })
  })
  test('a space thousands separator is read', async ({ page }) => {
    await importFleet(page, 't.csv', trips('vehicle;start;end;distance', 'Van 1;2026-01-05 00:00;2026-01-05 23:00;1 034,5'))
    expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '1034.5' })
  })
  test('GPSLogger speed is recognised as m/s', async ({ page }) => {
    await upload(page, [{ name: 'g.csv', data: 'time,lat,lon,elevation,accuracy,bearing,speed,satellites,provider\n2026-01-14T12:31:00.000Z,43.6581,-79.405,92,4,61,10.5,14,gps\n2026-01-14T12:32:10.000Z,43.661,-79.397,95,3,63,12.5,15,gps\n' }])
    await expect(page.getByLabel('Speed unit')).toHaveValue('mps')
  })
})

test.describe('data lost on import without a word', () => {
  test('unreadable rows are counted on the results', async ({ page }) => {
    await importFleet(page, 't.csv', trips('vehicle,start,end,distance', 'Van 1,2026-01-05 08:00,2026-01-05 10:00,50', 'Van 1,2026-01-06 08:00,late,50', 'Van 1,2026-01-07 08:00,2026-01-07 10:00'))
    await expect(status(page)).toContainText('2 of 3 rows could not be read')
  })
  test('a truncated GPX file says it is incomplete', async ({ page }) => {
    const whole = gpx(north())
    await upload(page, [{ name: 'x.gpx', data: whole.slice(0, Math.floor(whole.length / 2)) }])
    await expect(page.locator('.import')).toContainText('cut off')
  })
  test('several CSV files are refused, not cut to the first', async ({ page }) => {
    await upload(page, [{ name: 'a.csv', data: TRIP }, { name: 'b.csv', data: TRIP.replace('Van 1', 'Van 2') }])
    await expect(alert(page)).toContainText('one CSV or JSON file at a time')
  })
  test('a stray inch mark does not swallow the rest of the file', async ({ page }) => {
    await importFleet(page, 't.csv', trips('vehicle,start,end,distance', 'Van 24" box,2026-01-05 08:00,2026-01-05 10:00,50', 'Van 2,2026-01-05 08:00,2026-01-05 10:00,50'))
    await expect(status(page)).toContainText('2 vehicles · 2 trips')
  })
})

test.describe('malformed settings', () => {
  const link = async (settings: unknown) => {
    const { deflateRawSync } = await import('node:zlib')
    return `/app#s=${deflateRawSync(JSON.stringify(settings)).toString('base64url')}`
  }
  test('a link with the wrong shapes does not break the lab, now or on the next visit', async ({ page }) => {
    await page.goto(await link({ energy: { speedMult: null }, customModels: [null], tco: { years: 'x', currency: {} } }))
    await expect(status(page)).toBeVisible()
    await page.goto('/docs')
    await openLab(page)
    await expect(page.locator('.kpis')).not.toContainText('NaN')
  })
  test('text where the battery health number belongs does not pass every day', async ({ page }) => {
    await importFleet(page, 't.csv', TRIP)
    await page.goto('/docs')
    await page.goto(await link({ energy: { batteryHealthPct: 'abc' } }))
    await setTemp(page, -35)
    await expect(kpi(page, 'Days completed')).toHaveText('0.0%')
  })
  test('an unreadable link says so', async ({ page }) => {
    await page.goto('/app#s=not-a-link')
    await expect(page.getByText(/settings link could not be read/i)).toBeVisible()
  })
  test('a damaged saved fleet does not leave the lab loading for ever', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('fel-fleet-v1', '{"name":"x","trips":[{'))
    await page.goto('/app')
    await expect(status(page)).toContainText('Synthetic sample data')
  })
})

test.describe('vehicle edits', () => {
  const edit = async (page: Page) => {
    await tab(page, 'Vehicles')
    await page.getByLabel('Van 1 class').selectOption('car')
    await page.getByLabel('Van 2 class').selectOption('pickup')
    await page.getByRole('button', { name: 'Van 2', exact: true }).click()
    await page.getByLabel(/^Default load/).fill('450')
  }
  const kept = async (page: Page) => {
    await tab(page, 'Vehicles')
    await expect(page.getByLabel('Van 2 class')).toHaveValue('pickup')
    await expect(page.getByLabel('Van 1 class')).toHaveValue('car')
    if (!(await page.getByLabel(/^Default load/).count())) await page.getByRole('button', { name: 'Van 2', exact: true }).click()
    await expect(page.getByLabel(/^Default load/)).toHaveValue('450')
  }
  const TWO = TRIP + 'Van 2,2026-01-05 08:00,2026-01-05 12:00,160,0\n'

  test('changing two vehicles keeps both changes after a reload', async ({ page }) => {
    await importFleet(page, 't.csv', TWO)
    await edit(page)
    await page.reload()
    await kept(page)
  })
  test('a sample and back keeps the changes, and the sample keeps its own', async ({ page }) => {
    await importFleet(page, 't.csv', TWO)
    await edit(page)
    await fleetPick(page).selectOption('mixed')
    await expect(status(page)).toContainText('10 vehicles')
    const first = page.locator('#panel select[aria-label$=" class"]').first()
    await first.selectOption('car')
    await fleetPick(page).selectOption('own')
    await expect(status(page)).toContainText('2 vehicles')
    await kept(page)
    await fleetPick(page).selectOption('mixed')
    await expect(status(page)).toContainText('10 vehicles')
    await expect(first).toHaveValue('car')
  })
  test('weather that arrives after an edit does not undo it', async ({ page }) => {
    let arrive = () => {}
    const held = new Promise<void>((ok) => { arrive = ok })
    await page.route('https://archive-api.open-meteo.com/**', async (route) => {
      if (!route.request().url().includes('start_date=2026-01-05')) return route.abort('blockedbyclient')
      await held
      const time = Array.from({ length: 24 }, (_, h) => `2026-01-05T${String(h).padStart(2, '0')}:00`)
      return route.fulfill({ json: { hourly: { time, temperature_2m: time.map(() => -15) } }, headers: { 'access-control-allow-origin': '*' } })
    })
    const head = 'vehicle,start,end,distance,load,start lat,start lng,end lat,end lng\n'
    await importFleet(page, 't.csv', head + ['Van 1', 'Van 2'].map((v) => `${v},2026-01-05 08:00,2026-01-05 12:00,160,,43.7,-79.6,43.7,-79.6\n`).join(''))
    await edit(page)
    await expect(status(page)).toContainText('Fetching historical temperatures')
    arrive()
    await expect(status(page)).toContainText('Open-Meteo temperatures on 2 of 2 trips')
    await kept(page)
  })
  test('a new import starts without the changes made to the last one', async ({ page }) => {
    await importFleet(page, 't.csv', TWO)
    await edit(page)
    await tab(page, 'Your data')
    await page.locator('input[type=file]').setInputFiles({ name: 'u.csv', mimeType: 'text/plain', buffer: Buffer.from(TWO.replace(/,0\n/g, ',\n')) })
    await analyse(page)
    await tab(page, 'Vehicles')
    await expect(page.getByLabel('Van 1 class')).toHaveValue('van')
    await expect(page.getByLabel('Van 2 class')).toHaveValue('van')
  })
})

test.describe('climate profile', () => {
  const at = (lat: number, lng: number) => `vehicle,start,end,distance,load,start lat,start lng,end lat,end lng\nVan 1,2026-01-05 08:00,2026-01-05 12:00,160,0,${lat},${lng},${lat},${lng}\n`
  const shown = async (page: Page, name: string) => {
    await tab(page, 'Assumptions')
    await expect(page.getByLabel('Start from')).toHaveValue(name)
  }
  test('one picked by the user survives a reload and another fleet', async ({ page }) => {
    await openLab(page)
    await tab(page, 'Assumptions')
    await page.getByLabel('Start from').selectOption('Winnipeg')
    await page.reload()
    await shown(page, 'Winnipeg')
    await fleetPick(page).selectOption('rural')
    await expect(status(page)).toContainText('8 vehicles')
    await expect(status(page)).toContainText('using the Winnipeg climate profile')
    await page.getByLabel('Start from').selectOption('Nearest to the fleet')
    await shown(page, 'Red Deer')
    await page.reload()
    await shown(page, 'Toronto')
  })
  test('one picked by the sender arrives through a link', async ({ page, browser, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openLab(page)
    await tab(page, 'Assumptions')
    await page.getByLabel('Start from').selectOption('Winnipeg')
    await openExport(page)
    await page.getByRole('button', { name: 'Copy settings link' }).click()
    await expect(page.getByText('It contains no GPS data.')).toBeVisible()
    const url = await page.evaluate(() => navigator.clipboard.readText())
    const other = await browser.newContext()
    await other.route('**/*', (r) => (r.request().url().startsWith(new URL(url).origin) ? r.continue() : r.abort()))
    const p2 = await other.newPage()
    await openLab(p2, url)
    await shown(p2, 'Winnipeg')
    await p2.reload()
    await shown(p2, 'Winnipeg')
    await other.close()
  })
  test('a new fleet picks the nearest one when nothing was chosen', async ({ page }) => {
    await importFleet(page, 't.csv', at(51.05, -114.07))
    await shown(page, 'Calgary')
    await page.reload()
    await shown(page, 'Calgary')
  })
})

test.describe('edits made after a settings link', () => {
  const buffer = async (page: Page, set?: string) => {
    await tab(page, 'Charging')
    if (set) await page.getByLabel(/^Required buffer/).fill(set)
    return page.getByLabel(/^Required buffer/)
  }
  const copy = async (page: Page, says: string) => {
    await openExport(page)
    await page.getByRole('button', { name: 'Copy settings link' }).click()
    await expect(page.getByText(says)).toBeVisible()
  }
  test('is copied survive a reload', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openLab(page)
    await copy(page, 'Settings link copied')
    await buffer(page, '25')
    await page.reload()
    await expect(await buffer(page)).toHaveValue('25')
  })
  test('is opened survive a reload, and the link itself is applied', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openLab(page)
    await buffer(page, '30')
    await copy(page, 'Settings link copied')
    const url = await page.evaluate(() => navigator.clipboard.readText())
    await buffer(page, '5')
    await page.goto('/docs')
    await openLab(page, url)
    await expect(await buffer(page)).toHaveValue('30')
    await expect(page).toHaveURL(/\/app$/)
    await page.reload()
    await expect(await buffer(page, '25')).toHaveValue('25')
    await page.reload()
    await expect(await buffer(page)).toHaveValue('25')
  })
  test('is shown in the address bar, because the clipboard was refused, survive a reload', async ({ page }) => {
    await page.addInitScript(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('refused')) })
    await openLab(page)
    await copy(page, 'The address bar now holds the settings link')
    await expect(page).toHaveURL(/#s=.+/)
    await buffer(page, '25')
    await expect(page).toHaveURL(/\/app$/)
    await page.reload()
    await expect(await buffer(page)).toHaveValue('25')
  })
})

// Two E-Transits at 11.3 kW each plugged in on arrival draw 22.6 kW, whatever cap the managed plan keeps to.
test('the unmanaged peak ignores the site cap it is compared against', async ({ page }) => {
  await importFleet(page, 't.csv', TRIP + 'Van 2,2026-01-05 08:00,2026-01-05 12:00,160,0\n')
  await tab(page, 'Vehicles')
  for (const v of ['Van 1', 'Van 2']) await page.getByLabel(`${v} EV model`).selectOption({ label: 'Ford E-Transit 350' })
  await tab(page, 'Charging')
  await page.getByLabel(/^Site power cap/).fill('12')
  await expect(page.locator('.kpi', { hasText: 'Peak depot load' })).toContainText('vs 23 kW')
})

test('the same trip twice in a file is counted once', async ({ page }) => {
  await importFleet(page, 't.csv', TRIP + 'Van 1,2026-01-05 08:00,2026-01-05 12:00,160,0\n')
  expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '160' })
  await expect(status(page)).toContainText('1 vehicles · 1 trips')
  await expect(status(page)).toContainText('1 repeated trip left out')
})

test('the same MyGeotab trip twice is counted once', async ({ page }) => {
  const t = { device: { id: 'Van 1' }, start: '2026-01-05T13:00:00Z', stop: '2026-01-05T17:00:00Z', distance: 160 }
  await importFleet(page, 't.json', JSON.stringify([t, t, t]), false)
  expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '160' })
  await expect(status(page)).toContainText('2 repeated trips left out')
})

test.describe('leaving the Overview raises no page error', () => {
  const leave = async (page: Page, zoom: (map: HTMLElement) => void, delays: number[]) => {
    await openLab(page)
    await page.locator('.leaflet-control-zoom-in').waitFor()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.waitForTimeout(1500)
    for (const ms of delays) {
      await tab(page, 'Overview')
      await page.locator('.leaflet-control-zoom-in').waitFor()
      await page.waitForTimeout(800)
      await page.locator('.leaflet-container').evaluate(zoom)
      await page.evaluate((d) => new Promise<void>((ok) => setTimeout(() => { document.getElementById('tab-Vehicles')!.click(); ok() }, d)), ms)
      await page.waitForTimeout(500)
    }
    expect(errors).toEqual([])
  }
  test('during a button zoom', async ({ page }) => {
    await leave(page, (map) => map.querySelector<HTMLElement>('.leaflet-control-zoom-in')!.click(), [0, 30, 100, 180])
  })
  test('during a wheel zoom', async ({ page }) => {
    await leave(page, (map) => {
      const r = map.getBoundingClientRect()
      map.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + 200, clientY: r.top + 200, deltaY: -120 }))
    }, [0, 20, 100, 180])
  })
  test('as soon as the map appears', async ({ page }) => {
    await openLab(page)
    await page.locator('.leaflet-control-zoom-in').waitFor()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    for (const ms of [5, 10, 20, 45, 100]) {
      await tab(page, 'Vehicles')
      await page.waitForTimeout(500)
      await page.evaluate(async (d) => {
        document.getElementById('tab-Overview')!.click()
        while (!document.querySelector('.leaflet-control-zoom-in')) await new Promise((ok) => setTimeout(ok, 1))
        await new Promise((ok) => setTimeout(ok, d))
        document.getElementById('tab-Vehicles')!.click()
      }, ms)
      await page.waitForTimeout(500)
    }
    expect(errors).toEqual([])
  })
})
