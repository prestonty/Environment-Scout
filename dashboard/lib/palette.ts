// Fixed categorical order (blue, orange, aqua, yellow, magenta, green, violet, red).
// Light/dark hexes live in globals.css as --series-1..8; this module only picks
// which slot a device gets. See the dataviz skill's palette.md for the source values.
const SLOT_COUNT = 8;

// Stable hash so a device keeps its color regardless of which other devices are
// in view -- color must follow the entity, never its rank in the current filter.
function hashString(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function seriesVarFor(deviceId: string): string {
  const slot = (hashString(deviceId) % SLOT_COUNT) + 1;
  return `--series-${slot}`;
}
