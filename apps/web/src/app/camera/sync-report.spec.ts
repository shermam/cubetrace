import {
  detectClapperboard,
  type ClapperboardFrame,
  type MotionMeterInfo,
} from '@cubetrace/capture';

import { syncReport, syncReportFileName, syncSummaryLine } from './sync-report';
import type { SyncOutcome, SyncRunData } from './sync-run';

/** A check's frames: 60 at 30 fps, their timestamps 1,000 s behind the host clock, received 3 ms later. */
const T0_MS = 1_790_000_000_000;
const FRAMES: ClapperboardFrame[] = Array.from({ length: 60 }, (_, k) => ({
  timestampUs: (T0_MS - 1_000_000 + (k * 1000) / 30) * 1000,
  arrivalHostMs: T0_MS + (k * 1000) / 30 + (k % 2),
  receivedHostMs: T0_MS + (k * 1000) / 30 + 3,
  mean: k === 40 ? 9.5 : 1.25,
  changed: k === 40 ? 0.021 : 0.0002,
  costMs: 1,
}));

const METER: MotionMeterInfo = {
  format: 'NV12',
  path: 'copy',
  frameWidth: 1920,
  frameHeight: 1080,
  region: { x: 0, y: 0, w: 1920, h: 1080 },
  planeWidth: 320,
  planeHeight: 180,
  changeLevels: 12,
};

/** Two moves 300 ms apart (neither single), and a single one 1.3 s in, 40 ms before the motion. */
const DATA: SyncRunData = {
  startMs: T0_MS - 10,
  samples: [...FRAMES].reverse(),
  moves: [
    { hostMs: T0_MS + 200, move: 'U' },
    { hostMs: T0_MS + 500, move: "U'" },
    { hostMs: T0_MS + (40 * 1000) / 30 - 40, move: 'R' },
  ],
  meter: METER,
};

const CONTEXT = {
  label: 'laptop',
  deviceLabel: 'FaceTime HD Camera',
  frameSize: { width: 1920, height: 1080 },
  framing: { x: 0, y: 0, w: 1920, h: 1080 },
  app: { version: '0.2.0', commit: 'abc1234' },
  userAgent: 'Mozilla/5.0 (Macintosh) Chrome/153.0.0.0',
};

function outcome(): SyncOutcome {
  const result = detectClapperboard(
    DATA.samples,
    DATA.moves.map((move) => move.hostMs),
  );
  return { ...result, cost: { medianMs: 1, p95Ms: 1, maxMs: 1 }, durationMs: 2000 };
}

describe('syncReport', () => {
  it("holds where the check ran, how the frames were read, the series in time order, the moves and each turn's analysis", () => {
    const report = syncReport(DATA, outcome(), CONTEXT, T0_MS + 2500);

    expect(report).toMatchObject({
      report: 'cubetrace sync check',
      version: 2,
      createdMs: T0_MS + 2500,
      createdAt: new Date(T0_MS + 2500).toISOString(),
      app: { version: '0.2.0', commit: 'abc1234' },
      userAgent: 'Mozilla/5.0 (Macintosh) Chrome/153.0.0.0',
      camera: {
        label: 'laptop',
        deviceLabel: 'FaceTime HD Camera',
        frameWidth: 1920,
        frameHeight: 1080,
      },
      framing: { rect: { x: 0, y: 0, w: 1920, h: 1080 }, wide: true },
      meter: METER,
      detection: {
        estimator: 'motion-centre',
        windowMs: [-400, 700],
        baselineMs: [-900, -300],
        onsetMads: 3,
        peakMads: 6,
        floor: 0.001,
        eventHalfWindowMs: 150,
        earlierPeakShare: 0.8,
        droppedPercent: 20,
        spreadAllowanceMs: 50,
        minSpreadLimitMs: 40,
        clockToleranceMs: 1000,
      },
      result: {
        ok: false,
        reason: 'few-matches',
        message:
          'fewer than 4 matches (1 of 1 single turn matched a motion; 2 turns came within half a second of another)',
        matched: 1,
        unmatched: 0,
        // None is left out of the spread of fewer than four turns.
        kept: 1,
        dropped: [],
        moves: 3,
        frames: 60,
        durationMs: 2000,
        // Frames at 30 fps: a spread of up to 50 ms plus a frame passes.
        frameIntervalMs: 33.33,
        maxSpreadMs: 83.3,
      },
      // Received 3 ms after arriving, half a ms after their host time.
      clock: { frameMinusPageMs: -2.5 },
    });
    expect(report.moves).toEqual([
      { hostMs: T0_MS + 200, move: 'U', single: false },
      { hostMs: T0_MS + 500, move: "U'", single: false },
      { hostMs: DATA.moves[2].hostMs, move: 'R', single: true },
    ]);
    expect(report.turns).toHaveLength(1);
    expect(report.turns[0]).toMatchObject({ miss: null, lagMs: 40.5 });
    // The motion is one frame: its onset and the middle of its motion, the event, are that frame.
    expect(report.turns[0].eventHostMs).toBeCloseTo(T0_MS + 4000 / 3 + 0.5, 1);
    expect(report.turns[0].onsetHostMs).toBeCloseTo(T0_MS + 4000 / 3 + 0.5, 1);
    // The frames in time order, at their timestamps plus the arrival offset (half a ms here).
    expect(report.series).toHaveLength(60);
    expect(report.series[0]).toEqual({ hostMs: T0_MS + 0.5, mean: 1.25, changed: 0.0002 });
    expect(report.series[40]).toMatchObject({ mean: 9.5, changed: 0.021 });
    expect(report.series[40].hostMs).toBeCloseTo(T0_MS + 4000 / 3 + 0.5, 1);
  });

  it('says the framing is not wide for a rectangle around the cube, and takes the size from the meter when the preview had none', () => {
    const report = syncReport(
      DATA,
      outcome(),
      { ...CONTEXT, frameSize: null, framing: { x: 720, y: 270, w: 960, h: 540 } },
      T0_MS,
    );
    expect(report.camera).toMatchObject({ frameWidth: 1920, frameHeight: 1080 });
    expect(report.framing.wide).toBe(false);
  });
});

describe('syncReportFileName', () => {
  it("is the report's local time, to the second", () => {
    const at = new Date(2026, 8, 27, 21, 45, 3).getTime();
    expect(syncReportFileName(at)).toBe('cubetrace-sync-check-2026-09-27-214503.json');
  });
});

describe('syncSummaryLine', () => {
  it('is one console line with the outcome, the counts, the clock and how the frames were read', () => {
    const line = syncSummaryLine(syncReport(DATA, outcome(), CONTEXT, T0_MS));

    expect(line).toMatch(/^cubetrace: sync check failed \{/);
    const facts = JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>;
    expect(facts).toMatchObject({
      reason: 'few-matches',
      estimator: 'motion-centre',
      matched: 1,
      kept: 1,
      droppedLagsMs: [],
      turns: 1,
      moves: 3,
      frames: 60,
      frameMinusPageMs: -2.5,
      camera: 'laptop',
      frame: '1920×1080',
      wide: true,
      format: 'NV12',
      path: 'copy',
      plane: '320×180',
      costMs: 1,
    });
  });
});
