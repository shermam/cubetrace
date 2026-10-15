import { describe, expect, it } from 'vitest';

import {
  DRIFT_EVENT_INTERVAL_MS,
  DRIFT_HOLD_MS,
  LatencyDrift,
  LatencyMeter,
  MAX_READING_FRAMES,
  captureTimeOf,
  frameIntervalOf,
  percentiles,
  type FrameTiming,
  type LatencyDriftEvent,
} from './latency';

// A camera at 30 fps whose timestamps count from their own zero (µs), and a host clock (ms) on which
// its frames reach the capture worker `delivery` ms after their capture: the offset between the two
// zeros is fixed, as on the devices measured (docs/DEVICES.md, "VideoFrame.timestamp").
const ZERO_OFFSET_MS = 1_790_516_343_600;
const T0_US = 2_229_524_000;

function frameAt(
  index: number,
  delivery: number,
  options: { encode?: number | null; captureTime?: boolean } = {},
): FrameTiming {
  const timestampUs = T0_US + Math.round((index * 1e6) / 30);
  const captureHostMs = timestampUs / 1000 + ZERO_OFFSET_MS;
  const arrivalHostMs = captureHostMs + delivery;
  const encode = options.encode === undefined ? 12 : options.encode;
  return {
    timestampUs,
    captureHostMs: options.captureTime === true ? captureHostMs : null,
    arrivalHostMs,
    encodedHostMs: encode === null ? null : arrivalHostMs + encode,
  };
}

describe('percentiles', () => {
  it('gives the median and the 95th percentile by nearest rank, to 0.1 ms, never under 0', () => {
    expect(percentiles([])).toBeNull();
    expect(percentiles([7])).toEqual({ p50: 7, p95: 7 });
    const values = Array.from({ length: 20 }, (_, k) => k + 1);
    expect(percentiles(values)).toEqual({ p50: 10, p95: 19 });
    expect(percentiles([3.04, 3.06, -2])).toEqual({ p50: 3, p95: 3.1 });
    expect(percentiles([-4, -1])).toEqual({ p50: 0, p95: 0 });
  });
});

describe('frameIntervalOf', () => {
  it("gives a clip's median frame interval, to 0.1 ms, from its frames file's dtMs", () => {
    expect(frameIntervalOf([0, 33.3, 33.4, 33.3, 66.7, 33.3])).toBe(33.3);
    expect(frameIntervalOf([0, 34.6, 34.5])).toBe(34.6);
    expect(frameIntervalOf([0])).toBeNull();
    expect(frameIntervalOf([])).toBeNull();
  });
});

describe('captureTimeOf', () => {
  it("reads a frame's metadata().captureTime onto the host clock, where the browser gives one", () => {
    expect(captureTimeOf({ metadata: () => ({ captureTime: 1234.5 }) }, 1_000_000)).toBe(
      1_001_234.5,
    );
    expect(captureTimeOf({}, 1_000_000)).toBeNull();
    expect(captureTimeOf({ metadata: () => ({}) }, 1_000_000)).toBeNull();
    expect(captureTimeOf({ metadata: () => ({ captureTime: Number.NaN }) }, 0)).toBeNull();
    expect(
      captureTimeOf(
        {
          metadata: () => {
            throw new DOMException('closed', 'InvalidStateError');
          },
        },
        0,
      ),
    ).toBeNull();
  });
});

