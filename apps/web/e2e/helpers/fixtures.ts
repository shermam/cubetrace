import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { test } from '@playwright/test';
import { detectPhases, parseMove, type PhaseReport } from '@cubetrace/core';

// The oracle of the flows: fixtures/solves.json, the real solves whose first 30 the demo cube
// replays (scripts/write-demo-solves.mts copies them to public/demo/solves.json), with the numbers
// Cubeast recorded for them (docs/DATA-MODEL.md §8).

/** The part of a fixture that the flows compare with. */
export interface FixtureSolve {
  readonly scramble: string;
  readonly scrambled_facelets: string;
  /** The solution as the cube reported it, on its clock. */
  readonly moves: readonly { readonly m: string; readonly ms: number }[];
  readonly time_ms: number;
  /** Cubeast's quarter-turn count of the solution. */
  readonly quarter_turns: number;
}

let solves: readonly FixtureSolve[] | null = null;

/** Fixture `index`, which is also demo solve `index` below 30. Call it inside a test. */
export function fixtureSolve(index: number): FixtureSolve {
  if (solves === null) {
    const file = resolve(test.info().project.testDir, '../../../fixtures/solves.json');
    solves = (JSON.parse(readFileSync(file, 'utf8')) as { solves: FixtureSolve[] }).solves;
  }
  const solve = solves.at(index);
  if (solve === undefined) {
    throw new Error(`fixtures/solves.json has no solve ${String(index)}.`);
  }
  return solve;
}

/** What core's phase detector finds in a fixture: the cross face and the eight phases. */
export function fixturePhases(solve: FixtureSolve): PhaseReport {
  return detectPhases(
    solve.scrambled_facelets,
    solve.moves.map((move) => ({ m: parseMove(move.m), ms: move.ms })),
  );
}
