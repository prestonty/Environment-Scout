import { Filters } from "@/components/Filters";
import { StatTile } from "@/components/StatTile";
import { LineChart, type Series } from "@/components/LineChart";
import { ReadingsTable } from "@/components/ReadingsTable";
import { PhotoGallery } from "@/components/PhotoGallery";
import { fetchReadings, fetchPhotos, ApiError, type Reading, type Photo } from "@/lib/api";
import { resolveRange, type RangePreset } from "@/lib/dateRange";
import { seriesVarFor } from "@/lib/palette";

export const dynamic = "force-dynamic";

// Server's per-request cap (see server.py) -- one fetch per page load covers
// every chart and the device list; the "table rows" filter only slices the
// already-fetched set, it doesn't trigger a second request.
const FETCH_CAP = 1000;
const PHOTO_FETCH_CAP = 200;

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

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const range = (typeof sp.range === "string" ? sp.range : "7d") as RangePreset;
  const device = typeof sp.device === "string" ? sp.device : "";
  const limit = Number(typeof sp.limit === "string" ? sp.limit : "500") || 500;

  const { since } = resolveRange(range);

  let allRows: Reading[] = [];
  let error: string | null = null;
  try {
    allRows = await fetchReadings({ since, limit: FETCH_CAP });
  } catch (e) {
    error = e instanceof ApiError ? e.message : "Failed to load readings.";
  }

  let allPhotos: Photo[] = [];
  let photoError: string | null = null;
  try {
    allPhotos = await fetchPhotos({ since, limit: PHOTO_FETCH_CAP });
  } catch (e) {
    photoError = e instanceof ApiError ? e.message : "Failed to load photos.";
  }

  const devices = Array.from(new Set(allRows.map((r) => r.device_id))).sort();
  const filtered = device ? allRows.filter((r) => r.device_id === device) : allRows;
  const latest = filtered[0]; // API returns newest-first
  const tableRows = filtered.slice(0, limit);
  const filteredPhotos = device ? allPhotos.filter((p) => p.device_id === device) : allPhotos;

  return (
    <main className="container">
      <header className="pageHeader">
        <h1>Environmental Logger</h1>
        <p className="subtitle">Readings uploaded by the ESP32 sensor(s).</p>
      </header>

      <Filters devices={devices} selected={{ range, device, limit }} />

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
                Latest: {latest.device_id} at {new Date(latest.received_at).toLocaleString()}
              </p>
            </>
          )}

          {allRows.length === 0 && (
            <p className="latestCaption">No readings found for this range yet.</p>
          )}

          {filtered.length > 0 && (
            <section className="chartsGrid">
              <LineChart title="Temperature" unit="°C" series={toSeries(filtered, (r) => r.temperature_c)} />
              <LineChart title="Humidity" unit="%" series={toSeries(filtered, (r) => r.humidity_pct)} />
              <LineChart title="CO2" unit="ppm" decimals={0} series={toSeries(filtered, (r) => r.co2_ppm)} />
              <LineChart
                title="UV index"
                unit=""
                decimals={2}
                series={toSeries(filtered, (r) => r.uv_index_est)}
              />
            </section>
          )}

          {filtered.length > 0 && (
            <section>
              <h2>
                Readings ({tableRows.length} of {filtered.length})
              </h2>
              <ReadingsTable rows={tableRows} />
            </section>
          )}

          <section>
            <h2>Photos ({filteredPhotos.length})</h2>
            {photoError ? (
              <div className="errorBanner">{photoError}</div>
            ) : (
              <PhotoGallery photos={filteredPhotos} />
            )}
          </section>
        </>
      )}
    </main>
  );
}
