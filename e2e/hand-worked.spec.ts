// Every number here was worked out on paper from the documented model, not copied from the app.
import { test, expect, importFleet, setTemp, pickModel, result, exportCsv, kpi, tab, pointsCsv, gpx, north, track, TRIP } from './fixtures.ts'

/*
  Ford E-Transit: 89.9 kWh usable, 159 mi = 256 km rated -> 0.351171875 kWh/km.
  One 160 km trip, 08:00 to 12:00, empty. 40 km/h average, so every km is in the 30-60 band (x0.95): 152 weighted km.
  +21 C: 0.351171875 x 152 / 1.15 = 46.416 kWh, no cabin heat. Battery ends at 100 - 51.63 = 48.4%. Passes.
  -15 C: 0.351171875 x 152 / 0.54 = 98.848 kWh. Reference speed 50 km/h needs 3.2 h, so 0.8 h of cabin heat at
         (15 - -15)/(15 - -25) x 5 kW = 3.75 kW = 3.0 kWh. Total 101.848 kWh. The 15% buffer is 13.485 kWh.
         Shortfall = 101.848 - 89.9 + 13.485 = 25.433 kWh. It would pass at +21 C, so the cause is the cold.
  Annual: one trip, span floored at 7 days: 160 x 365/7 = 8342.86 km. Fuel 8342.86 x 15.5/100 = 1293.14 L x 1.837 = C$2,375.50.
*/
test('one trip: passes at +21 C, fails at -15 C by 25.4 kWh because of the cold, and the annual figures follow', async ({ page }) => {
  await importFleet(page, 'trips.csv', TRIP)
  await setTemp(page, 21)
  await pickModel(page, 'Van 1', 'Ford E-Transit 350')
  await expect(kpi(page, 'Days completed')).toHaveText('100.0%')
  expect(await result(page, 'Van 1')).toMatchObject({ best_fit_model: 'Ford E-Transit 350', days_completed_pct: '100', avg_day_km: '160', annual_km: '8343', data_is_synthetic: 'no' })
  await tab(page, 'Costs')
  await page.getByLabel('Show').selectOption('Van 1')
  await expect(page.locator('.mini-stats')).toContainText('Fuel a year todayC$2,376')
  await expect(page.locator('.mini-stats')).toContainText('8,343 km')

  await setTemp(page, -15)
  await expect(kpi(page, 'Days completed')).toHaveText('0.0%')
  const [name, csv] = await exportCsv(page, 'Failure days CSV')
  expect(name).toBe('fleet-ev-failure-days.csv')
  expect(csv).toBe('vehicle,date,reason,km,kwh,temp_c,start_soc_pct,shortfall_kwh\nVan 1,2026-01-05,Cold-weather range,160,101.8,-15,100,25.4')
})

/*
  Overnight charge at +21 C: the pack needs 46.416 kWh. Plug power is min(11.5, 11.3) = 11.3 kW, efficiency 90%, so the
  grid gives 46.416 / 0.9 = 51.57 kWh, peak 11.3 kW, one charger, no swaps.
*/
test('the night after it: 52 kWh from the grid at 11 kW on one charger', async ({ page }) => {
  await importFleet(page, 'trips.csv', TRIP)
  await setTemp(page, 21)
  await pickModel(page, 'Van 1', 'Ford E-Transit 350')
  await tab(page, 'Charging')
  await expect(page.locator('#panel')).toContainText('1 chargers for 1 vehicles, peak 11 kW')
  await expect(page.locator('#panel')).toContainText('52 kWh from the grid, 0 plug swaps')
})

// E-Transit payload is 3,320 lb = 1,506 kg, so 1,507 kg is over it on every EV van that carries less; 1,506 kg is not.
test('payload limit is exact', async ({ page }) => {
  await importFleet(page, 'trips.csv', TRIP.replace(',160,0', ',20,1507') + 'Van 2,2026-01-05 08:00,2026-01-05 08:30,20,1506\n')
  await setTemp(page, 21)
  await pickModel(page, 'Van 1', 'Ford E-Transit 350')
  await pickModel(page, 'Van 2', 'Ford E-Transit 350')
  expect(await result(page, 'Van 1')).toMatchObject({ days_completed_pct: '0', failure_reasons: 'Load exceeds payload: 1', verdict: 'hold' })
  expect(await result(page, 'Van 2')).toMatchObject({ days_completed_pct: '100' })
})

// 30 steps of 0.01 degree latitude: 30 x 1.11195 = 33.36 km.
test('GPS distance from a point CSV and from GPX', async ({ page }) => {
  await importFleet(page, 'points.csv', pointsCsv(north()))
  expect(await result(page, 'Van 1')).toMatchObject({ operating_days: '1', avg_day_km: '33.4', max_day_km: '33.4' })
  await importFleet(page, 'track.gpx', gpx(north(), 'GPX van'))
  expect(await result(page, 'GPX van')).toMatchObject({ avg_day_km: '33.4' })
})

// 8 x 0.556 = 4.45 km out, parked 30 minutes, 4.45 km back: 8.90 km in two trips.
test('a 30-minute stop splits a drive in two', async ({ page }) => {
  const out = track(9, (i) => [43 + i * 0.005, -79.5])
  const back = track(48, (i) => [43.04 - Math.max(0, i - 39) * 0.005, -79.5]).slice(39)
  await importFleet(page, 'points.csv', pointsCsv([...out, ...back]))
  await expect(page.locator('.status-line')).toContainText('1 vehicles · 2 trips')
  expect(await result(page, 'Van 1')).toMatchObject({ avg_day_km: '8.9' })
})
