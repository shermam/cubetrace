/// <reference types="node" />
// The real-hardware regression of docs/PLAN.md T2.0: the owner's exports (fixtures/hardware/) hold
// the moves on both clocks. Round 1 (schema version 1: a GAN 12 ui FreePlay on a MacBook and on the
// ThinkPhone, 15 solved attempts): within an attempt the cube's clock runs 0.7% slow, while across
// the pauses between attempts both clocks advance equally (docs/DEVICES.md), so one fit per attempt
// holds to the Bluetooth jitter and one fit per connection does not. The i3 round (schema version 2:
// a GAN 356 i3 on the MacBook, 6 solved attempts with clips) has a cube 0.1% slow and keeps the fit
// the app made on the day; its attempt 6 spans a reconnection of the cube, whose clock restarted, and
// the fit recorded on the day went through both clocks (T2.9). The round-1 exports do not say which
// moves ended their Bluetooth packet, so every move is taken as a sample. Node's types for this file
// only.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { AttemptRecord, CubeClockParams, SessionRecord } from './index';
import { AttemptMachine, CubeClockFit, parseAttempt, parseMove, parseSession } from './index';

const FOLDER = new URL('../../../fixtures/hardware/', import.meta.url);

interface Export {
  file: string;
  /** From the file name: the GAN 12 ui FreePlay of round 1, or the GAN 356 i3 of its round. */
  cube: 'gan12ui' | 'gan356i3';
  session: SessionRecord;
  attempts: AttemptRecord[];
}

const EXPORTS: Export[] = readdirSync(FOLDER)
  .filter((name) => name.endsWith('.json'))
  .sort()
  .map((file) => {
    const json: unknown = JSON.parse(readFileSync(new URL(file, FOLDER), 'utf8'));
    const attempts: unknown = Reflect.get(json as object, 'attempts');
    if (!Array.isArray(attempts)) {
      throw new Error(`${file}: an export has a list of attempts.`);
    }
    const cube: Export['cube'] = file.includes('gan356i3') ? 'gan356i3' : 'gan12ui';
    return {
      file,
      cube,
      session: parseSession(Reflect.get(json as object, 'session')),
      attempts: attempts.map((a: unknown) => parseAttempt(a)),
    };
  });

const ATTEMPTS = EXPORTS.flatMap(({ file, cube, attempts }) =>
  attempts.map((attempt) => ({ at: `${file} #${String(attempt.index)}`, cube, attempt })),
);

/** The fit of `moves`, every one of them a sample. */
function clockOf(moves: AttemptRecord['moves']): CubeClockFit {
  const fit = new CubeClockFit();
  for (const { cubeMs, hostMs } of moves) {
    fit.addSample(cubeMs, hostMs, true);
  }
  return fit;
}

function fitOf(moves: AttemptRecord['moves']): CubeClockParams {
  return clockOf(moves).params;
}

/**
 * The bounds of every attempt's fit. docs/PLAN.md T2.0 asked for slopes in 1.0069–1.0072 and a
 * residual under 20 ms, from the rounded summary of docs/DEVICES.md ("slopes 1.0069–1.0071, ±13 ms
 * at the 5th/95th percentiles"); the least-squares fits that attempt.json keeps give slopes of
 * 1.00669 to 1.00712 and a 95th percentile of the absolute residuals of 13.4 to 23.1 ms (a burst of
 * late packets in the laptop's attempt 3), so the bounds are those, with a little room. The median
 * attempt holds the plan's figures.
 */
const SLOPE: readonly [number, number] = [1.0066, 1.0072];
const RESIDUAL_P95_MS = 25;
const PLAN_SLOPE: readonly [number, number] = [1.0069, 1.0072];
const PLAN_RESIDUAL_P95_MS = 20;

/**
 * The GAN 356 i3's clock runs 0.1% slow (docs/DEVICES.md): the five attempts of its round fit
 * slopes of 1.00096 to 1.00170, with a 95th percentile of the absolute residuals of 17.9 to 22.0 ms.
 */
const I3_SLOPE: readonly [number, number] = [1.0008, 1.002];

