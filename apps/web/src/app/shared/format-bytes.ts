/** Decimal units, as Chrome shows storage: "0 B", "12.3 kB", "1.2 GB". */
export function formatBytes(count: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = count;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit === 0 ? String(value) : value.toFixed(1)} ${units[unit] ?? ''}`;
}
