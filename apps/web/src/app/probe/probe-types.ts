/**
 * Values of the device probe report (docs/PLAN.md, T1.8). A value the probe could not read is
 * one of three one-key markers instead of an exception, so the report always has every section
 * and says why something is absent.
 */

/** The API does not exist in this browser; names the API. */
export interface Missing {
  readonly missing: string;
}

/** The API threw or rejected; its error name and message. */
export interface Failed {
  readonly error: string;
}

/** The probe did not try, and why (usually because an earlier step failed). */
export interface Skipped {
  readonly skipped: string;
}

export type Absent = Missing | Failed | Skipped;

/** A value read from the browser, or the reason it is absent. */
export type Probed<T> = T | Absent;

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

const MARKERS: readonly string[] = ['missing', 'error', 'skipped'];

/** Whether `value` is one of the markers above: an object with exactly one of their keys. */
export function isAbsent(value: unknown): value is Absent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value);
  return (
    entries.length === 1 && MARKERS.includes(entries[0][0]) && typeof entries[0][1] === 'string'
  );
}

/** One line for a table cell: "not available: X", "error: X" or "skipped: X". */
export function describeAbsent(absent: Absent): string {
  if ('missing' in absent) {
    return `not available: ${absent.missing}`;
  }
  if ('error' in absent) {
    return `error: ${absent.error}`;
  }
  return `skipped: ${absent.skipped}`;
}
