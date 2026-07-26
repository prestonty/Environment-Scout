import Link from "next/link";
import { notFound } from "next/navigation";
import { Filters } from "@/components/Filters";
import { StatTile } from "@/components/StatTile";
import { LineChart, type Series } from "@/components/LineChart";
import { ReadingsTable } from "@/components/ReadingsTable";
import { PhotoGallery } from "@/components/PhotoGallery";
import { Pagination } from "@/components/Pagination";
import { fetchReadings, fetchPhotos, ApiError, type Reading, type Photo } from "@/lib/api";
import { resolveRange, type RangePreset } from "@/lib/dateRange";
import { seriesVarFor } from "@/lib/palette";
import { getDevice } from "@/lib/devices";

export const dynamic = "force-dynamic";

// Server's per-request cap (see server.py) -- one fetch per page load covers
// the charts and the paginated table/gallery below.
const FETCH_CAP = 1000;
const PHOTO_FETCH_CAP = 200;
const TABLE_PAGE_SIZE = 25;
const PHOTO_PAGE_SIZE = 12;

type SearchParams = Record<string, string | string[] | undefined>;

function toSeries(rows: Reading[], accessor: (r: Reading) => number | null): Series[] {
  const byDevice = new Map<string, Series>();
  for (const r of rows) {
    if (!byDevice.has(r.device_id)) {
      byDevice.set(r.device_id, {
        device: r.device_id,
        colorVar: seriesVarFor(r.device_id),
        points: [],
      });
    }
    byDevice.get(r.device_id)!.points.push({
      x: new Date(r.received_at).getTime(),
      y: accessor(r),
    });
  }
  return Array.from(byDevice.values());
}

function clampPage(requested: number, totalPages: number): number {
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(Math.floor(requested), totalPages);
}

function buildHref(sp: SearchParams, overrides: Record<string, string | number>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") params.set(k, v);
  }
  for (const [k, v] of Object.entries(overrides)) params.set(k, String(v));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export default async function DevicePage({
  params,
  searchParams,
}: {
  params: Promise<{ deviceId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { deviceId } = await params;
  const device = getDevice(deviceId);
  if (!device) notFound();

  const sp = await searchParams;
  const range = (typeof sp.range === "string" ? sp.range : "7d") as RangePreset;
  const { since } = resolveRange(range);

  let rows: Reading[] = [];
  let error: string | null = null;
  try {
    rows = await fetchReadings({ since, limit: FETCH_CAP, deviceId });
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Failed to load readings.";
  }

  let photos: Photo[] = [];
  let photoError: string | null = null;
  try {
    photos = await fetchPhotos({ since, limit: PHOTO_FETCH_CAP, deviceId });
  } catch (e) {
    photoError = e instanceof ApiError ? e.message : "Failed to load photos.";
  }

  const latest = rows[0]; // API returns newest-first

  const tableTotalPages = Math.max(1, Math.ceil(rows.length / TABLE_PAGE_SIZE));
  const tablePage = clampPage(Number(sp.tablePage) || 1, tableTotalPages);
  const tableRows = rows.slice((tablePage - 1) * TABLE_PAGE_SIZE, tablePage * TABLE_PAGE_SIZE);

  const photoTotalPages = Math.max(1, Math.ceil(photos.length / PHOTO_PAGE_SIZE));
  const photoPage = clampPage(Number(sp.photoPage) || 1, photoTotalPages);
  const photoRows = photos.slice((photoPage - 1) * PHOTO_PAGE_SIZE, photoPage * PHOTO_PAGE_SIZE);

  return (
    <main className="container">
      <Link href="/" className="backLink">
        ‹ Back to devices
      </Link>

      <header className="pageHeader">
        <h1>{device.name}</h1>
        <p className="subtitle">
          {device.location} &middot; {device.id}
        </p>
      </header>

      <Filters range={range} />

      {error && <div className="errorBanner">{error}</div>}

      {!error && (
        <>
          {latest && (
            <>
              <section className="statRow">
                <StatTile label="Temperature" value={latest.temperature_c} unit="°C" />
                <StatTile label="Humidity" value={latest.humidity_pct} unit="%" />
                <StatTile label="CO2" value={latest.co2_ppm} unit="ppm" decimals={0} />
                <StatTile label="UV index" value={latest.uv_index_est} unit="" decimals={2} />
              </section>
              <p className="latestCaption">
                Latest: {new Date(latest.received_at).toLocaleString()}
              </p>
            </>
          )}

          {rows.length === 0 && (
            <p className="latestCaption">No readings found for this range yet.</p>
          )}

          {rows.length > 0 && (
            <section className="chartsGrid">
              <LineChart title="Temperature" unit="°C" series={toSeries(rows, (r) => r.temperature_c)} />
              <LineChart title="Humidity" unit="%" series={toSeries(rows, (r) => r.humidity_pct)} />
              <LineChart title="CO2" unit="ppm" decimals={0} series={toSeries(rows, (r) => r.co2_ppm)} />
              <LineChart
                title="UV index"
                unit=""
                decimals={2}
                series={toSeries(rows, (r) => r.uv_index_est)}
              />
            </section>
          )}

          {rows.length > 0 && (
            <section>
              <h2>
                Readings ({rows.length})
              </h2>
              <ReadingsTable rows={tableRows} />
              <Pagination
                page={tablePage}
                totalPages={tableTotalPages}
                buildHref={(p) => buildHref(sp, { tablePage: p })}
              />
            </section>
          )}

          <section>
            <h2>Photos ({photos.length})</h2>
            {photoError ? (
              <div className="errorBanner">{photoError}</div>
            ) : (
              <>
                <PhotoGallery photos={photoRows} />
                <Pagination
                  page={photoPage}
                  totalPages={photoTotalPages}
                  buildHref={(p) => buildHref(sp, { photoPage: p })}
                />
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}
