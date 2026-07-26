-- Schema for the ESP32 environmental logger.
-- Run this once against your Supabase Postgres database (SQL editor, or
-- `psql "$DATABASE_URL" -f schema.sql`).

create table if not exists readings (
  id                   bigint generated always as identity primary key,
  device_id            text        not null,
  reading_time         timestamptz,              -- device-reported time, converted to UTC; NULL if unsynced
  uptime_s             bigint      not null,
  temperature_c        double precision,
  humidity_pct         double precision,
  uv_mv                double precision,
  uv_irradiance_mw_cm2 double precision,
  uv_index_est         double precision,
  co2_ppm              double precision,          -- NULL when device reported -1 (sensor warming up)
  received_at          timestamptz not null default now()
);

-- Dedupe key. Deviates slightly from the naive (device_id, uptime_s,
-- reading_time) constraint: Postgres treats NULLs as distinct in a unique
-- index, so a plain constraint would NOT catch duplicate re-uploads of rows
-- whose timestamp was unsynced (reading_time IS NULL) -- exactly the
-- scenario the spec calls out as the trigger for duplicate re-sends
-- (NVS reset / reflash). Coalescing to a sentinel closes that gap.
create unique index if not exists uq_reading
  on readings (device_id, uptime_s, (coalesce(reading_time, 'epoch'::timestamptz)));

-- Primary query pattern: latest rows for one device.
create index if not exists idx_readings_device_time
  on readings (device_id, received_at desc);

-- The app connects with the postgres role (BYPASSRLS), so this has no effect
-- on it. It's here to stop Supabase's PostgREST API from exposing this table
-- to anyone holding the project's anon key -- no policies are added, so RLS
-- denies that path entirely by default.
alter table readings enable row level security;

-- Photos captured from the phone at the captive portal, relayed to the
-- ingest server by the ESP32 the same way readings are. The image bytes
-- live in a private Supabase Storage bucket (see server.py); this table
-- only holds metadata + the object's path within that bucket.
create table if not exists photos (
  id                   bigint generated always as identity primary key,
  device_id            text        not null,
  filename             text        not null,   -- dedupe key; also the Storage object name
  taken_at             timestamptz,             -- NULL if device clock was unsynced at capture
  content_type         text        not null default 'image/jpeg',
  size_bytes           integer     not null,
  storage_path         text        not null,    -- "<device_id>/<filename>" in the bucket
  received_at          timestamptz not null default now()
);

-- Dedupe key: filename already embeds a per-device sequence number from the
-- firmware, so a retried relay of the same file is a no-op rather than a
-- duplicate row.
create unique index if not exists uq_photo
  on photos (device_id, filename);

-- Primary query pattern: latest photos for one device.
create index if not exists idx_photos_device_time
  on photos (device_id, received_at desc);

alter table photos enable row level security;