describe('LatencyMeter', () => {
  it('times the frames by their capture time where every one has it: the latency itself', () => {
    const meter = new LatencyMeter();
    for (let k = 0; k < 30; k++) {
      meter.add(frameAt(k, k % 10 === 0 ? 40 : 8, { captureTime: true }));
    }
    expect(meter.take()).toEqual({
      capture: { p50: 8, p95: 40, basis: 'capture-time' },
      encode: { p50: 12, p95: 12 },
      frames: 30,
    });
    // The reading forgets its frames.
    expect(meter.take()).toEqual({ capture: null, encode: null, frames: 0 });
  });

  it('times the frames by their timestamps beyond the floor of the track otherwise', () => {
    const meter = new LatencyMeter();
    // The camera's own latency (8 ms) is out of sight: only how much later than the soonest a frame came.
    for (let k = 0; k < 30; k++) {
      meter.add(frameAt(k, k < 10 ? 8 : 83));
    }
    const reading = meter.take();
    expect(reading.capture).toEqual({ p50: 75, p95: 75, basis: 'timestamp' });
    expect(meter.floorMs).toBeCloseTo(ZERO_OFFSET_MS + 8, 3);
    // The floor goes down with a frame that comes sooner, never up.
    meter.add(frameAt(31, 3));
    meter.add(frameAt(32, 50));
    expect(meter.take().capture).toEqual({ p50: 0, p95: 47, basis: 'timestamp' });
    expect(meter.floorMs).toBeCloseTo(ZERO_OFFSET_MS + 3, 3);
  });

  it("carries the track's floor from an earlier run of the pipeline", () => {
    const earlier = new LatencyMeter();
    earlier.add(frameAt(0, 8));
    const next = new LatencyMeter(earlier.floorMs);
    // The new run's frames all come 75 ms later than the track's soonest: it says so from the start.
    for (let k = 1; k <= 10; k++) {
      next.add(frameAt(k, 83));
    }
    expect(next.take().capture?.p50).toBe(75);
    expect(new LatencyMeter().read([frameAt(1, 83), frameAt(2, 83)]).capture?.p50).toBe(0);
  });

  it('falls back on the timestamps when a capture time is missing or not on the host clock', () => {
    const meter = new LatencyMeter();
    const elsewhere = { ...frameAt(1, 9), captureHostMs: frameAt(1, 9).arrivalHostMs - 60_000 };
    const later = { ...frameAt(2, 9), captureHostMs: frameAt(2, 9).arrivalHostMs + 30 };
    meter.add(frameAt(0, 8, { captureTime: true }));
    meter.add(elsewhere);
    meter.add(later);
    expect(meter.take().capture).toEqual({ p50: 1, p95: 1, basis: 'timestamp' });
  });

  it("reads a clip's frames: the encode latency of those encoded, the dropped ones too for the capture", () => {
    const meter = new LatencyMeter();
    const frames = [
      frameAt(0, 6, { encode: 10 }),
      frameAt(1, 7, { encode: 30 }),
      frameAt(2, 106, { encode: null }),
      frameAt(3, 8, { encode: 20 }),
    ];
    expect(meter.read(frames)).toEqual({
      capture: { p50: 1, p95: 100, basis: 'timestamp' },
      encode: { p50: 20, p95: 30 },
      frames: 4,
    });
    // A clip read lowers the floor too.
    expect(meter.floorMs).toBeCloseTo(ZERO_OFFSET_MS + 6, 3);
  });

  it('keeps at most a bounded number of frames for one reading', () => {
    const meter = new LatencyMeter();
    for (let k = 0; k < MAX_READING_FRAMES + 50; k++) {
      meter.add(frameAt(k, 8));
    }
    expect(meter.take().frames).toBe(MAX_READING_FRAMES);
  });
});

