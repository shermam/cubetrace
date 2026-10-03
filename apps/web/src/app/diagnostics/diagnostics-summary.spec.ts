import { cloudEvent, type CloudEvent } from '@cubetrace/core';

import {
  SUMMARY_DAYS,
  SUMMARY_ERRORS,
  diagnosticsSummary,
  failureMessage,
  isFailure,
} from './diagnostics-summary';

const APP = { version: '0.4.0', commit: 'abc1234' };
const OLD = { version: '0.3.0', commit: 'old1234' };
const LAPTOP = { label: 'office-mbp', platform: 'macOS', installed: false };
const PHONE = { label: 'ThinkPhone', platform: 'Android', installed: true };
const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function event(
  kind: string,
  tsMs: number,
  data: Record<string, unknown> = {},
  device = LAPTOP,
  app = APP,
  scope: { session?: string; attempt?: number } = {},
): CloudEvent {
  return cloudEvent({ tsMs, kind, app, device, data, ...scope });
}

describe('isFailure and failureMessage', () => {
  it('tells the failures from the rest, and says what went wrong', () => {
    const failures: [CloudEvent, string][] = [
      [event('error.app', 1, { where: 'store', message: 'disk full' }), 'store: disk full'],
      [event('error.cube', 1, { message: 'no answer' }), 'no answer'],
      [
        event('clip.failed', 1, { segment: 'solve', reason: 'the encoder closed' }),
        'solve: the encoder closed',
      ],
      [
        event('sync.check', 1, {
          outcome: 'failed',
          reason: 'no-motion',
          message: 'the cube did not move',
        }),
        'the cube did not move',
      ],
      [event('sync.check', 1, { outcome: 'failed', reason: 'no-motion' }), 'no-motion'],
      [
        event('upload.state', 1, { state: 'failed', error: 'the bucket answered 403' }),
        'the bucket answered 403',
      ],
      [
        event('upload.state', 1, { state: 'failed', failedFile: 'laptop.solve.mp4' }),
        'laptop.solve.mp4',
      ],
      [event('cube.failed', 1, { reason: 'no-state' }), 'no-state'],
      [
        event('remote.cut', 1, {
          outcome: 'failed',
          camera: 'phone-rear',
          segment: 'solve',
          reason: 'the phone is not recording',
        }),
        'phone-rear solve: the phone is not recording',
      ],
      [
        event('remote.clip.missing', 1, {
          camera: 'phone-rear',
          segment: 'scramble',
          reason: 'wait',
          message: "no clip within 120 s of the attempt's end",
        }),
        "phone-rear scramble: no clip within 120 s of the attempt's end",
      ],
    ];
    for (const [failure, message] of failures) {
      expect(isFailure(failure), failure.kind).toBe(true);
      expect(failureMessage(failure)).toBe(message);
    }
    for (const fine of [
      event('app.start', 1),
      event('sync.check', 1, { outcome: 'ok', offsetMs: 33 }),
      event('upload.state', 1, { state: 'done' }),
      event('cube.failed', 1, { reason: 'cancelled' }),
      event('cube.failed', 1, { reason: 'no-mac' }),
      event('attempt.done', 1, { status: 'dnf' }),
      event('remote.cut', 1, { outcome: 'sent', camera: 'phone-rear', segment: 'solve' }),
      event('remote.cut', 1, { outcome: 'done', camera: 'phone-rear', segment: 'solve' }),
      event('remote.clip', 1, { camera: 'phone-rear', segment: 'solve', late: false }),
      event('remote.clip.late', 1, { camera: 'phone-rear', segment: 'solve', afterEndMs: 130_000 }),
    ]) {
      expect(isFailure(fine), `${fine.kind} ${JSON.stringify(fine.data)}`).toBe(false);
    }
    expect(failureMessage(event('error.app', 1))).toBe('');
  });
});

