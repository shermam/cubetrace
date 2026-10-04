import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import { FRAMES_SCHEMA, RemoteClockFit, parseFrames, remoteFrames } from './index';
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
    expect(kept.remote).toEqual({
      ...fit.params,
      converged: fit.converged,
      takenMs: lastMs + 250,
    });
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
});
