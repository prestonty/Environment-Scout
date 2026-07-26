import type { Reading } from "@/lib/api";

function fmt(n: number | null, decimals = 1): string {
  return n === null ? "—" : n.toFixed(decimals);
}

export function ReadingsTable({ rows }: { rows: Reading[] }) {
  if (rows.length === 0) {
    return <p className="latestCaption">No readings for this filter.</p>;
  }

  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Received</th>
            <th>Device</th>
            <th>Temp (°C)</th>
            <th>Humidity (%)</th>
            <th>UV index</th>
            <th>CO2 (ppm)</th>
            <th>Uptime (s)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.received_at).toLocaleString()}</td>
              <td>{r.device_id}</td>
              <td>{fmt(r.temperature_c)}</td>
              <td>{fmt(r.humidity_pct)}</td>
              <td>{fmt(r.uv_index_est, 2)}</td>
              <td>{fmt(r.co2_ppm, 0)}</td>
              <td>{r.uptime_s}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
