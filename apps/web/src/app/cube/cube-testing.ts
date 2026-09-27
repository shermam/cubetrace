// Test doubles for the cube code, for unit tests: a GAN connector that the test answers, a GAN
// connection backed by the fake cube, a navigator with Web Bluetooth, and a small demo file.
// Nothing in the app imports this file, so it is not in the bundle.
import { SOLVED, applyMoves, parseMoves } from '@cubetrace/core';
import type { CubeConnection, FakeCube, MacProvider } from '@cubetrace/gan';

import type { GanConnector } from './cube-service';

/** One call of the fake connector: what the service passed, and how the test answers. */
export interface ConnectCall {
  readonly macProvider: MacProvider;
  resolve(connection: CubeConnection): void;
  reject(error: unknown): void;
}

/** `connectGanCube` for tests: every call waits until the test resolves or rejects it. */
export class FakeGanConnector {
  readonly calls: ConnectCall[] = [];

  readonly connect: GanConnector = (opts) =>
    new Promise<CubeConnection>((resolve, reject) => {
      this.calls.push({ macProvider: opts.macProvider, resolve, reject });
    });

  /** The latest call; throws if there is none. */
  get last(): ConnectCall {
    const call = this.calls.at(-1);
    if (call === undefined) {
      throw new Error('connectGanCube was not called.');
    }
    return call;
  }
}

/** The fake cube, presented as a GAN cube (what `connectGanCube` resolves with). */
export function asGanCube(cube: FakeCube): CubeConnection {
  return {
    kind: 'gan',
    events$: cube.events$,
    get facelets() {
      return cube.facelets;
    },
    requestFacelets: () => cube.requestFacelets(),
    requestBattery: () => cube.requestBattery(),
    disconnect: () => cube.disconnect(),
  };
}

/**
 * A navigator with Web Bluetooth and the Observable API; with `getDevices`, Chrome can read the
 * MAC address by itself (the flag is on). Web Bluetooth is not in the DOM types.
 */
export function bluetoothNavigator(getDevices: boolean): Partial<Navigator> {
  const noop = (): void => undefined;
  const bluetooth: Record<string, () => void> = { requestDevice: noop, when: noop };
  if (getDevices) {
    bluetooth['getDevices'] = noop;
  }
  const navigator = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', bluetooth };
  return navigator;
}

/** A solve as the demo file has it (scripts/write-demo-solves.mts). */
export interface DemoFileSolve {
  scramble: string;
  scrambled_facelets: string;
  moves: { m: string; ms: number }[];
  time_ms: number;
}

/** A solve for the demo file: `scramble`, then `solution` (moves with cube times). */
function demoSolve(scramble: string, solution: [string, number][]): DemoFileSolve {
  return {
    scramble,
    scrambled_facelets: applyMoves(SOLVED, parseMoves(scramble)),
    moves: solution.map(([m, ms]) => ({ m, ms })),
    time_ms: solution.at(-1)?.[1] ?? 0,
  };
}

/** A demo file in the format of scripts/write-demo-solves.mts: three short solves. */
export const DEMO_FILE: { solves: DemoFileSolve[] } = {
  solves: [
    demoSolve('R U', [
      ["U'", 0],
      ["R'", 150],
    ]),
    demoSolve("F2 D'", [
      ['D', 0],
      ['F', 90],
      ['F', 95],
    ]),
    demoSolve('L', [["L'", 0]]),
  ],
};
