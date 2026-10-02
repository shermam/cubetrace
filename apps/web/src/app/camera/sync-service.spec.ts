import type { FakeCube } from '@cubetrace/gan';

import { FAKE_FACETIME, FAKE_WEBCAM } from '../device/fake-browser';
import { SYNC_GRACE_MS, SYNC_SETTLE_MS } from '../session/session-service';
import { inverse, ready, turn } from '../session/session-harness';
import { statsOf, type FakeCapture } from './recording-testing';
import { SYNC_TICK_MS, SYNC_TURNS } from './sync-run';
import {
  AROUND_THE_CUBE,
  STILL,
  clapperboard,
  film,
  recording,
  rig,
  update,
  type Rig,
} from './sync-testing';

/**
 * The lags of a check's ten turns in the frames, ms: two far off (10 and 95 ms), which the spread
 * leaves out (T2.11); the other eight's median is 49 and their spread 8.
 */
const LAGS = [45, 10, 47, 48, 49, 95, 49, 50, 51, 53];
/** The turns the spread keeps: all but the second and the sixth. */
const KEPT = [0, 2, 3, 4, 6, 7, 8, 9];

/** Films the stillness after a check until the timer tracks attempts again (hold, then grace). */
async function settleAfter(r: Rig, capture: FakeCapture, fake: FakeCube): Promise<void> {
  await film(r, capture, fake, SYNC_SETTLE_MS + SYNC_GRACE_MS + SYNC_TICK_MS, STILL);
}

