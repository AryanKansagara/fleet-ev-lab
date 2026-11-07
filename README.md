# Fleet EV Lab

Upload GPS trips and see which vehicles could go electric, on which EV models, with what charging, and what it would cost or save, including in deep winter.

**Live:** https://fleet-ev-lab.vercel.app

## The pain

Geotab's analysis of 5.2 million trips found observed range peaking near 115% of rated at 21°C and falling to about 54% at -15°C. A spec-sheet range says little about whether a specific van finishes its real route in a cold snap, after a shared charger left it short, with 900 kg in the back. Operators name the order themselves: charging first, then payload, then daily mileage.

Geotab sells an EV suitability assessment. This is an independent, open take on the same question, not a replacement. It is not affiliated with Geotab, and it does not reproduce Geotab's curves: it fits its own labelled curve to the two published points, and every knot is editable.

## Features

- **Import:** GPX, GPS-point CSV or trip-summary CSV with column mapping, for generic telematics exports. Trip segmentation by stop duration, GPS noise and jump filtering, idling detection, depot inference and return-to-base scoring.
- **Weather:** historical temperature per trip from the Open-Meteo archive, cached, with an editable climate profile as the offline fallback. The winter stress test replays the coldest week in five years for that location.
- **Catalogue:** a dated constants file with sources per model, editable and user-addable. It flags ended production (BrightDrop, F-150 Lightning) and which figures could not be confirmed.
- **Energy model:** per-trip kWh from distance, speed bands, the temperature curve, HVAC and payload, all configurable.
- **Simulation:** day-by-day state of charge with shared chargers, a least-slack overnight scheduler, optional mid-day top-ups and a required buffer. Every failed day is tested to find out why it failed.
- **Outputs:** days completed, failure days and reasons, best-fit model, depot charger count and peak kW, 5 to 10-year TCO with a crossover year, CO2, and rollout phases.
- **Views:** Leaflet map with animated trips coloured by state of charge, vehicle-by-day heatmap, a temperature slider that reflows the whole fleet, charging Gantt with load curve, and a TCO crossover chart.
- **Export:** CSV, a print-friendly report, and a shareable URL holding settings only.
- **Samples:** all synthetic, on real road geometry. Toronto delivery vans, rural Alberta service trucks, and a Hamilton mixed fleet with a payload problem.

## Privacy

Your GPS data stays in the browser: there is no server, and share links carry settings only. Two things use the network. Open-Meteo receives each depot location rounded to about 10 km plus a date range. The OpenStreetMap tile server sees the area you are viewing.

## Model limits

- The range curve rests on two published fleet averages. The shape between them is an assumption.
- Vehicle specs and default prices are starting points, not quotes. Unconfirmed figures are flagged per model.
- Time zones are approximated from longitude, without DST. That is enough to find "overnight", not for hour-level tariffs.
- Depot plugs are not preempted once a session starts.
- Incentives default to none. Status was checked on 2026-11-05 and is listed in the app.

## Run locally

```
npm install
npm run dev
npm test
npm run build
```

`scripts/bake-routes.mjs` rebuilds the road geometry for the synthetic samples.