describe('diagnosticsSummary', () => {
  it('is empty without events', () => {
    expect(diagnosticsSummary([], NOW)).toEqual({
      devices: [],
      kinds: [],
      failures: [],
      total: 0,
      oldestMs: null,
      newestMs: null,
    });
  });

  it('gives each device its last start and build, its counts, and the failures newest first', () => {
    const events = [
      event('app.start', NOW - 10 * DAY, { installed: false }, LAPTOP, OLD),
      event('attempt.done', NOW - 10 * DAY + 1000, { status: 'solved' }, LAPTOP, OLD),
      event('app.start', NOW - 2 * DAY, { installed: false }, LAPTOP, APP),
      event('attempt.done', NOW - 2 * DAY + 1000, { status: 'solved' }),
      event('attempt.done', NOW - 2 * DAY + 2000, { status: 'dnf' }),
      event('error.app', NOW - DAY, { where: 'store', message: 'disk full' }, LAPTOP, APP, {
        session: 's1',
        attempt: 3,
      }),
      event('clip.failed', NOW - 3000, { segment: 'solve', reason: 'closed' }, PHONE, APP, {
        session: 's2',
        attempt: 1,
      }),
      event('page.viewed', NOW - 2000, { page: 'timer' }, PHONE, APP),
      event('sync.check', NOW - 1000, { outcome: 'ok', offsetMs: 61 }, PHONE, APP),
    ];
    const summary = diagnosticsSummary(events, NOW);
    expect(summary.total).toBe(9);
    expect(summary.oldestMs).toBe(NOW - 10 * DAY);
    expect(summary.newestMs).toBe(NOW - 1000);
    expect(summary.devices).toEqual([
      {
        label: 'office-mbp',
        platform: 'macOS',
        installed: false,
        lastStartMs: NOW - 2 * DAY,
        build: APP,
        events: 6,
        lastMs: NOW - DAY,
        failures: 1,
      },
      {
        label: 'ThinkPhone',
        platform: 'Android',
        installed: true,
        lastStartMs: null,
        build: null,
        events: 3,
        lastMs: NOW - 1000,
        failures: 1,
      },
    ]);
    // The last days only: the old build's start and attempt are out.
    expect(summary.kinds).toEqual([
      { kind: 'attempt.done', count: 2 },
      { kind: 'app.start', count: 1 },
      { kind: 'clip.failed', count: 1 },
      { kind: 'error.app', count: 1 },
      { kind: 'page.viewed', count: 1 },
      { kind: 'sync.check', count: 1 },
    ]);
    expect(summary.failures).toEqual([
      {
        tsMs: NOW - 3000,
        device: 'ThinkPhone',
        kind: 'clip.failed',
        message: 'solve: closed',
        session: 's2',
        attempt: 1,
      },
      {
        tsMs: NOW - DAY,
        device: 'office-mbp',
        kind: 'error.app',
        message: 'store: disk full',
        session: 's1',
        attempt: 3,
      },
    ]);
  });

  it(`counts the last ${String(SUMMARY_DAYS)} days to the second, and lists at most ${String(SUMMARY_ERRORS)} failures`, () => {
    const edge = NOW - SUMMARY_DAYS * DAY;
    const events = [
      event('page.viewed', edge - 1, { page: 'timer' }),
      event('page.viewed', edge, { page: 'timer' }),
      ...Array.from({ length: SUMMARY_ERRORS + 5 }, (_, k) =>
        event('error.app', NOW - k * 1000, { where: 'test', message: String(k) }),
      ),
    ];
    const summary = diagnosticsSummary(events, NOW);
    expect(summary.kinds).toEqual([
      { kind: 'error.app', count: SUMMARY_ERRORS + 5 },
      { kind: 'page.viewed', count: 1 },
    ]);
    expect(summary.failures).toHaveLength(SUMMARY_ERRORS);
    expect(summary.failures[0].message).toBe('test: 0');
    expect(summary.failures.at(-1)?.message).toBe(`test: ${String(SUMMARY_ERRORS - 1)}`);
    expect(summary.devices[0].failures).toBe(SUMMARY_ERRORS + 5);
  });
});
