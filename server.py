"""
Ingestion server for the ESP32 environmental logger.

Endpoints:
  POST /api/readings  - device upload (CSV body, API-key + device-id headers)
  GET  /api/readings   - read back stored rows (verification / dashboard use)
  POST /api/photos     - device upload (raw JPEG body, API-key + device-id/
                         filename/taken-at headers); stored in Supabase
                         Storage, metadata in the `photos` table
  GET  /api/photos     - read back stored photo metadata + signed URLs
  GET  /health         - trivial liveness check

Contract this must honor (see build spec): a 2xx response is a durability
promise to the device - it means "these bytes are committed," because the
device advances its own upload offset only on 2xx and never re-sends that
range. So every code path that can return 2xx runs *after* the INSERT has
completed successfully; anything that fails before or during the DB write
must return 5xx (retryable) rather than 2xx.
"""

import logging
import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import asyncpg
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ingest")

# ── Config ───────────────────────────────────────────────────────────────

API_KEY = os.environ["API_KEY"]
READ_API_KEY = os.environ.get("READ_API_KEY", API_KEY)
DATABASE_URL = os.environ["DATABASE_URL"]

# Photo storage: a private Supabase Storage bucket. The service-role key
# bypasses the bucket's access policy, same role BYPASSRLS plays for the DB
# connection, so callers only ever get in through this server.
#
# Optional (.get, not []): unlike API_KEY/DATABASE_URL, a missing photo
# config should only take down the photo endpoints, not the whole service -
# readings upload has no dependency on Supabase Storage and must keep
# working even if this was never configured.
SUPABASE_URL = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
SUPABASE_PHOTOS_BUCKET = os.environ.get("SUPABASE_PHOTOS_BUCKET", "photos")
PHOTOS_CONFIGURED = bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)

SIGNED_URL_EXPIRES_S = 3600

# The device's `timestamp` field is naive local time with no offset, and the
# device itself is fixed in the US Eastern zone (EST5EDT in the firmware's
# TZ_INFO). We interpret it as America/New_York and convert to UTC before
# storing, so `reading_time` in the DB is unambiguous timestamptz alongside
# `received_at`. DST-fallback fold ambiguity (one repeated hour/year) is
# accepted as-is (fold=0) since this field is best-effort, not authoritative.
DEVICE_TZ = ZoneInfo("America/New_York")

MAX_BODY_BYTES = 1_000_000  # generous vs. the ~2 KB the device actually sends
MAX_PHOTO_BYTES = 15_000_000  # matches the firmware's own SD-fill guard


# ── DB pool lifecycle ────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = await asyncpg.create_pool(dsn=DATABASE_URL, min_size=1, max_size=5)
    app.state.http = httpx.AsyncClient(timeout=30.0)
    try:
        yield
    finally:
        await app.state.pool.close()
        await app.state.http.aclose()


app = FastAPI(title="Environmental Logger Ingest", lifespan=lifespan)


# ── CSV parsing ──────────────────────────────────────────────────────────

class CSVParseError(ValueError):
    pass


def _parse_timestamp(raw: str) -> datetime:
    try:
        naive = datetime.fromisoformat(raw.strip())
    except ValueError:
        raise CSVParseError(f"bad timestamp: {raw!r}")
    return naive.replace(tzinfo=DEVICE_TZ).astimezone(timezone.utc)


def parse_csv_body(body: bytes) -> list[tuple]:
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as e:
        raise CSVParseError(f"body is not valid UTF-8: {e}")

    rows: list[tuple] = []
    for lineno, raw_line in enumerate(text.split("\n"), start=1):
        line = raw_line.rstrip("\r")
        if not line.strip():
            continue
        if line.startswith("timestamp,"):
            continue  # defensive: tolerate a stray header line

        parts = line.split(",")
        if len(parts) != 8:
            raise CSVParseError(f"line {lineno}: expected 8 fields, got {len(parts)}")

        ts_raw, uptime_raw, temp_raw, hum_raw, uvmv_raw, uvir_raw, uvi_raw, co2_raw = parts

        try:
            uptime_s = int(uptime_raw)
            temperature_c = float(temp_raw)
            humidity_pct = float(hum_raw)
            uv_mv = float(uvmv_raw)
            uv_irradiance = float(uvir_raw)
            uv_index_est = float(uvi_raw)
            co2_ppm = float(co2_raw)
        except ValueError as e:
            raise CSVParseError(f"line {lineno}: {e}")

        reading_time = _parse_timestamp(ts_raw) if ts_raw.strip() else None
        co2_final = None if co2_ppm == -1.0 else co2_ppm

        rows.append(
            (reading_time, uptime_s, temperature_c, humidity_pct,
             uv_mv, uv_irradiance, uv_index_est, co2_final)
        )

    if not rows:
        raise CSVParseError("no data rows found in body")

    return rows


