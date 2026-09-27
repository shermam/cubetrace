import type { ProbeReport } from './probe-report';
import { describeAbsent, isAbsent } from './probe-types';

/** One row of a section's table. */
export interface ReportRow {
  /** Dotted path inside the section, e.g. "exposureTime.max" or "videoInputs[0]". */
  readonly key: string;
  readonly value: string;
  /** The value is a missing/error/skipped marker rather than a reading. */
  readonly absent: boolean;
}

/**
 * Flattens a section of the report into rows: nested objects become dotted keys, a nested group
 * of numbers (a distribution, a capability range) one "key=value" row, lists of plain values one
 * comma-separated row, and lists of flat objects one "key=value" row per item.
 */
export function sectionRows(value: unknown, path = ''): ReportRow[] {
  if (isAbsent(value)) {
    return [{ key: path === '' ? 'status' : path, value: describeAbsent(value), absent: true }];
  }
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    if (items.length === 0) {
      return [row(path, '(none)')];
    }
    if (items.every(isPlain)) {
      return [row(path, items.map(formatPlain).join(', '))];
    }
    return items.flatMap((item, index) => {
      const itemPath = `${path}[${String(index)}]`;
      return isFlatObject(item)
        ? [
            row(
              itemPath,
              Object.entries(item)
                .map(([k, v]) => `${k}=${formatPlain(v)}`)
                .join(', '),
            ),
          ]
        : sectionRows(item, itemPath);
    });
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return [row(path, '(empty)')];
    }
    if (path !== '' && entries.every(([, item]) => typeof item === 'number')) {
      return [row(path, entries.map(([key, item]) => `${key}=${formatPlain(item)}`).join(', '))];
    }
    return entries.flatMap(([key, item]) =>
      sectionRows(item, path === '' ? key : `${path}.${key}`),
    );
  }
  return [row(path, formatPlain(value))];
}

/** The report with the label as currently typed (the label may change after the run). */
export function withLabel(report: ProbeReport, label: string): ProbeReport {
  return { ...report, label: label.trim() };
}

/** `probe-<label>-<date>.json`, the label reduced to a-z, 0-9 and dashes, the local date. */
export function reportFileName(label: string, generatedAt: string): string {
  const slug =
    label
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)
      .replace(/^-+|-+$/g, '') || 'unlabelled';
  const date = new Date(generatedAt);
  const day = Number.isNaN(date.getTime())
    ? 'undated'
    : [date.getFullYear(), date.getMonth() + 1, date.getDate()]
        .map((part) => String(part).padStart(2, '0'))
        .join('-');
  return `probe-${slug}-${day}.json`;
}

function row(key: string, value: string): ReportRow {
  return { key: key === '' ? 'value' : key, value, absent: false };
}

function isPlain(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isFlatObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isAbsent(value) &&
    Object.values(value).every(isPlain)
  );
}

function formatPlain(value: unknown): string {
  if (typeof value === 'string') {
    return value === '' ? '""' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  // JSON.stringify gives undefined (typed as string) for undefined and functions.
  const text = JSON.stringify(value) as string | undefined;
  return text ?? 'undefined';
}
