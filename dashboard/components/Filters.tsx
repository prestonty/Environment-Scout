import { RANGE_OPTIONS, type RangePreset } from "@/lib/dateRange";

interface Props {
  devices: string[];
  selected: {
    range: RangePreset;
    device: string;
    limit: number;
  };
}

export function Filters({ devices, selected }: Props) {
  return (
    <form className="filters" method="get">
      <label className="filterField">
        <span>Range</span>
        <select name="range" defaultValue={selected.range}>
          {RANGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="filterField">
        <span>Device</span>
        <select name="device" defaultValue={selected.device}>
          <option value="">All devices</option>
          {devices.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>

      <label className="filterField">
        <span>Table rows</span>
        <select name="limit" defaultValue={String(selected.limit)}>
          <option value="100">100</option>
          <option value="500">500</option>
          <option value="1000">1000</option>
        </select>
      </label>

      <button type="submit">Apply</button>
    </form>
  );
}
