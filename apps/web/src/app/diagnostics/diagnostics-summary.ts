// The QA view's Diagnostics section (docs/PLAN.md T3.9, docs/DIAGNOSTICS.md): the account's last
// events (users/{uid}/events) aggregated on the client, per device, by kind over the last days, and
// the failures among them. Pure: the page reads the events and draws these.
import type { CloudEvent } from '@cubetrace/core';

/** How many days back the counts by kind go. */
export const SUMMARY_DAYS = 7;

/** How many failures the summary lists, the newest first. */
export const SUMMARY_ERRORS = 20;

/** One device of the account, as its events show it. */
export interface DeviceSummary {
  readonly label: string;
  readonly platform: string;
  /** The app ran installed in its last event. */
  readonly installed: boolean;
  /** Its last `app.start`: when, and the build (null without one among the events read). */
  readonly lastStartMs: number | null;
  readonly build: { readonly version: string; readonly commit: string } | null;
  /** Its events among those read, and when the last one happened. */
  readonly events: number;
  readonly lastMs: number;
  /** The failures among them ({@link isFailure}). */
  readonly failures: number;
}

export interface KindCount {
  readonly kind: string;
  readonly count: number;
}

/** A failure, as the list shows it. */
export interface FailureEntry {
  readonly tsMs: number;
  readonly device: string;
  readonly kind: string;
  /** What went wrong, from the event's facts; empty when they say nothing more. */
  readonly message: string;
  readonly session: string | null;
  readonly attempt: number | null;
}

export interface DiagnosticsSummary {
  /** By label. */
  readonly devices: readonly DeviceSummary[];
  /** The counts by kind over the last {@link SUMMARY_DAYS} days, the most frequent first. */
  readonly kinds: readonly KindCount[];
  /** The last {@link SUMMARY_ERRORS} failures, the newest first. */
  readonly failures: readonly FailureEntry[];
  /** The events read, and the span they cover. */
  readonly total: number;
  readonly oldestMs: number | null;
  readonly newestMs: number | null;
}

/**
 * Whether `event` says something failed: an `error.*` event, a clip that could not be saved, a sync
 * check that failed, an attempt whose upload failed, a cube that could not be connected for a
 * reason other than the user's (the picker closed, no address given), a remote camera's cut that
 * failed, or a remote clip an attempt went without (T4.2). The round report marks these ❗.
 */
export function isFailure(event: CloudEvent): boolean {
  const { kind, data } = event;
  if (kind.startsWith('error.') || kind === 'clip.failed') {
    return true;
  }
  if (kind === 'sync.check') {
    return data['outcome'] === 'failed';
  }
  if (kind === 'upload.state') {
    return data['state'] === 'failed';
  }
  if (kind === 'cube.failed') {
    return data['reason'] !== 'cancelled' && data['reason'] !== 'no-mac';
  }
  // T4.2: a remote camera's clip the phone could not cut, or that the attempt went without.
  if (kind === 'remote.cut') {
    return data['outcome'] === 'failed';
  }
  return kind === 'remote.clip.missing';
}

/** What a failure's facts say went wrong, as text. */
export function failureMessage(event: CloudEvent): string {
  const { data } = event;
  const text = (key: string): string | null => {
    const value = data[key];
    return typeof value === 'string' && value !== '' ? value : null;
  };
  switch (event.kind) {
    case 'clip.failed':
      return [text('segment'), text('reason')].filter((part) => part !== null).join(': ');
    case 'sync.check':
      return text('message') ?? text('reason') ?? '';
    case 'upload.state':
      return text('error') ?? text('failedFile') ?? '';
    case 'cube.failed':
      return text('reason') ?? '';
    case 'remote.cut':
    case 'remote.clip.missing': {
      const clip = [text('camera'), text('segment')].filter((part) => part !== null).join(' ');
      const why = text('message') ?? text('reason') ?? '';
      return clip === '' ? why : `${clip}: ${why}`;
    }
    default:
      return [text('where'), text('message')].filter((part) => part !== null).join(': ');
  }
}

/** The events aggregated, at `nowMs` (the last days count back from it). */
export function diagnosticsSummary(
  events: readonly CloudEvent[],
  nowMs: number,
): DiagnosticsSummary {
  const devices = new Map<
    string,
    {
      platform: string;
      installed: boolean;
      lastStartMs: number | null;
      build: { version: string; commit: string } | null;
      events: number;
      lastMs: number;
      failures: number;
    }
  >();
  const kinds = new Map<string, number>();
  const failures: FailureEntry[] = [];
  const since = nowMs - SUMMARY_DAYS * 24 * 60 * 60 * 1000;
  let oldestMs: number | null = null;
  let newestMs: number | null = null;
  for (const event of events) {
    oldestMs = oldestMs === null ? event.tsMs : Math.min(oldestMs, event.tsMs);
    newestMs = newestMs === null ? event.tsMs : Math.max(newestMs, event.tsMs);
    const failed = isFailure(event);
    const label = event.device.label;
    const device = devices.get(label) ?? {
      platform: event.device.platform,
      installed: event.device.installed,
      lastStartMs: null,
      build: null,
      events: 0,
      lastMs: Number.NEGATIVE_INFINITY,
      failures: 0,
    };
    device.events++;
    if (failed) {
      device.failures++;
    }
    if (event.tsMs >= device.lastMs) {
      device.lastMs = event.tsMs;
      device.platform = event.device.platform;
      device.installed = event.device.installed;
    }
    if (
      event.kind === 'app.start' &&
      (device.lastStartMs === null || event.tsMs > device.lastStartMs)
    ) {
      device.lastStartMs = event.tsMs;
      device.build = { version: event.app.version, commit: event.app.commit };
    }
    devices.set(label, device);
    if (event.tsMs >= since) {
      kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
    }
    if (failed) {
      failures.push({
        tsMs: event.tsMs,
        device: label,
        kind: event.kind,
        message: failureMessage(event),
        session: event.session ?? null,
        attempt: event.attempt ?? null,
      });
    }
  }
  return {
    devices: [...devices.entries()]
      .sort(([p], [q]) => p.localeCompare(q))
      .map(([label, device]) => ({ label, ...device })),
    kinds: [...kinds.entries()]
      .sort(([p, m], [q, n]) => n - m || p.localeCompare(q))
      .map(([kind, count]) => ({ kind, count })),
    failures: failures.sort((p, q) => q.tsMs - p.tsMs).slice(0, SUMMARY_ERRORS),
    total: events.length,
    oldestMs,
    newestMs,
  };
}
