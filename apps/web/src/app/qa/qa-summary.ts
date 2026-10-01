// The QA view's tables (docs/PLAN.md T3.1): the attempts of the session index by day and device,
// with what their clips take and what of their files is uploaded. Pure: the page reads the index and
// draws these.
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
  /** Their files not uploaded yet: `upload.files` without a `doneMs`. */
  readonly pendingBytes: number;
  /** The documents among them that hold writes of this device the server has not confirmed. */
  readonly unsent: number;
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

const NONE: QaCounts = {
  attempts: 0,
  clips: 0,
  recordedBytes: 0,
  uploadedBytes: 0,
  pendingBytes: 0,
  unsent: 0,
};

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
  const rows = new Map<string, QaRow>();
  let total = NONE;
  for (const { document, pending } of attempts) {
    const day = dayOf(document.events.scrambleShown);
    const device = document.device.host;
    const key = JSON.stringify([day, device]);
    const counts = countsOf(document, pending);
    rows.set(key, { day, device, ...add(rows.get(key) ?? NONE, counts) });
    total = add(total, counts);
  }
  return {
    rows: [...rows.values()].sort(
      (p, q) => q.day.localeCompare(p.day) || p.device.localeCompare(q.device),
    ),
    total,
  };
}

function countsOf(attempt: CloudAttempt, pending: boolean): QaCounts {
  const files = Object.values(attempt.upload.files);
  return {
    attempts: 1,
    clips: attempt.video.length,
    recordedBytes: attempt.video.reduce((sum, clip) => sum + clip.bytes, 0),
    uploadedBytes: files
      .filter((file) => file.doneMs !== null)
      .reduce((sum, file) => sum + file.bytes, 0),
    pendingBytes: files
      .filter((file) => file.doneMs === null)
      .reduce((sum, file) => sum + file.bytes, 0),
    unsent: pending ? 1 : 0,
  };
}

function add(p: QaCounts, q: QaCounts): QaCounts {
  return {
    attempts: p.attempts + q.attempts,
    clips: p.clips + q.clips,
    recordedBytes: p.recordedBytes + q.recordedBytes,
    uploadedBytes: p.uploadedBytes + q.uploadedBytes,
    pendingBytes: p.pendingBytes + q.pendingBytes,
    unsent: p.unsent + q.unsent,
  };
}
