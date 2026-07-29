# ESP32 Environment Scout Project

## Ingestion Server

Takes the device's daily CSV uploads, authenticates them, drops the rows into
Postgres, and gives you a read-back endpoint to check what landed.

## Stack and deployment choice

**FastAPI + Supabase Postgres, running on Render.**

- FastAPI: the device sends custom headers (`X-API-Key`, `X-Device-Id`) plus a
  raw `text/csv` body, not JSON through a REST-style resource. That's awkward
  to shove through Supabase's auto-generated REST API, so a thin app layer that
  owns auth and parsing is about the right amount of code.
- Supabase: hosted Postgres with a dashboard for eyeballing rows, no extra infra
  cost.
- Render instead of Vercel: Vercel only runs FastAPI as serverless functions
  (`api/index.py` plus `vercel.json` rewrites, which is non-idiomatic wiring).
  For one device uploading once a day, that wiring buys you nothing. Render runs
  the same `uvicorn server:app` you'd run locally, as a normal persistent
  process, with a free tier and no serverless-specific code. If the free tier's
  spin-down behavior starts to bug you, Railway or Fly.io are drop-in swaps.

## Files

- [server.py](server.py): the FastAPI app (ingest, read-back, health).
- [schema.sql](schema.sql): Postgres schema plus the dedupe index.
- [requirements.txt](requirements.txt): Python deps.
- [.env.example](.env.example): required secrets.
- [render.yaml](render.yaml): Render deploy blueprint.
- [test_requests.sh](test_requests.sh): curl reproductions of the device's
  upload behavior, edge cases included.
- [Project_Code_361/Project_Code_361.ino](Project_Code_361/Project_Code_361.ino):
  firmware, with the HTTPS change already applied (see below).

## Setup

1. **Create the Supabase project**, then run [schema.sql](schema.sql) in the SQL
   editor.
2. **Grab the connection string**: hit **Connect** on the project, then open the
   **Session pooler** tab. Don't use "Direct connection" (Supabase wants IPv6 or
   a paid IPv4 add-on for that, and Render's outbound networking is IPv4-only
   anyway) and don't use "Transaction pooler" (it recycles backend connections
   mid-session, which breaks asyncpg's prepared statements). Session pooler is
   IPv4-friendly and hands each connection its own dedicated backend for the
   session, so prepared statements keep working.
3. **Copy `.env.example` to `.env`** and fill in `API_KEY` (generate one with
   `python -c "import secrets; print(secrets.token_urlsafe(32))"`) and
   `DATABASE_URL`.
4. **Install deps and run it locally**:
   ```bash
   pip install -r requirements.txt
   uvicorn server:app --reload
   ```
5. **Test** against `http://127.0.0.1:8000` using [test_requests.sh](test_requests.sh)
   (see Testing below).

## Deploy (Render)

1. Push this repo to GitHub.
2. In the Render dashboard: New, then Blueprint, then point it at the repo.
   Render reads [render.yaml](render.yaml).
3. Set `API_KEY`, `READ_API_KEY` (optional), and `DATABASE_URL` as env vars in
   the Render dashboard when it asks. They're marked `sync: false` in the
   blueprint so they never get written into the repo.
4. Once it's up, Render gives you an `https://<your-app>.onrender.com` URL. Check
   that `GET /health` returns `200`.

## Point the firmware at it

The credentials (`SECRET_AP_PASS`, `SECRET_STA_SSID`, `SECRET_STA_PASS`,
`SECRET_UPLOAD_KEY`) live in `Project_Code_361/secrets.h`, which is gitignored.
The `.ino` only references the macro names. Copy
[secrets.h.example](Project_Code_361/secrets.h.example) to `secrets.h` in the
same folder and fill in the real values. The Arduino IDE picks up same-folder
headers on its own.

Inside [Project_Code_361.ino](Project_Code_361/Project_Code_361.ino) the only
change you need is already in place:

- `UPLOAD_URL` now expects `https://...` (it was `http://...`).
- The POST uses `WiFiClientSecure` with `client.setInsecure()`, so there's no CA
  certificate baked into the firmware. Note that this skips certificate
  validation. That's fine for a hobby project talking to one known host, but it
  does mean someone in the right network position could intercept the connection.
  If you want real validation, swap `client.setInsecure()` for
  `client.setCACert(ROOT_CA_PEM)` using Render's CA chain.

Before you flash, edit these two lines to match your deployment:
```cpp
const char *UPLOAD_URL = "https://your-app.onrender.com/api/readings";
const char *UPLOAD_KEY = "<same value as API_KEY in .env>";
```

