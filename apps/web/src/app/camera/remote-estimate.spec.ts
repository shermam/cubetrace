import { RemoteClockFit } from '@cubetrace/core';
import { describe, expect, it } from 'vitest';

import { CUT_MARGIN_MS, ESTIMATE_MIN_SAMPLES, clockEstimate } from './remote-estimate';

/** The phone's clock minus the host's, in ms. */
const OFFSET_MS = 1234.5;

/** Adds a round trip sent at `t1` whose legs take `outMs` and `backMs`; the phone answers in 1 ms. */
function trip(fit: RemoteClockFit, t1: number, outMs: number, backMs: number): void {
  const t2 = t1 + outMs + OFFSET_MS;
  const t3 = t2 + 1;
  fit.addSample(t1, t2, t3, t3 - OFFSET_MS + backMs);
}

describe('clockEstimate', () => {
  it('has nothing to place the clock with before the first answer', () => {
    expect(clockEstimate(new RemoteClockFit())).toBeNull();
  });

  it('takes the offset of the least round trip while the fit keeps fewer than three samples, and says it has not converged', () => {
    const fit = new RemoteClockFit();
    // Two trips kept (25 ms is within 1.5 times 20): their median is 5 ms off the better one.
    trip(fit, 0, 10, 10);
    trip(fit, 1000, 15, 10);
    expect(fit.params.samples).toBe(2);
    expect(fit.params.samples).toBeLessThan(ESTIMATE_MIN_SAMPLES);
    expect(fit.offsetMs).toBe(OFFSET_MS + 1.25);

    const estimate = clockEstimate(fit);
    expect(estimate?.converged).toBe(false);
    expect(estimate?.params).toEqual({ ...fit.params, offsetMs: OFFSET_MS, driftPpm: 0 });
    expect(estimate?.toRemoteMs(5000)).toBe(5000 + OFFSET_MS);
    expect(estimate?.toHostMs(5000 + OFFSET_MS)).toBe(5000);
    // A quiet network: the margin is the floor.
    expect(estimate?.marginMs).toBe(CUT_MARGIN_MS);
  });

  it("is the fit's own from three samples kept, converged or not", () => {
    const fit = new RemoteClockFit();
    for (let k = 0; k < 3; k++) {
      trip(fit, k * 1000, 10, 10);
    }
    const estimate = clockEstimate(fit);
    expect(fit.converged).toBe(false);
    expect(estimate?.converged).toBe(false);
    expect(estimate?.params).toEqual(fit.params);
    expect(estimate?.toHostMs(9000)).toBe(fit.toHostMs(9000));
    expect(estimate?.toRemoteMs(9000)).toBe(fit.toRemoteMs(9000));

    // Ten more seconds of quiet trips: the fit converges, and the estimate says so.
    for (let k = 3; k < 13; k++) {
      trip(fit, k * 1000, 10, 10);
    }
    expect(fit.converged).toBe(true);
    expect(clockEstimate(fit)?.converged).toBe(true);
  });

  it('is frozen when taken (T4.3): the answers after it move the fit, not the estimate', () => {
    const fit = new RemoteClockFit();
    for (let k = 0; k < 13; k++) {
      trip(fit, k * 1000, 10, 10);
    }
    const estimate = clockEstimate(fit);
    expect(estimate?.line.offsetMs).toBe(fit.offsetMs);
    const before = estimate?.toHostMs(20_000 + OFFSET_MS);
    // The phone's clock 2 s back from then on (it slept): a minute of its answers.
    for (let k = 13; k < 73; k++) {
      const t1 = k * 1000;
      fit.addSample(t1, t1 + 10 + OFFSET_MS - 2000, t1 + 11 + OFFSET_MS - 2000, t1 + 21);
    }
    expect(fit.toHostMs(20_000 + OFFSET_MS)).toBeGreaterThan(21_000);
    expect(estimate?.toHostMs(20_000 + OFFSET_MS)).toBe(before);
    expect(estimate?.toRemoteMs(20_000)).toBe(20_000 + OFFSET_MS);
    // Before three samples, the least round trip's offset, as a line without a drift.
    const early = new RemoteClockFit();
    trip(early, 0, 10, 10);
    expect(clockEstimate(early)?.line).toMatchObject({ offsetMs: OFFSET_MS, driftPpm: 0 });
  });

  it("widens the margin past the floor by the kept trips' 95th percentile and the residuals' on a slow network", () => {
    const fit = new RemoteClockFit();
    // Wi-Fi power saving: trips of 400 to 500 ms, all kept (within 1.5 times 400), legs uneven.
    trip(fit, 0, 200, 200);
    trip(fit, 1000, 250, 200);
    trip(fit, 2000, 240, 240);
    trip(fit, 3000, 300, 200);
    expect(fit.params.samples).toBe(4);
    expect(fit.rttP95Ms).toBe(500);
    // Offsets 0, 25, 0 and 50 ms off: the median 12.5 ms off, the largest residual 37.5 ms.
    expect(fit.params.residualP95Ms).toBe(37.5);
    expect(clockEstimate(fit)?.marginMs).toBe(537.5);
  });
});