# ── DB access ────────────────────────────────────────────────────────────

INSERT_SQL = """
insert into readings
    (device_id, reading_time, uptime_s, temperature_c, humidity_pct,
     uv_mv, uv_irradiance_mw_cm2, uv_index_est, co2_ppm)
select $1, * from unnest(
    $2::timestamptz[], $3::bigint[], $4::double precision[], $5::double precision[],
    $6::double precision[], $7::double precision[], $8::double precision[], $9::double precision[]
)
on conflict (device_id, uptime_s, (coalesce(reading_time, 'epoch'::timestamptz)))
do nothing
returning id
"""


async def insert_readings(pool: asyncpg.Pool, device_id: str, rows: list[tuple]) -> int:
    cols = list(zip(*rows))
    async with pool.acquire() as conn:
        inserted = await conn.fetch(INSERT_SQL, device_id, *cols)
    return len(inserted)


INSERT_PHOTO_SQL = """
insert into photos (device_id, filename, taken_at, content_type, size_bytes, storage_path)
values ($1, $2, $3, $4, $5, $6)
on conflict (device_id, filename) do nothing
"""


# ── Supabase Storage helpers ─────────────────────────────────────────────
# Talked to directly over its REST API (rather than the supabase-py SDK) to
# keep the same "raw client against a documented API" style as the asyncpg
# calls above.

def _storage_headers() -> dict:
    return {
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
    }


async def upload_photo(client: httpx.AsyncClient, path: str, content: bytes, content_type: str):
    url = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_PHOTOS_BUCKET}/{path}"
    headers = {**_storage_headers(), "Content-Type": content_type, "x-upsert": "true"}
    resp = await client.post(url, headers=headers, content=content)
    resp.raise_for_status()


async def sign_photo_url(client: httpx.AsyncClient, path: str) -> str | None:
    url = f"{SUPABASE_URL}/storage/v1/object/sign/{SUPABASE_PHOTOS_BUCKET}/{path}"
    resp = await client.post(url, headers=_storage_headers(), json={"expiresIn": SIGNED_URL_EXPIRES_S})
    if resp.status_code != 200:
        logger.warning("Signed URL request failed for %s: %d %s", path, resp.status_code, resp.text)
        return None
    signed = resp.json().get("signedURL")
    return f"{SUPABASE_URL}/storage/v1{signed}" if signed else None


# ── Auth helpers ─────────────────────────────────────────────────────────

def _check_key(provided: str, expected: str):
    if not secrets.compare_digest(provided, expected):
        raise HTTPException(status_code=401, detail="invalid API key")


# ── Routes ───────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/api/readings")
async def ingest(
    request: Request,
    x_api_key: str = Header(...),
    x_device_id: str = Header(...),
):
    _check_key(x_api_key, API_KEY)

    if not x_device_id.strip():
        raise HTTPException(status_code=400, detail="missing X-Device-Id")

    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        raise HTTPException(status_code=400, detail="body too large")

    try:
        rows = parse_csv_body(body)
    except CSVParseError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        stored = await insert_readings(request.app.state.pool, x_device_id, rows)
    except Exception:
        logger.exception("DB write failed for device_id=%s (%d rows)", x_device_id, len(rows))
        raise HTTPException(status_code=500, detail="database error, retry later")

    return JSONResponse(status_code=200, content={"received": len(rows), "stored": stored})


