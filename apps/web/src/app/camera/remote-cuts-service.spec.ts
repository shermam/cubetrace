import { TestBed } from '@angular/core/testing';
import { parseFrames, type CloudEvent, type FramesJson, type VideoClip } from '@cubetrace/core';
import type { FakeCube } from '@cubetrace/gan';
import {
  FileSender,
  FirestoreSignaling,
  MessageLink,
  PROTOCOL_VERSION,
  TransferError,
  answerPings,
  bytesSource,
  hashToken,
  type Cut,
  type CutClip,
  type Message,
} from '@cubetrace/rtc';

import { ACCOUNT_LOADER } from '../auth/account-backend';
import { ACCOUNT_STORAGE_KEY, AuthService } from '../auth/auth-service';
import { ADA, FakeAccountBackend } from '../auth/fake-account';
import { bluetoothNavigator } from '../cube/cube-testing';
import { FakeLocalStorage, settle } from '../device/fake-browser';
import { MemoryConnector, rtcTimers } from '../rtc/rtc-testing';
import { TRANSPORT_CONNECTOR } from '../rtc/transport-connector';
import { ATTEMPT_FILES } from '../session/attempt-files';
import { ClipsInFlight } from '../session/clips-in-flight';
import { inverse, ready, setup, turn, type Setup } from '../session/session-harness';
import { SCRAMBLE_LEAD_MS, SOLVE_LEAD_MS, CLIP_TAIL_MS } from './clip-windows';
import { RemoteCamerasService } from './remote-cameras-service';
import { REMOTE_CLIP_WAIT_MS, RemoteCutsService } from './remote-cuts-service';
import { CUT_MARGIN_MS } from './remote-estimate';

// The remote cameras' clips (docs/PLAN.md T4.2) on the host: a phone paired over memory connections
// (as in remote-cameras-service.spec.ts) answers the cuts of a real SessionService's attempts with
// its files, through the protocol's FileSender; the attempt's folder is a fake of ATTEMPT_FILES.

/** The phone's clock minus the host's. */
const OFFSET_MS = 1234.5;

/** What the phone's capture says of a clip. */
const CLIP: CutClip = {
  codec: 'avc1.640028',
  audio: 'mp4a.40.2',
  width: 1080,
  height: 1920,
  fpsNominal: 30,
  frames: 4,
  crop: { x: 100, y: 200, w: 800, h: 600 },
  truncatedStart: false,
  lateMs: 0,
  bufferSeconds: 90,
  audioMissing: null,
};

/** An MP4's bytes, as many as `bytes`: five chunks of 64 KB and a bit, for the resumed transfer. */
function mp4(bytes = 5 * 65_536 + 4321): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) {
    out[i] = (i * 31 + 7) & 0xff;
  }
  return out;
}

interface Rig {
  readonly s: Setup;
  readonly backend: FakeAccountBackend;
  readonly connector: MemoryConnector;
  readonly cameras: RemoteCamerasService;
  readonly cuts: RemoteCutsService;
  readonly inFlight: ClipsInFlight;
  /** The attempts' files written, by `<index>/<name>`. */
  readonly written: Map<string, Uint8Array>;
  readonly fake: FakeCube;
}

/** A phone joined to the session: it answers the pings and keeps what the host sends. */
class Phone {
  readonly received: Message[] = [];
  link: MessageLink | null = null;
  sender: FileSender | null = null;
  token = '';
  peerId = '';

  constructor(
    private readonly r: Rig,
    readonly label = 'ThinkPhone',
  ) {}

