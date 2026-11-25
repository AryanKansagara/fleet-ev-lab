import { test, expect, fleetPick, upload, importFleet, analyse, alert, status, result, tab, openLab, pointsCsv, north, TRIP } from './fixtures.ts'

const noFleet = async (page: import('@playwright/test').Page) => {
  await expect(status(page)).toContainText('Synthetic sample data')
  await expect(fleetPick(page).locator('option[value=own]')).toHaveCount(0)
}

const rejected: [string, string, string, RegExp][] = [
  ['an empty file', 'empty.csv', '', /no data rows/],
  ['a header with no rows', 'head.csv', 'vehicle,timestamp,lat,lng\n', /no data rows/],
  ['prose', 'notes.txt', 'hello there', /no data rows/],
  ['JSON that is not MyGeotab', 'x.json', '{"foo": 1}', /not a list of MyGeotab/],
  ['truncated MyGeotab JSON', 'x.json', '{"result":[{"device":{"id":"b1"},"start":"2026-01-14T12:', /not a list of MyGeotab/],
  ['GPX with no times', 'x.gpx', '<gpx><trk><trkpt lat="43" lon="-79"/></trk></gpx>', /no timestamped track points/],
  ['GPX cut off before its first point', 'x.gpx', '<?xml version="1.0"?><gpx><trk><trks', /no timestamped track points/],
  ['LogRecords without coordinates', 'x.json', '[{"dateTime":"2026-01-14T12:00:00Z","latitude":"x","longitude":"y"}]', /no usable coordinates/],
]
for (const [what, name, data, message] of rejected) {
  test(`rejected with a message: ${what}`, async ({ page }) => {
    await upload(page, [{ name, data }])
    await expect(alert(page)).toContainText(message)
    await noFleet(page)
  })
}

test('rejected with a message: unmapped columns, unreadable rows and a vehicle that never moves', async ({ page }) => {
  await upload(page, [{ name: 'a.csv', data: 'foo,bar\n1,2\n' }])
  await analyse(page)
  await expect(alert(page)).toContainText('Map these columns first: Trip start, Trip end, Distance.')
  await upload(page, [{ name: 'b.csv', data: 'vehicle,start,end,distance\nA,yesterday,today,far\n' }])
  await analyse(page)
  await expect(alert(page)).toContainText('None of the 1 rows could be read')
  await upload(page, [{ name: 'c.csv', data: 'vehicle,timestamp,lat,lng\nA,2026-01-05 08:00,43,-79\nA,2026-01-05 09:00,43,-79\n' }])
  await analyse(page)
  await expect(alert(page)).toContainText('No trips came out of that data')
  await noFleet(page)
})

test('a column can be mapped by hand, with BOM, CRLF and semicolons in the file', async ({ page }) => {
  await upload(page, [{ name: 'a.csv', data: '﻿who;leave;back;far\r\nTruck 9;2026-01-05 08:00;2026-01-05 10:00;80,5\r\n' }])
  for (const [label, col] of [['Vehicle', 'who'], ['Trip start', 'leave'], ['Trip end', 'back'], ['Distance', 'far']]) {
    await page.locator('.map-fields label', { has: page.getByText(label, { exact: true }) }).first().locator('select').selectOption({ label: col })
  }
  await analyse(page)
  await expect(status(page)).toContainText('1 vehicles · 1 trips')
  expect(await result(page, 'Truck 9')).toMatchObject({ avg_day_km: '80.5' })
})

// 100 mi x 1.60934 = 160.9 km.
test('miles in the header are converted', async ({ page }) => {
  await importFleet(page, 'mi.csv', 'vehicle,start,end,Distance (mi)\nVan 1,2026-01-05 08:00,2026-01-05 12:00,100\n')
  expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '160.9' })
})

test('MyGeotab Trip JSON and LogRecord JSON', async ({ page }) => {
  await importFleet(page, 'trips.json', '{"result":[{"device":{"id":"b2A"},"start":"2026-01-14T13:00:00Z","stop":"2026-01-14T13:30:00Z","distance":18.4,"idlingDuration":"00:03:12","stopPoint":{"x":-79.41,"y":43.66}}]}', false)
  expect(await result(page, 'b2A')).toMatchObject({ avg_day_km: '18.4' })
  const log = north().map((r) => ({ device: { id: 'b3' }, dateTime: `${r[1]}Z`, latitude: +r[2], longitude: +r[3], speed: 66 }))
  await importFleet(page, 'log.json', JSON.stringify(log))
  expect(await result(page, 'b3')).toMatchObject({ avg_day_km: '33.4' })
})

test('pasted CSV, and a headerless point file', async ({ page }) => {
  await openLab(page)
  await tab(page, 'Your data')
  await page.getByText('Or paste CSV').click()
  await page.getByLabel('Paste CSV').fill(TRIP)
  await page.getByRole('button', { name: 'Read pasted data' }).click()
  await analyse(page)
  expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '160' })
  await importFleet(page, 'taxi.txt', north().map((r) => ['7', r[1], (+r[3] - 37).toFixed(6), r[2]].join(',')).join('\n'))
  expect(await result(page, '7')).toMatchObject({ avg_day_km: '33.4' })
})

test('several GPX files become several vehicles', async ({ page }) => {
  const one = `<gpx><trk><trkseg>${north().map((r) => `<trkpt lat="${r[2]}" lon="${r[3]}"><time>${r[1]}Z</time></trkpt>`).join('')}</trkseg></trk></gpx>`
  await upload(page, [{ name: 'North.gpx', data: one }, { name: 'South.gpx', data: one }])
  await expect(page.getByText('62 track points in 2 vehicle(s)')).toBeVisible()
  await analyse(page)
  await expect(status(page)).toContainText('2 vehicles · 2 trips')
})

test('markup and formulas in a vehicle name stay text on screen and are neutralised in the export', async ({ page }) => {
  const evil = '<img src=x onerror=alert(1)>'
  await importFleet(page, 'x.csv', `vehicle,start,end,distance\n${evil},2026-01-05 08:00,2026-01-05 10:00,50\n=1+1,2026-01-05 08:00,2026-01-05 10:00,50\n`)
  await tab(page, 'Vehicles')
  await expect(page.getByRole('button', { name: evil, exact: true })).toBeVisible()
  await expect(page.locator('img[src=x]')).toHaveCount(0)
  expect(await result(page, "'=1+1")).toMatchObject({ avg_day_km: '50' })
})

test('GPS jumps and invalid coordinates are dropped and counted', async ({ page }) => {
  const rows = north()
  rows.splice(10, 0, ['Van 1', '2026-01-05T08:09:30', '50.000000', '-70.000000'])
  rows.push(['Van 1', '2026-01-05T08:40:00', '0', '0'])
  await importFleet(page, 'p.csv', pointsCsv(rows))
  expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '33.4' })
  await tab(page, 'Your data')
  await expect(page.getByText('33 points. Dropped 1 GPS jumps and 1 invalid coordinates.')).toBeVisible()
})