If you're porting the change somewhere else, it's roughly ten lines:
```cpp
WiFiClientSecure client;
client.setInsecure();               // or client.setCACert(ROOT_CA_PEM);

HTTPClient http;
http.begin(client, UPLOAD_URL);     // https:// URL
http.addHeader("Content-Type", "text/csv");
http.addHeader("X-API-Key", UPLOAD_KEY);
http.addHeader("X-Device-Id", DEVICE_ID);
int code = http.POST((uint8_t *)buf, n);
http.end();
```

**Why HTTPS isn't optional here:** the API key rides along as a plaintext
header. Over plain HTTP, anyone on the network path (the device's own AP clients,
an ISP, a compromised router) can read it and impersonate the device. HTTPS is
the thing that actually keeps the key safe in transit.

## How the ingest keeps the data honest

- A row only counts as "stored" after a successful `INSERT` commit. The endpoint
  returns 200 after that commit, never before.
- Malformed input (wrong field count, unparseable number) returns 400. The whole
  batch gets parsed before anything touches the database, so one bad line kills
  the entire POST instead of half-committing it. This matches how the device
  tracks its offset: it advances past the whole POSTed range on a 2xx, so a
  partial commit would be worse than rejecting everything.
- Any database error (connection failure and the like) returns 500, which lets
  the device's own retry logic take over. It only advances its offset on a 2xx.
- A bad or missing `X-API-Key` returns 401.
- Duplicate re-uploads (say the device offset got reset by a reflash or NVS
  clear) get deduped by a unique index on `(device_id, uptime_s, reading_time)`.
  See the note in [schema.sql](schema.sql) about why `reading_time` gets coalesced
  to a sentinel for this. Re-posting a row that's already stored returns 200 with
  `stored: 0` instead of erroring, since the device only cares about the status
  code, not the count.

## Timestamp handling

The device's `timestamp` field is naive local time with no UTC offset, and the
device sits in the US Eastern zone. The server reads it as `America/New_York` and
converts to UTC before storing it in the `timestamptz` column `reading_time`.
It's a one-line decision in [server.py](server.py)
(`DEVICE_TZ = ZoneInfo("America/New_York")`). Change it if the device ever moves.

`reading_time` can be empty (clock never synced) or plain wrong (drift, or a
reboot that resets `uptime_s` but not wall time until the next sync). So for any
real analysis, lean on `received_at` instead. That's server-assigned UTC,
`now()` at insert time, and it's the time axis you can trust. Treat `reading_time`
as a best-effort annotation and nothing more.

## Multiple devices

This already works with more than one device. Every row carries its `device_id`
from the `X-Device-Id` header, neither endpoint assumes a single device, and both
the dedupe index and the read-back filter are scoped per device. Flash a second
board with a different `DEVICE_ID` and the same `UPLOAD_KEY` and `UPLOAD_URL` and
you don't have to touch the server.

## Data retention

Nothing yet in v1. At a few KB per device per day, growth isn't going to matter
for a long time (a few hundred MB a year even with several devices). Worth
revisiting with a retention policy or a rollup table only if that changes.

## Dashboard

There's a Next.js dashboard in [dashboard/](dashboard/) with stat tiles, a line
chart per metric, the raw readings table, and a photo gallery. Everything reads
from `GET /api/readings` and `GET /api/photos` server-side, so the API key never
reaches the browser. See [dashboard/README.md](dashboard/README.md) for setup and
Vercel deploy steps.

## Testing

```bash
HOST=https://your-app.onrender.com API_KEY=<your key> ./test_requests.sh
```

Or point it at a local server with `HOST=http://127.0.0.1:8000`. The script runs
through a normal batch, an empty timestamp with `co2 == -1`, a duplicate re-POST
(you should see `stored: 0` the second time), a stray header line in the middle
of a batch, a bad API key (401), a malformed line (400), a missing required
header, and a read-back query. It also walks you through simulating a DB outage:
point `DATABASE_URL` at an unreachable host and confirm you get a 500 with no
partial write.

For what it's worth, the full flow was run end to end against a real Postgres 16
instance in Docker, and every case in [test_requests.sh](test_requests.sh)
passed. The normal batch gave `stored:1`; the empty-timestamp/`co2==-1` row gave
`stored:1` with both fields mapped to NULL and the timestamp correctly converted
from Eastern to UTC; the duplicate re-POST gave `stored:0`, deduped through the
coalesced unique index; the stray header line was skipped for `stored:1`; the
bad key returned 401; the malformed line returned 400; the missing header
returned 422 (that's FastAPI's own validation, still non-2xx, so the device's
retry logic doesn't care); and the read-back JSON came through. The DB-outage
path checked out too: killing the database mid-run produced a 500 with zero rows
written, and the row count was the same after the database came back. A failed
write never quietly returns a 2xx.

One caveat: all of that ran against a throwaway local container, not the actual
Supabase project. Point `test_requests.sh` at your deployed instance to confirm
it behaves the same there.