  async join(token: string): Promise<void> {
    this.token = token;
    const signaling = new FirestoreSignaling(this.r.backend, {
      sessionId: this.r.s.service.session()?.id ?? '',
      uid: ADA.uid,
      now: () => this.r.s.perf.hostMs,
    }).call({ tokenHash: await hashToken(token) });
    this.peerId = signaling.peerId;
    const transport = await this.r.connector.connect(signaling);
    const link = new MessageLink(transport);
    this.link = link;
    this.sender = new FileSender(link);
    link.onMessage((message) => {
      this.received.push(message);
    });
    answerPings(link, () => this.r.s.perf.hostMs + OFFSET_MS);
    link.send({
      type: 'hello',
      v: PROTOCOL_VERSION,
      role: 'camera',
      device: { label: this.label, platform: 'Android' },
      app: { version: '0.4.0', commit: 'abc1234' },
      camera: {
        label: 'phone-rear',
        local: true,
        facing: 'environment',
        deviceLabel: 'camera 0, facing back',
        settings: { width: 1080, height: 1920, frameRate: 30 },
        capabilities: {},
        constraints: {},
        crop: null,
        mode: 'full',
        microphone: null,
      },
    });
  }

  of<T extends Message['type']>(type: T): Extract<Message, { type: T }>[] {
    return this.received.filter((message) => message.type === type) as Extract<
      Message,
      { type: T }
    >[];
  }

  /** The cut of `segment` received last. */
  cut(segment: Cut['segment']): Cut {
    const cut = this.of('cut')
      .filter((c) => c.segment === segment)
      .at(-1);
    if (cut === undefined) {
      throw new Error(`No ${segment} cut came.`);
    }
    return cut;
  }

  /**
   * The phone's frames file of the clip of `cut`: its first frame 600 ms into the window, on the
   * phone's clock (`t0HostMs` of the phone's own file).
   */
  frames(cut: Cut): FramesJson {
    return {
      schema: 2,
      camera: cut.camera,
      segment: cut.segment,
      app: { version: '0.4.0', commit: 'abc1234' },
      t0HostMs: cut.fromRemoteMs + 600,
      dtMs: [0, 33.4, 33.3, 33.3],
      keyframes: [0],
      arrival: { offsetMs: 1_789_999_990_000.25, residualP95Ms: 2.5 },
    };
  }

  /**
   * Offers the clip of `cut` (`cut-done`) and sends its frames file and its MP4, as the Camera page
   * does; `onProgress` hears the MP4's progress. Resolves with what each send did.
   */
  async deliver(
    cut: Cut,
    bytes = mp4(),
    onProgress?: (sent: number) => void,
  ): Promise<string[]> {
    const link = this.link;
    const sender = this.sender;
    if (link === null || sender === null) {
      throw new Error('Not connected.');
    }
    const frames = new TextEncoder().encode(`${JSON.stringify(this.frames(cut))}\n`);
    const names = {
      frames: `${cut.camera}.${cut.segment}.frames.json`,
      mp4: `${cut.camera}.${cut.segment}.mp4`,
    };
    link.send({
      type: 'cut-done',
      attempt: cut.attempt,
      scrambleShown: cut.scrambleShown,
      segment: cut.segment,
      files: [
        { name: names.frames, bytes: frames.length, kind: 'frames' },
        { name: names.mp4, bytes: bytes.length, kind: 'mp4' },
      ],
      clip: CLIP,
    });
    const outcomes: string[] = [];
    for (const [name, data, kind] of [
      [names.frames, frames, 'frames'],
      [names.mp4, bytes, 'mp4'],
    ] as const) {
      try {
        const result = await sender.send(
          bytesSource(data, { name, kind, attempt: cut.attempt, segment: cut.segment }),
          (progress) => onProgress?.(progress.sent),
        );
        outcomes.push(`${kind} from ${String(result.resumedFrom)}`);
      } catch (error: unknown) {
        outcomes.push(`${kind} ${error instanceof TransferError ? error.reason : String(error)}`);
        if (error instanceof TransferError && error.reason === 'closed') {
          break;
        }
      }
    }
    return outcomes;
  }

  /** The connection drops without a word. */
  drop(): void {
    this.link?.close('the network went');
  }
}

