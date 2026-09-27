import { expect, test } from '@playwright/test';
import { PHASE_NAMES } from '@cubetrace/core';

import { exportSession } from './helpers/export';
import { fixturePhases, fixtureSolve } from './helpers/fixtures';
import { demoPath, expectSolves, parseTime, solveRows, textOf } from './helpers/timer';

// Flow 1 of docs/PLAN.md, T1.9: a full attempt with the demo cube at speed 20, for three of the
// demo solves, checked against the fixtures they come from (fixtures/solves.json) and against what
// @cubetrace/core's phase detector finds in them. Demo solve 13 is the one whose cross is not on U.
const SPEED = 20;

for (const index of [0, 1, 13]) {
  test(`demo solve ${String(index)}: solved in its time, eight phases from core's cross face, exported`, async ({
    page,
  }) => {
    const solve = fixtureSolve(index);
    const report = fixturePhases(solve);

    await page.goto(demoPath(index, SPEED));
    await expectSolves(page, 1);
    const row = solveRows(page).first();
    await expect(row).toHaveAttribute('data-index', '1');
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
    expect(attempts).toHaveLength(1);
    const [attempt] = attempts;
    expect(attempt).toMatchObject({
      index: 1,
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
    // The solve's moves in the order the cube reported them, cut into the phases core finds in the
    // fixture: same names, move counts and F2L slots.
    const solveMoves = attempt.moves.filter((move) => move.phase === 'solve');
    expect(solveMoves.map((move) => move.m)).toEqual(solve.moves.map((move) => move.m));
    expect(attempt.phases.map((phase) => phase.name)).toEqual(PHASE_NAMES);
    expect(attempt.phases.map((phase) => [phase.name, phase.moves, phase.slot ?? null])).toEqual(
      report.phases.map((phase) => [phase.name, phase.moves, phase.slot ?? null]),
    );
  });
}
