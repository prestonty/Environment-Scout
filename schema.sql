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
