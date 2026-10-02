// The QA view's tables (docs/PLAN.md T3.1): the attempts of the session index by day and device,
// with what their clips take, what of their files is uploaded, and, since T3.7, how many have a gyro
// file and the median rate of those files. Pure: the page reads the index and draws these.
import type { CloudAttempt } from '@cubetrace/core';

import type { CloudEntry } from '../cloud/session-index';

/** The counts of a row, or of the total. */
export interface QaCounts {
  readonly attempts: number;
  /** Their clips (`video` entries). */
  readonly clips: number;
  /** What their clips' MP4s take: the sum of `video[].bytes`. */
  readonly recordedBytes: number;
  /** Their files whose upload is confirmed: `upload.files` with a `doneMs`. */
  readonly uploadedBytes: number;
  /**
   * Their files not uploaded yet: `upload.files` without a `doneMs`, and the clips that `upload.files`
   * does not name yet (its list is the one the attempt was created with, until the uploads sign
   * them), at their `video[].bytes`.
   */
  readonly pendingBytes: number;
  /** The documents among them that hold writes of this device the server has not confirmed. */
  readonly unsent: number;
  /** The attempts among them with a gyro file (`gyro` not null, T3.7). */
  readonly gyro: number;
  /** The median of those files' `rateHz`, to one decimal; null without one. */
  readonly gyroRateHz: number | null;
}

/** One day of one device. */
export interface QaRow extends QaCounts {
  /** The day, in the viewer's time zone: `2026-10-01`. */
  readonly day: string;
  /** The host label of the attempts' sessions (`device.host`). */
  readonly device: string;
}

export interface QaSummary {
  /** The newest day first, then by device. */
  readonly rows: readonly QaRow[];
  readonly total: QaCounts;
}

/** The counts as they add up, with every gyro rate seen, for the median at the end. */
interface Tally extends Omit<QaCounts, 'gyroRateHz'> {
  readonly gyroRates: readonly number[];
}

const NONE: Tally = {
  attempts: 0,
  clips: 0,
  recordedBytes: 0,
  uploadedBytes: 0,
  pendingBytes: 0,
  unsent: 0,
  gyro: 0,
  gyroRates: [],
};

/** The median of `values` (the mean of the middle two for an even count), to one decimal. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  const middle = sorted.length % 2 === 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
  return Math.round(middle * 10) / 10;
}

function countsOf(tally: Tally): QaCounts {
  const { gyroRates, ...counts } = tally;
  return { ...counts, gyroRateHz: median(gyroRates) };
}

/** The day of host time `ms` (about the wall clock, docs/DATA-MODEL.md §1) in this time zone. */
export function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The attempts by day (of the scramble shown, `dayOf` its host time) and device, with their counts,
 * and the total.
 */
export function qaSummary(
  attempts: readonly CloudEntry<CloudAttempt>[],
  dayOf: (ms: number) => string = localDay,
): QaSummary {
  const rows = new Map<string, { day: string; device: string; tally: Tally }>();
  let total = NONE;
  for (const { document, pending } of attempts) {
    const day = dayOf(document.events.scrambleShown);
    const device = document.device.host;
    const key = JSON.stringify([day, device]);
    const counts = tallyOf(document, pending);
    rows.set(key, { day, device, tally: add(rows.get(key)?.tally ?? NONE, counts) });
    total = add(total, counts);
  }
  return {
    rows: [...rows.values()]
      .sort((p, q) => q.day.localeCompare(p.day) || p.device.localeCompare(q.device))
      .map(({ day, device, tally }) => ({ day, device, ...countsOf(tally) })),
    total: countsOf(total),
  };
}

function tallyOf(attempt: CloudAttempt, pending: boolean): Tally {
  const files = Object.values(attempt.upload.files);
  const unlisted = attempt.video.filter((clip) => !Object.hasOwn(attempt.upload.files, clip.file));
  return {
    attempts: 1,
    clips: attempt.video.length,
    recordedBytes: attempt.video.reduce((sum, clip) => sum + clip.bytes, 0),
    uploadedBytes: files
      .filter((file) => file.doneMs !== null)
      .reduce((sum, file) => sum + file.bytes, 0),
    pendingBytes:
      files.filter((file) => file.doneMs === null).reduce((sum, file) => sum + file.bytes, 0) +
      unlisted.reduce((sum, clip) => sum + clip.bytes, 0),
    unsent: pending ? 1 : 0,
    gyro: attempt.gyro === null ? 0 : 1,
    gyroRates: attempt.gyro === null ? [] : [attempt.gyro.rateHz],
  };
}

function add(p: Tally, q: Tally): Tally {
  return {
    attempts: p.attempts + q.attempts,
    clips: p.clips + q.clips,
    recordedBytes: p.recordedBytes + q.recordedBytes,
    uploadedBytes: p.uploadedBytes + q.uploadedBytes,
    pendingBytes: p.pendingBytes + q.pendingBytes,
    unsent: p.unsent + q.unsent,
    gyro: p.gyro + q.gyro,
    gyroRates: [...p.gyroRates, ...q.gyroRates],
  };
}
