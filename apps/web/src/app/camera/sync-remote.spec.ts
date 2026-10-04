import { TestBed } from '@angular/core/testing';
import type { CloudEvent, CloudEventWrite, VideoClip } from '@cubetrace/core';

import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { SYNC_GRACE_MS, SYNC_SETTLE_MS } from '../session/session-service';
import { inverse, ready, turn } from '../session/session-harness';
import { RemoteCameraRegistry, type RemoteCameraEntry } from './remote-camera-registry';
import { SYNC_TICK_MS } from './sync-run';
import {
  FakeRemoteSource,
  REMOTE_CLOCK,
  STILL,
  clapperboard,
  filmTo,
  remotePhone,
  rig,
  update,
  type Rig,
} from './sync-testing';

// The sync check of a remote camera (docs/PLAN.md T4.3): a phone of the Cameras section measures its
// frames' motion and sends it, its times placed on the host clock by the clock sync (a fake source
// here: RemoteCamerasService's own is tested in remote-cameras-service.spec.ts); the host runs the
// same check on the cube's turns, keeps the lag beside the phone's clock sync, and the phone's later
// clips take it.

/**
 * The lags of the phone's ten turns, ms: its frames 50 ms later than the laptop's of
 * sync-service.spec.ts, the spread leaving out the second and the sixth; the eight kept's median is
 * 99 and their spread 8.
 */
const LAGS = [95, 60, 97, 98, 99, 145, 99, 100, 101, 103];

/** The timer with a cube (no camera of its own), and the phone in the registry. */
async function withPhone(changes: Partial<RemoteCameraEntry> = {}): Promise<
  { r: Rig; source: FakeRemoteSource; events: CloudEventWrite[] } & {
    fake: Awaited<ReturnType<typeof ready>>;
  }
> {
  const r = rig();
  const fake = await ready(r.s);
  await update(r);
  const source = new FakeRemoteSource();
  source.cameras.set([remotePhone(r.s.service.session()?.id ?? '', changes)]);
  TestBed.inject(RemoteCameraRegistry).provide(source);
  const events: CloudEventWrite[] = [];
  TestBed.inject(DiagnosticsService).attach({
    uid: 'ada',
    backend: {
      saveEvents: (_uid, writes) => {
        events.push(...writes);
        return Promise.resolve();
      },
    },
  });
  await update(r);
  return { r, source, events, fake };
}

function written(events: CloudEventWrite[], kind: string): CloudEvent[] {
  TestBed.inject(DiagnosticsService).flush();
  return events.map((write) => write.event).filter((event) => event.kind === kind);
}

