import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CHECKLIST,
  Query,
  evaluate,
  failureMessage,
  isFailure,
  readEvent,
  roundReport,
  utcDay,
  type ReportEvent,
} from './report.mts';
import { parseArgs } from './round-report.mts';

// The round report (docs/DIAGNOSTICS.md) over a fixture of events, without Firestore: the reader of
// the documents, the checklist's logic item by item, and the Markdown.

const NOW = Date.UTC(2026, 9, 2, 18, 0, 0);
const HOUR = 3_600_000;
const SESSION = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';
const DEMO = '9e8d7c6b-5a4f-4e3d-a2c1-b0a9f8e7d6c5';
const APP = { version: '0.4.0', commit: 'abc1234' };
const LAPTOP = { label: 'office-mbp', platform: 'macOS', installed: false };
const PHONE = { label: 'ThinkPhone', platform: 'Android', installed: true };

let counter = 0;

/** An event of `device` at `tsMs`, of the owner's account. */
function at(
  tsMs: number,
  kind: string,
  data: Record<string, unknown> = {},
  device = LAPTOP,
  scope: { session?: string; attempt?: number } = {},
  app = APP,
): ReportEvent {
  counter++;
  return {
    uid: 'owner-uid',
    id: `${String(Math.floor(tsMs)).padStart(13, '0')}-${counter.toString(16).padStart(8, '0')}`,
    tsMs,
    kind,
    app,
    device,
    session: scope.session ?? null,
    attempt: scope.attempt ?? null,
    data,
  };
}

