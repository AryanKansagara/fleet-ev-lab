// Each test states the correct behaviour of a reported bug. test.fail flips to a plain test in the PR that fixes it.
import { test, expect as slow, importFleet, upload, alert, status, result, tab, kpi, openLab, setTemp, pointsCsv, gpx, north, track, TRIP } from './fixtures.ts'

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
test.fail('a relocation is not counted as driving', async ({ page }) => {
  await importFleet(page, 'p.csv', pointsCsv(track(31, (i) => [43 + i * 0.005 + (i > 15 ? 4.5 : 0), -79.5])))
  expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '16.1' })
})

test.describe('numbers and units', () => {
  // 33.358 km = 20.728 mi on the odometer.
  test.fail('an odometer in miles gives the same distance as the GPS', async ({ page }) => {
    const rows = north().map((r, i) => [...r, (1000 + (i * 1.11195) / 1.60934).toFixed(3)].join(','))
    await importFleet(page, 'p.csv', ['vehicle,timestamp,lat,lng,Odometer (mi)', ...rows].join('\n'))
    expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '33.4' })
  })
  test.fail('"N/A" is not a distance of zero', async ({ page }) => {
    await importFleet(page, 't.csv', trips('vehicle,start,end,distance', 'Van 1,2026-01-05 08:00,2026-01-05 10:00,50', 'Van 1,2026-01-06 08:00,2026-01-06 10:00,N/A'))
    await expect(status(page)).toContainText('1 vehicles · 1 trips')
  })
  test.fail('a decimal comma with three digits is a decimal in a decimal-comma file', async ({ page }) => {
    await importFleet(page, 't.csv', trips('vehicle;start;end;distance', 'Van 1;2026-01-05 08:00;2026-01-05 10:00;12,345', 'Van 1;2026-01-05 12:00;2026-01-05 13:00;7,5'))
    expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '19.8' })
  })
  test.fail('a space thousands separator is read', async ({ page }) => {
    await importFleet(page, 't.csv', trips('vehicle;start;end;distance', 'Van 1;2026-01-05 00:00;2026-01-05 23:00;1 034,5'))
    expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '1034.5' })
  })
  test.fail('GPSLogger speed is recognised as m/s', async ({ page }) => {
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
  test.fail('a link with the wrong shapes does not break the lab, now or on the next visit', async ({ page }) => {
    await page.goto(await link({ energy: { speedMult: null }, customModels: [null], tco: { years: 'x', currency: {} } }))
    await expect(status(page)).toBeVisible()
    await page.goto('/docs')
    await openLab(page)
    await expect(page.locator('.kpis')).not.toContainText('NaN')
  })
  test.fail('text where the battery health number belongs does not pass every day', async ({ page }) => {
    await importFleet(page, 't.csv', TRIP)
    await page.goto('/docs')
    await page.goto(await link({ energy: { batteryHealthPct: 'abc' } }))
    await setTemp(page, -35)
    await expect(kpi(page, 'Days completed')).toHaveText('0.0%')
  })
  test.fail('an unreadable link says so', async ({ page }) => {
    await page.goto('/app#s=not-a-link')
    await expect(page.getByText(/settings link could not be read/i)).toBeVisible()
  })
  test.fail('a damaged saved fleet does not leave the lab loading for ever', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('fel-fleet-v1', '{"name":"x","trips":[{'))
    await page.goto('/app')
    await expect(status(page)).toContainText('Synthetic sample data')
  })
})

test.fail('changing two vehicles keeps both changes after a reload', async ({ page }) => {
  await importFleet(page, 't.csv', TRIP + 'Van 2,2026-01-05 08:00,2026-01-05 12:00,160,0\n')
  await tab(page, 'Vehicles')
  await page.getByLabel('Van 1 class').selectOption('car')
  await page.getByLabel('Van 2 class').selectOption('pickup')
  await page.reload()
  await tab(page, 'Vehicles')
  await expect(page.getByLabel('Van 2 class')).toHaveValue('pickup')
  await expect(page.getByLabel('Van 1 class')).toHaveValue('car')
})

test.fail('a climate profile picked by the user survives a reload', async ({ page }) => {
  await openLab(page)
  await tab(page, 'Assumptions')
  await page.getByLabel('Start from').selectOption('Winnipeg')
  await page.reload()
  await tab(page, 'Assumptions')
  await expect(page.getByLabel('Start from')).toHaveValue('Winnipeg')
})

test.fail('edits made after copying a settings link survive a reload', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await openLab(page)
  await page.locator('summary', { hasText: 'Export' }).click()
  await page.getByRole('button', { name: 'Copy settings link' }).click()
  await expect(page.getByText('It contains no GPS data.')).toBeVisible()
  await tab(page, 'Charging')
  await page.getByLabel(/^Required buffer/).fill('25')
  await page.reload()
  await tab(page, 'Charging')
  await expect(page.getByLabel(/^Required buffer/)).toHaveValue('25')
})

// Two E-Transits at 11.3 kW each plugged in on arrival draw 22.6 kW, whatever cap the managed plan keeps to.
test.fail('the unmanaged peak ignores the site cap it is compared against', async ({ page }) => {
  await importFleet(page, 't.csv', TRIP + 'Van 2,2026-01-05 08:00,2026-01-05 12:00,160,0\n')
  await tab(page, 'Vehicles')
  for (const v of ['Van 1', 'Van 2']) await page.getByLabel(`${v} EV model`).selectOption({ label: 'Ford E-Transit 350' })
  await tab(page, 'Charging')
  await page.getByLabel(/^Site power cap/).fill('12')
  await expect(page.locator('.kpi', { hasText: 'Peak depot load' })).toContainText('vs 23 kW')
})

test.fail('the same trip twice in a file is counted once', async ({ page }) => {
  await importFleet(page, 't.csv', TRIP + 'Van 1,2026-01-05 08:00,2026-01-05 12:00,160,0\n')
  expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '160' })
})

test.describe('map', () => {
  test.use({ strictMap: true })
  test.fail('leaving the Overview during a zoom raises no page error', async ({ page }) => {
    await openLab(page)
    const zoom = page.locator('.leaflet-control-zoom-in')
    await expect(zoom).toBeVisible()
    await page.waitForTimeout(2500)
    const error = page.waitForEvent('pageerror', { timeout: 5000 }).catch(() => null)
    await zoom.evaluate((el: HTMLElement) => {
      el.click()
      requestAnimationFrame(() => setTimeout(() => document.getElementById('tab-Vehicles')!.click(), 0))
    })
    expect(await error).toBeNull()
  })
})