describe('SyncService, a remote camera (T4.3)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("measures the phone's camera on the cube's turns, keeps its lag beside its clock sync's record, and its later clips take it", async () => {
    const { r, source, events, fake } = await withPhone();
    // The phone's clock sync, as the Cameras section records it before any check: no lag yet.
    r.s.service.putCameraClock('phone-rear', {
      offsetMs: 0,
      rttMs: REMOTE_CLOCK.rttMs,
      driftPpm: REMOTE_CLOCK.driftPpm,
      clapperboardResidualMs: 0,
      clapperboardSamples: 0,
      remote: REMOTE_CLOCK,
    });
    await update(r);
    expect(r.sync.checkOf('phone-rear')).toBeNull();
    expect(r.sync.remotes().map((camera) => camera.label)).toEqual(['phone-rear']);
    expect(r.sync.remoteBlocked('peer-1')).toBeNull();
    // This device's camera is off: no check of its own is due, nor started by itself for the phone.
    expect(r.sync.visible()).toBe(false);
    expect(r.sync.label()).toBeNull();

    r.sync.start({ remote: 'peer-1' });
    await update(r);
    expect(r.sync.visible()).toBe(true);
    expect(r.sync.target()).toBe('peer-1');
    expect(r.sync.targetCamera()?.label).toBe('phone-rear');
    expect(r.sync.run()?.state()).toBe('running');
    expect(r.sync.remoteBlocked('peer-1')).toBe('running');
    expect(source.watches).toHaveLength(1);
    expect(r.s.service.phase()).toBe('sync-check');

    const { turns, energy, events: middles } = clapperboard(r.s.perf.hostMs, LAGS);
    await filmTo(r, source.sink, fake, 14_000, energy, turns, true);
    const run = r.sync.run();
    expect(run?.state()).toBe('done');
    expect(source.watches[0].stopped).toBe(true);
    expect(r.sync.result()).toMatchObject({
      label: 'phone-rear',
      remote: 'ThinkPhone',
      previousOffsetMs: null,
      saved: true,
      outcome: {
        ok: true,
        offsetMs: 99,
        clapperboardResidualMs: 8,
        clapperboardSamples: 8,
        analysis: { matched: 10, kept: 8 },
      },
    });
    // Beside the clock sync's record, kept as it was; the entry repeats its round trip and drift.
    const clock = r.s.service.session()?.clock.cameras['phone-rear'];
    expect(clock).toMatchObject({
      offsetMs: 99,
      rttMs: 7.5,
      driftPpm: 3.1,
      clapperboardResidualMs: 8,
      clapperboardSamples: 8,
      remote: REMOTE_CLOCK,
    });
    expect(clock?.samples).toHaveLength(8);
    expect(clock?.samples?.[0].onsetHostMs).toBeCloseTo(middles[0], 1);
    expect(r.sync.checkOf('phone-rear')).toEqual(clock);
    // The frames' times as the phone's page received them: the frame clock agrees with it.
    expect(run?.outcome()?.analysis.clock?.frameMinusPageMs).toBe(-2);
    // Its event: the check's, with the phone and the clock sync that placed its frames.
    expect(written(events, 'sync.check').at(-1)?.data).toMatchObject({
      outcome: 'ok',
      camera: 'phone-rear',
      offsetMs: 99,
      spreadMs: 8,
      kept: 8,
      saved: true,
      remote: true,
      peer: 'ThinkPhone',
      clockConverged: false,
      clockOffsetMs: -2401,
      clockRttMs: 7.5,
      clockSamples: 12,
    });
    // Its diagnostics name the phone and the clock sync.
    expect(r.sync.report()?.remote).toEqual({ peer: 'ThinkPhone', clock: source.clock });

    // Its later clips take the lag as their syncResidualMs, as a local camera's do.
    await filmTo(r, source.sink, fake, SYNC_SETTLE_MS + SYNC_GRACE_MS + SYNC_TICK_MS, STILL);
    expect(r.s.service.suspended()).toBe(false);
    turn(r.s, fake, 'R U F', 100);
    await update(r);
    turn(r.s, fake, inverse('R U F'), 150);
    await update(r);
    const attempt = r.s.service.attempts().at(-1);
    expect(attempt).toBeDefined();
    const ref = {
      session: r.s.service.session()?.id ?? '',
      index: attempt?.index ?? 0,
      scrambleShown: attempt?.events.scrambleShown ?? 0,
    };
    const clip: VideoClip = {
      camera: 'phone-rear',
      segment: 'solve',
      file: 'phone-rear.solve.mp4',
      bytes: 1000,
      codec: 'avc1.640028',
      audio: null,
      width: 1080,
      height: 1920,
      crop: null,
      fpsNominal: 30,
      frames: 30,
      firstFrameHostMs: r.s.perf.hostMs - 5000,
      framesFile: 'phone-rear.solve.frames.json',
      syncResidualMs: null,
      truncatedStart: false,
    };
    expect(await r.s.service.attachClip(ref, clip)).toBe('saved');
    expect(r.s.service.attempts().at(-1)?.video[0].syncResidualMs).toBe(99);
  });

  it("writes the estimate of the check as the clock sync's record when there is none yet", async () => {
    const { r, source, fake } = await withPhone();
    r.sync.start({ remote: 'peer-1' });
    await update(r);
    const { turns, energy } = clapperboard(r.s.perf.hostMs, LAGS);
    await filmTo(r, source.sink, fake, 14_000, energy, turns, true);
    expect(r.s.service.session()?.clock.cameras['phone-rear']).toMatchObject({
      offsetMs: 99,
      rttMs: 7.5,
      driftPpm: 3.1,
      remote: { ...REMOTE_CLOCK, offsetMs: -2401, converged: false },
    });
  });

  it('asks for the framing on the phone while its rectangle is wide, and starts anyway; Retry measures the phone again', async () => {
    const { r, source, fake } = await withPhone({ framing: null });
    r.sync.start({ remote: 'peer-1' });
    await update(r);
    expect(r.sync.visible()).toBe(true);
    expect(r.sync.waiting()).toBe(true);
    expect(r.sync.framingWide()).toBe(true);
    expect(r.sync.target()).toBe('peer-1');
    expect(source.watches).toEqual([]);
    // The phone's rectangle drawn around the cube: the panel says so; Start (`again`) starts it.
    source.change({ framing: { x: 140, y: 610, w: 800, h: 700 } });
    await update(r);
    expect(r.sync.framingWide()).toBe(false);
    r.sync.later();
    source.change({ framing: null });
    r.sync.start({ remote: 'peer-1' });
    r.sync.startAnyway();
    await update(r);
    expect(r.sync.run()?.state()).toBe('running');
    expect(source.watches).toHaveLength(1);
    // The turns are there, but the phone stops measuring: the check ends as failed, nothing kept.
    const { turns, energy } = clapperboard(r.s.perf.hostMs, LAGS);
    await filmTo(r, source.sink, fake, 3000, energy, turns, true);
    source.watches[0].onError('the phone: the phone is not recording');
    await update(r);
    expect(r.sync.result()?.outcome).toMatchObject({
      ok: false,
      reason: 'interrupted',
      message: "the camera's frames could not be measured (the phone: the phone is not recording)",
    });
    expect(r.s.service.session()?.clock.cameras['phone-rear']).toBeUndefined();
    // Retry: the same phone again, the framing taken as it is (it was started anyway).
    await filmTo(r, source.sink, fake, SYNC_SETTLE_MS + SYNC_GRACE_MS + SYNC_TICK_MS, STILL);
    r.sync.again();
    await update(r);
    expect(r.sync.run()?.state()).toBe('running');
    expect(source.watches).toHaveLength(2);
    expect(r.sync.target()).toBe('peer-1');
  });

  it('refuses a phone not connected, without its clock sync, or not recording, and says why', async () => {
    const { r, source } = await withPhone();
    source.change({ state: 'reconnecting' });
    await update(r);
    expect(r.sync.remoteBlocked('peer-1')).toBe('remote-gone');
    r.sync.start({ remote: 'peer-1' });
    expect(r.sync.notice()).toBe(
      'The sync check cannot start now: the phone is not connected to this session.',
    );
    expect(r.sync.visible()).toBe(false);
    source.change({ state: 'connected', synced: false });
    expect(r.sync.remoteBlocked('peer-1')).toBe('remote-syncing');
    source.change({ synced: true, recording: false });
    expect(r.sync.remoteBlocked('peer-1')).toBe('remote-not-recording');
    source.change({ recording: true, session: 'another' });
    expect(r.sync.remoteBlocked('peer-1')).toBe('remote-gone');
    expect(r.sync.remotes()).toEqual([]);
    expect(r.sync.remoteBlocked('nobody')).toBe('remote-gone');
    // Its watch refused (the phone went meanwhile): the check ends at once, saying so.
    source.change({ session: r.s.service.session()?.id ?? '' });
    source.watchMotion = () => null;
    r.sync.start({ remote: 'peer-1' });
    await update(r);
    expect(r.sync.result()?.outcome).toMatchObject({
      ok: false,
      message: "the phone's frames could not be measured (it is not connected)",
    });
  });
});