/** A day of the owner on both devices: what the checklists ask for, as the events show it. */
function fixture(): ReportEvent[] {
  const t0 = NOW - 6 * HOUR;
  const events: ReportEvent[] = [
    // The laptop starts on a new build, signs in again, connects the 12 ui with the address read by
    // Chrome, records a session with the camera, uploads it.
    at(t0, 'app.start', {
      installed: false,
      online: true,
      persisted: 'persistent',
      previousVersion: '0.3.0',
      previousCommit: 'old1234',
      updated: true,
      firstStart: false,
    }),
    at(t0 + 100, 'page.viewed', { page: 'timer', demo: false }),
    at(t0 + 500, 'account.signin', { outcome: 'resumed', installed: false }),
    at(t0 + 600, 'cubes.synced', { count: 2, cloud: 2, unreadable: 0, fromServer: true }),
    at(t0 + 1000, 'camera.on', {
      label: 'FaceTime HD Camera',
      facing: 'unknown',
      width: 1920,
      height: 1080,
      fps: 30,
      asked: '1920×1080 at 60',
      notes: 0,
    }),
    at(t0 + 2000, 'cube.connected', {
      kind: 'gan',
      model: 'uiFp 138',
      hardware: '0.5',
      firmware: '8.62',
      gyro: true,
      productDate: null,
      mac: 'driver',
      ms: 2100,
      battery: 80,
    }),
    at(
      t0 + 2100,
      'session.started',
      {
        host: 'office-mbp',
        platform: 'macOS',
        isPhone: false,
        model: 'uiFp 138',
        hardware: '0.5',
        firmware: '8.62',
        gyro: true,
        audio: true,
        inspection15s: false,
        autoAdvance: true,
        battery: 80,
        storage: 'opfs',
      },
      LAPTOP,
      { session: SESSION },
    ),
    at(t0 + 2200, 'wake.lock', { status: 'active', wanted: false }, LAPTOP, { session: SESSION }),
    at(
      t0 + 3000,
      'recording.started',
      {
        camera: 'laptop',
        codec: 'avc1.640028',
        audioCodec: 'mp4a.40.2',
        bitrate: 4_000_000,
        quality: 'standard',
        audio: true,
        processing: 'raw',
        applied: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          voiceIsolation: null,
        },
        width: 1920,
        height: 1080,
        fps: 30,
      },
      LAPTOP,
      { session: SESSION },
    ),
    at(
      t0 + 5000,
      'sync.check',
      {
        outcome: 'ok',
        reason: null,
        message: null,
        camera: 'laptop',
        offsetMs: 33,
        spreadMs: 20,
        previousOffsetMs: null,
        matched: 9,
        of: 10,
        kept: 8,
        moves: 10,
        frames: 600,
        durationMs: 20_000,
        frameIntervalMs: 33.3,
        wide: false,
        costMs: 1.1,
        saved: true,
      },
      LAPTOP,
      { session: SESSION },
    ),
    at(
      t0 + 40_000,
      'sync.check',
      {
        outcome: 'ok',
        reason: null,
        message: null,
        camera: 'laptop',
        offsetMs: 41,
        spreadMs: 25,
        previousOffsetMs: 33,
        matched: 10,
        of: 10,
        kept: 8,
        moves: 10,
        frames: 600,
        durationMs: 20_000,
        frameIntervalMs: 33.3,
        wide: false,
        costMs: 1.0,
        saved: true,
      },
      LAPTOP,
      { session: SESSION },
    ),
  ];
  // Twenty-two attempts, each with two clips, uploaded within a minute; the third corrected; the
  // tenth a DNF with both clips; the eleventh deleted.
  for (let k = 1; k <= 22; k++) {
    const start = t0 + 60_000 + k * 90_000;
    const scope = { session: SESSION, attempt: k };
    const dnf = k === 10;
    for (const segment of ['scramble', 'solve']) {
      events.push(
        at(
          start + (segment === 'scramble' ? 15_000 : 32_000),
          'clip.saved',
          {
            segment,
            camera: 'laptop',
            bytes: segment === 'scramble' ? 8_000_000 : 11_000_000,
            frames: segment === 'scramble' ? 480 : 660,
            codec: 'avc1.640028',
            audioCodec: 'mp4a.40.2',
            audio: true,
            truncatedStart: false,
            lateMs: 0,
            bufferSeconds: 90,
            syncResidualMs: 41,
            audioRebasedMs: 0,
            kept: segment === 'scramble',
          },
          LAPTOP,
          scope,
        ),
      );
    }
    events.push(
      at(
        start + 33_000,
        'attempt.done',
        {
          status: dnf ? 'dnf' : 'solved',
          timeMs: dnf ? null : 14_000 + k * 100,
          inspectionMs: 2_500,
          movesQtm: 58,
          tps: 4.1,
          replayOk: true,
          scrambleCorrected: k === 3,
          scrambleExtraMoves: k === 3 ? 2 : 0,
          phases: dnf ? 3 : 8,
          pickup: true,
          clockResidualP95Ms: 12,
          clockSamples: 40,
          clockA: 1.007,
          gyroSamples: 2049,
          gyroRateHz: 49.8,
          gyroTruncated: false,
          resyncs: 0,
          clips: 2,
          clipsLate: 0,
          clipBytes: 19_000_000,
          syncResidualMs: 41,
          scrambleMs: 14_000,
          settledMs: 1300,
          settled: true,
        },
        LAPTOP,
        scope,
      ),
    );
    if (k === 11) {
      events.push(
        at(
          start + 34_000,
          'attempt.deleted',
          { status: 'solved', timeMs: 15_100, clips: 2 },
          LAPTOP,
          scope,
        ),
      );
      continue;
    }
    events.push(
      at(
        start + 35_000,
        'upload.state',
        {
          state: 'uploading',
          files: 6,
          bytes: 19_100_000,
          sent: 0,
          tries: 6,
          error: null,
          failedFile: null,
        },
        LAPTOP,
        scope,
      ),
    );
    events.push(
      at(
        start + 70_000,
        'upload.state',
        {
          state: 'done',
          files: 6,
          bytes: 19_100_000,
          sent: 19_100_000,
          tries: 6,
          error: null,
          failedFile: null,
        },
        LAPTOP,
        scope,
      ),
    );
  }
  const end = t0 + 60_000 + 23 * 90_000;
  events.push(
    at(
      end,
      'cube.disconnected',
      {
        kind: 'gan',
        requested: true,
        reason: 'Disconnected on request.',
        idleMs: 5000,
        visibilityState: 'visible',
        hiddenMs: null,
        connectedMs: end - (t0 + 2000),
        battery: 76,
        model: 'uiFp 138',
        moves: 2400,
      },
      LAPTOP,
      { session: SESSION },
    ),
    at(end + 500, 'wake.lock', { status: 'inactive', wanted: false }, LAPTOP, { session: SESSION }),
    at(
      end + 3000,
      'cube.connected',
      {
        kind: 'gan',
        model: 'uiFp 138',
        hardware: '0.5',
        firmware: '8.62',
        gyro: true,
        productDate: null,
        mac: 'driver',
        ms: 1800,
        battery: 76,
      },
      LAPTOP,
      { session: SESSION },
    ),
    at(end + 60_000, 'page.viewed', { page: 'sessions', demo: false }),
    at(
      end + 61_000,
      'files.downloaded',
      { what: 'export', files: 1, names: `cubetrace-session-${SESSION}.json`, attempts: 21 },
      LAPTOP,
      { session: SESSION },
    ),
    at(end + 62_000, 'page.viewed', { page: 'session', demo: false }, LAPTOP, { session: SESSION }),
    at(end + 63_000, 'clips.viewed', { clips: 2, local: 2, gyro: true }, LAPTOP, {
      session: SESSION,
      attempt: 5,
    }),
    at(
      end + 64_000,
      'files.downloaded',
      {
        what: 'clips',
        files: 6,
        names:
          'laptop.scramble.mp4, laptop.scramble.frames.json, laptop.solve.mp4, laptop.solve.frames.json, gyro.json, attempt.json',
      },
      LAPTOP,
      { session: SESSION, attempt: 5 },
    ),
    at(end + 65_000, 'page.viewed', { page: 'qa', demo: false }),
    at(end + 66_000, 'session.deleted', { current: false, attempts: null }, LAPTOP, {
      session: DEMO,
    }),
    // The phone: the installed app signs in with the popup, a demo signed in stays on the device,
    // a real session off Wi-Fi waits, then goes; a clip fails once.
    at(
      t0 + 2 * HOUR,
      'app.start',
      {
        installed: true,
        online: true,
        persisted: 'persistent',
        previousVersion: null,
        previousCommit: null,
        updated: false,
        firstStart: true,
      },
      PHONE,
    ),
    at(t0 + 2 * HOUR + 1000, 'account.signin', { outcome: 'ok', installed: true }, PHONE),
    at(
      t0 + 2 * HOUR + 1500,
      'cubes.synced',
      { count: 2, cloud: 2, unreadable: 0, fromServer: true },
      PHONE,
    ),
    at(t0 + 2 * HOUR + 2000, 'page.viewed', { page: 'qa', demo: false }, PHONE),
    at(t0 + 2 * HOUR + 3000, 'page.viewed', { page: 'sessions', demo: false }, PHONE),
    at(
      t0 + 2 * HOUR + 10_000,
      'session.started',
      {
        host: 'ThinkPhone',
        platform: 'Android',
        isPhone: true,
        model: 'Fake cube',
        hardware: 'simulated',
        firmware: 'simulated',
        gyro: false,
        audio: true,
        inspection15s: false,
        autoAdvance: true,
        battery: null,
        storage: 'opfs',
      },
      PHONE,
      { session: DEMO },
    ),
    at(
      t0 + 2 * HOUR + 30_000,
      'attempt.done',
      {
        status: 'solved',
        timeMs: 15_000,
        clips: 0,
        replayOk: true,
        phases: 8,
        resyncs: 0,
        clipsLate: 0,
        clipBytes: 0,
        settled: true,
      },
      PHONE,
      { session: DEMO, attempt: 1 },
    ),
    at(
      t0 + 3 * HOUR,
      'cube.connected',
      {
        kind: 'gan',
        model: 'uiFp 138',
        hardware: '0.5',
        firmware: '8.62',
        gyro: true,
        productDate: null,
        mac: 'stored',
        ms: 3500,
        battery: 76,
      },
      PHONE,
    ),
    at(
      t0 + 3 * HOUR + 1000,
      'camera.on',
      {
        label: 'camera2 1, facing front',
        facing: 'user',
        width: 1920,
        height: 1080,
        fps: 30,
        asked: '1920×1080 at 60',
        notes: 0,
      },
      PHONE,
    ),
    at(
      t0 + 3 * HOUR + 2000,
      'camera.switched',
      {
        label: 'camera2 0, facing back',
        facing: 'environment',
        width: 1920,
        height: 1080,
        fps: 30,
        asked: '1920×1080 at 60',
        notes: 0,
        from: 'camera2 1, facing front',
      },
      PHONE,
    ),
    at(t0 + 3 * HOUR + 60_000, 'upload.paused', { reason: 'wifi', untilMs: null, left: 1 }, PHONE),
    at(
      t0 + 3 * HOUR + 120_000,
      'clip.failed',
      { segment: 'solve', reason: 'the clip worker closed' },
      PHONE,
      { session: 'ph0ne5e5-5b7d-4c1e-9f3a-2b8d6e4c1a7f', attempt: 2 },
    ),
    at(t0 + 3 * HOUR + 600_000, 'upload.resumed', {}, PHONE),
    at(
      t0 + 3 * HOUR + 700_000,
      'storage.deleted',
      {
        files: 2,
        bytes: 19_000_000,
        usageBefore: 7_100_000_000,
        usageAfter: 6_000_000_000,
        percent: 59,
      },
      PHONE,
    ),
    at(
      t0 + 4 * HOUR,
      'cube.disconnected',
      {
        kind: 'gan',
        requested: false,
        reason: 'The Bluetooth connection was closed.',
        idleMs: 372_104,
        visibilityState: 'hidden',
        hiddenMs: 311_875,
        connectedMs: 905_233,
        battery: 75,
        model: 'uiFp 138',
        moves: 300,
      },
      PHONE,
    ),
  );
  return events;
}

