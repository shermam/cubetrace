import { TestBed } from '@angular/core/testing';
import {
  MemorySessionStore,
  SOLVED,
  applyMoves,
  parseMoves,
  type CameraInfo,
  type VideoClip,
} from '@cubetrace/core';
import { FakeCube, type CubeConnection, type CubeEvent } from '@cubetrace/gan';
import { FakeDirectoryHandle, OpfsSessionStore } from '@cubetrace/storage';
import { Subject } from 'rxjs';

import { DEMO_FILE, asGanCube } from '../cube/cube-testing';
import { parseDemoSolves } from '../cube/demo';
import { FakeLocalStorage, settle } from '../device/fake-browser';
import { connect, inverse, ready, scripted, setup, turn } from './session-harness';
import {
  CURRENT_SESSION_KEY,
  HARDWARE_WAIT_MS,
  UNKNOWN_CUBE,
  type AttemptMilestone,
} from './session-service';
import { SESSION_A, testAttempt, testSession } from './session-testing';

describe('SessionService', () => {
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
    vi.useRealTimers();
  });

  it('waits for a cube, showing the next scramble', async () => {
    const s = setup();
    await s.service.whenReady();
    s.service.prepare();
    await settle();

    expect(s.service.phase()).toBe('no-cube');
    expect(s.service.scramble()).toBe('R U F');
    expect(s.service.attempt()).toBeNull();
    expect(s.service.index()).toBe(1);
    expect(s.service.session()).toBeNull();
    expect(s.service.display()).toEqual({ text: '0.00', kind: 'idle', overtime: false });
  });

  it('runs one attempt from the scramble to solved, and saves it with the session', async () => {
    const s = setup();
    const fake = await ready(s);

    // Connected and solved: attempt 1 of a new session, with the scramble on screen.
    const session = s.service.session();
    expect(session).not.toBeNull();
    expect(session?.cube).toEqual({
      model: 'Fake cube',
      hardware: 'simulated',
      firmware: 'simulated',
      gyro: false,
    });
    expect(session?.host).toMatchObject({ platform: 'macOS', isPhone: false });
    expect(s.localStorage.getItem(CURRENT_SESSION_KEY)).toBe(session?.id);
    expect(s.service.attempt()).toMatchObject({ index: 1, scramble: 'R U F', state: 'scrambling' });
    expect(s.service.phase()).toBe('scrambling');

    turn(s, fake, 'R U');
    expect(s.service.attempt()?.progress).toMatchObject({ matched: 2, total: 3 });
    turn(s, fake, 'F');
    expect(s.service.phase()).toBe('armed');
    expect(s.service.display()).toEqual({ text: '0.00', kind: 'ready', overtime: false });

    // The first turn starts the solve; the timer runs frame by frame.
    turn(s, fake, "F'", 2000);
    const solveStart = s.perf.hostMs;
    expect(s.service.phase()).toBe('solving');
    s.perf.advance(1234);
    s.frames.frame();
    expect(s.service.display()).toEqual({ text: '1.23', kind: 'running', overtime: false });

    turn(s, fake, "U' R'", 400);
    expect(s.perf.hostMs - solveStart).toBe(2034);
    expect(s.service.display()).toEqual({ text: '2.03', kind: 'solved', overtime: false });
    expect(s.frames.waiting).toBe(0);
    expect(s.service.attempts().map((a) => a.index)).toEqual([1]);
    expect(s.service.lastResult()?.result).toMatchObject({
      status: 'solved',
      timeMs: 2034,
      movesQtm: 3,
      replayOk: true,
      scrambleCorrected: false,
    });

    // Saved: the attempt, and the session with its summary and the cube clock fit.
    await s.service.whenSaved();
    const exported = await s.store.exportSession(session?.id ?? '');
    expect(exported.attempts).toEqual(s.service.attempts());
    expect(exported.attempts[0].phases.map((p) => p.name)).toHaveLength(8);
    expect(exported.session.summary).toEqual({ attempts: 1, solved: 1, dnf: 0 });
    expect(exported.session.clock.cube.samples).toBe(6);
    expect(exported.session.clock.cube.a).toBeCloseTo(1, 9);
    // The attempt keeps the fit of its own moves (schema version 2).
    expect(exported.attempts[0]).toMatchObject({ schema: 2, clock: { samples: 6 }, video: [] });
    expect(exported.attempts[0].clock?.a).toBeCloseTo(1, 9);
    expect(s.service.saving()).toBe(false);

    // Auto-advance: the next attempt begins with the scramble made during the solve.
    await settle();
    expect(s.made).toEqual(['R U F', "L2 D B'"]);
    expect(s.service.attempt()).toMatchObject({
      index: 2,
      scramble: "L2 D B'",
      state: 'scrambling',
    });
    expect(s.service.display().text).toBe('2.03');
  });

  it("fits the attempt's cube clock on the moves that ended their Bluetooth packet only", async () => {
    const s = setup();
    await s.service.whenReady();
    s.service.prepare();
    await settle();
    const fake = new FakeCube({ now: () => s.perf.hostMs });
    const { connection, emit } = scripted(fake);
    await connect(s, connection);
    expect(s.service.phase()).toBe('scrambling');

    // The cube's clock 0.7% slow; U and F' arrive in the packets of F and U', with their times.
    const host = (cubeMs: number): number => 1_790_000_000_000 + 1.007 * cubeMs;
    const moves: [string, number, number][] = [
      ['R', 1000, 1000],
      ['U', 1100, 1300],
      ['F', 1300, 1300],
      ["F'", 3000, 3150],
      ["U'", 3150, 3150],
      ["R'", 3400, 3400],
    ];
    for (const [m, cubeMs, arrivalCubeMs] of moves) {
      emit({
        type: 'move',
        m: parseMoves(m)[0],
        cubeMs,
        hostMs: host(arrivalCubeMs),
        packetLast: cubeMs === arrivalCubeMs,
      });
    }
    await s.service.whenSaved();
    const [record] = await s.store.loadAttempts(s.service.session()?.id ?? '');
    expect(record.result).toMatchObject({ status: 'solved', replayOk: true });
    expect(record.moves).toHaveLength(6);
    expect(record.clock?.samples).toBe(4);
    expect(record.clock?.a).toBeCloseTo(1.007, 6);
    expect(record.clock?.residualP95Ms).toBeLessThan(0.01);
  });

  it('waits for Next after a solve when auto-advance is off', async () => {
    const s = setup();
    s.settings.setAutoAdvance(false);
    const fake = await ready(s);
    turn(s, fake, 'R U F');
    turn(s, fake, inverse('R U F'));
    await settle();

    expect(s.service.phase()).toBe('next');
    expect(s.service.attempt()?.state).toBe('solved');
    expect(s.service.index()).toBe(2);
    expect(s.service.scramble()).toBe("L2 D B'");
    s.service.advance();
    expect(s.service.attempt()).toMatchObject({
      index: 2,
      scramble: "L2 D B'",
      state: 'scrambling',
    });
  });

  it('asks to solve the cube first, and begins the attempt when it is solved', async () => {
    const s = setup();
    const fake = await ready(s, applyMoves(SOLVED, parseMoves('D')));

    expect(s.service.phase()).toBe('solve-first');
    expect(s.service.attempt()).toBeNull();
    turn(s, fake, "D'");
    expect(s.service.phase()).toBe('scrambling');
    expect(s.service.attempt()).toMatchObject({ index: 1, scramble: 'R U F' });
  });

  it('marks a DNF: saved, and the next attempt waits until the cube is solved again', async () => {
    const s = setup();
    const fake = await ready(s);
    expect(s.service.canDnf()).toBe(false);
    turn(s, fake, 'R U F');
    turn(s, fake, "F'", 500);
    expect(s.service.canDnf()).toBe(true);

    s.perf.advance(700);
    s.service.dnf();
    await settle();
    expect(s.service.lastResult()?.result).toMatchObject({ status: 'dnf', timeMs: null });
    expect(s.service.display()).toEqual({ text: 'DNF', kind: 'dnf', overtime: false });
    expect(s.service.phase()).toBe('solve-first');

    turn(s, fake, "U' R'");
    expect(s.service.attempt()).toMatchObject({ index: 2, state: 'scrambling' });
    await s.service.whenSaved();
    const session = s.service.session();
    expect((await s.store.loadAttempts(session?.id ?? '')).map((a) => a.result.status)).toEqual([
      'dnf',
    ]);
    expect(session?.summary).toEqual({ attempts: 1, solved: 0, dnf: 1 });
  });

  it('deletes the last attempt; the attempt on screen takes its number, with its scramble', async () => {
    const s = setup();
    const fake = await ready(s);
    turn(s, fake, 'R U F');
    turn(s, fake, inverse('R U F'));
    await settle();
    expect(s.service.attempt()).toMatchObject({ index: 2, scramble: "L2 D B'" });

    s.service.deleteLast();
    expect(s.service.attempts()).toEqual([]);
    expect(s.service.attempt()).toMatchObject({
      index: 1,
      scramble: "L2 D B'",
      state: 'scrambling',
    });
    expect(s.service.display().text).toBe('0.00');
    await s.service.whenSaved();
    const session = s.service.session();
    expect(await s.store.loadAttempts(session?.id ?? '')).toEqual([]);
    expect((await s.store.exportSession(session?.id ?? '')).session.summary.attempts).toBe(0);
    expect(s.service.canDeleteLast()).toBe(false);
  });

  it('does not skip, delete or start a session during a solve', async () => {
    const s = setup();
    const fake = await ready(s);
    turn(s, fake, 'R U F');
    turn(s, fake, inverse('R U F'));
    await settle();
    turn(s, fake, "L2 D B'");
    expect(s.service.phase()).toBe('armed');

    expect(s.service.canSkip()).toBe(false);
    expect(s.service.canDeleteLast()).toBe(false);
    s.service.deleteLast();
    s.service.skip();
    s.service.newSession();
    expect(s.service.attempts()).toHaveLength(1);
    expect(s.service.attempt()?.state).toBe('armed');
  });

  it('skips a scramble: nothing is recorded, and the next one waits for a solved cube', async () => {
    const s = setup();
    const fake = await ready(s);
    turn(s, fake, 'R');

    s.service.skip();
    await settle();
    expect(s.service.attempt()).toBeNull();
    expect(s.service.phase()).toBe('solve-first');
    expect(s.service.scramble()).toBe("L2 D B'");
    turn(s, fake, "R'");
    expect(s.service.attempt()).toMatchObject({
      index: 1,
      scramble: "L2 D B'",
      state: 'scrambling',
    });

    // With no move made, Skip takes the next scramble at once.
    s.service.skip();
    await settle();
    expect(s.service.attempt()).toMatchObject({ index: 1, scramble: "U' R2 F" });
    await s.service.whenSaved();
    expect(await s.store.loadAttempts(s.service.session()?.id ?? '')).toEqual([]);
  });

  it('resumes the session stored under the current id: its attempts, and the next index', async () => {
    const store = new MemorySessionStore();
    await store.createSession(testSession());
    await store.saveAttempt(testAttempt(1, 12_000));
    await store.saveAttempt(testAttempt(2, null));
    const localStorage = new FakeLocalStorage();
    localStorage.setItem(CURRENT_SESSION_KEY, SESSION_A);
    const s = setup({ store, localStorage });

    expect(s.service.phase()).toBe('loading');
    await ready(s);
    expect(s.service.session()?.id).toBe(SESSION_A);
    expect(s.service.attempts().map((a) => a.index)).toEqual([1, 2]);
    // The fake cube is the session's cube: the session goes on with attempt 3.
    expect(s.service.attempt()).toMatchObject({ index: 3, state: 'scrambling' });
  });

  it('starts over when the stored session is gone, and says so', async () => {
    const localStorage = new FakeLocalStorage();
    localStorage.setItem(CURRENT_SESSION_KEY, SESSION_A);
    const s = setup({ localStorage });
    await s.service.whenReady();

    expect(s.service.session()).toBeNull();
    expect(s.service.notice()).toContain('could not be resumed');
    expect(localStorage.getItem(CURRENT_SESSION_KEY)).toBeNull();
  });

  it('starts a new session when the current one’s session.json cannot be read, naming the file', async () => {
    // A write cut short by a page load left it empty (issue #12).
    const root = new FakeDirectoryHandle();
    await root.plant(`sessions/${SESSION_A}/session.json`, '');
    const store = new OpfsSessionStore(root);
    const localStorage = new FakeLocalStorage();
    localStorage.setItem(CURRENT_SESSION_KEY, SESSION_A);
    const s = setup({ store, localStorage });
    await ready(s);

    expect(s.service.notice()).toBe(
      `The last session could not be resumed (sessions/${SESSION_A}/session.json is empty.); ` +
        'the next attempt starts a new one.',
    );
    const fresh = s.service.session()?.id;
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(SESSION_A);
    expect(localStorage.getItem(CURRENT_SESSION_KEY)).toBe(fresh);
    expect(s.service.attempt()).toMatchObject({ index: 1, state: 'scrambling' });
    // The Sessions page lists the new session, and the unreadable one apart.
    expect(await s.service.listSessions()).toMatchObject({
      sessions: [{ session: { id: fresh }, attempts: 0, current: true, unreadable: [] }],
      unreadable: [
        {
          sessionId: SESSION_A,
          kind: 'session',
          path: `sessions/${SESSION_A}/session.json`,
          reason: 'empty',
        },
      ],
    });
  });

  it('resumes a session without its unreadable attempt.json, which the next attempt replaces', async () => {
    const root = new FakeDirectoryHandle();
    const store = new OpfsSessionStore(root);
    await store.createSession(testSession());
    await store.saveAttempt(testAttempt(1, 12_000));
    await root.plant(`sessions/${SESSION_A}/attempts/0002/attempt.json`, '');
    const localStorage = new FakeLocalStorage();
    localStorage.setItem(CURRENT_SESSION_KEY, SESSION_A);
    const s = setup({ store, localStorage });
    const fake = await ready(s);

    expect(s.service.notice()).toBeNull();
    expect(s.service.session()?.id).toBe(SESSION_A);
    expect(s.service.attempts().map((a) => a.index)).toEqual([1]);
    expect(await s.service.listSessions()).toMatchObject({
      sessions: [
        {
          attempts: 1,
          unreadable: [
            { path: `sessions/${SESSION_A}/attempts/0002/attempt.json`, reason: 'empty' },
          ],
        },
      ],
      unreadable: [],
    });

    expect(s.service.attempt()).toMatchObject({ index: 2, state: 'scrambling' });
    turn(s, fake, 'R U F');
    turn(s, fake, inverse('R U F'));
    await s.service.whenSaved();
    expect((await store.loadAttempts(SESSION_A)).map((a) => a.index)).toEqual([1, 2]);
    expect(await store.listProblems()).toEqual([]);
  });

  it('starts a new session for another cube, and on New session', async () => {
    const store = new MemorySessionStore();
    await store.createSession({
      ...testSession(),
      cube: { model: 'GAN 356 i3', hardware: '1', firmware: '2', gyro: false },
    });
    const localStorage = new FakeLocalStorage();
    localStorage.setItem(CURRENT_SESSION_KEY, SESSION_A);
    const s = setup({ store, localStorage });
    const fake = await ready(s);

    const first = s.service.session()?.id;
    expect(first).not.toBe(SESSION_A);
    turn(s, fake, 'R U F');
    turn(s, fake, inverse('R U F'));
    await settle();

    s.service.newSession();
    const second = s.service.session()?.id;
    expect(second).not.toBe(first);
    expect(s.service.attempts()).toEqual([]);
    expect(s.service.attempt()).toMatchObject({ index: 1, scramble: "L2 D B'" });
    expect(s.localStorage.getItem(CURRENT_SESSION_KEY)).toBe(second);
    await s.service.whenSaved();
    expect((await s.store.listSessions()).map((x) => x.id).sort()).toEqual(
      [SESSION_A, first, second].sort(),
    );
    // Persistent storage was asked for once, with the first session.
    expect(s.storage.persistCalls).toBe(1);
  });

  it('adopts the state the cube reports when moves went unseen (a resync)', async () => {
    const s = setup();
    await s.service.whenReady();
    s.service.prepare();
    await settle();
    const fake = new FakeCube({ now: () => s.perf.hostMs });
    const { connection, emit } = scripted(fake);
    await connect(s, connection);

    turn(s, fake, 'R');
    // The cube says it is at the scramble's end: the U and F turns were not seen.
    s.perf.advance(300);
    emit({
      type: 'facelets',
      facelets: applyMoves(SOLVED, parseMoves('R U F')),
      hostMs: s.perf.hostMs,
    });
    expect(s.service.attempt()).toMatchObject({ state: 'armed' });
    expect(s.service.attempt()?.events.scrambleDone).toBe(s.perf.hostMs);
  });

  describe('Mark as solved', () => {
    it('during the scramble: the attempt begins again with its scramble and number, and nothing is recorded', async () => {
      const s = setup();
      const fake = await ready(s);
      turn(s, fake, 'R U');
      expect(s.service.attempt()?.progress).toMatchObject({ matched: 2, total: 3 });

      s.perf.advance(1000);
      await s.cube.resetToSolved();
      const restarted = s.perf.hostMs;
      expect(s.service.phase()).toBe('scrambling');
      expect(s.service.attempt()).toMatchObject({
        index: 1,
        scramble: 'R U F',
        state: 'scrambling',
        progress: { matched: 0, total: 3 },
        events: { scrambleShown: restarted, scrambleStart: null },
      });
      expect(s.service.scramble()).toBe('R U F');
      expect(s.service.attempts()).toEqual([]);

      // It goes on from the solved cube, and only its own moves are recorded.
      turn(s, fake, 'R U F');
      expect(s.service.phase()).toBe('armed');
      turn(s, fake, inverse('R U F'));
      await s.service.whenSaved();
      const [record] = await s.store.loadAttempts(s.service.session()?.id ?? '');
      expect(record).toMatchObject({
        index: 1,
        scramble: 'R U F',
        events: { scrambleShown: restarted },
        result: { status: 'solved', replayOk: true, scrambleCorrected: false },
      });
      expect(record.moves.map((m) => m.m)).toEqual(['R', 'U', 'F', "F'", "U'", "R'"]);
    });

    it('during a solve: no record, the time goes back to 0, and the attempt begins again', async () => {
      const s = setup();
      const fake = await ready(s);
      turn(s, fake, 'R U F');
      turn(s, fake, "F'", 1000);
      s.perf.advance(700);
      s.frames.frame();
      expect(s.service.phase()).toBe('solving');
      expect(s.service.display().text).toBe('0.70');

      await s.cube.resetToSolved();
      expect(s.service.attempt()).toMatchObject({
        index: 1,
        scramble: 'R U F',
        state: 'scrambling',
      });
      expect(s.service.display().text).toBe('0.00');
      expect(s.frames.waiting).toBe(0);
      expect(s.service.lastResult()).toBeNull();
      expect(s.service.attempts()).toEqual([]);

      turn(s, fake, 'R U F');
      turn(s, fake, inverse('R U F'), 500);
      expect(s.service.attempts()).toHaveLength(1);
      expect(s.service.lastResult()?.result).toMatchObject({ status: 'solved', timeMs: 1000 });
    });

    it('leaves an attempt that has ended alone', async () => {
      const s = setup();
      s.settings.setAutoAdvance(false);
      const fake = await ready(s);
      turn(s, fake, 'R U F');
      turn(s, fake, inverse('R U F'));
      await settle();
      const last = s.service.lastResult();
      expect(s.service.phase()).toBe('next');

      await s.cube.resetToSolved();
      expect(s.service.phase()).toBe('next');
      expect(s.service.attempt()).toMatchObject({ index: 1, state: 'solved' });
      expect(s.service.lastResult()).toBe(last);
      expect(s.service.attempts()).toHaveLength(1);
    });

    it('begins the attempt that waited for a solved cube', async () => {
      const s = setup();
      await ready(s, applyMoves(SOLVED, parseMoves('B')));
      expect(s.service.phase()).toBe('solve-first');

      await s.cube.resetToSolved();
      expect(s.service.attempt()).toMatchObject({
        index: 1,
        scramble: 'R U F',
        state: 'scrambling',
      });
    });
  });

  it('asks the cube for its state when the tab is back, and catches up with turns it missed', async () => {
    const s = setup();
    await s.service.whenReady();
    s.service.prepare();
    await settle();
    const fake = new FakeCube({ now: () => s.perf.hostMs });
    const { connection, emit } = scripted(fake);
    // The cube's answer: the scramble's end, while the app saw R only.
    const turned = applyMoves(SOLVED, parseMoves('R U F'));
    const asked: CubeConnection = {
      kind: 'gan',
      events$: connection.events$,
      get facelets() {
        return connection.facelets;
      },
      requestFacelets: () => {
        emit({ type: 'facelets', facelets: turned, hostMs: s.perf.hostMs });
        return Promise.resolve();
      },
      requestBattery: () => connection.requestBattery(),
      resetToSolved: () => connection.resetToSolved(),
      disconnect: () => connection.disconnect(),
    };
    await connect(s, asked);
    turn(s, fake, 'R');

    s.page.setVisibility('hidden');
    s.perf.advance(20_000);
    expect(s.service.attempt()?.state).toBe('scrambling');
    s.page.setVisibility('visible');
    expect(s.cube.facelets()).toBe(turned);
    expect(s.service.attempt()).toMatchObject({ state: 'armed' });
    expect(s.service.attempt()?.events.scrambleDone).toBe(s.perf.hostMs);
  });

  it('pauses the time when the cube disconnects, and goes on when it is back', async () => {
    const s = setup();
    const fake = await ready(s);
    turn(s, fake, 'R U F');
    turn(s, fake, "F'", 1000);
    s.perf.advance(500);
    await fake.disconnect('Out of range.');

    expect(s.service.phase()).toBe('paused');
    expect(s.service.display()).toEqual({ text: '0.50', kind: 'paused', overtime: false });
    s.perf.advance(5000);
    s.frames.frame();
    expect(s.service.display().text).toBe('0.50');

    // The same cube again (its state: one solve move in); the attempt goes on.
    const again = new FakeCube({
      start: applyMoves(SOLVED, parseMoves("R U F F'")),
      now: () => s.perf.hostMs,
    });
    await connect(s, asGanCube(again));
    expect(s.service.phase()).toBe('solving');
    turn(s, again, "U' R'", 100);
    expect(s.service.lastResult()?.result).toMatchObject({ status: 'solved', timeMs: 5700 });
  });

  it('marks the pickup when the cube turns more than 15° after the attempt is armed', async () => {
    const s = setup();
    await s.service.whenReady();
    s.service.prepare();
    await settle();
    const fake = new FakeCube({ now: () => s.perf.hostMs });
    const { connection, emit } = scripted(fake);
    await connect(s, connection);
    const gyro = (q: [number, number, number, number]): void => {
      s.perf.advance(50);
      emit({ type: 'gyro', q, hostMs: s.perf.hostMs });
    };

    gyro([0, 0, 0, 1]);
    turn(s, fake, 'R U F');
    gyro([0, 0, Math.sin(Math.PI / 36), Math.cos(Math.PI / 36)]); // 10° from the reference
    expect(s.service.attempt()?.events.pickup).toBeNull();
    gyro([0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)]); // 30°
    const pickup = s.perf.hostMs;
    expect(s.service.attempt()?.events.pickup).toBe(pickup);
    gyro([0, 0, 0, 1]);
    expect(s.service.attempt()?.events.pickup).toBe(pickup);
  });

  it('counts the inspection down while armed when the setting is on', async () => {
    const s = setup();
    s.settings.setInspection(true);
    const fake = await ready(s);
    turn(s, fake, 'R U F');

    expect(s.service.display()).toEqual({ text: '15', kind: 'inspection', overtime: false });
    s.perf.advance(4200);
    s.frames.frame();
    expect(s.service.display().text).toBe('11');
    s.perf.advance(12_000);
    s.frames.frame();
    expect(s.service.display()).toEqual({ text: '0', kind: 'inspection', overtime: true });
  });

  it('keeps the screen on while a cube is connected during a session', async () => {
    const s = setup();
    const fake = await ready(s);
    TestBed.tick();
    await settle();
    expect(s.wakeLock.held()).toBe(1);

    await fake.disconnect();
    TestBed.tick();
    await settle();
    expect(s.wakeLock.held()).toBe(0);
  });

  it("replays the demo solve's scramble as the attempt's", async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.service.whenReady();
    s.service.prepare();
    await vi.advanceTimersByTimeAsync(0);
    const [demo] = parseDemoSolves(DEMO_FILE);

    s.cube.connectDemo(demo, 10);
    expect(s.service.attempt()).toMatchObject({ index: 1, scramble: demo.scramble });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.service.attempts()).toHaveLength(1);
    expect(s.service.attempts()[0]).toMatchObject({
      scramble: demo.scramble,
      result: { status: 'solved', replayOk: true },
    });
    // The next attempt has a scramble of its own.
    expect(s.service.attempt()).toMatchObject({ index: 2, scramble: 'R U F' });
  });

  it('waits for the cube to say what it is, and begins without it after 3 s', async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.service.whenReady();
    s.service.prepare();
    await vi.advanceTimersByTimeAsync(0);
    // A cube that reports its battery but not its hardware.
    const events = new Subject<CubeEvent>();
    const connecting = s.cube.connect();
    s.connector.last.resolve({
      kind: 'gan',
      events$: events,
      facelets: SOLVED,
      requestFacelets: () => Promise.resolve(),
      requestBattery: () => Promise.resolve(),
      resetToSolved: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
    });
    await connecting;
    events.next({ type: 'battery', level: 80 });

    expect(s.service.phase()).toBe('cube-info');
    expect(s.service.attempt()).toBeNull();
    await vi.advanceTimersByTimeAsync(HARDWARE_WAIT_MS);
    expect(s.service.attempt()).toMatchObject({ index: 1, state: 'scrambling' });
    expect(s.service.session()?.cube).toEqual(UNKNOWN_CUBE);
  });

  it('lists, exports and deletes stored sessions; deleting the current one forgets it', async () => {
    const store = new MemorySessionStore();
    await store.createSession(testSession(SESSION_A, 1000));
    await store.saveAttempt(testAttempt(1, 10_000));
    await store.saveAttempt({
      ...testAttempt(2, 12_000),
      video: [clip('scramble', 1_000_000), clip('solve', 2_500_000)],
    });
    const localStorage = new FakeLocalStorage();
    localStorage.setItem(CURRENT_SESSION_KEY, SESSION_A);
    const s = setup({ store, localStorage });
    await s.service.whenReady();

    expect(await s.service.listSessions()).toEqual({
      sessions: [
        {
          session: testSession(SESSION_A, 1000),
          attempts: 2,
          mean: '11.00',
          clips: 2,
          clipBytes: 3_500_000,
          current: true,
          unreadable: [],
        },
      ],
      unreadable: [],
    });
    const exported = await s.service.exportSession(SESSION_A);
    expect(exported.attempts.map((a) => a.index)).toEqual([1, 2]);

    await s.service.deleteSession(SESSION_A);
    expect(s.service.session()).toBeNull();
    expect(s.service.attempts()).toEqual([]);
    expect(localStorage.getItem(CURRENT_SESSION_KEY)).toBeNull();
    expect(await s.service.listSessions()).toEqual({ sessions: [], unreadable: [] });
  });

  it('says so when a record cannot be saved, and keeps going', async () => {
    const store = new MemorySessionStore();
    store.saveAttempt = () => Promise.reject(new Error('The disk is full.'));
    const s = setup({ store });
    const fake = await ready(s);
    turn(s, fake, 'R U F');
    turn(s, fake, inverse('R U F'));
    await s.service.whenSaved();

    expect(s.service.saveError()).toBe('The disk is full.');
    expect(s.service.attempts()).toHaveLength(1);
  });

  describe('for the recording (T2.4)', () => {
    /** The milestones the service emits from now on. */
    function milestones(s: ReturnType<typeof setup>): AttemptMilestone[] {
      const seen: AttemptMilestone[] = [];
      s.service.milestones$.subscribe((milestone) => seen.push(milestone));
      return seen;
    }

    it('says when an attempt is armed and when it ended, with its record and its end', async () => {
      const s = setup();
      const seen = milestones(s);
      const fake = await ready(s);
      const session = s.service.session()?.id ?? '';
      const shown = s.service.attempt()?.events.scrambleShown ?? 0;

      turn(s, fake, 'R U F');
      turn(s, fake, inverse('R U F'), 500);

      const record = s.service.attempts()[0];
      const attempt = { session, index: 1, scrambleShown: shown };
      expect(seen).toEqual([
        {
          type: 'armed',
          attempt,
          scrambleStart: record.events.scrambleStart,
          scrambleDone: record.events.scrambleDone,
        },
        { type: 'ended', attempt, record, endMs: record.events.solveEnd },
      ]);
    });

    it('says when an attempt goes without a record, and when a DNF ended, at its time', async () => {
      const s = setup();
      const seen = milestones(s);
      const fake = await ready(s);
      const session = s.service.session()?.id ?? '';

      // Skipped while scrambling: dropped.
      turn(s, fake, 'R');
      const first = s.service.attempt()?.events.scrambleShown ?? 0;
      s.service.skip();
      expect(seen).toEqual([
        { type: 'dropped', attempt: { session, index: 1, scrambleShown: first }, clips: [] },
      ]);

      // A DNF during the solve: it ended when it was marked.
      turn(s, fake, inverse('R'));
      await settle();
      const second = s.service.attempt();
      turn(s, fake, second?.scramble ?? '');
      turn(s, fake, 'U', 400);
      s.perf.advance(900);
      const dnfMs = s.perf.hostMs;
      s.service.dnf();
      expect(seen.slice(1).map((milestone) => milestone.type)).toEqual(['armed', 'ended']);
      expect(seen[2]).toMatchObject({
        type: 'ended',
        attempt: { session, index: 1, scrambleShown: second?.events.scrambleShown },
        endMs: dnfMs,
        record: { result: { status: 'dnf' } },
      });
    });

    it('adds a clip to the attempt under way, to its record once saved, and replaces one of its kind', async () => {
      const s = setup();
      const fake = await ready(s);
      const session = s.service.session()?.id ?? '';
      const attempt = {
        session,
        index: 1,
        scrambleShown: s.service.attempt()?.events.scrambleShown ?? 0,
      };
      turn(s, fake, 'R U F');

      expect(await s.service.attachClip(attempt, clip('scramble', 10))).toBe('kept');
      turn(s, fake, inverse('R U F'), 500);
      const record = s.service.attempts()[0];
      expect(record.video).toEqual([clip('scramble', 10)]);

      expect(await s.service.attachClip(attempt, clip('solve', 20))).toBe('saved');
      expect(await s.service.attachClip(attempt, clip('scramble', 30))).toBe('saved');
      const [stored] = (await s.store.exportSession(session)).attempts;
      expect(stored.video).toEqual([clip('scramble', 30), clip('solve', 20)]);
      expect({ ...stored, video: [] }).toEqual({ ...record, video: [] });
      expect(s.service.attempts()).toEqual([stored]);
      expect(s.service.lastResult()).toEqual(stored);

      // Another attempt with that index, or none: gone.
      expect(await s.service.attachClip({ ...attempt, scrambleShown: 1 }, clip('solve', 1))).toBe(
        'gone',
      );
      expect(await s.service.attachClip({ ...attempt, index: 7 }, clip('solve', 1))).toBe('gone');
      expect(s.service.hasAttempt(attempt)).toBe(true);
      expect(s.service.hasAttempt({ ...attempt, index: 7 })).toBe(false);

      // After New session, the record of the earlier session is updated in the store.
      s.service.newSession();
      expect(s.service.session()?.id).not.toBe(session);
      expect(s.service.hasAttempt(attempt)).toBe(true);
      expect(await s.service.attachClip(attempt, clip('solve', 40))).toBe('saved');
      const [earlier] = (await s.store.exportSession(session)).attempts;
      expect(earlier.video).toEqual([clip('scramble', 30), clip('solve', 40)]);
      expect(await s.service.attachClip({ ...attempt, index: 2 }, clip('solve', 1))).toBe('gone');

      // A deleted session's attempts are gone.
      await s.service.deleteSession(session);
      expect(s.service.hasAttempt(attempt)).toBe(false);
    });

    it("puts the camera in the session's cameras, with the audio, and notes in its notes", async () => {
      const s = setup();
      const fake = await ready(s);
      const session = s.service.session()?.id ?? '';
      expect(s.service.session()).toMatchObject({ cameras: [], audio: true, notes: '' });

      s.service.putCamera(camera('FaceTime HD Camera'), false);
      s.service.putCamera(camera('FaceTime HD Camera'), false);
      s.service.putCamera({ ...camera('Phone'), label: 'phone-front' }, false);
      s.service.putCamera(camera('Studio Display Camera'), false);
      await s.service.addNote(session, 'clip failed: scramble of attempt 1: first');
      await s.service.addNote(session, 'clip failed: solve of attempt 1: second');
      await s.service.whenSaved();

      const stored = (await s.store.exportSession(session)).session;
      expect(stored).toEqual(s.service.session());
      expect(stored.cameras.map((entry) => [entry.label, entry.deviceLabel])).toEqual([
        ['laptop', 'Studio Display Camera'],
        ['phone-front', 'Phone'],
      ]);
      expect(stored.audio).toBe(false);
      expect(stored.notes).toBe(
        'clip failed: scramble of attempt 1: first\nclip failed: solve of attempt 1: second',
      );

      // A note for an earlier session goes to its session.json.
      turn(s, fake, 'R U F');
      turn(s, fake, inverse('R U F'), 500);
      s.service.newSession();
      expect(s.service.session()?.id).not.toBe(session);
      await s.service.addNote(session, 'third');
      expect((await s.store.exportSession(session)).session.notes).toMatch(/second\nthird$/);
      expect(s.service.session()?.notes).toBe('');
    });

    it('creates a session with the audio setting', async () => {
      const s = setup();
      s.settings.setRecordAudio(false);
      await ready(s);
      expect(s.service.session()?.audio).toBe(false);
    });
  });
});

/** A clip of `segment` of the laptop's camera, `bytes` long. */
function clip(segment: 'scramble' | 'solve', bytes: number): VideoClip {
  return {
    camera: 'laptop',
    segment,
    file: `laptop.${segment}.mp4`,
    bytes,
    codec: 'vp09.00.40.08',
    audio: 'opus',
    width: 1920,
    height: 1080,
    crop: null,
    fpsNominal: 30,
    frames: 90,
    firstFrameHostMs: 1_790_000_000_000,
    framesFile: `laptop.${segment}.frames.json`,
    syncResidualMs: null,
  };
}

/** A camera entry of session.json, named `deviceLabel`. */
function camera(deviceLabel: string): CameraInfo {
  return {
    label: 'laptop',
    local: true,
    facing: 'unknown',
    deviceLabel,
    settings: { width: 1920, height: 1080, frameRate: 30 },
    capabilities: {},
    constraints: {},
    crop: null,
    mode: 'full',
  };
}
