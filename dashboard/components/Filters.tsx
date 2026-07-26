import { RANGE_OPTIONS, type RangePreset } from "@/lib/dateRange";

interface Props {
  range: RangePreset;
}

export function Filters({ range }: Props) {
  return (
    <form className="filters" method="get">
      <label className="filterField">
        <span>Range</span>
        <select name="range" defaultValue={range}>
          {RANGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <button type="submit">Apply</button>
    </form>
  );
}
