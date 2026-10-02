import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import {
  GYRO_BUFFER_MS,
  GYRO_BUFFER_RATE_HZ,
  GYRO_FILE,
  GYRO_SCHEMA,
  GyroBuffer,
  gyroFile,
  gyroIntervals,
  gyroSummary,
  parseGyro,
  type GyroJson,
} from './index';
import { APP, SESSION } from './test-records';

// The cube's gyroscope stream (T3.7): the ring buffer the app fills with every gyro event, and the
// gyro file of an attempt's window, held to its JSON Schema.

const Q: readonly [number, number, number, number] = [0, 0, 0, 1];

/** A quaternion turned `deg` degrees about the white axis. */
function turned(deg: number): [number, number, number, number] {
  const half = (deg * Math.PI) / 360;
  return [0, 0, Math.sin(half), Math.cos(half)];
}

/** Fills `buffer` with `count` samples `gapMs` apart from `startMs`, turning one degree a sample. */
function fill(buffer: GyroBuffer, startMs: number, count: number, gapMs = 20): void {
  for (let k = 0; k < count; k++) {
    buffer.push(startMs + k * gapMs, turned(k), [0, 0, k % 8]);
  }
}

const validate = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(GYRO_SCHEMA);

describe('GyroBuffer', () => {
  it('is sized for 10 minutes at 100 Hz by default, and by time and rate otherwise', () => {
    expect(new GyroBuffer().capacity).toBe((GYRO_BUFFER_MS / 1000) * GYRO_BUFFER_RATE_HZ);
    expect(new GyroBuffer({ windowMs: 1000, rateHz: 50 }).capacity).toBe(50);
    expect(new GyroBuffer({ windowMs: 10, rateHz: 50 }).capacity).toBe(1);
    expect(() => new GyroBuffer({ windowMs: 0 })).toThrow(RangeError);
    expect(() => new GyroBuffer({ rateHz: -1 })).toThrow(RangeError);
  });

  it('keeps the samples in order and tells its oldest and newest', () => {
    const buffer = new GyroBuffer({ windowMs: 10_000, rateHz: 100 });
    expect(buffer.length).toBe(0);
    expect(buffer.oldestHostMs).toBeNull();
    expect(buffer.newestHostMs).toBeNull();
    fill(buffer, 1000, 5);
    expect(buffer.length).toBe(5);
    expect(buffer.oldestHostMs).toBe(1000);
    expect(buffer.newestHostMs).toBe(1080);
    const window = buffer.window(0, 10_000);
    expect(Array.from(window.hostMs)).toEqual([1000, 1020, 1040, 1060, 1080]);
    expect(window.q.length).toBe(20);
    expect(Array.from(window.q.subarray(0, 4))).toEqual([0, 0, 0, 1]);
    expect(window.q[4 + 2]).toBeCloseTo(Math.sin(Math.PI / 360), 6);
    expect(Array.from(window.v ?? [])).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4]);
    expect(window.truncatedStart).toBe(true); // Nothing from before the first sample.
    expect(buffer.window(1000, 1080).truncatedStart).toBe(false);
  });

  it('wraps around when it is full, dropping the oldest sample', () => {
    const buffer = new GyroBuffer({ windowMs: 100_000, rateHz: 0.1 }); // A capacity of 10.
    expect(buffer.capacity).toBe(10);
    fill(buffer, 0, 25, 10);
    expect(buffer.length).toBe(10);
    expect(buffer.oldestHostMs).toBe(150);
    expect(buffer.newestHostMs).toBe(240);
    const window = buffer.window(0, 1000);
    expect(Array.from(window.hostMs)).toEqual([150, 160, 170, 180, 190, 200, 210, 220, 230, 240]);
    // The quaternions and velocities went around with their samples.
    expect(window.q[2]).toBeCloseTo(turned(15)[2], 6);
    expect(window.v?.[2]).toBe(15 % 8);
    expect(window.v?.[29]).toBe(24 % 8);
  });

  it('drops the samples older than its window behind the newest one, however few there are', () => {
    const buffer = new GyroBuffer({ windowMs: 1000, rateHz: 1000 }); // Room for far more than a second.
    fill(buffer, 0, 10, 100); // 0 … 900 ms
    expect(buffer.length).toBe(10);
    buffer.push(1500, Q); // Everything before 500 ms goes.
    expect(buffer.length).toBe(6);
    expect(buffer.oldestHostMs).toBe(500);
    buffer.push(10_000, Q);
    expect(buffer.length).toBe(1);
    expect(buffer.oldestHostMs).toBe(10_000);
  });

  it('extracts a window by host time, both ends included, and says when it could not reach its start', () => {
    const buffer = new GyroBuffer({ windowMs: 60_000, rateHz: 100 });
    fill(buffer, 10_000, 100, 20); // 10,000 … 11,980 ms
    const inside = buffer.window(10_500, 10_600);
    expect(Array.from(inside.hostMs)).toEqual([10_500, 10_520, 10_540, 10_560, 10_580, 10_600]);
    expect(inside.truncatedStart).toBe(false);
    const between = buffer.window(10_501, 10_599);
    expect(Array.from(between.hostMs)).toEqual([10_520, 10_540, 10_560, 10_580]);
    const tail = buffer.window(11_900, 20_000);
    expect(Array.from(tail.hostMs)).toEqual([11_900, 11_920, 11_940, 11_960, 11_980]);
    // Older than the buffer: from its oldest sample, and said.
    const early = buffer.window(5000, 10_050);
    expect(Array.from(early.hostMs)).toEqual([10_000, 10_020, 10_040]);
    expect(early.truncatedStart).toBe(true);
    // Nothing in the stretch: empty arrays.
    const none = buffer.window(12_000, 13_000);
    expect(none.hostMs.length).toBe(0);
    expect(none.q.length).toBe(0);
    expect(none.v).toBeNull();
    expect(none.truncatedStart).toBe(false);
    expect(new GyroBuffer().window(0, 1).truncatedStart).toBe(true);
  });

  it('gives no velocities when the cube sends none, and zeros for the samples without one among the others', () => {
    const buffer = new GyroBuffer({ windowMs: 60_000, rateHz: 100 });
    buffer.push(1000, Q);
    buffer.push(1020, Q, null);
    expect(buffer.window(0, 2000).v).toBeNull();
    buffer.push(1040, Q, [1, -7, 7]);
    expect(Array.from(buffer.window(0, 2000).v ?? [])).toEqual([0, 0, 0, 0, 0, 0, 1, -7, 7]);
  });

  it('ignores a sample without a finite time, and can be cleared', () => {
    const buffer = new GyroBuffer({ windowMs: 60_000, rateHz: 100 });
    buffer.push(Number.NaN, Q);
    buffer.push(Number.POSITIVE_INFINITY, Q);
    expect(buffer.length).toBe(0);
    fill(buffer, 0, 3);
    buffer.clear();
    expect(buffer.length).toBe(0);
    expect(buffer.oldestHostMs).toBeNull();
    fill(buffer, 100, 2);
    expect(Array.from(buffer.window(0, 1000).hostMs)).toEqual([100, 120]);
  });
});

