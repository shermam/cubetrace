import { inverse, ready, turn } from '../session/session-harness';
import { statsOf } from './recording-testing';
import { SYNC_TICK_MS } from './sync-run';
import { clapperboard, film, recording, rig, update } from './sync-testing';

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

    const { turns, energy, onsets } = clapperboard(r.s.perf.hostMs, [44, 50, 47, 52, 49]);
    await film(r, capture, fake, 2000, energy, turns);
    expect(r.sync.run()?.moves()).toBe(1);
    expect(r.sync.run()?.frames()).toBeGreaterThan(55);
    expect(r.sync.run()?.onsets()).toBe(1);
    expect(r.sync.run()?.secondsLeft()).toBe(18);

    // Five turns, then a second and more of stillness: it ends before its 20 s.
    await film(r, capture, fake, 6000, energy, turns);
    const run = r.sync.run();
    expect(run?.state()).toBe('done');
    expect(capture.watches[0].stopped).toBe(true);
    const result = r.sync.result();
    expect(result).toMatchObject({
      label: 'laptop',
      previousOffsetMs: null,
      saved: true,
      outcome: { ok: true, offsetMs: 49, clapperboardResidualMs: 8, clapperboardSamples: 5 },
    });
    const clock = r.s.service.session()?.clock.cameras['laptop'];
    expect(clock).toMatchObject({
      offsetMs: 49,
      rttMs: 0,
      driftPpm: 0,
      clapperboardResidualMs: 8,
      clapperboardSamples: 5,
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

  it('runs again on demand, replacing the lag and saying the one before', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);
    const first = clapperboard(r.s.perf.hostMs, [40, 41, 42, 41, 40]);
    await film(r, capture, fake, 8000, first.energy, first.turns);
    expect(r.s.service.session()?.clock.cameras['laptop']?.offsetMs).toBe(41);
    r.sync.later();

    r.sync.start();
    await update(r);
    expect(r.sync.visible()).toBe(true);
    expect(capture.watches).toHaveLength(2);
    const second = clapperboard(r.s.perf.hostMs, [60, 61, 62, 61, 60]);
    await film(r, capture, fake, 8000, second.energy, second.turns);

    expect(r.sync.result()).toMatchObject({
      previousOffsetMs: 41,
      outcome: { ok: true, offsetMs: 61 },
    });
    expect(r.s.service.session()?.clock.cameras['laptop']?.offsetMs).toBe(61);
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

    r.sync.start();
    await update(r);
    expect(r.sync.run()?.state()).toBe('running');
    expect(r.sync.result()).toBeNull();
    expect(capture.watches).toHaveLength(2);
  });

  it('"Later" ends a check under way without a result and hides it; it does not start by itself again', async () => {
    const r = rig();
    const { fake, capture } = await recording(r);
    const run = r.sync.run();

    r.sync.later();
    await update(r);

    expect(run?.state()).toBe('cancelled');
    expect(capture.watches[0].stopped).toBe(true);
    expect(r.sync.visible()).toBe(false);
    expect(r.sync.result()).toBeNull();
    await film(r, capture, fake, 1000, () => 1);
    expect(r.sync.run()).toBe(run);
    expect(r.sync.blocked()).toBeNull();
  });

  it('ends a check as failed when the recording stops, or the frames cannot be measured', async () => {
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
    r.sync.start();
    expect(capture.watches).toHaveLength(2);
  });

  it('needs the camera recording, and waits for the end of a solve to start by itself', async () => {
    const r = rig();
    const fake = await ready(r.s);
    await update(r);
    // No camera: nothing to check.
    expect(r.sync.label()).toBeNull();
    expect(r.sync.blocked()).toBe('not-recording');
    r.sync.start();
    expect(r.sync.run()).toBeNull();

    // The scramble done, the solve about to start: the camera turned on now waits for its end.
    turn(r.s, fake, 'R U F');
    await r.camera.start();
    await update(r);
    r.starter.last.emitStats(statsOf(5));
    await update(r);
    expect(r.recording.status()).toBe('recording');
    expect(r.sync.blocked()).toBe('solving');
    expect(r.sync.run()).toBeNull();

    turn(r.s, fake, inverse('R U F'), 300);
    await update(r);
    expect(r.s.service.attempts()).toHaveLength(1);
    expect(r.sync.run()?.state()).toBe('running');
    expect(r.sync.visible()).toBe(true);
  });
});