@app.get("/api/readings")
async def read_readings(
    request: Request,
    x_api_key: str = Header(...),
    device_id: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=1000),
    since: datetime | None = Query(default=None),
    until: datetime | None = Query(default=None),
):
    _check_key(x_api_key, READ_API_KEY)

    clauses = []
    args: list = []

    if device_id is not None:
        args.append(device_id)
        clauses.append(f"device_id = ${len(args)}")
    if since is not None:
        args.append(since)
        clauses.append(f"received_at >= ${len(args)}")
    if until is not None:
        args.append(until)
        clauses.append(f"received_at <= ${len(args)}")

    where = f"where {' and '.join(clauses)}" if clauses else ""
    args.append(limit)
    sql = f"""
        select id, device_id, reading_time, uptime_s, temperature_c, humidity_pct,
               uv_mv, uv_irradiance_mw_cm2, uv_index_est, co2_ppm, received_at
        from readings
        {where}
        order by received_at desc
        limit ${len(args)}
    """

    async with request.app.state.pool.acquire() as conn:
        records = await conn.fetch(sql, *args)

    return [dict(r) for r in records]


@app.post("/api/photos")
async def ingest_photo(
    request: Request,
    x_api_key: str = Header(...),
    x_device_id: str = Header(...),
    x_filename: str = Header(...),
    x_taken_at: str | None = Header(default=None),
):
    _check_key(x_api_key, API_KEY)

    if not PHOTOS_CONFIGURED:
        raise HTTPException(status_code=503, detail="photo storage not configured on server")

    if not x_device_id.strip():
        raise HTTPException(status_code=400, detail="missing X-Device-Id")
    if not x_filename.strip() or "/" in x_filename:
        raise HTTPException(status_code=400, detail="missing or invalid X-Filename")

    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="empty body")
    if len(body) > MAX_PHOTO_BYTES:
        raise HTTPException(status_code=400, detail="photo too large")

    taken_at = None
    if x_taken_at and x_taken_at.strip():
        try:
            taken_at = _parse_timestamp(x_taken_at)
        except CSVParseError:
            raise HTTPException(status_code=400, detail=f"bad X-Taken-At: {x_taken_at!r}")

    storage_path = f"{x_device_id}/{x_filename}"

    try:
        await upload_photo(request.app.state.http, storage_path, body, "image/jpeg")
    except Exception:
        logger.exception(
            "Storage upload failed for device_id=%s filename=%s", x_device_id, x_filename
        )
        raise HTTPException(status_code=500, detail="storage error, retry later")

    try:
        async with request.app.state.pool.acquire() as conn:
            await conn.execute(
                INSERT_PHOTO_SQL,
                x_device_id, x_filename, taken_at, "image/jpeg", len(body), storage_path,
            )
    except Exception:
        logger.exception(
            "DB write failed for photo device_id=%s filename=%s", x_device_id, x_filename
        )
        raise HTTPException(status_code=500, detail="database error, retry later")

    return JSONResponse(status_code=200, content={"stored": True, "storage_path": storage_path})


@app.get("/api/photos")
async def read_photos(
    request: Request,
    x_api_key: str = Header(...),
    device_id: str | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=1000),
    since: datetime | None = Query(default=None),
    until: datetime | None = Query(default=None),
):
    _check_key(x_api_key, READ_API_KEY)

    clauses = []
    args: list = []

    if device_id is not None:
        args.append(device_id)
        clauses.append(f"device_id = ${len(args)}")
    if since is not None:
        args.append(since)
        clauses.append(f"received_at >= ${len(args)}")
    if until is not None:
        args.append(until)
        clauses.append(f"received_at <= ${len(args)}")

    where = f"where {' and '.join(clauses)}" if clauses else ""
    args.append(limit)
    sql = f"""
        select id, device_id, filename, taken_at, content_type, size_bytes, storage_path, received_at
        from photos
        {where}
        order by received_at desc
        limit ${len(args)}
    """

    async with request.app.state.pool.acquire() as conn:
        records = await conn.fetch(sql, *args)

    client = request.app.state.http
    results = []
    for r in records:
        row = dict(r)
        # Metadata rows can still be listed even if Storage was never
        # configured; just can't produce a URL to view the image at.
        row["signed_url"] = await sign_photo_url(client, row["storage_path"]) if PHOTOS_CONFIGURED else None
        results.append(row)
    return results
