import {
  BASELINE_FROM_MS,
  BASELINE_TO_MS,
  CLOCK_TOLERANCE_MS,
  DROPPED_PERCENT,
  EARLIER_PEAK_SHARE,
  ENERGY_FLOOR,
  EVENT_HALF_WINDOW_MS,
  MIN_BASELINE_FRAMES,
  MIN_MATCHES,
  MIN_SPREAD_LIMIT_MS,
  ONSET_MADS,
  PEAK_MADS,
  SINGLE_TURN_MS,
  SPREAD_ALLOWANCE_MS,
  WINDOW_AFTER_MS,
  WINDOW_BEFORE_MS,
  isWideFraming,
  singleTurns,
  type ClapperboardClock,
  type ClapperboardEstimator,
  type DroppedPair,
  type FrameSize,
  type FramingRect,
  type MotionMeterInfo,
  type TurnAnalysis,
} from '@cubetrace/capture';

import type { MotionCost, SyncOutcome, SyncRunData } from './sync-run';

/** What a check's diagnostics say about where it ran: the camera, its framing, the build. */
export interface SyncReportContext {
  /** The camera's label in the session (`laptop`), or the capture lab's `lab`. */
  readonly label: string;
  /** The browser's name for the camera (`FaceTime HD Camera`); empty when unknown. */
  readonly deviceLabel: string;
  /** The frames' size as the preview measured it; null when unknown. */
  readonly frameSize: FrameSize | null;
  /** The framing rectangle the check watched, frame pixels; null for the whole frame. */
  readonly framing: FramingRect | null;
  /** This build: the app's version and commit (the page's footer). */
  readonly app: { readonly version: string; readonly commit: string };
  /** `navigator.userAgent`: the browser and its version; null when unknown. */
  readonly userAgent: string | null;
}

/**
 * A sync check's diagnostics (docs/PLAN.md, T2.8 and T2.11), the JSON file the check's panel offers
 * for an issue: where it ran, how the frames were read, the whole motion series, the cube's moves,
 * what the detection saw around each single turn, and how it ended. Not a record of the data model:
 * nothing keeps it but the file.
 */
export interface SyncReport {
  readonly report: 'cubetrace sync check';
  /**
   * 2 since T2.11: a turn's lag is to the middle of its motion (`turns[].eventHostMs`,
   * `detection.estimator`), and the result says the turns kept and those left out of the spread; the
   * files of version 1 (T2.8) have the lags to the first rise (`turns[].onsetHostMs`).
   */
  readonly version: 2;
  /** When it was made: host ms, and the same as a date. */
  readonly createdMs: number;
  readonly createdAt: string;
  readonly app: { readonly version: string; readonly commit: string };
  readonly userAgent: string | null;
  readonly camera: {
    readonly label: string;
    readonly deviceLabel: string;
    readonly frameWidth: number | null;
    readonly frameHeight: number | null;
  };
  /** The framing rectangle (null: the whole frame), and whether it is wide (over 60% of it). */
  readonly framing: { readonly rect: FramingRect | null; readonly wide: boolean };
  /** How the capture worker read the frames (format, copied or drawn, region, plane). */
  readonly meter: MotionMeterInfo | null;
  /** The detection's parameters (packages/capture/src/clapperboard.ts). */
  readonly detection: {
    /** How a turn's time in the frames is found: the middle of its motion. */
    readonly estimator: ClapperboardEstimator;
    readonly windowMs: readonly [number, number];
    readonly baselineMs: readonly [number, number];
    readonly minBaselineFrames: number;
    readonly onsetMads: number;
    readonly peakMads: number;
    readonly floor: number;
    /** A turn's event is the centroid of its motion within this of its peak, ms, either side. */
    readonly eventHalfWindowMs: number;
    /** An earlier peak this share as high above the baseline as the window's highest is taken. */
    readonly earlierPeakShare: number;
    readonly singleTurnMs: number;
    readonly minMatches: number;
    /** The share of the matched turns, in percent, whose lags the spread leaves out. */
    readonly droppedPercent: number;
    /** The spread limit is this plus the frames' median interval, and never under the minimum. */
    readonly spreadAllowanceMs: number;
    readonly minSpreadLimitMs: number;
    readonly clockToleranceMs: number;
  };
  /** How it ended. */
  readonly result: {
    readonly ok: boolean;
    /** The failure's reason and message; null when it passed. */
    readonly reason: string | null;
    readonly message: string | null;
    /** The median lag of the turns kept, and the range of their lags. */
    readonly offsetMs: number | null;
    readonly spreadMs: number | null;
    /** The frames' median interval, and the widest spread that passes with it. */
    readonly frameIntervalMs: number | null;
    readonly maxSpreadMs: number;
    /** Single turns matched and not, moves and frames. */
    readonly matched: number;
    readonly unmatched: number;
    /** Of the matched turns, those whose lags the spread keeps, and those it leaves out. */
    readonly kept: number;
    readonly dropped: readonly DroppedPair[];
    readonly moves: number;
    readonly frames: number;
    readonly durationMs: number;
    readonly cost: MotionCost | null;
  };
  /** The frames' clock: the arrival fit, and their host times against the page's clock. */
  readonly clock: ClapperboardClock | null;
  /** What the detection saw around each single turn. */
  readonly turns: readonly TurnAnalysis[];
  /** The cube's moves during the check, and whether each was a single turn. */
  readonly moves: readonly {
    readonly hostMs: number;
    readonly move: string;
    readonly single: boolean;
  }[];
  /**
   * Every frame's motion, in time order: its host time (timestamp plus the arrival offset), the mean
   * absolute difference (levels) and the changed area (share of the pixels).
   */
  readonly series: readonly {
    readonly hostMs: number;
    readonly mean: number;
    readonly changed: number;
  }[];
}

