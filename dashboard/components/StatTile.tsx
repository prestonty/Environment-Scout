interface Props {
  label: string;
  value: number | null;
  unit: string;
  decimals?: number;
}

export function StatTile({ label, value, unit, decimals = 1 }: Props) {
  return (
    <div className="statTile">
      <span className="statLabel">{label}</span>
      <span className="statValue">
        {value === null ? "—" : value.toFixed(decimals)}
        {unit && <span className="statUnit">{unit}</span>}
      </span>
    </div>
  );
}
