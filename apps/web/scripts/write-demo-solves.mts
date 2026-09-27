// Writes public/demo/solves.json: the first 30 solves of fixtures/solves.json with only what the
// demo cube replays (`scramble`, `scrambled_facelets`, `moves` as `[{ m, ms }]`) and `time_ms`
// (docs/PLAN.md, T1.6a). The app fetches it when a demo starts (src/app/cube/demo.ts), so it is
// in no bundle. npm runs this script, like write-version.mts, after `npm install` and before
// `npm start` and `npm run build` (apps/web/package.json); the file is generated, so it is not
// committed. The fixtures are read-only (CLAUDE.md).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const appDir = resolve(import.meta.dirname, '..');
const fixture = resolve(appDir, '../../fixtures/solves.json');
const target = resolve(appDir, 'public/demo/solves.json');
const COUNT = 30;
/** docs/PLAN.md: under 100 kB. */
const MAX_BYTES = 100_000;

interface DemoMove {
  m: string;
  ms: number;
}

interface DemoSolve {
  scramble: string;
  scrambled_facelets: string;
  moves: DemoMove[];
  time_ms: number;
}

function member(value: unknown, key: string, where: string): unknown {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    throw new Error(`fixtures/solves.json: ${where} has no "${key}".`);
  }
  return (value as Record<string, unknown>)[key];
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') {
    throw new Error(`fixtures/solves.json: ${where} is not text.`);
  }
  return value;
}

function number(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`fixtures/solves.json: ${where} is not a number.`);
  }
  return value;
}

function slim(raw: unknown, index: number): DemoSolve {
  const where = `solves[${String(index)}]`;
  const moves = member(raw, 'moves', where);
  if (!Array.isArray(moves)) {
    throw new Error(`fixtures/solves.json: ${where}.moves is not a list.`);
  }
  return {
    scramble: text(member(raw, 'scramble', where), `${where}.scramble`),
    scrambled_facelets: text(
      member(raw, 'scrambled_facelets', where),
      `${where}.scrambled_facelets`,
    ),
    moves: moves.map((move: unknown, i) => {
      const at = `${where}.moves[${String(i)}]`;
      return { m: text(member(move, 'm', at), `${at}.m`), ms: number(member(move, 'ms', at), at) };
    }),
    time_ms: number(member(raw, 'time_ms', where), `${where}.time_ms`),
  };
}

const parsed: unknown = JSON.parse(readFileSync(fixture, 'utf8'));
const solves = member(parsed, 'solves', 'the file');
if (!Array.isArray(solves) || solves.length < COUNT) {
  throw new Error(`fixtures/solves.json: fewer than ${String(COUNT)} solves.`);
}
// One solve per line: compact, and still readable in a diff or a browser.
const lines = solves.slice(0, COUNT).map((raw: unknown, i) => JSON.stringify(slim(raw, i)));
const source = `{"solves":[\n${lines.join(',\n')}\n]}\n`;
const bytes = Buffer.byteLength(source);
if (bytes >= MAX_BYTES) {
  throw new Error(
    `public/demo/solves.json would be ${String(bytes)} bytes; the limit is ${String(MAX_BYTES)}.`,
  );
}

// Rewriting an unchanged file would make a running `ng serve` rebuild for nothing.
if (!existsSync(target) || readFileSync(target, 'utf8') !== source) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}
