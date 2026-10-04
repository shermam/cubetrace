import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import {
  FRAMES_SCHEMA,
  RemoteClockFit,
  parseFrames,
  remoteFrames,
  type RemoteClockLine,
  type RemoteClockSnapshot,
} from './index';
import { H0 as SIM_H0, homeWifi, pinged, simulation } from './remote-clock-sim';
import { APP, framesJson } from './test-records';

// The frames file of a remote camera's clip as the host keeps it (docs/DATA-MODEL.md §9, T4.2): the
// phone's file, its first frame's time converted to the host clock through a fit of the data
// channel's round trips, and that fit recorded beside it.

/** The host clock of the simulation: a wall clock, as `performance.timeOrigin` is. */
const H0 = 1_790_000_000_000;

/**
 * A fit of a phone whose clock is `offsetMs` ahead of the host's and drifts by `driftPpm`, fed with
 * round trips of 6 ms every 2 s for `seconds`, the legs symmetric to within ±0.5 ms; the phone's clock
 * and the host time of the last round trip with it.
 */
function fitted(
  offsetMs: number,
  driftPpm: number,
  seconds: number,
): { fit: RemoteClockFit; remote: (hostMs: number) => number; lastMs: number } {
  const remote = (hostMs: number): number => hostMs + offsetMs + driftPpm * 1e-6 * (hostMs - H0);
  const fit = new RemoteClockFit();
  let t1 = H0;
  for (let k = 0; t1 < H0 + seconds * 1000; k++, t1 = H0 + k * 2000) {
    const there = 3 + (k % 3) * 0.25;
    const back = 3 - (k % 2) * 0.25;
    const arrived = t1 + there;
    fit.addSample(t1, remote(arrived), remote(arrived + 0.5), arrived + 0.5 + back);
  }
  return { fit, remote, lastMs: t1 - 2000 };
}