/**
 * The residual bound of the i3's attempt 6 after the cube reconnected, 35 ms rather than the 25 ms
 * of every other attempt (`RESIDUAL_P95_MS`): six late packets set it. Its 112 moves fit a slope of
 * 1.000862 with a 95th percentile of the absolute residuals of 32.6 ms because six of its packets
 * came 33 to 50 ms late (its scramble alone fits to 30.5 ms and its solve to 32.2, so the jitter is
 * the packets', not a bend of the line).
 */
const I3_RECONNECTED_RESIDUAL_P95_MS = 35;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((p, q) => p - q);
  return sorted[Math.floor(sorted.length / 2)];
}

describe('the cube clock of the real-hardware exports (fixtures/hardware)', () => {
  it('has the two exports of round 1 and the one of the i3 round, 21 solved attempts', () => {
    expect(EXPORTS.map(({ file, cube, attempts }) => [file, cube, attempts.length])).toEqual([
      ['2026-09-27-macbook-pro-2021-gan12ui.json', 'gan12ui', 12],
      ['2026-09-27-macbook-pro-2021-gan356i3.json', 'gan356i3', 6],
      ['2026-09-27-thinkphone-gan12ui.json', 'gan12ui', 3],
    ]);
    expect(ATTEMPTS.every(({ attempt }) => attempt.result.status === 'solved')).toBe(true);
  });

  it('fits every attempt of the 12 ui with the cube 0.7% slow, to the Bluetooth jitter', () => {
    const fits = ATTEMPTS.filter(({ cube }) => cube === 'gan12ui').map(({ at, attempt }) => ({
      at,
      fit: fitOf(attempt.moves),
    }));
    expect(fits).toHaveLength(15);
    console.log(
      fits
        .map(
          ({ at, fit }) =>
            `${at}: a = ${fit.a.toFixed(6)}, residual p95 ${fit.residualP95Ms.toFixed(1)} ms, ${String(fit.samples)} moves`,
        )
        .join('\n'),
    );
    for (const { at, fit } of fits) {
      expect(fit.a, at).toBeGreaterThanOrEqual(SLOPE[0]);
      expect(fit.a, at).toBeLessThanOrEqual(SLOPE[1]);
      expect(fit.residualP95Ms, at).toBeLessThan(RESIDUAL_P95_MS);
    }
    const slope = median(fits.map(({ fit }) => fit.a));
    expect(slope).toBeGreaterThanOrEqual(PLAN_SLOPE[0]);
    expect(slope).toBeLessThanOrEqual(PLAN_SLOPE[1]);
    expect(median(fits.map(({ fit }) => fit.residualP95Ms))).toBeLessThan(PLAN_RESIDUAL_P95_MS);
  });

  it('fits every attempt of the GAN 356 i3 with the cube 0.1% slow, to the same jitter', () => {
    const fits = ATTEMPTS.filter(({ cube }) => cube === 'gan356i3').map(({ at, attempt }) => ({
      at,
      clock: clockOf(attempt.moves),
    }));
    expect(fits).toHaveLength(6);
    // Attempts 1 to 5 on one cube clock each; attempt 6 on two, below.
    expect(fits.map(({ clock }) => clock.restarts)).toEqual([0, 0, 0, 0, 0, 1]);
    for (const { at, clock } of fits.slice(0, 5)) {
      const fit = clock.params;
      expect(fit.a, at).toBeGreaterThanOrEqual(I3_SLOPE[0]);
      expect(fit.a, at).toBeLessThanOrEqual(I3_SLOPE[1]);
      expect(fit.residualP95Ms, at).toBeLessThan(RESIDUAL_P95_MS);
    }
  });

  it("starts the fit of the i3's attempt 6 again where the cube reconnected; the fit of the day went through both clocks", () => {
    const i3 = EXPORTS.find(({ cube }) => cube === 'gan356i3');
    const attempt = i3?.attempts.at(-1);
    if (i3 === undefined || attempt === undefined) {
      throw new Error('No export of the i3.');
    }
    expect(attempt.index).toBe(6);
    // The cube idle-disconnected for 434 s after the scramble's second move, and its count started
    // again when it reconnected.
    expect(attempt.moves.slice(1, 3).map(({ cubeMs }) => cubeMs)).toEqual([561_080, 10_977]);
    expect(attempt.moves[2].hostMs - attempt.moves[1].hostMs).toBeCloseTo(434_099, 0);
    // The fit the app kept on the day (before T2.9) took all 114 moves as one line: a slope of −0.81,
    // residuals of 48 s. Kept as the record of the bug.
    expect(attempt.clock?.samples).toBe(114);
    expect(attempt.clock?.a).toBeLessThan(0);
    expect(attempt.clock?.residualP95Ms).toBeGreaterThan(40_000);
    // Now the fit starts again at the reconnection: the 112 moves since, the i3's 0.1% slow clock.
    const fit = fitOf(attempt.moves);
    expect(fit.samples).toBe(112);
    expect(fit.a).toBeGreaterThanOrEqual(I3_SLOPE[0]);
    expect(fit.a).toBeLessThanOrEqual(I3_SLOPE[1]);
    expect(fit.residualP95Ms).toBeLessThan(I3_RECONNECTED_RESIDUAL_P95_MS);
    expect(fit).toEqual(fitOf(attempt.moves.slice(2)));
    // The session's coarse fit, which the app starts again with each connection, is of the same
    // moves: the connection that ended the session began with this attempt's third move.
    expect(fit).toEqual(i3.session.clock.cube);
  });

  it("misses by hundreds of ms with one fit over a whole connection: the laptop's attempts 2 to 12", () => {
    const { attempts } = EXPORTS[0];
    // The cube's clock restarts when it connects again: here between attempts 1 and 2.
    const restarts = attempts.flatMap((a, k) =>
      k > 0 && a.moves[0].cubeMs < (attempts[k - 1].moves.at(-1)?.cubeMs ?? 0) ? [a.index] : [],
    );
    expect(restarts).toEqual([2]);
    const connection = attempts.filter((a) => a.index >= 2);
    expect(connection.map((a) => a.index)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const whole = fitOf(connection.flatMap((a) => a.moves));
    console.log(
      `One fit over attempts 2-12 (${String(whole.samples)} moves): a = ${whole.a.toFixed(6)}, residual p95 ${whole.residualP95Ms.toFixed(1)} ms.`,
    );
    expect(whole.residualP95Ms).toBeGreaterThan(300);
    for (const a of connection) {
      expect(fitOf(a.moves).residualP95Ms).toBeLessThan(RESIDUAL_P95_MS);
    }
  });

  it('replays every attempt through the machine to the same record, whose clock is that fit', () => {
    for (const { at, attempt } of ATTEMPTS) {
      const machine = new AttemptMachine({
        session: attempt.session,
        index: attempt.index,
        scramble: attempt.scramble,
        scrambleShownMs: attempt.events.scrambleShown,
      });
      const scrambleMoves = attempt.moves.filter((m) => m.phase === 'scramble').length;
      for (const [k, { m, cubeMs, hostMs }] of attempt.moves.entries()) {
        machine.onMove({ m: parseMove(m), cubeMs, hostMs, packetLast: true });
        if (k === scrambleMoves - 1) {
          expect(machine.state, at).toBe('armed');
          if (attempt.events.pickup !== null) {
            machine.onPickup(attempt.events.pickup);
          }
        }
      }
      expect(machine.state, at).toBe('solved');
      const record = machine.toRecord();
      expect(record.result.timeMs, at).toBe(attempt.result.timeMs);
      expect(record.result.movesQtm, at).toBe(attempt.result.movesQtm);
      // Everything else as recorded on the day, too: events, phases, the whole result. The clips
      // of a schema-2 export are the camera's, not the machine's; the moves' counters and packet
      // flags (T3.7) were not kept on the day, so the replay's are left out.
      expect(
        {
          ...record,
          moves: record.moves.map(({ serial: _serial, packetLast: _packetLast, ...move }) => move),
          clock: null,
          video: [],
        },
        at,
      ).toEqual({
        ...attempt,
        clock: null,
        video: [],
      });
      const clock = clockOf(attempt.moves);
      expect(record.clock, at).toEqual(clock.params);
      // A schema-2 export keeps the fit the app made on the day. On the i3 every move ended its
      // Bluetooth packet (one move per notification), so that fit has every move as a sample and is
      // this one, but where the cube's clock started again within the attempt (attempt 6, above).
      if (attempt.clock !== null && clock.restarts === 0) {
        expect(attempt.clock.samples, at).toBe(attempt.moves.length);
        expect(attempt.clock, at).toEqual(clock.params);
      }
    }
  });
});
