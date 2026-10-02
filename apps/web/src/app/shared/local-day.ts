/**
 * The day of host time `ms` (about the wall clock, docs/DATA-MODEL.md §1) in this time zone, as
 * `2026-10-01`: the QA view's rows (T3.1) and the diagnostics' daily cap (T3.9) count by it.
 */
export function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
