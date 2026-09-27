import { expect, test } from '@playwright/test';
import { formatMove, inverse, opposite, parseMove, parseMoves } from '@cubetrace/core';

import { exportSession } from './helpers/export';
import { fixtureSolve } from './helpers/fixtures';
import { demoPath, expectSolves, solveRows } from './helpers/timer';
import { recordTimerViews, timerViews, viewAfter } from './helpers/timer-views';

// Flow 2 of docs/PLAN.md, T1.9: with `?misscramble=5` the demo cube turns a wrong face after the
// scramble's move 5, then turns it back and finishes the scramble (src/app/cube/demo.ts). The page
// shows the undo guidance with the inverse, clears it, arms the attempt, and the record says the
// scramble was corrected, at the cost of 2 extra moves (docs/DATA-MODEL.md §3).

test('a mis-scramble: the undo guidance shows the inverse and clears; the attempt arms and records the correction', async ({
  page,
}) => {
  const solve = fixtureSolve(0);
  const scramble = solve.scramble.split(' ');
  await recordTimerViews(page);

  await page.goto(demoPath(0, 20, 5));
  await expectSolves(page, 1);
  const row = solveRows(page).first();
  await expect(row).toHaveAttribute('data-status', 'solved');
  await expect(row).toContainText('Corrected');
  const views = await timerViews(page);

  // The record: the scramble's first five moves, a clockwise quarter turn of a face that neither
  // move 5 nor move 6 turns (nor the opposite faces), its inverse, then the rest of the scramble.
  const { attempts } = await exportSession(page);
  const [attempt] = attempts;
  const turned = attempt.moves.filter((move) => move.phase === 'scramble').map((move) => move.m);
  const wrong = parseMove(turned[5]);
  const undo = formatMove(inverse(wrong));
  expect(turned).toEqual([...scramble.slice(0, 5), turned[5], undo, ...scramble.slice(5)]);
  expect(wrong.turns).toBe(1);
  const neighbours = parseMoves(`${scramble[4]} ${scramble[5]}`).map((move) => move.face);
  expect([...neighbours, ...neighbours.map(opposite)]).not.toContain(wrong.face);
  expect(attempt.result).toMatchObject({
    status: 'solved',
    replayOk: true,
    scrambleCorrected: true,
    scrambleExtraMoves: 2,
  });

  // What the page showed, in order: the guidance with the inverse while the scramble stood at its
  // move 5; then no guidance any more (the guidance appeared once, with that move only); then the
  // attempt armed; then the solve.
  const guided = viewAfter(views, -1, 'the undo guidance', (view) => view.undo !== null);
  expect(views[guided]).toMatchObject({
    phase: 'scrambling',
    progress: `5 / ${String(scramble.length)}`,
    undo: [undo],
  });
  const cleared = viewAfter(views, guided, 'the guidance cleared', (view) => view.undo === null);
  expect(views.slice(guided, cleared).every((view) => view.undo?.join(' ') === undo)).toBe(true);
  expect(views.slice(cleared).every((view) => view.undo === null)).toBe(true);
  const armed = viewAfter(
    views,
    cleared - 1,
    'the armed attempt',
    (view) => view.phase === 'armed',
  );
  viewAfter(views, armed, 'the solve', (view) => view.phase === 'solving');
});
