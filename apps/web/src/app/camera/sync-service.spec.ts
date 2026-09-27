import { inverse, ready, turn } from '../session/session-harness';
import { statsOf } from './recording-testing';
import { SYNC_TICK_MS, SYNC_TURNS } from './sync-run';
import { clapperboard, film, recording, rig, update } from './sync-testing';

/** The lags of a check's ten turns in the frames, ms: median 49, spread (p95 − p5) 8. */
const LAGS = [44, 50, 47, 52, 49, 44, 50, 47, 52, 49];

describe('SyncService', () => {
  it('starts by itself when a session records, and keeps the lag it finds in the session', async () => {
    const r = rig();
    expect(r.sync.visible()).toBe(false);
    const { fake, capture } = await recording(r);

    // The check started with the session: it watches the framing rectangle.
    expect(r.sync.visible()).toBe(true);
    expect(r.sync.run()?.state()).toBe('running');
    expect(r.sync.blocked()).toBe('running');
    expect(capture.watches).toHaveLength(1);
    expect(capture.watches[0].rect).toEqual(r.camera.framing());
    expect(r.sync.label()).toBe('laptop');
    expect(SYNC_TURNS).toBe(10);

    const { turns, energy, onsets } = clapperboard(r.s.perf.hostMs, LAGS);
    await film(r, capture, fake, 2000, energy, turns);
    expect(r.sync.run()?.moves()).toBe(1);
    expect(r.sync.run()?.frames()).toBeGreaterThan(55);
    expect(r.sync.run()?.onsets()).toBe(1);
    expect(r.sync.run()?.secondsLeft()).toBe(18);

    // Ten turns, then a second and more of stillness: it ends before its 20 s.
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
      outcome: { ok: true, offsetMs: 49, clapperboardResidualMs: 8, clapperboardSamples: 10 },
    });
    const clock = r.s.service.session()?.clock.cameras['laptop'];
    expect(clock).toMatchObject({
      offsetMs: 49,
      rttMs: 0,
      driftPpm: 0,
      clapperboardResidualMs: 8,
      clapperboardSamples: 10,
    });
    expect(clock?.samples?.map((pair) => pair.moveHostMs)).toEqual(turns);
    clock?.samples?.forEach((pair, k) => {
      expect(pair.onsetHostMs).toBeCloseTo(onsets[k], 1);
    });
    expect(r.sync.stored()).toEqual(clock);
    await r.s.service.whenSaved();
    const stored = await r.s.store.exportSession(r.s.service.session()?.id ?? '');
    expect(stored.session.clock.cameras['laptop']).toEqual(clock);

    // The panel stays until closed; the check does not start again by itself.
    await film(r, capture, fake, 3000, () => 1);
    expect(r.sync.visible()).toBe(true);
    r.sync.later();
    await update(r);
    expect(r.sync.visible()).toBe(false);
    expect(capture.watches).toHaveLength(1);
  });

  it("suspends the timer while it runs: the turns become no attempt's, which begins again after it with its scramble and number", async () => {
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
    await film(r, capture, fake, 8000, energy, turns);

    // Over: the cube is solved again (each turn was turned back), and attempt 1 begins again with
    // its scramble. The check's turns are in no record.
    expect(r.sync.run()?.state()).toBe('done');
    expect(r.s.service.suspended()).toBe(false);
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
    expect(r.s.service.phase()).toBe('scrambling');
  });

  it('fails after 20 s without turns, keeping nothing, and Retry starts it again', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);

    await film(r, capture, fake, 19_000, () => 1);
    expect(r.sync.run()?.state()).toBe('running');
    await film(r, capture, fake, 1000 + SYNC_TICK_MS, () => 1);

    expect(r.sync.run()?.state()).toBe('done');
    expect(r.sync.result()?.outcome).toMatchObject({
      ok: false,
      reason: 'no-moves',
      message: 'the cube did not move',
    });
    expect(r.sync.result()?.outcome.durationMs).toBeGreaterThanOrEqual(20_000);
    expect(r.s.service.session()?.clock.cameras).toEqual({});
    expect(r.sync.visible()).toBe(true);
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
    expect(r.s.service.phase()).toBe('scrambling');
    expect(r.s.service.attempt()).toMatchObject({ index: 1, scramble });
    await film(r, capture, fake, 1000, () => 1);
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
    await update(r);
    expect(r.s.service.phase()).toBe('solve-first');
    expect(r.s.service.attempt()).toBeNull();

    turn(r.s, fake, "U'");
    await update(r);
    expect(r.s.service.phase()).toBe('scrambling');
    expect(r.s.service.attempt()).toMatchObject({ index: 1, scramble });
  });

  it('ends a check as failed when the recording stops, the frames cannot be measured or the cube goes', async () => {
    const r = rig();
    const { capture } = await recording(r);

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
    await update(r);
    r.starter.last.emitStats(statsOf(5));
    await update(r);
    expect(r.recording.status()).toBe('recording');
    expect(r.sync.blocked()).toBe('scrambling');
    r.sync.start();
    expect(r.sync.run()).toBeNull();
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
    expect(r.s.service.suspended()).toBe(false);

    // Solved: attempt 2 begins, its scramble not begun, and the check starts by itself.
    turn(r.s, fake, "U' R'", 300);
    await update(r);
    expect(r.s.service.attempts().map((attempt) => attempt.scramble)).toEqual([scramble]);
    expect(r.sync.run()?.state()).toBe('running');
    expect(r.sync.visible()).toBe(true);
    expect(r.s.service.phase()).toBe('sync-check');
    expect(r.s.service.index()).toBe(2);
  });
});