describe('RemoteCutsService', () => {
  let r: Rig;

  /** The timer with a session under way, signed in, and memory connections of `bytesPerSecond`. */
  async function rig(bytesPerSecond?: number): Promise<Rig> {
    TestBed.resetTestingModule();
    const backend = new FakeAccountBackend();
    backend.user = ADA;
    const localStorage = new FakeLocalStorage();
    localStorage.setItem(ACCOUNT_STORAGE_KEY, 'signed-in');
    const written = new Map<string, Uint8Array>();
    let connector: MemoryConnector | null = null;
    const s = setup({
      localStorage,
      navigator: bluetoothNavigator(true),
      providers: [
        { provide: ACCOUNT_LOADER, useValue: backend.loader },
        {
          provide: TRANSPORT_CONNECTOR,
          useValue: (signaling: Parameters<MemoryConnector['connect']>[0]) => {
            if (connector === null) {
              throw new Error('No connector yet.');
            }
            return connector.connect(signaling);
          },
        },
        {
          provide: ATTEMPT_FILES,
          useValue: {
            read: () => Promise.reject(new Error('not read here')),
            write: (_session: string, index: number, name: string, content: unknown) => {
              const parts: Uint8Array[] =
                typeof content === 'string'
                  ? [new TextEncoder().encode(content)]
                  : content instanceof Uint8Array
                    ? [content]
                    : (content as Uint8Array[]);
              const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
              let at = 0;
              for (const part of parts) {
                joined.set(part, at);
                at += part.length;
              }
              written.set(`${String(index)}/${name}`, joined);
              return Promise.resolve();
            },
          },
        },
      ],
    });
    connector = new MemoryConnector({
      delayMs: 4,
      timers: rtcTimers(s.perf, s.timers),
      ...(bytesPerSecond === undefined ? {} : { bytesPerSecond }),
    });
    const cameras = TestBed.inject(RemoteCamerasService);
    TestBed.inject(AuthService);
    await settle();
    const fake = await ready(s);
    await pump(s, 0);
    return {
      s,
      backend,
      connector,
      cameras,
      cuts: TestBed.inject(RemoteCutsService),
      inFlight: TestBed.inject(ClipsInFlight),
      written,
      fake,
    };
  }

  /** Moves the clock `ms` forward in steps, letting the effects and promises run after each. */
  async function pump(s: Setup, ms: number, rounds = 4): Promise<void> {
    for (let k = 0; k < rounds; k++) {
      s.timers.advance(ms / rounds);
      await settle();
      await settle();
      TestBed.tick();
    }
  }

  /** Lets `ms` pass in steps of 1 s, pumping each. */
  async function pass(ms: number): Promise<void> {
    for (let left = ms; left > 0; left -= 1000) {
      await pump(r.s, Math.min(1000, left), 2);
    }
  }

  /** Pumps 10 ms at a time until `task` settles (at most 400 rounds). */
  async function drive<T>(task: Promise<T>): Promise<T> {
    const state = { done: false };
    void task.then(
      () => (state.done = true),
      () => (state.done = true),
    );
    for (let k = 0; k < 400 && !state.done; k++) {
      await pump(r.s, 10, 1);
    }
    return task;
  }

  async function events(): Promise<CloudEvent[]> {
    await pump(r.s, 5000);
    return r.backend.events.map((entry) => entry.write.event);
  }

  function remote(all: CloudEvent[]): CloudEvent[] {
    return all.filter((event) => event.kind.startsWith('remote.'));
  }

  /**
   * Add camera, and the phone joins with its token; the hellos exchanged and the first ping answered
   * (the attempts' turns move the clock without running the timers).
   */
  async function paired(phone = new Phone(r)): Promise<Phone> {
    await r.cameras.addCamera();
    const joining = phone.join(r.cameras.pairing()?.token ?? '');
    await pump(r.s, 0);
    await joining;
    await pump(r.s, 40);
    return phone;
  }

  /** The scramble of the attempt under way, done: the attempt is armed. */
  async function scrambled(): Promise<void> {
    turn(r.s, r.fake, 'R U F', 100);
    await pump(r.s, 20);
  }

  /** The cube solved: the attempt ended. */
  async function solved(): Promise<void> {
    turn(r.s, r.fake, inverse('R U F'), 150);
    await pump(r.s, 20);
  }

  /** The attempt's record, once saved. */
  function record(index = 1): ReturnType<Setup['service']['attempts']>[number] {
    const found = r.s.service.attempts().find((attempt) => attempt.index === index);
    if (found === undefined) {
      throw new Error(`No attempt ${String(index)}.`);
    }
    return found;
  }

  function sessionId(): string {
    return r.s.service.session()?.id ?? '';
  }

  /** The frames file written for a clip, read back. */
  function writtenFrames(name: string, index = 1): FramesJson {
    const bytes = r.written.get(`${String(index)}/${name}`);
    if (bytes === undefined) {
      throw new Error(`${name} was not written.`);
    }
    return parseFrames(JSON.parse(new TextDecoder().decode(bytes)));
  }

  beforeEach(async () => {
    r = await rig();
  });

  it("cuts on the estimate of a fit that has not converged, widened by the margin; takes the phone's files into the attempt's folder with the times on the host clock, adds both clips to the record and acknowledges them", async () => {
    const phone = await paired();
    await scrambled();
    const scrambleCut = phone.cut('scramble');
    const view = r.s.service.attempt();
    const shown = view?.events.scrambleShown ?? 0;
    const start = view?.events.scrambleStart ?? 0;
    const done = view?.events.scrambleDone ?? 0;
    // The window of the host's own scramble clip, widened by half a second on each side, on the
    // phone's clock (the estimate of the one answer so far: its offset).
    expect(scrambleCut).toMatchObject({
      attempt: 1,
      scrambleShown: shown,
      segment: 'scramble',
      reason: 'armed',
      camera: 'phone-rear',
    });
    expect(scrambleCut.fromRemoteMs).toBeCloseTo(start - SCRAMBLE_LEAD_MS - CUT_MARGIN_MS + OFFSET_MS, 6);
    expect(scrambleCut.toRemoteMs).toBeCloseTo(done + CLIP_TAIL_MS + CUT_MARGIN_MS + OFFSET_MS, 6);
    // The attempt waits for the phone's clip; the session records what the cut relied on.
    expect(r.inFlight.has(sessionId(), 1)).toBe(true);
    const clock = r.s.service.session()?.clock.cameras['phone-rear'];
    expect(clock?.remote).toMatchObject({ converged: false, samples: 1 });
    expect(clock?.remote?.offsetMs).toBeCloseTo(OFFSET_MS, 6);
    expect(clock?.clapperboardSamples).toBe(0);

    await solved();
    const solveCut = phone.cut('solve');
    const ended = record();
    expect(solveCut.fromRemoteMs).toBeCloseTo(
      (ended.events.solveStart ?? 0) - SOLVE_LEAD_MS - CUT_MARGIN_MS + OFFSET_MS,
      6,
    );
    expect(solveCut.toRemoteMs).toBeCloseTo(
      (ended.events.solveEnd ?? 0) + CLIP_TAIL_MS + CUT_MARGIN_MS + OFFSET_MS,
      6,
    );
    expect(ended.video).toEqual([]);

    // The phone sends both clips: written, converted, attached, acknowledged.
    expect(await drive(phone.deliver(scrambleCut))).toEqual(['frames from 0', 'mp4 from 0']);
    expect(await drive(phone.deliver(solveCut))).toEqual(['frames from 0', 'mp4 from 0']);
    await pump(r.s, 20);
    expect(phone.of('clip-ack')).toEqual([
      expect.objectContaining({ segment: 'scramble', scrambleShown: shown, stored: true }),
      expect.objectContaining({ segment: 'solve', scrambleShown: shown, stored: true }),
    ]);
    expect(r.inFlight.has(sessionId(), 1)).toBe(false);
    expect(r.written.get('1/phone-rear.solve.mp4')).toEqual(mp4());
    const frames = writtenFrames('phone-rear.solve.frames.json');
    expect(frames.camera).toBe('phone-rear');
    expect(frames.t0RemoteMs).toBe(solveCut.fromRemoteMs + 600);
    expect(frames.t0HostMs).toBeCloseTo(solveCut.fromRemoteMs + 600 - OFFSET_MS, 2);
    // What the conversion used: the fit's estimate, not converged, and when it was taken.
    expect(frames.remote).toMatchObject({ converged: false, rttMs: 8 });
    expect(frames.remote?.offsetMs).toBeCloseTo(OFFSET_MS, 6);
    expect(frames.remote?.samples).toBeGreaterThanOrEqual(1);
    expect(frames.remote?.takenMs).toBeLessThanOrEqual(r.s.perf.hostMs);

    const clips = record().video;
    expect(clips.map((clip) => `${clip.camera}.${clip.segment}`)).toEqual([
      'phone-rear.scramble',
      'phone-rear.solve',
    ]);
    expect(clips[1]).toEqual<VideoClip>({
      camera: 'phone-rear',
      segment: 'solve',
      file: 'phone-rear.solve.mp4',
      bytes: mp4().length,
      codec: 'avc1.640028',
      audio: 'mp4a.40.2',
      width: 1080,
      height: 1920,
      crop: { x: 100, y: 200, w: 800, h: 600 },
      fpsNominal: 30,
      frames: 4,
      firstFrameHostMs: frames.t0HostMs,
      framesFile: 'phone-rear.solve.frames.json',
      // The camera's entry in clock.cameras is the clock sync's, before any sync check: no lag.
      syncResidualMs: null,
      truncatedStart: false,
    });
    expect(r.cuts.stateOf({ session: sessionId(), index: 1, scrambleShown: shown }, 'phone-rear', 'solve')).toBe(
      'stored',
    );

    const all = remote(await events());
    expect(all.map((e) => `${e.kind} ${(e.data['outcome'] ?? e.data['segment']) as string}`)).toEqual([
      'remote.cut sent',
      'remote.cut sent',
      'remote.cut done',
      'remote.clip scramble',
      'remote.cut done',
      'remote.clip solve',
    ]);
    expect(all[0].data).toMatchObject({
      camera: 'phone-rear',
      peer: 'ThinkPhone',
      segment: 'scramble',
      marginMs: CUT_MARGIN_MS,
      converged: false,
      samples: 1,
    });
    expect(all[0].attempt).toBe(1);
    expect(all.at(-1)?.data).toMatchObject({
      camera: 'phone-rear',
      segment: 'solve',
      mp4Bytes: mp4().length,
      late: false,
      kept: false,
      converged: false,
      offsetMs: OFFSET_MS,
      resumedBytes: 0,
    });
  });

  it('keeps a clip that comes while its attempt is under way for the record to come', async () => {
    const phone = await paired();
    await scrambled();
    expect(await drive(phone.deliver(phone.cut('scramble')))).toEqual([
      'frames from 0',
      'mp4 from 0',
    ]);
    await pump(r.s, 20);
    expect(phone.of('clip-ack').at(-1)).toMatchObject({ segment: 'scramble', stored: true });
    await solved();
    expect(record().video.map((clip) => clip.file)).toEqual(['phone-rear.scramble.mp4']);
    // The solve clip still holds it.
    expect(r.inFlight.has(sessionId(), 1)).toBe(true);
    const all = remote(await events());
    expect(all.find((e) => e.kind === 'remote.clip')?.data).toMatchObject({ kept: true });
  });

  it('waits 120 s after the attempt’s end, then lets it go with a note saying whose clip is missing; a clip that comes later is attached as an addition and noted late', async () => {
    const phone = await paired();
    await scrambled();
    await solved();
    const endMs = record().events.solveEnd ?? 0;
    // The phone never answers: the attempt is held until 120 s after its end.
    await pass(REMOTE_CLIP_WAIT_MS - 2000);
    expect(r.inFlight.has(sessionId(), 1)).toBe(true);
    await pass(3000);
    expect(r.inFlight.has(sessionId(), 1)).toBe(false);
    const notes = r.s.service.session()?.notes.split('\n') ?? [];
    expect(notes).toEqual([
      "remote clip missing: scramble of attempt 1 from phone-rear: no clip within 120 s of the attempt's end",
      "remote clip missing: solve of attempt 1 from phone-rear: no clip within 120 s of the attempt's end",
    ]);
    let all = remote(await events());
    const missing = all.filter((e) => e.kind === 'remote.clip.missing');
    expect(missing.map((e) => e.data['segment'])).toEqual(['scramble', 'solve']);
    expect(missing[0].data).toMatchObject({ camera: 'phone-rear', reason: 'wait' });
    expect(Number(missing[0].data['afterEndMs'])).toBeGreaterThanOrEqual(REMOTE_CLIP_WAIT_MS);

    // The solve clip comes later: attached all the same (its record saved again, which the upload
    // queue sends as an addition), and noted.
    expect(await drive(phone.deliver(phone.cut('solve')))).toEqual(['frames from 0', 'mp4 from 0']);
    await pump(r.s, 20);
    expect(record().video.map((clip) => clip.file)).toEqual(['phone-rear.solve.mp4']);
    expect(phone.of('clip-ack').at(-1)).toMatchObject({ segment: 'solve', stored: true });
    expect(r.inFlight.has(sessionId(), 1)).toBe(false);
    expect(r.s.service.session()?.notes.split('\n').at(-1)).toMatch(
      /^remote clip late: solve of attempt 1 from phone-rear: attached 1\d\d s after the attempt ended$/,
    );
    all = remote(await events());
    const late = all.find((e) => e.kind === 'remote.clip.late');
    expect(late?.data).toMatchObject({ camera: 'phone-rear', segment: 'solve' });
    expect(Number(late?.data['afterEndMs'])).toBeGreaterThan(REMOTE_CLIP_WAIT_MS);
    expect(all.filter((e) => e.kind === 'remote.clip').at(-1)?.data).toMatchObject({ late: true });
    expect(Number(late?.data['afterEndMs'])).toBeLessThan(r.s.perf.hostMs - endMs + 1);
  });

  it('resumes a file cut in the middle once the phone is back, from the bytes the host holds', async () => {
    // A link of 1 MB/s: the MP4 takes a third of a second.
    r = await rig(1_000_000);
    const phone = await paired();
    await scrambled();
    await solved();
    const cut = phone.cut('solve');
    // The connection drops 200 ms into the transfer, a few chunks in.
    const delivering = phone.deliver(cut);
    for (let k = 0; k < 20; k++) {
      await pump(r.s, 10, 1);
    }
    phone.drop();
    const first = await drive(delivering);
    expect(first).toEqual(['frames from 0', 'mp4 closed']);
    await pump(r.s, 20);
    expect(r.cameras.cameras()[0].state).toBe('reconnecting');
    expect(r.written.has('1/phone-rear.solve.mp4')).toBe(false);
    // The frames file is in already.
    expect(writtenFrames('phone-rear.solve.frames.json').t0RemoteMs).toBe(cut.fromRemoteMs + 600);

    // The phone calls again with its token and offers the clip again: the MP4 goes on from where
    // the host's bytes end (a whole number of chunks).
    const back = new Phone(r);
    const joining = back.join(phone.token);
    await pump(r.s, 0);
    await joining;
    await pump(r.s, 10);
    expect(r.cameras.cameras()[0].state).toBe('connected');
    const again = await drive(back.deliver(cut));
    expect(again[0]).toBe('frames from 0');
    expect(again[1]).toMatch(/^mp4 from \d+$/);
    const resumedFrom = Number(again[1].split(' ').at(-1));
    expect(resumedFrom).toBeGreaterThanOrEqual(65_536);
    expect(resumedFrom).toBeLessThan(mp4().length);
    await pump(r.s, 20);
    expect(r.written.get('1/phone-rear.solve.mp4')).toEqual(mp4());
    expect(back.of('clip-ack').at(-1)).toMatchObject({ segment: 'solve', stored: true });
    const all = remote(await events());
    expect(all.find((e) => e.kind === 'remote.clip')?.data['resumedBytes']).toBe(resumedFrom);
  });

  it('gives a clip up at once when the phone cannot cut it, and the clips still to come of a phone that leaves', async () => {
    const phone = await paired();
    await scrambled();
    const cut = phone.cut('scramble');
    phone.link?.send({
      type: 'cut-failed',
      attempt: cut.attempt,
      scrambleShown: cut.scrambleShown,
      segment: 'scramble',
      reason: 'the window is older than the buffer',
    });
    await pump(r.s, 20);
    expect(r.s.service.session()?.notes).toBe(
      'remote clip missing: scramble of attempt 1 from phone-rear: the phone could not cut it: the window is older than the buffer',
    );
    await solved();
    expect(r.inFlight.has(sessionId(), 1)).toBe(true);
    phone.link?.send({ type: 'leave', reason: 'the user left' });
    await pump(r.s, 20);
    expect(r.inFlight.has(sessionId(), 1)).toBe(false);
    expect(r.s.service.session()?.notes.split('\n').at(-1)).toBe(
      'remote clip missing: solve of attempt 1 from phone-rear: the phone left (it left: the user left)',
    );
    const all = remote(await events());
    expect(all.map((e) => `${e.kind} ${(e.data['outcome'] ?? e.data['reason']) as string}`)).toEqual([
      'remote.cut sent',
      'remote.cut failed',
      'remote.clip.missing cut-failed',
      'remote.cut sent',
      'remote.clip.missing left',
    ]);
  });

  it("refuses the clip of an attempt that went without a record, and the phone's offer of an attempt there is not", async () => {
    const phone = await paired();
    await scrambled();
    const cut = phone.cut('scramble');
    // Mark as solved: the attempt goes without a record (it begins again from the solved cube).
    await r.s.cube.resetToSolved();
    await pump(r.s, 20);
    expect(r.inFlight.has(sessionId(), 1)).toBe(false);
    expect(await drive(phone.deliver(cut))).toEqual(['frames aborted', 'mp4 aborted']);
    await pump(r.s, 20);
    expect(phone.of('clip-ack').at(-1)).toMatchObject({
      segment: 'scramble',
      stored: false,
      reason: 'the attempt is gone',
    });
    expect(r.written.size).toBe(0);
    // An offer of an attempt the session never had.
    phone.link?.send({
      type: 'cut-done',
      attempt: 9,
      scrambleShown: 5,
      segment: 'solve',
      files: [],
      clip: CLIP,
    });
    await pump(r.s, 20);
    expect(phone.of('clip-ack').at(-1)).toMatchObject({ attempt: 9, stored: false });
    expect(r.s.service.session()?.notes).toBe('');
  });

  it('asks for nothing with Record remote cameras off; the phone stays connected', async () => {
    const phone = await paired();
    r.s.settings.setRecordRemoteCameras(false);
    await scrambled();
    await solved();
    expect(phone.of('cut')).toEqual([]);
    expect(r.inFlight.has(sessionId(), 1)).toBe(false);
    expect(r.cameras.cameras()[0].state).toBe('connected');
  });

  it('sends the cuts of a phone that was reconnecting when the attempt needed them once it is back', async () => {
    const phone = await paired();
    phone.drop();
    await pump(r.s, 20);
    expect(r.cameras.cameras()[0].state).toBe('reconnecting');
    await scrambled();
    expect(phone.of('cut')).toEqual([]);
    expect(r.inFlight.has(sessionId(), 1)).toBe(true);
    const back = new Phone(r);
    const joining = back.join(phone.token);
    await pump(r.s, 0);
    await joining;
    await pump(r.s, 20);
    expect(back.of('cut').map((cut) => cut.segment)).toEqual(['scramble']);
    const all = remote(await events());
    expect(Number(all.find((e) => e.kind === 'remote.cut')?.data['waitedMs'])).toBeGreaterThan(0);
  });
});