/** The diagnostics of a check that ended (`SyncReport`), made at `createdMs` (host ms). */
export function syncReport(
  data: SyncRunData,
  outcome: SyncOutcome,
  context: SyncReportContext,
  createdMs: number,
): SyncReport {
  const { analysis } = outcome;
  const offset = analysis.clock?.arrivalOffsetMs ?? null;
  const series =
    offset === null
      ? []
      : [...data.samples]
          .sort((p, q) => p.timestampUs - q.timestampUs)
          .map((sample) => ({
            hostMs: round(sample.timestampUs / 1000 + offset, 2),
            mean: sample.mean,
            changed: sample.changed,
          }));
  const single = new Set(singleTurns(data.moves.map((move) => move.hostMs)));
  return {
    report: 'cubetrace sync check',
    version: 2,
    createdMs: round(createdMs, 1),
    createdAt: new Date(createdMs).toISOString(),
    app: { version: context.app.version, commit: context.app.commit },
    userAgent: context.userAgent,
    camera: {
      label: context.label,
      deviceLabel: context.deviceLabel,
      frameWidth: context.frameSize?.width ?? data.meter?.frameWidth ?? null,
      frameHeight: context.frameSize?.height ?? data.meter?.frameHeight ?? null,
    },
    framing: {
      rect: context.framing,
      wide: isWideFraming(context.framing, context.frameSize ?? meterSize(data.meter)),
    },
    meter: data.meter,
    detection: {
      estimator: analysis.estimator,
      windowMs: [-WINDOW_BEFORE_MS, WINDOW_AFTER_MS],
      baselineMs: [-BASELINE_FROM_MS, -BASELINE_TO_MS],
      minBaselineFrames: MIN_BASELINE_FRAMES,
      onsetMads: ONSET_MADS,
      peakMads: PEAK_MADS,
      floor: ENERGY_FLOOR,
      eventHalfWindowMs: EVENT_HALF_WINDOW_MS,
      earlierPeakShare: EARLIER_PEAK_SHARE,
      singleTurnMs: SINGLE_TURN_MS,
      minMatches: MIN_MATCHES,
      droppedPercent: DROPPED_PERCENT,
      spreadAllowanceMs: SPREAD_ALLOWANCE_MS,
      minSpreadLimitMs: MIN_SPREAD_LIMIT_MS,
      clockToleranceMs: CLOCK_TOLERANCE_MS,
    },
    result: {
      ok: outcome.ok,
      reason: outcome.ok ? null : outcome.reason,
      message: outcome.ok ? null : outcome.message,
      offsetMs: analysis.offsetMs,
      spreadMs: analysis.spreadMs,
      frameIntervalMs: analysis.frameIntervalMs,
      maxSpreadMs: analysis.maxSpreadMs,
      matched: analysis.matched,
      unmatched: analysis.unmatched,
      kept: analysis.kept,
      dropped: analysis.dropped,
      moves: analysis.moves,
      frames: analysis.frames,
      durationMs: outcome.durationMs,
      cost: outcome.cost,
    },
    clock: analysis.clock,
    turns: analysis.turns,
    moves: data.moves.map((move) => ({
      hostMs: move.hostMs,
      move: move.move,
      single: single.has(move.hostMs),
    })),
    series,
  };
}

/** `cubetrace-sync-check-2026-09-27-214503.json`: the report's time, local, to the second. */
export function syncReportFileName(createdMs: number): string {
  const date = new Date(createdMs);
  const two = (value: number): string => String(value).padStart(2, '0');
  const day = `${String(date.getFullYear())}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  const time = `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
  return `cubetrace-sync-check-${day}-${time}.json`;
}

/**
 * The console's line for a check (`cubetrace: sync check failed {…}`): the outcome, the counts (the
 * turns matched, kept, and the lags of those left out), the frames' clock, the camera and how its
 * frames were read, and the time per frame.
 */
export function syncSummaryLine(report: SyncReport): string {
  const { result, meter, clock } = report;
  const facts = {
    reason: result.reason,
    message: result.message,
    estimator: report.detection.estimator,
    offsetMs: result.offsetMs,
    spreadMs: result.spreadMs,
    matched: result.matched,
    kept: result.kept,
    droppedLagsMs: result.dropped.map((pair) => pair.lagMs),
    turns: result.matched + result.unmatched,
    moves: result.moves,
    frames: result.frames,
    durationMs: result.durationMs,
    frameMinusPageMs: clock?.frameMinusPageMs ?? null,
    arrivalOffsetMs: clock?.arrivalOffsetMs ?? null,
    arrivalResidualP95Ms: clock?.arrivalResidualP95Ms ?? null,
    camera: report.camera.label,
    frame:
      report.camera.frameWidth === null || report.camera.frameHeight === null
        ? null
        : `${String(report.camera.frameWidth)}×${String(report.camera.frameHeight)}`,
    wide: report.framing.wide,
    format: meter?.format ?? null,
    path: meter?.path ?? null,
    plane: meter === null ? null : `${String(meter.planeWidth)}×${String(meter.planeHeight)}`,
    costMs: result.cost?.medianMs ?? null,
  };
  return `cubetrace: sync check ${result.ok ? 'passed' : 'failed'} ${JSON.stringify(facts)}`;
}

function meterSize(meter: MotionMeterInfo | null): FrameSize | null {
  return meter === null ? null : { width: meter.frameWidth, height: meter.frameHeight };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
