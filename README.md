# ESP32 Environmental Logger — Ingest Server

Receives the device's daily CSV uploads, authenticates them, stores rows in
Postgres, and exposes a read-back endpoint for verification.

## Stack and deployment choice

**FastAPI + Supabase Postgres, deployed on Render.**

- FastAPI: the device sends custom headers (`X-API-Key`, `X-Device-Id`) and a
  raw `text/csv` body, not JSON through a REST-style resource — that's
  awkward to express through Supabase's auto-generated REST API directly, so
  a thin app layer that owns auth + parsing is the right amount of code.
- Supabase: hosted Postgres with a dashboard for eyeballing rows, at no extra
  infra cost.
- Render over Vercel: Vercel only runs FastAPI as serverless functions
  (`api/index.py` + `vercel.json` rewrites, non-idiomatic wiring). For one
  device uploading once a day that wiring buys nothing — Render runs the
  same `uvicorn server:app` you'd run locally, as a normal persistent
  process, with a free tier and no serverless-specific code. If you outgrow
  the free tier's spin-down behavior, Railway/Fly.io are drop-in equivalents.

## Files

- [server.py](server.py) — the FastAPI app (ingest, read-back, health).
- [schema.sql](schema.sql) — Postgres schema + dedupe index.
- [requirements.txt](requirements.txt) — Python deps.
- [.env.example](.env.example) — required secrets.
- [render.yaml](render.yaml) — Render deploy blueprint.
- [test_requests.sh](test_requests.sh) — curl reproductions of the device's
  upload behavior, including edge cases.
- [Project_Code_361/Project_Code_361.ino](Project_Code_361/Project_Code_361.ino) —
  firmware, with the HTTPS change applied (see below).

## Setup

1. **Create the Supabase project**, then in the SQL editor run
   [schema.sql](schema.sql).