describe('readEvent', () => {
  it('reads a document of users/{uid}/events, and tolerates one of another shape', () => {
    const read = readEvent('owner-uid', '1790000000000-a1b2c3d4', {
      schema: 1,
      tsMs: 1_790_000_000_000,
      kind: 'app.start',
      app: APP,
      device: LAPTOP,
      session: SESSION,
      attempt: 3,
      data: { installed: false },
    });
    expect(read).toEqual({
      uid: 'owner-uid',
      id: '1790000000000-a1b2c3d4',
      tsMs: 1_790_000_000_000,
      kind: 'app.start',
      app: APP,
      device: LAPTOP,
      session: SESSION,
      attempt: 3,
      data: { installed: false },
    });
    expect(readEvent('u', 'i', { tsMs: 1, kind: 'x.y' })).toMatchObject({
      app: { version: '?', commit: '?' },
      device: { label: '?', platform: '', installed: false },
      session: null,
      attempt: null,
      data: {},
    });
    expect(readEvent('u', 'i', { kind: 'x.y' })).toBeNull();
    expect(readEvent('u', 'i', 'app.start')).toBeNull();
    expect(readEvent('u', 'i', null)).toBeNull();
  });
});

describe('isFailure and failureMessage', () => {
  it('agree with the QA view', () => {
    expect(isFailure(at(1, 'error.app', { where: 'store', message: 'full' }))).toBe(true);
    expect(failureMessage(at(1, 'error.app', { where: 'store', message: 'full' }))).toBe(
      'store: full',
    );
    expect(isFailure(at(1, 'clip.failed', { segment: 'solve', reason: 'closed' }))).toBe(true);
    expect(isFailure(at(1, 'sync.check', { outcome: 'failed', reason: 'no-motion' }))).toBe(true);
    expect(isFailure(at(1, 'sync.check', { outcome: 'ok' }))).toBe(false);
    expect(isFailure(at(1, 'upload.state', { state: 'failed', error: '403' }))).toBe(true);
    expect(failureMessage(at(1, 'upload.state', { state: 'failed', error: '403' }))).toBe('403');
    expect(isFailure(at(1, 'upload.state', { state: 'done' }))).toBe(false);
    expect(isFailure(at(1, 'cube.failed', { reason: 'cancelled' }))).toBe(false);
    expect(isFailure(at(1, 'cube.failed', { reason: 'no-state' }))).toBe(true);
    expect(isFailure(at(1, 'attempt.done', { status: 'dnf' }))).toBe(false);
    const failed = at(1, 'remote.cut', {
      outcome: 'failed',
      camera: 'phone-rear',
      segment: 'solve',
      reason: 'the phone is not recording',
    });
    expect(isFailure(failed)).toBe(true);
    expect(failureMessage(failed)).toBe('phone-rear solve: the phone is not recording');
    expect(isFailure(at(1, 'remote.cut', { outcome: 'sent', camera: 'phone-rear' }))).toBe(false);
    const missing = at(1, 'remote.clip.missing', {
      camera: 'phone-rear',
      segment: 'scramble',
      reason: 'wait',
      message: "no clip within 120 s of the attempt's end",
    });
    expect(isFailure(missing)).toBe(true);
    expect(failureMessage(missing)).toBe(
      "phone-rear scramble: no clip within 120 s of the attempt's end",
    );
    expect(isFailure(at(1, 'remote.clip.late', { camera: 'phone-rear' }))).toBe(false);
  });
});

