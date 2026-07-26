export type RangePreset = "24h" | "7d" | "30d" | "90d" | "all";

export const RANGE_OPTIONS: { value: RangePreset; label: string }[] = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveRange(preset: RangePreset): { since?: string } {
  const now = Date.now();
  switch (preset) {
    case "24h":
      return { since: new Date(now - 1 * DAY_MS).toISOString() };
    case "7d":
      return { since: new Date(now - 7 * DAY_MS).toISOString() };
    case "30d":
      return { since: new Date(now - 30 * DAY_MS).toISOString() };
    case "90d":
      return { since: new Date(now - 90 * DAY_MS).toISOString() };
    case "all":
    default:
      return {};
  }
}