2. **Get the connection string**: click **Connect** on the project, then the
   **Session pooler** tab. Not "Direct connection" (Supabase requires IPv6 or
   a paid IPv4 add-on for that, and Render's outbound networking is IPv4-only
   anyway) and not "Transaction pooler" (that recycles backend connections
   mid-session, which breaks asyncpg's prepared statements). Session pooler
   is IPv4-compatible and gives each connection a dedicated backend for its
   session, so prepared statements still work fine.
3. **Copy `.env.example` to `.env`** and fill in `API_KEY` (generate with
   `python -c "import secrets; print(secrets.token_urlsafe(32))"`) and
   `DATABASE_URL`.
4. **Install deps and run locally**:
   ```bash
   pip install -r requirements.txt
   uvicorn server:app --reload
   ```
5. **Test** against `http://127.0.0.1:8000` with [test_requests.sh](test_requests.sh)
   (see Testing below).

## Deploy (Render)

1. Push this repo to GitHub.
2. In the Render dashboard: New → Blueprint → point at the repo. Render
   reads [render.yaml](render.yaml).
3. Set `API_KEY`, `READ_API_KEY` (optional), and `DATABASE_URL` as env vars
   in the Render dashboard when prompted (they're marked `sync: false` in
   the blueprint so they're never written into the repo).
4. Once deployed, Render gives you an `https://<your-app>.onrender.com` URL.
   Confirm `GET /health` returns `200`.

## Point the firmware at it

Credentials (`SECRET_AP_PASS`, `SECRET_STA_SSID`, `SECRET_STA_PASS`,
`SECRET_UPLOAD_KEY`) live in `Project_Code_361/secrets.h`, which is
gitignored — the `.ino` only references the macro names. Copy
[secrets.h.example](Project_Code_361/secrets.h.example) to `secrets.h` in
that same folder and fill in real values; the Arduino IDE picks up
same-folder headers automatically.

In [Project_Code_361.ino](Project_Code_361/Project_Code_361.ino) itself, the
only change needed is already applied:

- `UPLOAD_URL` is now expected to be `https://...` (was `http://...`).
- `WiFiClientSecure` + `client.setInsecure()` is used for the POST, so no CA
  certificate needs to be embedded in the firmware. This skips certificate
  validation — acceptable for a hobby project talking to one known host, but
  means a network-position attacker could in principle intercept the
  connection. For real validation, replace `client.setInsecure()` with
  `client.setCACert(ROOT_CA_PEM)` using Render's CA chain.

Before flashing, edit these two lines to your real deployment:
```cpp
const char *UPLOAD_URL = "https://your-app.onrender.com/api/readings";
const char *UPLOAD_KEY = "<same value as API_KEY in .env>";
```

The ~10-line shape of the change, if you're porting it elsewhere:
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

**Why HTTPS is mandatory, not optional:** the API key travels as a plaintext
header. Over plain HTTP, anyone on the network path (the device's own AP
clients, an ISP, a compromised router) can read it and impersonate the
device. HTTPS is what actually protects the key in transit.

## Ingest correctness (what protects the data)

- A row is only ever counted as "stored" after a successful `INSERT` commit;
  the endpoint returns 200 **after** that commit, never before.
- Malformed input (wrong field count, bad number) → 400. The whole batch is
  parsed before anything touches the database, so a bad line rejects the
  whole POST rather than partially committing it — matching how the device's
  offset tracking works (it advances past the whole POSTed range on 2xx, so
  partial commits would be worse than an all-or-nothing reject).
- Any database error (connection failure, etc.) → 500, so the device's own
  retry logic (it only advances its offset on 2xx) kicks in.
- Bad or missing `X-API-Key` → 401.
- Duplicate re-uploads (device offset reset by reflash/NVS clear) are
  deduped via a unique index on `(device_id, uptime_s, reading_time)` — see
  the note in [schema.sql](schema.sql) about why `reading_time` is coalesced
  to a sentinel for this purpose. Re-posting an already-stored row returns
  200 with `stored: 0` rather than erroring — the device only cares about
  the status code, not the count.

## Timestamp handling (decision, stated explicitly)

The device's `timestamp` field is naive local time with no UTC offset, and
the device is fixed in the US Eastern zone. The server interprets it as
`America/New_York` and converts to UTC before storing it in the `timestamptz`
column `reading_time`. This is a one-line decision in
[server.py](server.py) (`DEVICE_TZ = ZoneInfo("America/New_York")`) — change
it if the device is ever relocated.

Because `reading_time` can be empty (clock unsynced) or wrong (drift, reboot
resets `uptime_s` but not wall time until re-synced), **`received_at`
(server-assigned UTC, `now()` at insert time) is the trustworthy time axis**
for any real analysis. Treat `reading_time` as best-effort annotation only.

## Multiple devices

Already supported — every row carries `device_id` from the `X-Device-Id`
header, both endpoints are unaware of any single-device assumption, and the
dedupe index and read-back filter are scoped per device. Flashing a second
board with a different `DEVICE_ID` and the same `UPLOAD_KEY`/`UPLOAD_URL`
needs no server change.

## Data retention

Not addressed in v1 — a few KB/device/day means unbounded growth is a
non-issue for a long time (hundreds of MB/year even with several devices).
Revisit with a retention policy or a rollup table only if that changes.

## Dashboard

Not built for v1. `GET /api/readings` is the verification surface; a chart
UI is a separate, optional follow-up and wasn't cheap enough to justify
bundling in here.

## Testing

```bash
HOST=https://your-app.onrender.com API_KEY=<your key> ./test_requests.sh
```

Or against a local server with `HOST=http://127.0.0.1:8000`. The script
covers: a normal batch, empty-timestamp + `co2 == -1`, a duplicate re-POST
(expect `stored: 0` the second time), a stray header line mid-batch, a bad
API key (401), a malformed line (400), a missing required header, and a
read-back query. It also describes how to simulate a DB outage (point
`DATABASE_URL` at an unreachable host and confirm 500 + no partial write).

What was verified while building this: the full flow was run end-to-end
against a real Postgres 16 instance (Docker) — every case in
[test_requests.sh](test_requests.sh) passed, including a normal batch
(`stored:1`), the empty-timestamp/`co2==-1` row (`stored:1`, both mapped to
NULL, timestamp correctly converted from Eastern to UTC), a duplicate
re-POST (`stored:0`, deduped via the coalesced unique index), a stray
header line mid-batch (skipped, `stored:1`), a bad key (401), a malformed
line (400), a missing required header (422 — FastAPI's own validation,
still non-2xx so the device's retry logic is unaffected), and read-back
JSON. The DB-outage path was also verified directly: stopping the database
mid-run produced a 500 with zero rows written, and the row count was
unchanged after the database came back up — confirming a failed write never
silently returns 2xx. This was all exercised against a disposable local
container, not the actual Supabase project — point `test_requests.sh` at
your deployed instance to confirm the same behavior there too.