describe('Query', () => {
  it('finds the next and the previous event on the same device within a window, and the sessions', () => {
    const q = new Query(fixture(), NOW);
    const start = q.of('app.start')[0];
    expect(q.next(start, 'cube.connected', 10_000)?.data['mac']).toBe('driver');
    expect(q.next(start, 'cube.connected', 1000)).toBeNull();
    expect(q.onPhone('app.start')).toHaveLength(1);
    expect(q.onLaptop('app.start')).toHaveLength(1);
    const phoneStart = q.onPhone('app.start')[0];
    expect(q.next(phoneStart, 'cube.connected', 2 * HOUR)?.device.label).toBe('ThinkPhone');
    const done = q.of('upload.state').find((e) => e.data['state'] === 'done');
    expect(done).toBeDefined();
    expect(q.previous(done as ReportEvent, 'attempt.done', HOUR)?.attempt).toBe(1);
    expect([...q.sessions().keys()].sort()).toEqual(
      [SESSION, DEMO, 'ph0ne5e5-5b7d-4c1e-9f3a-2b8d6e4c1a7f'].sort(),
    );
    expect(q.realAttempts()).toHaveLength(22);
    expect(q.biggestSession()).toEqual({ session: SESSION, attempts: 22, device: 'office-mbp' });
  });
});

