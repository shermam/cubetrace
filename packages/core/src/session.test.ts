import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import type { AttemptRecord, CubeInfo, HostInfo, SessionRecord, SessionSettings } from './index';
import {
  AttemptMachine,
  CubeClockFit,
  SESSION_SCHEMA,
  createSession,
  parseMoves,
  summarize,
} from './index';

const HOST: HostInfo = {
  label: 'office-mbp',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  platform: 'macOS',
  isPhone: false,
};
const CUBE: CubeInfo = {
  model: 'GAN 12 ui FreePlay',
  hardware: '1.2',
  firmware: '2.3.1',
  gyro: true,
};
const SETTINGS: SessionSettings = { inspection15s: false, autoAdvance: true };
const ID = '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f';
const OTHER = '9e8d7c6b-5a4f-4e3d-a2c1-b0a9f8e7d6c5';

const validate = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile<SessionRecord>(
  SESSION_SCHEMA,
);

function expectValid(s: unknown): void {
  const valid = validate(s);
  expect(validate.errors ?? [], JSON.stringify(validate.errors)).toEqual([]);
  expect(valid).toBe(true);
}

function create(extra: Partial<Parameters<typeof createSession>[0]> = {}): SessionRecord {
  return createSession({
    host: HOST,
    cube: CUBE,
    settings: SETTINGS,
    appVersion: '0.1.0',
    commit: 'abc1234',
    nowMs: 1_730_640_000_000.5,
    id: ID,
    ...extra,
  });
}

/** An attempt of `session` on `R U F`, solved or a DNF. */
function attempt(session: string, index: number, dnf: boolean): AttemptRecord {
  const machine = new AttemptMachine({ session, index, scramble: 'R U F', scrambleShownMs: 0 });
  for (const [k, m] of parseMoves(dnf ? 'R U F R' : "R U F F' U' R'").entries()) {
    machine.onMove({ m, cubeMs: 100 * k, hostMs: 100 * (k + 1) });
  }
  machine.markDnf(1000);
  return machine.toRecord();
}

describe('createSession', () => {
  it('creates session.json as docs/DATA-MODEL.md §6 describes it', () => {
    const s = create();
    expect(s).toEqual({
      schema: 2,
      id: ID,
      createdMs: 1_730_640_000_000.5,
      app: { version: '0.1.0', commit: 'abc1234' },
      host: HOST,
      cube: CUBE,
      cameras: [],
      clock: { cube: { a: 1, b: 0, residualP95Ms: 0, samples: 0 }, cameras: {} },
      audio: true,
      settings: SETTINGS,
      notes: '',
      summary: { attempts: 0, solved: 0, dnf: 0 },
    });
    expectValid(s);
    // The empty clock fit is the one CubeClockFit reports without samples.
    expect(s.clock.cube).toEqual(new CubeClockFit().params);
  });

  it('draws a new lowercase UUID v4 with crypto.randomUUID by default', () => {
    const input = {
      host: HOST,
      cube: CUBE,
      settings: SETTINGS,
      appVersion: '0.1.0',
      commit: 'unknown',
      nowMs: 0,
    };
    const a = createSession(input);
    const b = createSession(input);
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b.id).not.toBe(a.id);
    expectValid(a);
  });

  it('copies only the known fields of host, cube and settings', () => {
    // The cube's hardware event, passed as it is: its `type` must not reach session.json.
    const hardwareEvent = { type: 'hardware' as const, ...CUBE };
    const s = create({
      cube: hardwareEvent,
      host: { ...HOST, extra: 1 } as HostInfo,
      settings: { ...SETTINGS, theme: 'dark' } as SessionSettings,
    });
    expect(s.cube).toEqual(CUBE);
    expect(s.host).toEqual(HOST);
    expect(s.settings).toEqual(SETTINGS);
    expectValid(s);
  });

  it('rejects an id that is not a lowercase UUID v4', () => {
    expect(() => create({ id: 'session-1' })).toThrow(/UUID v4/);
    expect(() => create({ id: ID.toUpperCase() })).toThrow(/UUID v4/);
    // A UUID of another version.
    expect(() => create({ id: '3f1c9a2e-5b7d-1c1e-9f3a-2b8d6e4c1a7f' })).toThrow(/UUID v4/);
  });

  it('takes the audio flag, and the record takes the clock fit', () => {
    const fit = new CubeClockFit();
    fit.addSample(1000, 1_730_640_000_100, true);
    fit.addSample(61_000, 1_730_640_060_106.25, true);
    const s: SessionRecord = {
      ...create({ audio: false }),
      clock: { cube: fit.params, cameras: {} },
    };
    expect(s.audio).toBe(false);
    expect(s.clock.cube.samples).toBe(2);
    expectValid(s);
  });
});

describe('summarize', () => {
  it("counts the session's attempts, solved and DNF, and ignores other sessions'", () => {
    const s = create();
    const attempts = [
      attempt(ID, 1, false),
      attempt(ID, 2, true),
      attempt(ID, 3, false),
      attempt(OTHER, 1, false),
    ];
    expect(attempts.map((a) => a.result.status)).toEqual(['solved', 'dnf', 'solved', 'solved']);
    expect(summarize(s, attempts)).toEqual({ attempts: 3, solved: 2, dnf: 1 });
    expect(summarize(s, [])).toEqual({ attempts: 0, solved: 0, dnf: 0 });
    expectValid({ ...s, summary: summarize(s, attempts) });
  });
});
