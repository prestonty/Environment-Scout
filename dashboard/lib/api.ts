export interface Reading {
  id: number;
  device_id: string;
  reading_time: string | null;
  uptime_s: number;
  temperature_c: number | null;
  humidity_pct: number | null;
  uv_mv: number | null;
  uv_irradiance_mw_cm2: number | null;
  uv_index_est: number | null;
  co2_ppm: number | null;
  received_at: string;
}

export interface ReadingsQuery {
  since?: string;
  until?: string;
  limit: number;
  deviceId?: string;
}

export interface Photo {
  id: number;
  device_id: string;
  filename: string;
  taken_at: string | null;
  content_type: string;
  size_bytes: number;
  storage_path: string;
  received_at: string;
  signed_url: string | null;
}

export interface PhotosQuery {
  since?: string;
  until?: string;
  limit: number;
  deviceId?: string;
}

export class ApiError extends Error {}

export async function fetchReadings(query: ReadingsQuery): Promise<Reading[]> {
  const baseUrl = process.env.READINGS_API_URL;
  const apiKey = process.env.READINGS_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new ApiError(
      "Server is missing READINGS_API_URL / READINGS_API_KEY env vars."
    );
  }

  const url = new URL("/api/readings", baseUrl);
  if (query.since) url.searchParams.set("since", query.since);
  if (query.until) url.searchParams.set("until", query.until);
  if (query.deviceId) url.searchParams.set("device_id", query.deviceId);
  url.searchParams.set("limit", String(query.limit));

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "X-API-Key": apiKey },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(`Could not reach the ingest server at ${baseUrl}.`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ApiError(`Readings fetch failed (${res.status}): ${detail}`);
  }

  return (await res.json()) as Reading[];
}

export async function fetchPhotos(query: PhotosQuery): Promise<Photo[]> {
  const baseUrl = process.env.READINGS_API_URL;
  const apiKey = process.env.READINGS_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new ApiError(
      "Server is missing READINGS_API_URL / READINGS_API_KEY env vars."
    );
  }

  const url = new URL("/api/photos", baseUrl);
  if (query.since) url.searchParams.set("since", query.since);
  if (query.until) url.searchParams.set("until", query.until);
  if (query.deviceId) url.searchParams.set("device_id", query.deviceId);
  url.searchParams.set("limit", String(query.limit));

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "X-API-Key": apiKey },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(`Could not reach the ingest server at ${baseUrl}.`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ApiError(`Photos fetch failed (${res.status}): ${detail}`);
  }

  return (await res.json()) as Photo[];
}
