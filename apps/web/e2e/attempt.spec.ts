import { expect, test } from '@playwright/test';
import { PHASE_NAMES } from '@cubetrace/core';

import { exportSession } from './helpers/export';
import { fixturePhases, fixtureSolve } from './helpers/fixtures';
import { demoPath, expectSolves, parseTime, replayDemo, solveRows, textOf } from './helpers/timer';

// Flow 1 of docs/PLAN.md, T1.9: a full attempt with the demo cube at speed 20, for three of the
// demo solves, checked against the fixtures they come from (fixtures/solves.json) and against what
// @cubetrace/core's phase detector finds in them. Demo solve 13 is the one whose cross is not on U.
//
// The replay that starts with the page runs while the page is still loading: cubing.js builds its
// search tables in a worker and the scramble picture's chunk is evaluated. On a busy machine that
// holds the fake cube's timers back by tens of milliseconds, which a solve of 750 ms at speed 20
// cannot absorb (5% is 37 ms). So the time is checked on a second replay of the same solve, started
// from the connect dialog once the page has settled; both attempts' records are checked.
const SPEED = 20;

for (const index of [0, 1, 13]) {
  test(`demo solve ${String(index)}: solved in its time, eight phases from core's cross face, exported`, async ({
    page,
  }) => {
    const solve = fixtureSolve(index);
    const report = fixturePhases(solve);

    await page.goto(demoPath(index, SPEED));
    await expectSolves(page, 1);
    // Settled: the next attempt has its scramble from cubing.js.
    await expect(page.getByTestId('timer-status')).toHaveAttribute('data-phase', 'scrambling', {
      timeout: 30_000,
    });
    await replayDemo(page);
    await expectSolves(page, 2);
    const row = solveRows(page).first();
    await expect(row).toHaveAttribute('data-index', '2');
    await expect(row).toHaveAttribute('data-status', 'solved');

    // The time, frozen at the result, within 5% of the recorded time divided by the speed.
    await expect(page.getByTestId('timer')).toHaveAttribute('data-kind', 'solved');
    const shown = await textOf(page, 'timer');
    const expectedMs = solve.time_ms / SPEED;
    test.info().annotations.push({
      type: 'time',
      description: `shown ${shown} s, expected ${(expectedMs / 1000).toFixed(3)} s`,
    });
    expect(Math.abs(parseTime(shown) - expectedMs)).toBeLessThanOrEqual(0.05 * expectedMs);
    await expect(row.getByTestId('solve-time')).toHaveText(shown);
    // Eight phases in the chart: a segment of the last solve's bar for each.
    await expect(page.getByTestId('breakdown-last').locator('[data-phase]')).toHaveCount(8);

    const { attempts } = await exportSession(page);
    expect(attempts.map((attempt) => attempt.index)).toEqual([1, 2]);
    for (const attempt of attempts) {
      expect(attempt).toMatchObject({
        scramble: solve.scramble,
        scrambledFacelets: solve.scrambled_facelets,
        crossFace: report.crossFace,
      });
      expect(attempt.result).toMatchObject({
        status: 'solved',
        replayOk: true,
        movesQtm: solve.quarter_turns,
        scrambleCorrected: false,
        scrambleExtraMoves: 0,
      });
      // The solve's moves in the order the cube reported them, cut into the phases core finds in
      // the fixture: same names, move counts and F2L slots.
      const solveMoves = attempt.moves.filter((move) => move.phase === 'solve');
      expect(solveMoves.map((move) => move.m)).toEqual(solve.moves.map((move) => move.m));
      expect(attempt.phases.map((phase) => phase.name)).toEqual(PHASE_NAMES);
      expect(attempt.phases.map((phase) => [phase.name, phase.moves, phase.slot ?? null])).toEqual(
        report.phases.map((phase) => [phase.name, phase.moves, phase.slot ?? null]),
      );
    }
  });
}