describe('LatencyDrift', () => {
  /** Feeds a reading a second from `fromS` to `toS` (inclusive); the events asked for. */
  function feed(
    drift: LatencyDrift,
    fromS: number,
    toS: number,
    p50: number,
    p95 = p50 + 10,
  ): { atS: number; event: LatencyDriftEvent }[] {
    const events: { atS: number; event: LatencyDriftEvent }[] = [];
    for (let s = fromS; s <= toS; s++) {
      const event = drift.update(s * 1000, { p50, p95 });
      if (event !== null) {
        events.push({ atS: s, event });
      }
    }
    return events;
  }

  it('never drifts without a baseline (no sync check yet)', () => {
    const drift = new LatencyDrift();
    expect(feed(drift, 0, 30, 400)).toEqual([]);
    expect(drift.deltaMs).toBeNull();
    expect(drift.p50Ms).toBe(400);
  });

  it('drifts once the running median sits more than 30 ms off for 5 s, not before', () => {
    const drift = new LatencyDrift();
    drift.setBaseline(4);
    expect(feed(drift, 0, 20, 6)).toEqual([]);
    // The step of 2026-10-09: 75 ms more. The 10 s median follows in 5 s, then 5 s more to hold.
    const events = feed(drift, 21, 40, 79);
    expect(events).toEqual([
      {
        atS: 30,
        event: { why: 'drift', baselineMs: 4, p50Ms: 79, p95Ms: 89, deltaMs: 75 },
      },
    ]);
    expect(drift.deltaMs).toBe(75);
    // Since the running median crossed the threshold: half of the ten seconds at 79 ms, at 25 s.
    expect(drift.driftingSinceMs).toBe(25_000);
  });

  it("takes a phone's readings, which have no 95th percentile", () => {
    const drift = new LatencyDrift();
    drift.setBaseline(30);
    const events: LatencyDriftEvent[] = [];
    // A phone reports every 2 s.
    for (let s = 0; s <= 40; s += 2) {
      const event = drift.update(s * 1000, { p50: s < 10 ? 31 : 105 });
      if (event !== null) {
        events.push(event);
      }
    }
    expect(events).toEqual([
      { why: 'drift', baselineMs: 30, p50Ms: 105, p95Ms: null, deltaMs: 75 },
    ]);
    expect(drift.p95Ms).toBeNull();
    expect(drift.update(42_000, { p50: Number.NaN })).toBeNull();
    expect(drift.p50Ms).toBe(105);
  });

  it('takes no single bad second for a drift: the median of ten', () => {
    const drift = new LatencyDrift();
    drift.setBaseline(4);
    for (let s = 0; s <= 60; s++) {
      expect(drift.update(s * 1000, { p50: s % 10 === 0 ? 300 : 5, p95: 400 })).toBeNull();
    }
    expect(drift.deltaMs).toBeNull();
  });

  it('recovers once back within 30 ms for 5 s, and says so once the minute after the drift has come', () => {
    const drift = new LatencyDrift();
    drift.setBaseline(4);
    // From the first reading on: off at once, held for 5 s.
    expect(feed(drift, 0, 15, 79).map((e) => [e.atS, e.event.why])).toEqual([[5, 'drift']]);
    const driftAt = 5;
    // Back at once: recovered after the median comes back and holds 5 s, but the event waits for
    // the minute since the drift's.
    const back = feed(drift, 16, 90, 6);
    expect(drift.deltaMs).toBeNull();
    expect(back).toEqual([
      {
        atS: driftAt + DRIFT_EVENT_INTERVAL_MS / 1000,
        event: { why: 'recovered', baselineMs: 4, p50Ms: 6, p95Ms: 16, deltaMs: 2 },
      },
    ]);
  });

  it('forgets a change that changed back before its minute came: one event a minute at most', () => {
    const drift = new LatencyDrift();
    drift.setBaseline(4);
    // A drift (said at 5 s), a recovery (at about 25 s, not said yet), a drift again: nothing new
    // to say when the minute comes.
    const events = [
      ...feed(drift, 0, 15, 79),
      ...feed(drift, 16, 30, 6),
      ...feed(drift, 31, 120, 79),
    ];
    expect(events.map((e) => [e.atS, e.event.why])).toEqual([[5, 'drift']]);
    expect(drift.deltaMs).toBe(75);
    // Then back for good: said a minute after the drift at the soonest.
    const later = feed(drift, 121, 140, 5);
    expect(later.map((e) => e.event.why)).toEqual(['recovered']);
    expect(later[0].atS - 5).toBeGreaterThanOrEqual(DRIFT_EVENT_INTERVAL_MS / 1000);
  });

  it('measures a drift below the baseline too, and anew from a new check', () => {
    const drift = new LatencyDrift();
    drift.setBaseline(80);
    const events = feed(drift, 0, 20, 5);
    expect(events.map((e) => e.event.deltaMs)).toEqual([-75]);
    // A new check at the new latency: within its baseline at once, recovered after the hold.
    drift.setBaseline(5);
    expect(drift.deltaMs).toBe(0);
    feed(drift, 21, 21 + DRIFT_HOLD_MS / 1000, 5);
    expect(drift.deltaMs).toBeNull();
  });

  it('starts its readings again when the camera changes, and stops drifting without a baseline', () => {
    const drift = new LatencyDrift();
    drift.setBaseline(4);
    feed(drift, 0, 20, 79);
    expect(drift.deltaMs).toBe(75);
    drift.restart();
    expect(drift.p50Ms).toBeNull();
    drift.setBaseline(null);
    expect(drift.update(21_000, { p50: 79, p95: 90 })).toBeNull();
    expect(drift.deltaMs).toBeNull();
    expect(drift.driftingSinceMs).toBeNull();
  });
});
