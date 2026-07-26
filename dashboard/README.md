# Environmental Logger Dashboard

A small Next.js app to view the data the ESP32 uploads to the ingest server
(`../server.py`): stat tiles for the latest reading, a line chart per metric
(temperature, humidity, CO2, UV index), the raw readings table, and a photo
gallery.

## How it works

Every page load runs entirely on the server (a Next.js Server Component):
it calls `GET /api/readings` and `GET /api/photos` on your deployed ingest
server using an API key that lives only in server-side env vars — the key
is never sent to the browser. Filtering by device, time range, and row count
is done via the URL's query string (`?range=30d&device=esp32-01`), so the
page works with plain `<select>` + submit, no client-side data fetching.

One fetch (`limit=1000`) covers the whole time range per load; the device
list and every chart are derived from it, and the "table rows" filter just
slices that same result rather than making a second request. For a single
hobby device this is far more than enough — if you run several
high-frequency devices and need more than 1000 rows in a given range,
narrow the time range or raise `FETCH_CAP` in `app/page.tsx`.

## Setup

1. **Install deps**: `npm install`
2. **Copy `.env.example` to `.env.local`** and fill in:
   - `READINGS_API_URL` — your deployed ingest server, e.g.
     `https://your-app.onrender.com` (no trailing slash).
   - `READINGS_API_KEY` — the server's `READ_API_KEY` (or `API_KEY` if you
     didn't set a separate read key).
3. **Run locally**: `npm run dev`, then open `http://localhost:3000`.

## Deploy (Vercel)

1. Push this repo to GitHub (the `dashboard/` folder can live alongside the
   server code — Vercel will be pointed at this subfolder).
2. In the Vercel dashboard: **Add New → Project**, import the repo, and set
   **Root Directory** to `dashboard`. Vercel auto-detects Next.js — no other
   config needed.
3. Add `READINGS_API_URL` and `READINGS_API_KEY` as Environment Variables in
   the Vercel project settings (same values as your local `.env.local`).
4. Deploy. Vercel gives you a `https://<your-project>.vercel.app` URL.

Because every render is server-side and dynamic (`export const dynamic =
"force-dynamic"` in `app/page.tsx`), each page load makes a fresh request to
the ingest server — no stale caching to worry about, and no rebuild needed
to see new data.

## Notes

- Colors are assigned per `device_id` by a stable hash (see `lib/palette.ts`),
  so a device keeps the same chart color regardless of which other devices
  are currently in view.
- Dark mode follows the OS `prefers-color-scheme` setting automatically.
- If `READINGS_API_URL` / `READINGS_API_KEY` are missing or the ingest server
  is unreachable, the page shows an inline error banner instead of crashing.
