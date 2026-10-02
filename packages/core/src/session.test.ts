import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import type {
  BatteryReading,
  AttemptRecord,
  CameraIdentity,
  CameraInfo,
  CubeInfo,
  HostInfo,
  SessionRecord,
  SessionSettings,
} from './index';
import {
  AttemptMachine,
  CubeClockFit,
  SESSION_SCHEMA,
  createSession,
  labelFor,
  parseMoves,
  sameCamera,
  summarize,
  withBattery,
} from './index';
import { CAMERA_CLOCK } from './test-records';

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
  productDate: null,
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
      battery: [],
    });
    expectValid(s);
    // The empty clock fit is the one CubeClockFit reports without samples.
    expect(s.clock.cube).toEqual(new CubeClockFit().params);
  });

  it("keeps the cube's production date when it says one, and the battery reports so far (T3.7)", () => {
    const { productDate, ...gen2 } = CUBE;
    expect(productDate).toBeNull();
    // A Gen2 cube's hardware event: no production date.
    expect(create({ cube: gen2 }).cube).toEqual(CUBE);
    const gen4 = create({
      cube: { ...gen2, productDate: '2025-03-14' },
      battery: [{ hostMs: 1_730_639_990_000, level: 83, extra: true } as BatteryReading],
    });
    expect(gen4.cube.productDate).toBe('2025-03-14');
    expect(gen4.battery).toEqual([{ hostMs: 1_730_639_990_000, level: 83 }]);
    expectValid(gen4);
  });

  it('coalesces consecutive equal battery levels (withBattery)', () => {
    const first = withBattery([], { hostMs: 1000, level: 83 });
    expect(first).toEqual([{ hostMs: 1000, level: 83 }]);
    const same = withBattery(first, { hostMs: 2000, level: 83 });
    expect(same).toEqual(first);
    expect(same).not.toBe(first);
    const lower = withBattery(same, { hostMs: 3000, level: 82 });
    expect(lower).toEqual([
      { hostMs: 1000, level: 83 },
      { hostMs: 3000, level: 82 },
    ]);
    // Back up after a charge: a new entry, since the last one differs.
    expect(withBattery(lower, { hostMs: 4000, level: 83 })).toHaveLength(3);
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

/** The owner's two laptop cameras of issue #40, as the browser names them. */
const FACETIME = 'FaceTime HD Camera (3A71:F4B5)';
const LOGITECH = 'Logitech Webcam C930e (046d:0843)';

/** A camera of a session, labelled `label`, named `deviceLabel` by the browser. */
function entry(label: string, deviceLabel: string): CameraInfo {
  return {
    label,
    local: true,
    facing: 'unknown',
    deviceLabel,
    settings: { width: 1920, height: 1080, frameRate: 30 },
    capabilities: {},
    constraints: {},
    crop: null,
    mode: 'full',
    microphone: null,
  };
}

/** The cameras of a session: each camera given its label by `labelFor` as it comes, once. */
function labelled(cameras: readonly CameraIdentity[]): CameraIdentity[] {
  const session: CameraIdentity[] = [];
  for (const camera of cameras) {
    const label = labelFor(session, camera);
    if (!session.some((known) => known.label === label)) {
      session.push({ ...camera, label });
    }
  }
  return session;
}

describe('labelFor', () => {
  it('gives a camera its own label in a session without cameras: a new session starts again there', () => {
    expect(labelFor([], { label: 'laptop', deviceLabel: FACETIME })).toBe('laptop');
    expect(labelFor([], { label: 'phone-front', deviceLabel: 'camera 1, facing front' })).toBe(
      'phone-front',
    );
    expect(labelFor([], { label: 'laptop', deviceLabel: LOGITECH, deviceId: 'b2' })).toBe('laptop');
  });

  it('gives a second device under a label the first free `-2`, `-3`, and the same device its label back', () => {
    const cameras = [entry('laptop', FACETIME)];
    // Issue #40: the FaceTime camera, then the Logitech webcam, both `laptop` by the host.
    expect(labelFor(cameras, { label: 'laptop', deviceLabel: LOGITECH })).toBe('laptop-2');
    expect(labelFor(cameras, { label: 'laptop', deviceLabel: FACETIME })).toBe('laptop');
    cameras.push(entry('laptop-2', LOGITECH));
    expect(labelFor(cameras, { label: 'laptop', deviceLabel: LOGITECH })).toBe('laptop-2');
    expect(labelFor(cameras, { label: 'laptop', deviceLabel: FACETIME })).toBe('laptop');
    expect(labelFor(cameras, { label: 'laptop', deviceLabel: 'Studio Display Camera' })).toBe(
      'laptop-3',
    );
    // Another label is another family: a phone's front and rear cameras keep theirs.
    expect(labelFor(cameras, { label: 'phone-front', deviceLabel: 'camera 1, facing front' })).toBe(
      'phone-front',
    );
    // A free number before a taken one is taken first.
    expect(
      labelFor([entry('laptop', FACETIME), entry('laptop-3', LOGITECH)], {
        label: 'laptop',
        deviceLabel: 'Studio Display Camera',
      }),
    ).toBe('laptop-2');
  });

  it('keeps one label per device through any number of switches', () => {
    const switches: CameraIdentity[] = [FACETIME, LOGITECH, FACETIME, LOGITECH, 'USB Camera'].map(
      (deviceLabel) => ({ label: 'laptop', deviceLabel }),
    );
    const session = labelled(switches);
    expect(session.map((camera) => [camera.label, camera.deviceLabel])).toEqual([
      ['laptop', FACETIME],
      ['laptop-2', LOGITECH],
      ['laptop-3', 'USB Camera'],
    ]);
    for (const camera of switches) {
      expect(labelFor(session, camera)).toBe(
        session.find((known) => known.deviceLabel === camera.deviceLabel)?.label,
      );
    }
  });

  it("gives a device the label of its entry, whatever its own label is now (the host's label changed)", () => {
    const cameras = [entry('laptop', FACETIME)];
    expect(labelFor(cameras, { label: 'phone', deviceLabel: FACETIME })).toBe('laptop');
    expect(labelFor(cameras, { label: 'phone', deviceLabel: LOGITECH })).toBe('phone');
  });

  it('tells two cameras of one name apart by their ids, when the ids of both are known', () => {
    const name = 'USB Camera (1234:5678)';
    const cameras: CameraIdentity[] = [{ label: 'laptop', deviceLabel: name, deviceId: 'a1' }];
    expect(labelFor(cameras, { label: 'laptop', deviceLabel: name, deviceId: 'a1' })).toBe(
      'laptop',
    );
    expect(labelFor(cameras, { label: 'laptop', deviceLabel: name, deviceId: 'b2' })).toBe(
      'laptop-2',
    );
    // An id unknown on either side: the name decides.
    expect(labelFor(cameras, { label: 'laptop', deviceLabel: name })).toBe('laptop');
    expect(labelFor(cameras, { label: 'laptop', deviceLabel: name, deviceId: null })).toBe(
      'laptop',
    );
    expect(
      labelFor([entry('laptop', name)], { label: 'laptop', deviceLabel: name, deviceId: 'b2' }),
    ).toBe('laptop');
    // The entry with the same id first, before an earlier one of the same name without an id (the
    // records keep no id, so after a reload only the ids seen since are known).
    const reloaded: CameraIdentity[] = [
      { label: 'laptop', deviceLabel: name, deviceId: null },
      { label: 'laptop-2', deviceLabel: name, deviceId: 'b2' },
    ];
    expect(labelFor(reloaded, { label: 'laptop', deviceLabel: name, deviceId: 'b2' })).toBe(
      'laptop-2',
    );
    expect(labelFor(reloaded, { label: 'laptop', deviceLabel: name, deviceId: 'a1' })).toBe(
      'laptop',
    );
    // An id under another name is another camera.
    expect(labelFor(cameras, { label: 'laptop', deviceLabel: LOGITECH, deviceId: 'a1' })).toBe(
      'laptop-2',
    );
  });

  it('gives labels that the schema takes, as `clock.cameras` keys too', () => {
    const cameras = [entry('laptop', FACETIME), entry('laptop-2', LOGITECH)];
    const third = labelFor(cameras, { label: 'laptop', deviceLabel: 'USB Camera' });
    expect(third).toBe('laptop-3');
    const s: SessionRecord = {
      ...create(),
      cameras: [...cameras, entry(third, 'USB Camera')],
      clock: {
        cube: new CubeClockFit().params,
        cameras: { laptop: CAMERA_CLOCK, 'laptop-2': { ...CAMERA_CLOCK, offsetMs: 177.4 } },
      },
    };
    expectValid(s);
  });
});

describe('sameCamera', () => {
  it('compares the names, and the ids when both are known', () => {
    const facetime: CameraIdentity = { label: 'laptop', deviceLabel: FACETIME };
    expect(sameCamera(facetime, { label: 'laptop-2', deviceLabel: FACETIME })).toBe(true);
    expect(sameCamera(facetime, { label: 'laptop', deviceLabel: LOGITECH })).toBe(false);
    expect(sameCamera({ ...facetime, deviceId: 'a1' }, { ...facetime, deviceId: 'a1' })).toBe(true);
    expect(sameCamera({ ...facetime, deviceId: 'a1' }, { ...facetime, deviceId: 'b2' })).toBe(
      false,
    );
    expect(sameCamera({ ...facetime, deviceId: 'a1' }, facetime)).toBe(true);
    expect(sameCamera(facetime, { ...facetime, deviceId: null })).toBe(true);
  });
});