describe('remoteFrames', () => {
  it("keeps the phone's first frame time, converts it to the host clock through the fit, and records the fit with its convergence and time", () => {
    const { fit, remote, lastMs } = fitted(-3127.4, 0, 30);
    const truth = lastMs - 4000;
    const phone = { ...framesJson(), app: { ...APP }, t0HostMs: remote(truth) };
    const kept = remoteFrames(phone, 'phone-rear', fit, lastMs + 250);
    expect(kept.camera).toBe('phone-rear');
    expect(kept.t0RemoteMs).toBe(phone.t0HostMs);
    expect(Math.abs(kept.t0HostMs - truth)).toBeLessThan(1);
    // Rounded to 0.01 ms, as the capture rounds a frames file's first frame time.
    expect(Math.round(kept.t0HostMs * 100)).toBe(kept.t0HostMs * 100);
    // The fit's record, its offset the one applied at the first frame (T4.3).
    expect(kept.remote).toEqual({
      ...fit.params,
      offsetMs: Math.round(((kept.t0RemoteMs ?? 0) - kept.t0HostMs) * 100) / 100,
      converged: fit.converged,
      takenMs: lastMs + 250,
    });
    expect(Math.abs((kept.remote?.offsetMs ?? 0) + 3127.4)).toBeLessThan(1);
    expect(kept.remote?.converged).toBe(true);
    // The rest is the phone's, copied; the phone's file is untouched.
    expect(kept.dtMs).toEqual(phone.dtMs);
    expect(kept.dtMs).not.toBe(phone.dtMs);
    expect(kept.keyframes).toEqual(phone.keyframes);
    expect(kept.arrival).toEqual(phone.arrival);
    expect(kept.app).toEqual(APP);
    expect(phone.camera).toBe('laptop');
    expect(phone.t0RemoteMs).toBeUndefined();
    // In the order of docs/DATA-MODEL.md §9, valid against the schema, and read back as it is.
    expect(Object.keys(kept)).toEqual([
      'schema',
      'camera',
      'segment',
      'app',
      't0HostMs',
      't0RemoteMs',
      'dtMs',
      'keyframes',
      'arrival',
      'remote',
    ]);
    const validate = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(FRAMES_SCHEMA);
    expect(validate(kept), JSON.stringify(validate.errors)).toBe(true);
    expect(parseFrames(JSON.parse(JSON.stringify(kept)))).toEqual(kept);
  });

  it("uses the fit's line at the clip's time once the drift is fitted, not the offset of its newest sample", () => {
    // 80 ppm over ten minutes: the offset moves by 48 ms, 3.2 ms in the 40 s before the newest sample.
    const { fit, remote, lastMs } = fitted(812.5, 80, 600);
    expect(fit.hasDrift).toBe(true);
    const truth = lastMs - 40_000;
    const kept = remoteFrames(
      { ...framesJson(), t0HostMs: remote(truth) },
      'phone-rear',
      fit,
      lastMs,
    );
    expect(Math.abs(kept.t0HostMs - truth)).toBeLessThan(1);
    // The newest sample's offset alone would put it 3.2 ms off.
    expect(Math.abs(remote(truth) - fit.offsetMs - truth)).toBeGreaterThan(3);
    expect(kept.remote?.driftPpm).toBeCloseTo(80, 0);
    // The record converts the clip again by itself: its offset is the one applied at the first frame.
    expect((kept.t0RemoteMs ?? 0) - (kept.remote?.offsetMs ?? 0)).toBeCloseTo(kept.t0HostMs, 1);
  });

  it("refuses a file converted already and a label that cannot name the clip's files", () => {
    const { fit } = fitted(10, 0, 30);
    const kept = remoteFrames(framesJson(), 'phone-rear', fit, H0);
    expect(() => remoteFrames(kept, 'phone-rear', fit, H0)).toThrow(
      "The frames file is a remote clip's already",
    );
    expect(() => remoteFrames(framesJson(), 'Phone Rear', fit, H0)).toThrow(
      '"Phone Rear" is not a camera label.',
    );
    // A file without a build stays without one.
    expect('app' in kept).toBe(false);
  });

  // T4.3: the line the host took when it cut the clip, at the clip's own time.

  it('converts a clip recorded 10 minutes into a session with 50 ppm of drift within 1 ms of the truth, with the line taken at its cut', () => {
    // The phone 240 ms behind, drifting by 50 ppm (30 ms over the 10 minutes), pinged as ClockPinger
    // pings over a quiet link (6 ms, a millisecond of jitter per leg).
    const sim = simulation({ offsetMs: -240, driftPpm: 50, rttMs: 6, jitterMs: 2, seed: 3 });
    const fit = new RemoteClockFit();
    const cutMs = pinged(fit, sim, 600);
    // The cut at the window's end: the solve's clip, its first frame 23 s earlier.
    const line = fit.line();
    const atCut = snapshot(line, fit);
    const truth = cutMs - 23_000;
    // The clip's files come 3 s later, the pings going on meanwhile.
    pinged(fit, sim, 3, () => undefined, cutMs + 2000);
    const kept = remoteFrames(
      { ...framesJson(), t0HostMs: sim.remote(truth) },
      'phone-rear',
      atCut,
      cutMs + 3000,
    );
    expect(Math.abs(kept.t0HostMs - truth)).toBeLessThan(1);
    expect(kept.remote?.driftPpm).toBeCloseTo(50, -1);
    expect(kept.remote?.takenMs).toBe(cutMs + 3000);
    // The offset at the pairing would put it 29 ms off, and the line's offset at the cut without its
    // drift 1.15 ms (23 s at 50 ppm).
    expect(Math.abs(sim.offsetAt(SIM_H0) - sim.offsetAt(truth))).toBeGreaterThan(28);
    expect(Math.abs(sim.remote(truth) - line.offsetMs - truth)).toBeGreaterThan(1);
  });

  it("converts a clip whose files come after the phone was away with the line of its cut, not the fit's estimate then", () => {
    const sim = simulation({ offsetMs: -240, driftPpm: 50, rttMs: 6, jitterMs: 2, seed: 4 });
    const fit = new RemoteClockFit();
    const cutMs = pinged(fit, sim, 600);
    const atCut = snapshot(fit.line(), fit);
    const truth = cutMs - 23_000;
    const phone = { ...framesJson(), t0HostMs: sim.remote(truth) };
    // The phone slept for five minutes right after its cut, its clock stopped meanwhile (the
    // monotonic clock does not count a sleep): 300 s behind from then on. Two minutes of answers
    // after it woke, the fit is all of the new clock, and its clips come.
    const woken = simulation({
      offsetMs: -240 - 300_000,
      driftPpm: 50,
      rttMs: 6,
      jitterMs: 2,
      seed: 5,
    });
    const back = cutMs + 300_000;
    pinged(fit, woken, 120, () => undefined, back);
    const late = remoteFrames(phone, 'phone-rear', atCut, back + 120_000);
    expect(Math.abs(late.t0HostMs - truth)).toBeLessThan(1);
    // The fit's estimate then would place it five minutes off.
    const now = remoteFrames(phone, 'phone-rear', fit, back + 120_000);
    expect(Math.abs(now.t0HostMs - truth)).toBeGreaterThan(299_000);
  });

  it('places the clips of 20 minutes on the simulated home Wi-Fi within 1.5 ms of the truth with the lines of their cuts', () => {
    // T4.2b's simulation of the owner's home Wi-Fi (least round trip about 6 ms, median 14, one ping
    // in 20 held 100 to 300 ms), the phone 240 ms behind drifting by 50 ppm; a clip cut every minute
    // from the second, each converted with the line taken at its cut.
    for (const seed of [1, 2, 3]) {
      const sim = simulation({ offsetMs: -240, driftPpm: 50, legs: homeWifi, seed });
      const fit = new RemoteClockFit();
      const errors: number[] = [];
      let nextCut = SIM_H0 + 120_000;
      pinged(fit, sim, 1200, ([t1]) => {
        if (t1 >= nextCut) {
          nextCut += 60_000;
          const truth = t1 - 20_000;
          const kept = remoteFrames(
            { ...framesJson(), t0HostMs: sim.remote(truth) },
            'phone-rear',
            snapshot(fit.line(), fit),
            t1,
          );
          errors.push(Math.abs(kept.t0HostMs - truth));
        }
      });
      expect(errors.length).toBeGreaterThanOrEqual(18);
      expect(Math.max(...errors), `seed ${String(seed)}: ${errors.join(', ')}`).toBeLessThan(1.5);
    }
  });
});

/** The estimate a host takes at a cut: the fit's line, frozen, with its record and convergence. */
function snapshot(line: RemoteClockLine, fit: RemoteClockFit): RemoteClockSnapshot {
  return {
    toHostMs: (remoteMs) => line.toHostMs(remoteMs),
    params: { ...fit.params },
    converged: fit.converged,
  };
}