describe('SyncService', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts by itself when a session records, and keeps the lag it finds in the session', async () => {
    const r = rig();
    expect(r.sync.visible()).toBe(false);
    const { fake, capture } = await recording(r);

    // The check started with the session: it watches the framing rectangle.
    expect(r.sync.visible()).toBe(true);
    expect(r.sync.waiting()).toBe(false);
    expect(r.sync.run()?.state()).toBe('running');
    expect(r.sync.blocked()).toBe('running');
    expect(capture.watches).toHaveLength(1);
    expect(capture.watches[0].rect).toEqual(AROUND_THE_CUBE);
    expect(r.sync.label()).toBe('laptop');
    expect(SYNC_TURNS).toBe(10);
    expect(r.sync.run()?.secondsLeft()).toBe(20);

    const { turns, energy, events } = clapperboard(r.s.perf.hostMs, LAGS);
    await film(r, capture, fake, 2000, energy, turns);
    expect(r.sync.run()?.moves()).toBe(1);
    expect(r.sync.run()?.frames()).toBeGreaterThan(55);
    expect(r.sync.run()?.matched()).toBe(1);
    // Turning: no countdown any more, the turns count.
    expect(r.sync.run()?.secondsLeft()).toBe(0);

    // Ten turns, then a second and more of stillness: it ends.
    await film(r, capture, fake, 12_000, energy, turns);
    const run = r.sync.run();
    expect(run?.state()).toBe('done');
    expect(run?.outcome()?.durationMs).toBeLessThan(14_000);
    expect(capture.watches[0].stopped).toBe(true);
    const result = r.sync.result();
    expect(result).toMatchObject({
      label: 'laptop',
      previousOffsetMs: null,
      saved: true,
      outcome: {
        ok: true,
        offsetMs: 49,
        clapperboardResidualMs: 8,
        clapperboardSamples: 8,
        analysis: { matched: 10, kept: 8 },
      },
    });
    const clock = r.s.service.session()?.clock.cameras['laptop'];
    expect(clock).toMatchObject({
      offsetMs: 49,
      rttMs: 0,
      driftPpm: 0,
      clapperboardResidualMs: 8,
      clapperboardSamples: 8,
    });
    // The pairs kept, each move with the middle of its turn's motion.
    expect(clock?.samples?.map((pair) => pair.moveHostMs)).toEqual(KEPT.map((k) => turns[k]));
    clock?.samples?.forEach((pair, k) => {
      expect(pair.onsetHostMs).toBeCloseTo(events[KEPT[k]], 1);
    });
    expect(r.sync.stored()).toEqual(clock);
    await r.s.service.whenSaved();
    const stored = await r.s.store.exportSession(r.s.service.session()?.id ?? '');
    expect(stored.session.clock.cameras['laptop']).toEqual(clock);

    // The panel stays until closed; the check does not start again by itself.
    await film(r, capture, fake, 3000, STILL);
    expect(r.sync.visible()).toBe(true);
    r.sync.later();
    await update(r);
    expect(r.sync.visible()).toBe(false);
    expect(capture.watches).toHaveLength(1);
  });

  it("suspends the timer while it runs and until the cube is still: the turns become no attempt's, which begins again after it with its scramble and number", async () => {
    const r = rig();
    const { fake, capture } = await recording(r);
    // Attempt 1 was under way, its scramble not begun: dropped for the check.
    const scramble = r.s.made[0];
    expect(r.s.service.suspended()).toBe(true);
    expect(r.s.service.phase()).toBe('sync-check');
    expect(r.s.service.attempt()).toBeNull();
    expect(r.s.service.scramble()).toBe(scramble);
    expect(r.s.service.index()).toBe(1);

    const { turns, energy } = clapperboard(r.s.perf.hostMs, LAGS);
    await film(r, capture, fake, 6000, energy, turns);
    expect(r.s.service.phase()).toBe('sync-check');
    expect(r.s.service.attempt()).toBeNull();
    await film(r, capture, fake, 7500, energy, turns);

    // Over, but the cube has not been still for 2 s since the last turn: the timer waits.
    expect(r.sync.run()?.state()).toBe('done');
    expect(r.s.service.phase()).toBe('sync-check');
    expect(r.s.service.syncCheckOver()).toBe(true);
    expect(r.s.service.attempt()).toBeNull();
    await settleAfter(r, capture, fake);

    // The cube is solved again (each turn was turned back), and attempt 1 begins again with its
    // scramble. The check's turns are in no record.
    expect(r.s.service.suspended()).toBe(false);
    expect(r.s.service.syncCheckOver()).toBe(false);
    expect(r.s.service.phase()).toBe('scrambling');
    expect(r.s.service.attempt()).toMatchObject({
      index: 1,
      scramble,
      state: 'scrambling',
      events: { scrambleStart: null },
    });
    expect(r.s.service.attempts()).toEqual([]);
    await r.s.service.whenSaved();
    expect(await r.s.store.loadAttempts(r.s.service.session()?.id ?? '')).toEqual([]);

    // Its scramble and solve are recorded as ever, without the check's turns.
    turn(r.s, fake, scramble);
    turn(r.s, fake, inverse(scramble), 300);
    await update(r);
    const [record] = r.s.service.attempts();
    expect(record).toMatchObject({
      index: 1,
      scramble,
      result: { status: 'solved', scrambleCorrected: false, scrambleExtraMoves: 0 },
    });
    expect(record.moves).toHaveLength(6);
  });

  it('never gives up in the middle of the turns: past 20 s it waits for the tenth', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);
    // Ten turns 2.5 s apart: the tenth 25 s in.
    const { turns, energy } = clapperboard(r.s.perf.hostMs, LAGS, 2500);

    await film(r, capture, fake, 22_000, energy, turns);
    expect(r.sync.run()?.state()).toBe('running');
    expect(r.sync.run()?.moves()).toBe(8);
    expect(r.s.service.phase()).toBe('sync-check');

    await film(r, capture, fake, 4500, energy, turns);
    expect(r.sync.run()?.state()).toBe('done');
    expect(r.sync.result()?.outcome).toMatchObject({ ok: true, offsetMs: 49 });
    expect(r.sync.result()?.outcome.durationMs).toBeGreaterThan(25_000);
  });

  it('after the check, turns made go to no attempt until the cube has been still, and a turn just after is ignored', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);
    const scramble = r.s.made[0];
    const { turns, energy } = clapperboard(r.s.perf.hostMs, LAGS);
    await film(r, capture, fake, 13_500, energy, turns);
    expect(r.sync.run()?.state()).toBe('done');

    // Two more turns, before the cube has been still for 2 s since the check's last one and a
    // second and a half apart, as if the check went on: the timer still waits.
    const more = [r.s.perf.hostMs + 200, r.s.perf.hostMs + 1700];
    await film(r, capture, fake, 3000, STILL, more);
    expect(r.s.service.phase()).toBe('sync-check');
    expect(r.s.service.suspended()).toBe(true);
    // Still for 2 s since the last: the suspension ends; a turn half a second later is ignored,
    // and so is its turning back: the attempt waits for a second of stillness, the cube solved.
    await film(r, capture, fake, 1200, STILL);
    expect(r.s.service.suspended()).toBe(false);
    expect(r.s.service.phase()).toBe('sync-check');
    const late = [r.s.perf.hostMs + 300, r.s.perf.hostMs + 900];
    await film(r, capture, fake, 1500, STILL, late);
    expect(r.s.service.attempt()).toBeNull();
    await film(r, capture, fake, 500, STILL);
    expect(r.s.service.phase()).toBe('scrambling');
    const attempt = r.s.service.attempt();
    expect(attempt).toMatchObject({ index: 1, scramble, events: { scrambleStart: null } });
    expect(attempt?.events.scrambleShown).toBeGreaterThan(late[1] + SYNC_GRACE_MS - 1);
  });

  it('runs again on demand, replacing the lag and saying the one before', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);
    const first = clapperboard(r.s.perf.hostMs, [40, 41, 42, 41, 40, 40, 41, 42, 41, 40]);
    await film(r, capture, fake, 14_000, first.energy, first.turns);
    expect(r.s.service.session()?.clock.cameras['laptop']?.offsetMs).toBe(41);
    r.sync.later();

    r.sync.start();
    await update(r);
    expect(r.sync.visible()).toBe(true);
    expect(r.s.service.phase()).toBe('sync-check');
    expect(capture.watches).toHaveLength(2);
    const second = clapperboard(r.s.perf.hostMs, [60, 61, 62, 61, 60, 60, 61, 62, 61, 60]);
    await film(r, capture, fake, 14_000, second.energy, second.turns);

    expect(r.sync.result()).toMatchObject({
      previousOffsetMs: 41,
      outcome: { ok: true, offsetMs: 61 },
    });
    expect(r.s.service.session()?.clock.cameras['laptop']?.offsetMs).toBe(61);
    await settleAfter(r, capture, fake);
    expect(r.s.service.phase()).toBe('scrambling');
  });

  it('keeps a check per camera of the session, by the label the session gives it: a camera switched to is due its own, one switched back to finds its own (T2.14)', async () => {
    const r = rig([FAKE_WEBCAM, FAKE_FACETIME]);
    const { fake, capture } = await recording(r);
    // The first camera's check, due by itself at the session's start.
    expect(r.sync.label()).toBe('laptop');
    const first = clapperboard(r.s.perf.hostMs, LAGS);
    await film(r, capture, fake, 14_000, first.energy, first.turns);
    expect(r.sync.result()).toMatchObject({ label: 'laptop', outcome: { ok: true, offsetMs: 49 } });
    r.sync.later();
    await settleAfter(r, capture, fake);
    expect(r.s.service.phase()).toBe('scrambling');

    // The FaceTime camera, `laptop` by the host too (issue #40): `laptop-2` in the session, which
    // has no check of it, so one is due by itself, asking for a rectangle around the cube first
    // (the framing is the camera's own).
    await r.camera.select('facetime');
    await update(r);
    const facetime = r.starter.last;
    expect(facetime).not.toBe(capture);
    facetime.emitStats(statsOf(5));
    await update(r);
    expect(r.sync.label()).toBe('laptop-2');
    expect(r.sync.stored()).toBeNull();
    expect(r.sync.visible()).toBe(true);
    expect(r.sync.waiting()).toBe(true);
    r.camera.setFraming(AROUND_THE_CUBE);
    r.sync.start();
    await update(r);
    expect(r.sync.run()?.state()).toBe('running');
    expect(facetime.watches).toHaveLength(1);
    // The Logitech webcam's lag of docs/DEVICES.md, for a camera of its own.
    const second = clapperboard(
      r.s.perf.hostMs,
      [177, 175, 178, 176, 177, 179, 177, 176, 178, 177],
    );
    await film(r, facetime, fake, 14_000, second.energy, second.turns);
    expect(r.sync.result()).toMatchObject({
      label: 'laptop-2',
      previousOffsetMs: null,
      saved: true,
      outcome: { ok: true, offsetMs: 177 },
    });
    expect(r.sync.stored()?.offsetMs).toBe(177);
    r.sync.later();
    await settleAfter(r, facetime, fake);

    // The first camera again: its own check is there, so none is due.
    await r.camera.select('fake-webcam');
    await update(r);
    r.starter.last.emitStats(statsOf(5));
    await update(r);
    expect(r.sync.label()).toBe('laptop');
    expect(r.sync.stored()?.offsetMs).toBe(49);
    expect(r.sync.visible()).toBe(false);
    expect(r.starter.last.watches).toHaveLength(0);
    await r.s.service.whenSaved();
    const { session } = await r.s.store.exportSession(r.s.service.session()?.id ?? '');
    expect(session.cameras.map((entry) => [entry.label, entry.deviceLabel])).toEqual([
      ['laptop', 'fake_device_0'],
      ['laptop-2', 'FaceTime HD Camera (3A71:F4B5)'],
    ]);
    expect(session.clock.cameras).toMatchObject({
      laptop: { offsetMs: 49, clapperboardSamples: 8 },
      'laptop-2': { offsetMs: 177, clapperboardSamples: 8 },
    });
  });

  it('fails after 20 s without turns, keeping nothing, and Retry starts it again', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);

    await film(r, capture, fake, 19_000, STILL);
    expect(r.sync.run()?.state()).toBe('running');
    expect(r.sync.run()?.secondsLeft()).toBe(1);
    await film(r, capture, fake, 1000 + SYNC_TICK_MS, STILL);

    expect(r.sync.run()?.state()).toBe('done');
    expect(r.sync.result()?.outcome).toMatchObject({
      ok: false,
      reason: 'no-moves',
      message: 'the cube did not move',
    });
    expect(r.sync.result()?.outcome.durationMs).toBeGreaterThanOrEqual(20_000);
    expect(r.s.service.session()?.clock.cameras).toEqual({});
    expect(r.sync.visible()).toBe(true);
    // The cube has been still all along: the timer goes on once its grace is over.
    await film(r, capture, fake, SYNC_GRACE_MS, STILL);
    expect(r.s.service.phase()).toBe('scrambling');

    r.sync.start();
    await update(r);
    expect(r.sync.run()?.state()).toBe('running');
    expect(r.sync.result()).toBeNull();
    expect(capture.watches).toHaveLength(2);
    expect(r.s.service.phase()).toBe('sync-check');
  });

  it('"Later" ends a check under way without a result and hides it; the timer goes on', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);
    const run = r.sync.run();
    const scramble = r.s.service.scramble();

    r.sync.later();
    await update(r);

    expect(run?.state()).toBe('cancelled');
    expect(capture.watches[0].stopped).toBe(true);
    expect(r.sync.visible()).toBe(false);
    expect(r.sync.result()).toBeNull();
    expect(r.s.service.suspended()).toBe(false);
    await film(r, capture, fake, SYNC_GRACE_MS, STILL);
    expect(r.s.service.phase()).toBe('scrambling');
    expect(r.s.service.attempt()).toMatchObject({ index: 1, scramble });
    expect(r.sync.run()).toBe(run);
    expect(r.sync.blocked()).toBeNull();
  });

  it('left with the cube turned, the attempt waits for the cube to be solved', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);
    const scramble = r.s.service.scramble();
    // One turn, not turned back.
    const { turns, energy } = clapperboard(r.s.perf.hostMs, [45]);
    await film(r, capture, fake, 2000, energy, turns);

    r.sync.later();
    await film(r, capture, fake, SYNC_GRACE_MS, STILL);
    expect(r.s.service.phase()).toBe('solve-first');
    expect(r.s.service.attempt()).toBeNull();

    turn(r.s, fake, "U'");
    await film(r, capture, fake, SYNC_GRACE_MS, STILL);
    expect(r.s.service.phase()).toBe('scrambling');
    expect(r.s.service.attempt()).toMatchObject({ index: 1, scramble });
  });

  it('ends a check as failed when the recording stops, the frames cannot be measured or the cube goes', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);

    capture.watches[0].onError?.("Error: The camera's frames cannot be read here.");
    await update(r);
    expect(r.sync.result()?.outcome).toMatchObject({
      ok: false,
      reason: 'interrupted',
      message:
        "the camera's frames could not be measured (Error: The camera's frames cannot be read here.)",
    });
    expect(r.s.service.suspended()).toBe(false);

    r.sync.start();
    await update(r);
    expect(r.sync.run()?.state()).toBe('running');
    await r.s.cube.disconnect();
    await update(r);
    expect(r.sync.result()?.outcome).toMatchObject({
      reason: 'interrupted',
      message: 'the cube disconnected',
    });
    await film(r, capture, fake, SYNC_GRACE_MS, STILL);
    expect(r.s.service.phase()).toBe('no-cube');
    expect(r.sync.blocked()).toBe('no-cube');

    // Another connection: its attempt begins, the check being over.
    await ready(r.s);
    await update(r);
    expect(r.s.service.phase()).toBe('scrambling');
    r.sync.start();
    await update(r);
    expect(r.sync.run()?.state()).toBe('running');
    capture.emitError({ message: 'The video encoder failed.', fatal: true });
    await update(r);
    expect(r.sync.result()?.outcome).toMatchObject({
      ok: false,
      reason: 'interrupted',
      message: 'recording stopped',
    });
    expect(r.sync.blocked()).toBe('not-recording');
    expect(r.s.service.suspended()).toBe(false);
    r.sync.start();
    expect(capture.watches).toHaveLength(3);
    expect(r.sync.notice()).toBe(
      'The sync check cannot start now: the camera is not recording (it records while a session is under way).',
    );
  });

  it('never starts once the scramble has begun, nor during a solve; it starts by itself at the next attempt', async () => {
    const r = rig();
    const fake = await ready(r.s);
    await update(r);
    // No camera: nothing to check.
    expect(r.sync.label()).toBeNull();
    expect(r.sync.blocked()).toBe('not-recording');
    r.sync.start();
    expect(r.sync.run()).toBeNull();

    // The camera on once the scramble has begun: the check waits.
    const scramble = r.s.service.scramble() ?? '';
    turn(r.s, fake, 'R');
    await r.camera.start();
    r.camera.setFraming(AROUND_THE_CUBE);
    await update(r);
    r.starter.last.emitStats(statsOf(5));
    await update(r);
    expect(r.recording.status()).toBe('recording');
    expect(r.sync.blocked()).toBe('scrambling');
    r.sync.start();
    expect(r.sync.run()).toBeNull();
    expect(r.sync.notice()).toBe(
      "The sync check cannot start now: the scramble has begun; it can after the solve, or before the scramble's first turn.",
    );
    expect(r.s.service.phase()).toBe('scrambling');

    // The scramble done, the solve about to start, then under way: still not.
    turn(r.s, fake, 'U F');
    await update(r);
    expect(r.s.service.phase()).toBe('armed');
    expect(r.sync.blocked()).toBe('solving');
    turn(r.s, fake, "F'", 300);
    await update(r);
    expect(r.s.service.phase()).toBe('solving');
    r.sync.start();
    expect(r.sync.run()).toBeNull();
    expect(r.sync.notice()).toBe(
      'The sync check cannot start now: a solve is about to start or under way; it can after the solve.',
    );
    expect(r.s.service.suspended()).toBe(false);

    // Solved: attempt 2 begins, its scramble not begun, and the check starts by itself.
    turn(r.s, fake, "U' R'", 300);
    await update(r);
    expect(r.s.service.attempts().map((attempt) => attempt.scramble)).toEqual([scramble]);
    expect(r.sync.run()?.state()).toBe('running');
    expect(r.sync.visible()).toBe(true);
    expect(r.sync.notice()).toBeNull();
    expect(r.s.service.phase()).toBe('sync-check');
    expect(r.s.service.index()).toBe(2);
  });

  it('with the whole frame to watch, asks for a framing rectangle around the cube first; then Start, or Start anyway', async () => {
    const r = rig();
    const { fake, capture } = await recording(r, { framed: false });

    // Due by itself, but waiting: the timer goes on meanwhile.
    expect(r.sync.visible()).toBe(true);
    expect(r.sync.framingWide()).toBe(true);
    expect(r.sync.waiting()).toBe(true);
    expect(r.sync.run()).toBeNull();
    expect(capture.watches).toHaveLength(0);
    expect(r.s.service.phase()).toBe('scrambling');

    // "Edit the framing" opens the editor; a rectangle around the cube, and it is ready.
    expect(r.camera.framingEditing()).toBe(false);
    r.sync.editFraming();
    expect(r.camera.framingEditing()).toBe(true);
    r.camera.setFraming(AROUND_THE_CUBE);
    await update(r);
    expect(r.sync.framingWide()).toBe(false);
    expect(r.sync.waiting()).toBe(true);
    expect(r.sync.run()).toBeNull();
    r.sync.start();
    await update(r);
    expect(r.sync.waiting()).toBe(false);
    expect(r.sync.run()?.state()).toBe('running');
    expect(capture.watches.at(-1)?.rect).toEqual(AROUND_THE_CUBE);
    r.sync.later();
    await film(r, capture, fake, SYNC_GRACE_MS, STILL);

    // The whole frame again: Start asks again; Start anyway runs it, and the next ones in the
    // session run without asking.
    r.camera.setFraming({ x: 0, y: 0, w: 1920, h: 1080 });
    r.sync.start();
    await update(r);
    expect(r.sync.waiting()).toBe(true);
    r.sync.startAnyway();
    await update(r);
    expect(r.sync.run()?.state()).toBe('running');
    expect(capture.watches.at(-1)?.rect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    r.sync.later();
    await film(r, capture, fake, SYNC_GRACE_MS, STILL);
    r.sync.start();
    await update(r);
    expect(r.sync.waiting()).toBe(false);
    expect(r.sync.run()?.state()).toBe('running');
  });

  it('keeps what the check saw for its diagnostics, and writes one line to the console', async () => {
    const r = rig();
    const info = vi.mocked(console.info);
    const { fake, capture } = await recording(r);
    capture.watches[0].onMeter?.({
      format: 'NV12',
      path: 'copy',
      frameWidth: 1920,
      frameHeight: 1080,
      region: AROUND_THE_CUBE,
      planeWidth: 160,
      planeHeight: 90,
      changeLevels: 12,
    });
    const { turns, energy } = clapperboard(r.s.perf.hostMs, LAGS);
    await film(r, capture, fake, 14_000, energy, turns);

    const report = r.sync.report();
    expect(report).toMatchObject({
      report: 'cubetrace sync check',
      version: 2,
      camera: {
        label: 'laptop',
        deviceLabel: 'fake_device_0',
        frameWidth: 1920,
        frameHeight: 1080,
      },
      framing: { rect: AROUND_THE_CUBE, wide: false },
      meter: { format: 'NV12', path: 'copy', planeWidth: 160 },
      detection: { estimator: 'motion-centre' },
      result: {
        ok: true,
        reason: null,
        offsetMs: 49,
        spreadMs: 8,
        matched: 10,
        unmatched: 0,
        kept: 8,
      },
    });
    expect(report?.moves.map((move) => move.move)).toEqual(Array(5).fill(['U', "U'"]).flat());
    expect(report?.moves.every((move) => move.single)).toBe(true);
    expect(report?.turns).toHaveLength(10);
    expect(report?.series.length).toBe(report?.result.frames);
    expect(report?.series[0]).toEqual({
      hostMs: expect.any(Number) as number,
      mean: 0.12,
      changed: 0.0003,
    });
    expect(report?.clock?.frameMinusPageMs).toBe(0);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toMatch(/^cubetrace: sync check passed \{"reason":null,/);
    expect(info.mock.calls[0][0]).toContain('"offsetMs":49');
    expect(info.mock.calls[0][0]).toContain('"matched":10,"kept":8,"droppedLagsMs":[10,95]');
    expect(info.mock.calls[0][0]).toContain('"format":"NV12","path":"copy","plane":"160×90"');
  });
});