describe('the checklist', () => {
  it('names each item once, with a round, a section, a title and kinds, and the kinds it names are in docs/DIAGNOSTICS.md', () => {
    const ids = CHECKLIST.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const doc = readFileSync(new URL('../../docs/DIAGNOSTICS.md', import.meta.url), 'utf8');
    // The kinds of the catalogue's table, each a dotted lowercase name of at most 64 characters, as
    // core's EVENT_KIND asks: a kind that is not one makes no event at all.
    const catalogue = doc.split('\n## The catalogue\n')[1]?.split('\n## ')[0] ?? '';
    const named = [...catalogue.matchAll(/^\| `([^`]+)` \|/gmu)].map((match) => match[1]);
    expect(named.length).toBeGreaterThan(30);
    for (const kind of named) {
      expect(kind).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/u);
      expect(kind.length).toBeLessThanOrEqual(64);
    }
    for (const item of CHECKLIST) {
      expect(item.title.length, item.id).toBeGreaterThan(10);
      expect(item.section, item.id).toMatch(/^(T\d\.\d+ — .+|the cube's whole record)$/u);
      for (const kind of item.kinds) {
        expect(named, `${item.id} names ${kind}`).toContain(kind);
      }
      // The table of docs/DIAGNOSTICS.md has a row per item.
      expect(doc, item.id).toContain(`| ${item.id} |`);
    }
  });

  it('ticks what the fixture shows, leaves what it does not, and marks the failures', () => {
    const results = new Map(evaluate(fixture(), NOW).map((item) => [item.id, item.result]));
    const status = (id: string): string | undefined => results.get(id)?.status;
    const facts = (id: string): string => results.get(id)?.facts ?? '';

    expect(status('1.5.1')).toBe('ok');
    expect(facts('1.5.1')).toContain('uiFp 138 (2)');
    expect(status('1.5.2')).toBe('ok');
    expect(facts('1.5.2')).toContain('remembered: 1 connection on ThinkPhone');
    expect(status('1.5.3')).toBe('none');
    expect(status('1.5.4')).toBe('ok');
    expect(status('1.5.5')).toBe('none');
    expect(status('1.5.6')).toBe('none');
    expect(status('1.5.7')).toBe('ok');
    expect(facts('1.5.7')).toContain('22 of 22');
    expect(status('1.5.8')).toBe('ok');
    expect(status('1.5.9')).toBe('none');
    expect(status('1.5.10')).toBe('ok');
    expect(status('1.5.11')).toBe('none');
    expect(status('1.5.12')).toBe('none');
    expect(status('1.5.13')).toBe('ok');
    expect(facts('1.5.13')).toContain('hidden for 312 s');
    expect(status('1.6.2')).toBe('ok');
    expect(facts('1.6.2')).toContain('22 attempts in one session on office-mbp');
    expect(status('1.6.3')).toBe('ok');
    expect(status('1.6.5')).toBe('ok');
    expect(facts('1.6.5')).toBe('21 of 21 solved real attempts have all eight phases');
    expect(status('1.6.6')).toBe('ok');
    expect(status('1.6.7')).toBe('ok');
    expect(status('1.6.8')).toBe('none');
    expect(status('1.6.10')).toBe('none');
    expect(status('1.6.11')).toBe('ok');
    expect(status('1.6.12')).toBe('ok');
    expect(status('1.7.1')).toBe('ok');
    expect(status('1.7.4')).toBe('ok');
    expect(status('1.7.5')).toBe('ok');
    expect(facts('1.7.5')).toContain('office-mbp old1234 → abc1234');
    expect(status('1.7.6')).toBe('none');
    expect(status('2.1.1')).toBe('ok');
    expect(status('2.1.2')).toBe('ok');
    expect(status('2.1.9')).toBe('ok');
    expect(status('2.4.1')).toBe('ok');
    expect(facts('2.4.1')).toContain('avc1.640028 at 4 Mbps, mp4a.40.2');
    expect(status('2.4.2')).toBe('ok');
    expect(facts('2.4.2')).toContain('median 19 MB per attempt');
    expect(status('2.4.3')).toBe('ok');
    expect(status('2.4.5')).toBe('ok');
    expect(status('2.4.6')).toBe('none');
    expect(status('2.4.10')).toBe('none');
    expect(status('2.5.2')).toBe('ok');
    expect(status('2.5.3')).toBe('ok');
    expect(facts('2.5.3')).toContain('office-mbp/laptop: offsets 33, 41 ms');
    expect(status('2.5.4')).toBe('none');
    expect(status('2.5.6')).toBe('ok');
    expect(status('2.10.1')).toBe('ok');
    expect(status('2.12.1')).toBe('ok');
    expect(status('2.14.1')).toBe('none');
    expect(status('3.0.2')).toBe('none');
    expect(status('3.0.4')).toBe('ok');
    expect(status('3.1.1')).toBe('ok');
    expect(status('3.1.6')).toBe('ok');
    expect(status('3.3.2')).toBe('ok');
    expect(facts('3.3.2')).toContain(
      '21 attempts on office-mbp uploaded (6 files), median 37 s after the end',
    );
    expect(status('3.3.4')).toBe('ok');
    expect(status('3.3.5')).toBe('none');
    expect(status('3.3.7')).toBe('ok');
    expect(status('3.3.9')).toBe('ok');
    expect(status('3.3.11')).toBe('ok');
    expect(status('3.4.2')).toBe('ok');
    expect(status('3.4.3')).toBe('none');
    expect(status('3.7.1')).toBe('ok');
    expect(facts('3.7.1')).toContain('office-mbp 50 Hz');
    // Nothing failed in the fixture's checks but the phone's clip.
    const failedItems = [...results.entries()]
      .filter(([, r]) => r.status === 'failed')
      .map(([id]) => id);
    expect(failedItems).toEqual([]);
  });

  it('marks a failure where the events show one', () => {
    const events = fixture();
    events.push(
      at(
        NOW - HOUR,
        'upload.state',
        {
          state: 'failed',
          files: 6,
          bytes: 1,
          sent: 0,
          tries: 3,
          error: 'the bucket answered 403',
          failedFile: 'laptop.solve.mp4',
        },
        LAPTOP,
        { session: SESSION, attempt: 3 },
      ),
      at(
        NOW - HOUR + 1000,
        'sync.check',
        {
          outcome: 'ok',
          camera: 'laptop',
          offsetMs: 120,
          spreadMs: 90,
          matched: 8,
          of: 10,
          kept: 6,
          wide: false,
        },
        LAPTOP,
        { session: SESSION },
      ),
      at(
        NOW - HOUR + 2000,
        'cube.disconnected',
        {
          kind: 'gan',
          requested: false,
          reason: 'The Bluetooth connection was closed.',
          idleMs: 4000,
          visibilityState: 'visible',
          hiddenMs: null,
          connectedMs: 60_000,
          battery: 70,
          model: 'uiFp 138',
          moves: 3,
        },
        LAPTOP,
      ),
    );
    const results = new Map(evaluate(events, NOW).map((item) => [item.id, item.result]));
    expect(results.get('3.3.2')?.status).toBe('failed');
    expect(results.get('3.3.2')?.facts).toContain('the bucket answered 403');
    expect(results.get('2.5.3')?.status).toBe('failed');
    expect(results.get('1.5.8')?.status).toBe('failed');
    expect(results.get('1.5.8')?.facts).toContain('within a minute of a turn');
  });
});

describe('the checklist after T4.2', () => {
  /** A day of three solves with the phone paired, as the host's events tell it. */
  function remoteDay(): ReportEvent[] {
    const t0 = NOW - 3 * HOUR;
    const scope = (attempt: number) => ({ session: SESSION, attempt });
    const events: ReportEvent[] = [];
    for (let k = 1; k <= 3; k++) {
      const end = t0 + k * 60_000;
      for (const segment of ['scramble', 'solve']) {
        events.push(
          at(
            end - (segment === 'scramble' ? 20_000 : 0),
            'remote.cut',
            {
              outcome: 'sent',
              camera: 'phone-rear',
              peer: 'ThinkPhone',
              segment,
              reason: segment === 'scramble' ? 'armed' : 'ended',
              windowMs: 15_000,
              marginMs: k === 1 ? 640 : 500,
              waitedMs: 0,
              offsetMs: -2500.4,
              rttMs: 120,
              samples: 8,
              converged: k > 1,
            },
            LAPTOP,
            scope(k),
          ),
          at(
            end + 4000 - (segment === 'scramble' ? 18_000 : 0),
            'remote.clip',
            {
              camera: 'phone-rear',
              peer: 'ThinkPhone',
              segment,
              bytes: 3_000_000,
              mp4Bytes: 2_998_000,
              transferMs: 1500,
              bytesPerSecond: 2_000_000,
              resumedBytes: 0,
              late: false,
              kept: false,
              converged: k > 1,
              offsetMs: -2500.4,
              truncatedStart: false,
            },
            LAPTOP,
            scope(k),
          ),
        );
      }
      events.push(
        at(
          end + 4100,
          'attempt.done',
          { status: 'solved', timeMs: 12_000, clips: 4, settledMs: 4100, settled: true },
          LAPTOP,
          scope(k),
        ),
        at(
          end + 40_000,
          'upload.state',
          { state: 'done', files: 9, bytes: 12_000_000, sent: 12_000_000, tries: 9 },
          LAPTOP,
          scope(k),
        ),
      );
    }
    events.push(
      at(t0 + 4 * 60_000, 'clips.viewed', { clips: 4, local: 4, gyro: true }, LAPTOP),
      // The phone walked away during the fourth attempt's clip, and came back.
      at(t0 + 5 * 60_000, 'rtc.connected', { peer: 'ThinkPhone', reconnection: true }, LAPTOP),
      at(
        t0 + 5 * 60_000 + 3000,
        'remote.clip',
        {
          camera: 'phone-rear',
          segment: 'solve',
          bytes: 3_000_000,
          transferMs: 900,
          bytesPerSecond: 3_333_333,
          resumedBytes: 1_310_720,
          late: false,
        },
        LAPTOP,
        scope(4),
      ),
      // The fifth's given up, then attached late.
      at(
        t0 + 8 * 60_000,
        'remote.clip.missing',
        {
          camera: 'phone-rear',
          segment: 'solve',
          reason: 'wait',
          message: "no clip within 120 s of the attempt's end",
          afterEndMs: 120_000,
        },
        LAPTOP,
        scope(5),
      ),
      at(
        t0 + 9 * 60_000,
        'remote.clip.late',
        { camera: 'phone-rear', segment: 'solve', afterEndMs: 180_000, afterMissedMs: 60_000 },
        LAPTOP,
        scope(5),
      ),
      // Record remote cameras off, then on again before an attempt.
      at(t0 + 10 * 60_000, 'settings.changed', { key: 'recordRemoteCameras', value: false }),
      at(t0 + 11 * 60_000, 'settings.changed', { key: 'recordRemoteCameras', value: true }),
      at(
        t0 + 12 * 60_000,
        'remote.cut',
        { outcome: 'sent', camera: 'phone-rear', segment: 'scramble', marginMs: 500 },
        LAPTOP,
        scope(6),
      ),
    );
    return events;
  }

  it('ticks the remote clips from the host’s events: the cuts, the clips, the four clips, the nine files, the resumed transfer, the late clip, the switch', () => {
    const results = new Map(evaluate(remoteDay(), NOW).map((item) => [item.id, item.result]));
    const status = (id: string): string | undefined => results.get(id)?.status;
    const facts = (id: string): string => results.get(id)?.facts ?? '';

    expect(status('4.2.1')).toBe('ok');
    expect(facts('4.2.1')).toBe(
      '7 remote clips on office-mbp (phone-rear); 7 cuts sent, 2 before the clock sync converged, margin 500 ms; transfer 1.5 s at 2 MB/s (medians)',
    );
    expect(status('4.2.2')).toBe('ok');
    expect(facts('4.2.2')).toBe(
      '3 real attempts on office-mbp with four clips or more (3 with nothing left to come, 4.1 s after the end, median); 1 viewing on office-mbp of four clips or more',
    );
    expect(status('4.2.3')).toBe('ok');
    expect(facts('4.2.3')).toBe('3 uploads on office-mbp of nine files or more');
    expect(status('4.2.4')).toBe('ok');
    expect(facts('4.2.4')).toContain(
      '1 clip on office-mbp resumed in the middle of a file (1310720 bytes held, median)',
    );
    expect(status('4.2.5')).toBe('ok');
    expect(facts('4.2.5')).toBe(
      "1 clip on office-mbp given up (wait), 1 late clip on office-mbp attached 180 s after the attempt's end (median)",
    );
    expect(status('4.2.6')).toBe('ok');
    expect(facts('4.2.6')).toBe(
      '1 switch on office-mbp off, 1 switch on office-mbp on followed by a cut within the hour',
    );

    // None of it without the events; the failures mark 4.2.1.
    const empty = new Map(evaluate([], NOW).map((item) => [item.id, item.result.status]));
    for (const id of ['4.2.1', '4.2.2', '4.2.3', '4.2.4', '4.2.5', '4.2.6']) {
      expect(empty.get(id), id).toBe('none');
    }
    const withFailure = [
      ...remoteDay(),
      at(
        NOW - HOUR,
        'remote.cut',
        {
          outcome: 'failed',
          camera: 'phone-rear',
          segment: 'solve',
          reason: 'the phone is not recording',
        },
        LAPTOP,
        { session: SESSION, attempt: 7 },
      ),
    ];
    const failedResult = evaluate(withFailure, NOW).find((item) => item.id === '4.2.1')?.result;
    expect(failedResult?.status).toBe('failed');
    expect(failedResult?.facts).toContain(
      '1 failure on office-mbp: phone-rear solve: the phone is not recording',
    );
  });
});

describe('the checklist after T4.3', () => {
  /**
   * A day with the phone paired and its live preview on, as both devices' events tell it: a sync
   * check of the phone's camera failed then passed, the clips after it with its lag, the preview off
   * and on, and the clock sync converged for 25 minutes after a withdrawal.
   */
  function syncDay(): ReportEvent[] {
    const t0 = NOW - 4 * HOUR;
    const scope = (attempt: number) => ({ session: SESSION, attempt });
    const check = (offsetMs: number, outcome: string, extra: Record<string, unknown> = {}) => ({
      outcome,
      reason: outcome === 'ok' ? null : 'no-motion',
      message: outcome === 'ok' ? null : 'the camera saw no motion inside the rectangle',
      camera: 'phone-rear',
      offsetMs,
      spreadMs: 9.5,
      remote: true,
      peer: 'ThinkPhone',
      clockConverged: true,
      clockOffsetMs: -241.3,
      clockRttMs: 6.1,
      clockSamples: 12,
      ...extra,
    });
    const preview = (kind: string, tsMs: number, data: Record<string, unknown>) =>
      at(tsMs, kind, data, PHONE, { session: SESSION });
    const events: ReportEvent[] = [
      at(t0, 'sync.check', { outcome: 'ok', camera: 'laptop', offsetMs: 41.2, spreadMs: 7 }),
      at(t0 + 60_000, 'sync.check', check(0, 'failed')),
      at(t0 + 120_000, 'sync.check', check(112.4, 'ok')),
      preview('preview.started', t0 - 60_000, {
        width: 1920,
        height: 1080,
        scale: 5,
        maxKbps: 300,
        maxFps: 15,
        recordingSeconds: 0,
      }),
      // Off for five minutes, then on again: a span with the preview, then one without.
      at(t0 + 10 * 60_000, 'settings.changed', { key: 'livePreviewFromPhones', value: false }),
      preview('preview.stopped', t0 + 10 * 60_000 + 200, {
        why: 'off',
        seconds: 660,
        frames: 9800,
        fps: 14.8,
        kbps: 210,
        encodeMsPerFrame: 3.2,
        encoder: 'ExternalEncoder',
        cpuLimitedShare: 0.02,
        recordingSeconds: 660,
        recordingFps: 28.9,
        recordingFpsMin: 26,
        recordingDropped: 4,
      }),
      at(t0 + 15 * 60_000, 'settings.changed', { key: 'livePreviewFromPhones', value: true }),
      preview('preview.started', t0 + 15 * 60_000 + 200, {
        width: 1920,
        height: 1080,
        scale: 5,
        maxKbps: 300,
        maxFps: 15,
        recordingSeconds: 300,
        recordingFps: 29.9,
        recordingFpsMin: 29,
        recordingDropped: 0,
      }),
    ];
    // The phone's clips of the three solves after the check: its lag.
    for (let k = 1; k <= 3; k++) {
      for (const segment of ['scramble', 'solve']) {
        events.push(
          at(
            t0 + (3 + k) * 60_000,
            'remote.clip',
            { camera: 'phone-rear', segment, late: false, syncResidualMs: 112.4 },
            LAPTOP,
            scope(k),
          ),
        );
      }
    }
    // One clip before the check: none.
    events.push(
      at(
        t0 + 30_000,
        'remote.clip',
        { camera: 'phone-rear', segment: 'solve', late: false, syncResidualMs: null },
        LAPTOP,
        scope(0),
      ),
    );
    // The clock sync: withdrawn once, then converged for 25 minutes of minute records.
    const clock = (tsMs: number, why: string, converged: boolean) =>
      at(tsMs, 'rtc.clock', { camera: 'phone-rear', peer: 'ThinkPhone', why, converged });
    events.push(
      clock(t0 + 20 * 60_000, 'converged', true),
      clock(t0 + 22 * 60_000, 'withdrawn', false),
      clock(t0 + 23 * 60_000, 'syncing', false),
      clock(t0 + 24 * 60_000, 'converged', true),
    );
    for (let m = 1; m <= 25; m++) {
      events.push(clock(t0 + (24 + m) * 60_000, 'minute', true));
    }
    return events;
  }

  it('ticks the remote sync check, the lag its clips take, the preview and what it cost, and twenty minutes converged', () => {
    const results = new Map(evaluate(syncDay(), NOW).map((item) => [item.id, item.result]));
    const status = (id: string): string | undefined => results.get(id)?.status;
    const facts = (id: string): string => results.get(id)?.facts ?? '';

    expect(status('4.3.1')).toBe('ok');
    expect(facts('4.3.1')).toBe(
      "1 check on office-mbp of a phone's camera passed (phone-rear): lag 112.4 ms, spread 9.5 ms, 1 with the clock sync converged, its round trip 6.1 ms (medians); the MacBook's own camera 41.2 ms; 1 failed check on office-mbp: the camera saw no motion inside the rectangle",
    );
    expect(status('4.3.2')).toBe('ok');
    expect(facts('4.3.2')).toBe(
      '6 remote clips on office-mbp of 7 with the lag of a check (112 ms)',
    );
    expect(status('4.3.3')).toBe('ok');
    expect(facts('4.3.3')).toBe(
      '2 previews on ThinkPhone sent (1920×1080 / 5; at most 300 kbps and 15 fps)',
    );
    expect(status('4.3.4')).toBe('ok');
    expect(facts('4.3.4')).toBe(
      'the recording at 28.9 fps with the preview (least 26, 4 frames dropped), 29.9 fps without (least 29, 0 dropped), over 1 and 1 spans; the preview 14.8 fps at 210 kbps, 3.2 ms a frame (ExternalEncoder), the CPU holding it back 0.02 of the time (medians)',
    );
    expect(status('4.3.5')).toBe('ok');
    expect(facts('4.3.5')).toBe(
      'the clock sync converged for 25 minutes at the longest, 1 withdrawal; 7 remote clips on office-mbp',
    );

    // None of it without the events; a phone's check that only failed marks 4.3.1; less than twenty
    // minutes converged leaves 4.3.5.
    const empty = new Map(evaluate([], NOW).map((item) => [item.id, item.result.status]));
    for (const id of ['4.3.1', '4.3.2', '4.3.3', '4.3.4', '4.3.5']) {
      expect(empty.get(id), id).toBe('none');
    }
    const onlyFailed = syncDay().filter(
      (e) => !(e.kind === 'sync.check' && e.data['remote'] === true && e.data['outcome'] === 'ok'),
    );
    expect(evaluate(onlyFailed, NOW).find((item) => item.id === '4.3.1')?.result.status).toBe(
      'failed',
    );
    const short = syncDay().filter(
      (e) => !(e.kind === 'rtc.clock' && e.tsMs > NOW - 4 * HOUR + 40 * 60_000),
    );
    const shortResult = evaluate(short, NOW).find((item) => item.id === '4.3.5')?.result;
    expect(shortResult?.status).toBe('none');
    expect(shortResult?.facts).toContain('converged for 16 minutes at the longest');
  });
});

describe('roundReport', () => {
  it('prints the events per device and day, the checklists and the failures, as Markdown', () => {
    const report = roundReport(fixture(), { days: 7, nowMs: NOW });
    expect(report).toContain(
      '# cubetrace round report: the last 7 days, to 2026-10-02 18:00:00 UTC',
    );
    expect(report).toMatch(/\d+ events of 1 account and 2 devices/u);
    expect(report).toContain('### ThinkPhone (Android, installed; account owner-…)');
    expect(report).toContain("### After T3.7 — the cube's whole record");
    expect(report).toContain('### office-mbp (macOS; account owner-…)');
    expect(report).toContain('Last start 2026-10-02 12:00:00 UTC on build 0.4.0 · abc1234');
    expect(report).toContain(
      '| Day (UTC) | Events | Attempts | Clips | Uploads done | Failures | Kinds |',
    );
    expect(report).toMatch(/\| 2026-10-02 \| \d+ \| 22 \| 44 \| 21 \| 0 \| [^|]*attempt\.done×22/u);
    expect(report).toContain('### Round 1 (v0.1.0) — T1.5 — cube connection');
    expect(report).toContain('| 1.5.1 | GAN 12 ui on a laptop with the flag on');
    expect(report).toContain('| ✅ |');
    expect(report).toContain('| ⬜ |');
    expect(report).toMatch(/\*\*\d+ items: \d+ ✅, \d+ ⬜, 0 ❗\.\*\*/u);
    expect(report).toContain('## Last 20 failures');
    expect(report).toContain('| `clip.failed` | ph0ne5e5… / 2 | solve: the clip worker closed |');
    // Every item of the checklist is a row.
    for (const item of CHECKLIST) {
      expect(report).toContain(`| ${item.id} |`);
    }
    // Nothing of an account but the first characters of its uid.
    expect(report).not.toContain('owner-uid');
  });

  it('says so without events', () => {
    const report = roundReport([], { days: 3, nowMs: NOW });
    expect(report).toContain('0 events of 0 accounts and 0 devices');
    expect(report).toContain('No event.');
    expect(report).toContain('None.');
    expect(report).toMatch(/\*\*\d+ items: 1 ✅, \d+ ⬜, 0 ❗\.\*\*/u);
  });

  it('keeps the day in UTC', () => {
    expect(utcDay(Date.UTC(2026, 9, 2, 23, 59, 59))).toBe('2026-10-02');
    expect(utcDay(Date.UTC(2026, 9, 3, 0, 0, 0))).toBe('2026-10-03');
  });
});

describe('parseArgs', () => {
  it('reads --days, --limit and --uid, with their defaults, and refuses the rest', () => {
    expect(parseArgs([])).toEqual({ days: 7, limit: 20_000, uid: null });
    expect(parseArgs(['--days', '30', '--limit', '500', '--uid', 'abc'])).toEqual({
      days: 30,
      limit: 500,
      uid: 'abc',
    });
    expect(() => parseArgs(['--days'])).toThrow('--days needs a value.');
    expect(() => parseArgs(['--days', '0'])).toThrow('positive');
    expect(() => parseArgs(['--since', '1'])).toThrow('Unknown option --since');
  });
});
