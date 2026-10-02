// What the upload queue's panel (the Sessions page), indicator (the header) and badges (a session's
// attempts) say (T3.3). Pure, so that the words are tested once.
import type { CloudUploadState } from '@cubetrace/core';
import type { AttemptView, QueuePause, QueueView } from '@cubetrace/upload';

import { formatBytes } from '../shared/format-bytes';
import type { UploadBadge } from '../timer/solve-list';
import type { UploadsStatus } from './upload-service';

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A time as the panel writes it: `Oct 2, 2026, 9:00 PM`. */
export function uploadTime(ms: number): string {
  return WHEN.format(ms);
}

/** "1 attempt", "3 attempts". */
export function attemptsText(count: number): string {
  return `${String(count)} ${count === 1 ? 'attempt' : 'attempts'}`;
}

/** Why the queue does not send now, as a sentence; null when nothing holds it. */
export function pauseText(pause: QueuePause | null): string | null {
  if (pause === null) {
    return null;
  }
  switch (pause.reason) {
    case 'quota':
      return `Paused until ${uploadTime(pause.untilMs)}: the day's upload quota is used up.`;
    case 'not-wifi':
      return 'Waiting for Wi-Fi (Settings → Uploads → Wi-Fi only).';
    case 'offline':
      return 'Offline: the uploads go on once the network is back.';
  }
}

/** The panel's first line: where the uploads are, and what is left. */
export function statusText(status: UploadsStatus, view: QueueView | null): string {
  switch (status) {
    case 'signed-out':
      return 'Sign in to upload your sessions.';
    case 'off':
      return 'Uploads are off (Settings → Uploads): the sessions stay on this device.';
    case 'unavailable':
      return 'This browser keeps no sessions in its file system: there is nothing to upload.';
    case 'error':
      return 'The uploads could not start.';
    case 'loading':
      return 'Reading this device’s sessions…';
    case 'waiting':
      return 'Another tab of cubetrace uploads: one tab at a time.';
    case 'running':
      break;
  }
  if (view === null) {
    return 'Reading this device’s sessions…';
  }
  const { waiting, pending, uploading, failed } = view.counts;
  const left = waiting + pending + uploading;
  const paused = pauseText(view.pause);
  if (left === 0) {
    return failed === 0
      ? 'Up to date: every attempt of this device is uploaded.'
      : `${attemptsText(failed)} could not be uploaded: Retry once the cause is fixed.`;
  }
  const rest = `${attemptsText(left)} to upload, ${formatBytes(view.bytesLeft)}.`;
  return paused === null ? `Uploading: ${rest}` : `${paused} ${rest}`;
}

/** "2 pending · 1 uploading · 1 waiting for clips · 12 done · 1 failed": the counts above zero. */
export function countsText(view: QueueView): string {
  const { waiting, pending, uploading, done, failed } = view.counts;
  const parts: string[] = [];
  if (pending > 0) {
    parts.push(`${String(pending)} pending`);
  }
  if (uploading > 0) {
    parts.push(`${String(uploading)} uploading`);
  }
  if (waiting > 0) {
    parts.push(`${String(waiting)} waiting for clips`);
  }
  parts.push(`${String(done)} done`);
  if (failed > 0) {
    parts.push(`${String(failed)} failed`);
  }
  return parts.join(' · ');
}

/** An attempt's state in the panel's row, and in the session page's badge. */
export function attemptStateText(attempt: AttemptView): string {
  switch (attempt.state) {
    case 'waiting':
      return 'waiting for its clips';
    case 'pending':
      return attempt.error === null ? 'pending' : 'will try again';
    case 'uploading':
      return `uploading ${String(percent(attempt))}%`;
    case 'done':
      return 'uploaded';
    case 'failed':
      return 'failed';
  }
}

/** An attempt's badge on its session's page, from the queue of this device. */
export function uploadBadge(attempt: AttemptView): UploadBadge {
  switch (attempt.state) {
    case 'waiting':
    case 'pending':
      return { state: attempt.state, text: 'to upload' };
    case 'uploading':
      return { state: 'uploading', text: `uploading ${String(percent(attempt))}%` };
    case 'done':
      return { state: 'done', text: 'uploaded' };
    case 'failed':
      return { state: 'failed', text: 'upload failed' };
  }
}

/** An attempt's badge from its document in the index (another device's session, T3.1). */
export function cloudUploadBadge(state: CloudUploadState): UploadBadge {
  switch (state) {
    case 'pending':
      return { state: 'pending', text: 'to upload' };
    case 'uploading':
      return { state: 'uploading', text: 'uploading' };
    case 'done':
      return { state: 'done', text: 'uploaded' };
    case 'failed':
      return { state: 'failed', text: 'upload failed' };
  }
}

/** The share of an attempt's bytes sent, 0 to 100. */
export function percent(attempt: Pick<AttemptView, 'sent' | 'bytes'>): number {
  return attempt.bytes <= 0 ? 0 : Math.min(100, Math.floor((attempt.sent / attempt.bytes) * 100));
}

/** The header indicator's state and words; null when there is nothing to show. */
export function indicatorOf(
  outstanding: {
    readonly left: number;
    readonly failed: number;
    readonly pause: QueuePause | null;
    readonly bytesLeft: number;
  } | null,
): { state: 'uploading' | 'paused' | 'failed'; count: number; title: string } | null {
  if (outstanding === null) {
    return null;
  }
  const { left, failed, pause, bytesLeft } = outstanding;
  const failedText =
    failed === 0 ? '' : ` ${attemptsText(failed)} could not be uploaded: see Sessions.`;
  if (left === 0) {
    return { state: 'failed', count: failed, title: failedText.trim() };
  }
  const rest = `${attemptsText(left)} to upload, ${formatBytes(bytesLeft)}.`;
  const paused = pauseText(pause);
  return {
    state: failed > 0 ? 'failed' : paused === null ? 'uploading' : 'paused',
    count: left,
    title: (paused === null ? `Uploading: ${rest}` : `${paused} ${rest}`) + failedText,
  };
}