describe('gyroIntervals', () => {
  it('rounds the sample times to 0.1 ms, so that the intervals sum without drifting', () => {
    // 20.07 ms apart: rounding each interval would add 0.03 ms a sample.
    const times = Array.from({ length: 1001 }, (_, k) => 1_790_000_000_000.25 + k * 20.07);
    const dtMs = gyroIntervals(times);
    expect(dtMs).toHaveLength(1001);
    expect(dtMs[0]).toBe(0);
    expect(new Set(dtMs.slice(1))).toEqual(new Set([20, 20.1]));
    const sum = dtMs.reduce((total, dt) => total + Math.round(dt * 10), 0) / 10;
    expect(sum).toBeCloseTo(Math.round(1000 * 20.07 * 10) / 10, 6);
    expect(gyroIntervals([])).toEqual([]);
    expect(gyroIntervals([5])).toEqual([0]);
    expect(gyroIntervals([0, 0.04, 0.06, 0.16])).toEqual([0, 0, 0.1, 0.1]);
  });
});

describe('gyroFile and gyroSummary', () => {
  function windowOf(count: number, velocity = true): GyroBuffer {
    const buffer = new GyroBuffer({ windowMs: 60_000, rateHz: 100 });
    for (let k = 0; k < count; k++) {
      buffer.push(
        1_790_000_000_000.25 + k * 20.07,
        [0.123456789, -0.5, 0.0000049, 0.8],
        velocity ? [0, k % 8, -(k % 8)] : null,
      );
    }
    return buffer;
  }

  it('writes the window as docs/DATA-MODEL.md §11 says, valid against gyro.schema.json', () => {
    const buffer = windowOf(50);
    const window = buffer.window(1_789_999_999_000, 1_790_000_001_000);
    const file = gyroFile({ session: SESSION, index: 17, app: APP, window });
    expect(validate(file), JSON.stringify(validate.errors)).toBe(true);
    expect(parseGyro(file)).toEqual(file);
    expect(file).toMatchObject({
      schema: 1,
      session: SESSION,
      index: 17,
      app: APP,
      t0HostMs: 1_790_000_000_000.25,
      truncatedStart: true,
    });
    expect(Object.keys(file)).toEqual([
      'schema',
      'session',
      'index',
      'app',
      't0HostMs',
      'dtMs',
      'q',
      'v',
      'truncatedStart',
    ]);
    expect(file.dtMs).toHaveLength(50);
    expect(file.dtMs[0]).toBe(0);
    expect(file.dtMs[1]).toBe(20.1);
    // The quaternions to 5 decimals (the cube's 15-bit fractions), flat, four per sample.
    expect(file.q).toHaveLength(200);
    expect(file.q.slice(0, 4)).toEqual([0.12346, -0.5, 0, 0.8]);
    expect(file.v).toHaveLength(150);
    expect(file.v?.slice(0, 6)).toEqual([0, 0, 0, 0, 1, -1]);
    expect(file.app).not.toBe(APP);
  });

  it('puts null for the velocities of a cube that gives none', () => {
    const window = windowOf(3, false).window(0, 2e12);
    const file = gyroFile({ session: SESSION, index: 1, app: APP, window });
    expect(file.v).toBeNull();
    expect(validate(file), JSON.stringify(validate.errors)).toBe(true);
  });

  it('refuses a window without a sample: such an attempt has no file', () => {
    const window = new GyroBuffer().window(0, 1);
    expect(() => gyroFile({ session: SESSION, index: 1, app: APP, window })).toThrow(RangeError);
  });

  it('sums a file up for attempt.json: its span from the intervals and its rate to one decimal', () => {
    const buffer = windowOf(50);
    const window = buffer.window(1_790_000_000_000.25, 1_790_000_001_000);
    const file = gyroFile({ session: SESSION, index: 17, app: APP, window });
    const summary = gyroSummary(file);
    expect(summary).toEqual({
      file: GYRO_FILE,
      samples: 50,
      fromHostMs: 1_790_000_000_000.25,
      toHostMs: 1_790_000_000_000.25 + 983.4, // 49 × 20.07 = 983.43, in tenths.
      rateHz: 49.8, // 49 samples over 0.9834 s.
      truncatedStart: false,
    });
    expect(gyroSummary(file, 'other.json').file).toBe('other.json');
    const one: GyroJson = {
      ...file,
      dtMs: [0],
      q: file.q.slice(0, 4),
      v: file.v?.slice(0, 3) ?? null,
    };
    expect(gyroSummary(one)).toMatchObject({ samples: 1, rateHz: 0, toHostMs: one.t0HostMs });
    const same: GyroJson = {
      ...one,
      dtMs: [0, 0],
      q: file.q.slice(0, 8),
      v: file.v?.slice(0, 6) ?? null,
    };
    expect(gyroSummary(same).rateHz).toBe(0);
  });
});
