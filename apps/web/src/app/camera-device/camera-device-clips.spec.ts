import { TestBed } from '@angular/core/testing';
import type { SaveClipParams, SavedClip } from '@cubetrace/capture';
import type { CameraInfo, FramesJson } from '@cubetrace/core';
import {
  Crc32,
  FileReceiver,
  MemoryTransport,
  MessageLink,
  type Cut,
  type FileDescription,
  type IncomingFile,
  type MemoryLinkOptions,
  type Message,
  type ReceivedFile,
} from '@cubetrace/rtc';
import { FakeDirectoryHandle } from '@cubetrace/storage';

import { APP_BUILD } from '../../environments/version';
import { CameraService } from '../camera/camera-service';
import { ENCODER_SETTLE_MS } from '../camera/recording-service';
import { CLIP_AS_ASKED, clipFor } from '../camera/recording-testing';
import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import { FakePerformance, FakeTimers, settle } from '../device/fake-browser';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { E2E_REMOTE, type E2eRemote } from '../rtc/e2e-remote';
import { rtcTimers } from '../rtc/rtc-testing';
import { RTC_TIMERS } from '../rtc/rtc-timers';
import { CameraDeviceCapture } from './camera-device-capture';
import { CameraDeviceClips } from './camera-device-clips';
import {
  CLIP_STAGING,
  OpfsClipStaging,
  STAGED_MAX_AGE_MS,
  STAGING_FOLDER,
  STAGING_INDEX,
  type StagedClip,
} from './clip-staging';

// The camera device's side of the remote clips (docs/PLAN.md T4.2): the host's cuts saved through
// the capture (a fake whose saves the test answers, after planting the files the clip worker would
// have written), staged in a fake origin private file system, offered and sent to a host that is
// the other end of a memory transport, and deleted on its word.

/** The session the phone joined. */
const SESSION = 'b7c4e0d2-9f1a-4c3b-8e2d-5a6f7b8c9d0e';
const OTHER_SESSION = 'c8d5f1e3-0a2b-4d4c-9f3e-6b7a8c9d0e1f';

const PHONE_CAMERA: CameraInfo = {
  label: 'phone-rear',
  local: true,
  facing: 'environment',
  deviceLabel: 'camera 0, facing back',
  settings: { width: 1080, height: 1920, frameRate: 30 },
  capabilities: {},
  constraints: {},
  crop: { x: 100, y: 200, w: 800, h: 600 },
  mode: 'full',
  microphone: null,
};

/** A clip `saveClip` was asked for, which the test answers. */
interface PendingSave {
  readonly params: SaveClipParams;
  resolve(saved: SavedClip): void;
  reject(error: Error): void;
}

interface Rig {
  readonly perf: FakePerformance;
  readonly timers: FakeTimers;
  readonly root: FakeDirectoryHandle;
  readonly staging: OpfsClipStaging;
  readonly saves: PendingSave[];
  readonly events: { kind: string; data: Record<string, unknown> }[];
  readonly clips: CameraDeviceClips;
}

/** A file as the host of the test holds it, across connections until it is complete. */
class HeldFile implements IncomingFile {
  readonly parts: Uint8Array[] = [];
  readonly #crc = new Crc32();
  received = 0;
  done = false;

  constructor(readonly description: FileDescription) {}

  get crc32(): number {
    return this.#crc.value;
  }

  append(bytes: Uint8Array): void {
    const copy = bytes.slice();
    this.parts.push(copy);
    this.received += copy.length;
    this.#crc.update(copy);
  }

  finish(): void {
    this.done = true;
  }

  discard(): void {
    this.parts.length = 0;
  }

  text(): string {
    const all = new Uint8Array(this.received);
    let at = 0;
    for (const part of this.parts) {
      all.set(part, at);
      at += part.length;
    }
    return new TextDecoder().decode(all);
  }
}

/**
 * The host's end of the phone's connections: what the phone sends, and its files, a file begun again
 * (same name and size, not complete) resumed from the bytes held.
 */
class Host {
  readonly received: Message[] = [];
  readonly files = new Map<string, HeldFile>();
  readonly completed: ReceivedFile[] = [];
  /** The files it refuses at their begin. */
  readonly refused = new Set<string>();
  transport: MemoryTransport | null = null;
  link: MessageLink | null = null;

  constructor(private readonly r: Rig) {}

  /** A new connection: the phone's end of it, as a link. */
  connect(options: MemoryLinkOptions = {}): MessageLink {
    const [host, phone] = MemoryTransport.pair({
      delayMs: 4,
      timers: rtcTimers(this.r.perf, this.r.timers),
      ...options,
    });
    this.transport = host;
    const link = new MessageLink(host);
    this.link = link;
    link.onMessage((message) => {
      this.received.push(message);
    });
    const receiver = new FileReceiver(link, { open: (description) => this.open(description) });
    receiver.onReceived((file) => {
      this.completed.push(file);
    });
    return new MessageLink(phone);
  }

  send(message: Message): void {
    this.link?.send(message);
  }

  of<T extends Message['type']>(type: T): Extract<Message, { type: T }>[] {
    return this.received.filter((message) => message.type === type) as Extract<
      Message,
      { type: T }
    >[];
  }

  private open(description: FileDescription): IncomingFile {
    if (this.refused.has(description.name)) {
      throw new Error('the host has the clip already');
    }
    const held = this.files.get(description.name);
    if (held !== undefined && !held.done && held.description.bytes === description.bytes) {
      return held;
    }
    const file = new HeldFile(description);
    this.files.set(description.name, file);
    return file;
  }
}

describe('CameraDeviceClips', () => {
  let r: Rig;

  function rig(
    options: { root?: FakeDirectoryHandle; e2e?: E2eRemote; perf?: FakePerformance } = {},
  ): Rig {
    TestBed.resetTestingModule();
    const perf = options.perf ?? new FakePerformance();
    const timers = new FakeTimers(perf);
    const root = options.root ?? new FakeDirectoryHandle();
    const staging = new OpfsClipStaging(() => Promise.resolve(root));
    const saves: PendingSave[] = [];
    const events: Rig['events'] = [];
    const globals = {
      performance: perf,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      [E2E_REMOTE]: options.e2e,
    } as BrowserGlobals;
    const offsetMs = options.e2e?.clockOffsetMs ?? 0;
    TestBed.configureTestingModule({
      providers: [
        { provide: BROWSER_GLOBALS, useValue: globals },
        // The connection's clock, ahead of the capture's by the suite's offset, as RTC_TIMERS has it.
        {
          provide: RTC_TIMERS,
          useValue: { ...rtcTimers(perf, timers), now: () => perf.hostMs + offsetMs },
        },
        { provide: CLIP_STAGING, useValue: staging },
        {
          provide: CameraDeviceCapture,
          useValue: {
            saveClip: (params: SaveClipParams) =>
              new Promise<SavedClip>((resolve, reject) => {
                saves.push({ params, resolve, reject });
              }),
          },
        },
        { provide: CameraService, useValue: { cameraInfo: () => PHONE_CAMERA } },
        {
          provide: DiagnosticsService,
          useValue: {
            record: (kind: string, data: Record<string, unknown>) => {
              events.push({ kind, data });
            },
          },
        },
      ],
    });
    return { perf, timers, root, staging, saves, events, clips: TestBed.inject(CameraDeviceClips) };
  }

  /**
   * Moves the clock `ms` forward in steps of 10 ms, letting the promises run after each (a file's
   * chunk is read from a Blob, which takes a turn of the event loop).
   */
  async function pump(ms: number): Promise<void> {
    const rounds = Math.max(2, Math.ceil(ms / 10));
    for (let k = 0; k < rounds; k++) {
      r.timers.advance(ms / rounds);
      await settle();
      await settle();
    }
  }

  /** The cut of `segment` of attempt 1, its window ending `endInMs` from now on the phone's clock. */
  function cutOf(segment: Cut['segment'], endInMs = 1000, scrambleShown = 1_000_000): Cut {
    const toRemoteMs = r.perf.hostMs + endInMs;
    return {
      type: 'cut',
      attempt: 1,
      scrambleShown,
      segment,
      fromRemoteMs: toRemoteMs - 12_000,
      toRemoteMs,
      reason: segment === 'scramble' ? 'armed' : 'ended',
      camera: 'phone-rear',
    };
  }

  /** The frames file the clip worker would write for `params`, on the capture's clock. */
  function framesOf(params: SaveClipParams): FramesJson {
    return {
      schema: 2,
      camera: params.camera,
      segment: params.segment,
      app: APP_BUILD,
      t0HostMs: Math.floor(params.startHostMs / 1000) * 1000,
      dtMs: [0, 33.3, 33.4, 33.3],
      keyframes: [0],
      arrival: { offsetMs: 12.5, residualP95Ms: 1.5 },
    };
  }

  /** An MP4's content, `bytes` long. */
  function mp4Text(bytes: number): string {
    return 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(Math.ceil(bytes / 36)).slice(0, bytes);
  }

  /**
   * Answers the oldest save as the clip worker does: its files planted in the staging folder, then
   * the clip resolved. Returns the files' content.
   */
  async function saveNext(mp4Bytes = 100_000): Promise<{ frames: string; mp4: string }> {
    const pending = r.saves.shift();
    if (pending === undefined) {
      throw new Error('No clip was asked for.');
    }
    const params = pending.params;
    const folder = `${STAGING_FOLDER}/sessions/${params.sessionId}/attempts/${String(params.index).padStart(4, '0')}`;
    const frames = `${JSON.stringify(framesOf(params))}\n`;
    const mp4 = mp4Text(mp4Bytes);
    await r.root.plant(`${folder}/${params.camera}.${params.segment}.frames.json`, frames);
    await r.root.plant(`${folder}/${params.camera}.${params.segment}.mp4`, mp4);
    pending.resolve({ clip: { ...clipFor(params), bytes: mp4Bytes }, report: CLIP_AS_ASKED });
    await pump(0);
    return { frames, mp4 };
  }

  /** The files of the staging folder, by their path in it. */
  function stagedFiles(): string[] {
    return [...r.root.files().keys()]
      .filter((path) => path.startsWith(`${STAGING_FOLDER}/`))
      .map((path) => path.slice(STAGING_FOLDER.length + 1))
      .sort();
  }

  /** The staged clips' index, as written. */
  function index(): StagedClip[] {
    const file = r.root.files().get(`${STAGING_FOLDER}/${STAGING_INDEX}`);
    return file === undefined ? [] : (JSON.parse(file.text) as { clips: StagedClip[] }).clips;
  }

  /** A clip in the index, of `session`, staged at `stagedMs`, with its files planted. */
  async function stageDirectly(
    session: string,
    stagedMs: number,
    attempt = 1,
  ): Promise<StagedClip> {
    const clip: StagedClip = {
      session,
      attempt,
      scrambleShown: 1_000_000,
      segment: 'solve',
      camera: 'phone-rear',
      stagedMs,
      fromRemoteMs: stagedMs - 12_000,
      toRemoteMs: stagedMs - 1000,
      clip: {
        codec: 'avc1.640028',
        audio: null,
        width: 1080,
        height: 1920,
        fpsNominal: 30,
        frames: 4,
        crop: null,
        truncatedStart: false,
        lateMs: 0,
        bufferSeconds: 90,
        audioMissing: null,
      },
      files: [
        { name: 'phone-rear.solve.frames.json', bytes: 3, kind: 'frames' },
        { name: 'phone-rear.solve.mp4', bytes: 5, kind: 'mp4' },
      ],
    };
    const folder = `${STAGING_FOLDER}/sessions/${session}/attempts/${String(attempt).padStart(4, '0')}`;
    await r.root.plant(`${folder}/phone-rear.solve.frames.json`, '{}\n');
    await r.root.plant(`${folder}/phone-rear.solve.mp4`, 'video');
    await r.staging.add(clip);
    return clip;
  }

  beforeEach(() => {
    r = rig();
  });

  it('cuts once the window has ended, stages the clip, offers it and sends the frames file then the MP4; deletes it on the host’s word', async () => {
    const host = new Host(r);
    r.clips.join(SESSION);
    r.clips.attach(host.connect());
    await pump(10);
    const cut = cutOf('solve', 1000);
    host.send(cut);
    await pump(1000 + ENCODER_SETTLE_MS - 20);
    expect(r.saves).toHaveLength(0);
    await pump(40);
    expect(r.saves).toHaveLength(1);
    expect(r.saves[0].params).toEqual({
      startHostMs: cut.fromRemoteMs,
      endHostMs: cut.toRemoteMs,
      sessionId: SESSION,
      index: 1,
      camera: 'phone-rear',
      segment: 'solve',
      fpsNominal: 30,
      app: APP_BUILD,
      staging: STAGING_FOLDER,
    });

    const params = r.saves[0].params;
    const { frames, mp4 } = await saveNext(100_000);
    await pump(200);
    expect(r.clips.pending()).toBe(1);
    const done = host.of('cut-done');
    expect(done).toHaveLength(1);
    expect(done[0]).toEqual({
      type: 'cut-done',
      attempt: 1,
      scrambleShown: cut.scrambleShown,
      segment: 'solve',
      files: [
        { name: 'phone-rear.solve.frames.json', bytes: frames.length, kind: 'frames' },
        { name: 'phone-rear.solve.mp4', bytes: 100_000, kind: 'mp4' },
      ],
      clip: {
        codec: 'vp09.00.40.08',
        audio: 'opus',
        width: 1920,
        height: 1080,
        fpsNominal: 30,
        frames: clipFor(params).frames,
        crop: PHONE_CAMERA.crop,
        truncatedStart: false,
        lateMs: 0,
        bufferSeconds: 90,
        audioMissing: null,
      },
    });
    // The frames file first, then the MP4, each whole.
    expect(
      host.completed.map((file) => [file.name, file.kind, file.attempt, file.segment]),
    ).toEqual([
      ['phone-rear.solve.frames.json', 'frames', 1, 'solve'],
      ['phone-rear.solve.mp4', 'mp4', 1, 'solve'],
    ]);
    expect(host.files.get('phone-rear.solve.frames.json')?.text()).toBe(frames);
    expect(host.files.get('phone-rear.solve.mp4')?.text()).toBe(mp4);
    // Staged until the host says so, with its index.
    expect(stagedFiles()).toEqual([
      'index.json',
      `sessions/${SESSION}/attempts/0001/phone-rear.solve.frames.json`,
      `sessions/${SESSION}/attempts/0001/phone-rear.solve.mp4`,
    ]);
    expect(index().map((clip) => [clip.session, clip.attempt, clip.segment, clip.camera])).toEqual([
      [SESSION, 1, 'solve', 'phone-rear'],
    ]);

    host.send({
      type: 'clip-ack',
      attempt: 1,
      scrambleShown: cut.scrambleShown,
      segment: 'solve',
      stored: true,
      reason: '',
    });
    await pump(10);
    await r.clips.whenIdle();
    expect(r.clips.pending()).toBe(0);
    expect(stagedFiles()).toEqual(['index.json']);
    expect(index()).toEqual([]);
  });

  it('cuts a cut asked again once, and replaces the clip of an attempt begun again', async () => {
    const host = new Host(r);
    r.clips.join(SESSION);
    r.clips.attach(host.connect());
    await pump(10);
    const first = cutOf('scramble', 500);
    // Sent again over a new connection before it was answered: one cut.
    host.send(first);
    host.send(first);
    await pump(500 + ENCODER_SETTLE_MS + 10);
    expect(r.saves).toHaveLength(1);
    await saveNext(1000);
    await pump(100);
    expect(r.clips.pending()).toBe(1);
    host.send(first);
    await pump(500 + ENCODER_SETTLE_MS + 10);
    expect(r.saves).toHaveLength(0);

    // The same attempt and segment, of a new scramble: the attempt was begun again.
    const again = cutOf('scramble', 500, first.scrambleShown + 30_000);
    host.send(again);
    await pump(500 + ENCODER_SETTLE_MS + 10);
    expect(r.saves).toHaveLength(1);
    await saveNext(2000);
    await pump(100);
    expect(r.clips.pending()).toBe(1);
    expect(index().map((clip) => clip.scrambleShown)).toEqual([again.scrambleShown]);
    expect(host.of('cut-done').map((done) => done.scrambleShown)).toEqual([
      first.scrambleShown,
      again.scrambleShown,
    ]);
    expect(host.files.get('phone-rear.scramble.mp4')?.received).toBe(2000);
  });

  it('answers cut-failed when the capture cannot cut, and records it', async () => {
    const host = new Host(r);
    r.clips.join(SESSION);
    r.clips.attach(host.connect());
    await pump(10);
    const cut = cutOf('solve', 0);
    host.send(cut);
    await pump(ENCODER_SETTLE_MS + 10);
    r.saves.shift()?.reject(new Error('the phone is not recording'));
    await pump(10);
    expect(host.of('cut-failed')).toEqual([
      {
        type: 'cut-failed',
        attempt: 1,
        scrambleShown: cut.scrambleShown,
        segment: 'solve',
        reason: 'the phone is not recording',
      },
    ]);
    expect(r.clips.pending()).toBe(0);
    expect(r.events).toEqual([
      {
        kind: 'remote.cut',
        data: {
          outcome: 'failed',
          camera: 'phone-rear',
          segment: 'solve',
          reason: 'the phone is not recording',
          delayMs: expect.any(Number) as number,
        },
      },
    ]);
  });

  it('keeps a clip the host has not answered, and sends it again over the next connection, the MP4 resumed from the bytes the host holds', async () => {
    const host = new Host(r);
    r.clips.join(SESSION);
    // 200 kB/s: the MP4 of 300 kB takes 1.5 s.
    const off = r.clips.attach(host.connect({ bytesPerSecond: 200_000 }));
    await pump(10);
    host.send(cutOf('solve', 0));
    await pump(ENCODER_SETTLE_MS + 10);
    const { mp4 } = await saveNext(300_000);
    await pump(600);
    const held = host.files.get('phone-rear.solve.mp4')?.received ?? 0;
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(300_000);
    // The connection drops in the middle of the MP4.
    host.transport?.close('the network went');
    off();
    await pump(100);
    expect(r.clips.pending()).toBe(1);

    r.clips.attach(host.connect());
    await pump(200);
    // Offered again, first thing: the frames file whole again, the MP4 from where it stopped.
    expect(host.of('cut-done')).toHaveLength(2);
    expect(host.completed.map((file) => [file.name, file.resumedFrom])).toEqual([
      ['phone-rear.solve.frames.json', 0],
      ['phone-rear.solve.frames.json', 0],
      ['phone-rear.solve.mp4', held],
    ]);
    expect(host.files.get('phone-rear.solve.mp4')?.text()).toBe(mp4);
    expect(r.clips.pending()).toBe(1);

    host.send({
      type: 'clip-ack',
      attempt: 1,
      scrambleShown: 1_000_000,
      segment: 'solve',
      stored: true,
      reason: '',
    });
    await pump(10);
    await r.clips.whenIdle();
    expect(r.clips.pending()).toBe(0);
    expect(stagedFiles()).toEqual(['index.json']);
  });

  it('offers the clips staged before the page was loaded again first, and deletes one the host does not take', async () => {
    let host = new Host(r);
    r.clips.join(SESSION);
    r.clips.attach(host.connect());
    await pump(10);
    host.send(cutOf('solve', 0));
    await pump(ENCODER_SETTLE_MS + 10);
    // The host takes nothing (it has the clip's MP4 already): the clip waits for its word.
    host.refused.add('phone-rear.solve.mp4');
    await saveNext(1000);
    await pump(100);
    expect(r.clips.pending()).toBe(1);

    // The page is loaded again: the same file system, a new service.
    r = rig({ root: r.root, perf: r.perf });
    r.clips.join(SESSION);
    await pump(10);
    expect(r.clips.pending()).toBe(1);
    host = new Host(r);
    r.clips.attach(host.connect());
    await pump(100);
    expect(host.received.map((message) => message.type).at(0)).toBe('cut-done');
    expect(host.completed.map((file) => file.name)).toEqual([
      'phone-rear.solve.frames.json',
      'phone-rear.solve.mp4',
    ]);

    // The host does not take it: the phone's copy goes all the same.
    host.send({
      type: 'clip-ack',
      attempt: 1,
      scrambleShown: 1_000_000,
      segment: 'solve',
      stored: false,
      reason: 'the attempt is gone',
    });
    await pump(10);
    await r.clips.whenIdle();
    expect(r.clips.pending()).toBe(0);
    expect(stagedFiles()).toEqual(['index.json']);
  });

  it('deletes the clips staged more than a day ago when the page opens, and those of other sessions when it joins one', async () => {
    const now = r.perf.hostMs;
    await stageDirectly(SESSION, now - STAGED_MAX_AGE_MS - 1000, 1);
    const kept = await stageDirectly(SESSION, now - 60_000, 2);
    await stageDirectly(OTHER_SESSION, now - 60_000, 1);
    // A clip a page staged and did not list before it went.
    await r.root.plant(`${STAGING_FOLDER}/sessions/stray/attempts/0001/phone-rear.solve.mp4`, 'x');

    r.clips.start();
    await r.clips.whenIdle();
    expect(index().map((clip) => [clip.session, clip.attempt])).toEqual([
      [SESSION, 2],
      [OTHER_SESSION, 1],
    ]);
    expect(stagedFiles()).toEqual([
      'index.json',
      `sessions/${SESSION}/attempts/0002/phone-rear.solve.frames.json`,
      `sessions/${SESSION}/attempts/0002/phone-rear.solve.mp4`,
      `sessions/${OTHER_SESSION}/attempts/0001/phone-rear.solve.frames.json`,
      `sessions/${OTHER_SESSION}/attempts/0001/phone-rear.solve.mp4`,
    ]);

    r.clips.join(SESSION);
    await r.clips.whenIdle();
    expect(index()).toEqual([kept]);
    expect(r.clips.pending()).toBe(1);
    expect(stagedFiles()).toEqual([
      'index.json',
      `sessions/${SESSION}/attempts/0002/phone-rear.solve.frames.json`,
      `sessions/${SESSION}/attempts/0002/phone-rear.solve.mp4`,
    ]);
  });

  it('bends as the end-to-end suite asks, in a development build: a clock off, a connection cut, cuts ignored', async () => {
    // A connection's clock 5 s ahead of the capture's: the window goes back to the capture's clock,
    // and the frames file's first frame time onto the connection's.
    r = rig({ e2e: { clockOffsetMs: 5000, closeAfterBytes: 70_000 } });
    const host = new Host(r);
    r.clips.join(SESSION);
    const off = r.clips.attach(host.connect({ bytesPerSecond: 1_000_000 }));
    await pump(10);
    const cut = cutOf('solve', 5000 - ENCODER_SETTLE_MS);
    host.send(cut);
    await pump(ENCODER_SETTLE_MS + 10);
    expect(r.saves).toHaveLength(1);
    const params = r.saves[0].params;
    expect([params.startHostMs, params.endHostMs]).toEqual([
      cut.fromRemoteMs - 5000,
      cut.toRemoteMs - 5000,
    ]);
    await saveNext(200_000);
    await pump(1000);
    const sent = JSON.parse(
      host.files.get('phone-rear.solve.frames.json')?.text() ?? '{}',
    ) as FramesJson;
    expect(sent.t0HostMs).toBe(framesOf(params).t0HostMs + 5000);
    // The connection was cut once, in the middle of the MP4: after the two chunks before 70 kB had
    // reached the host.
    expect(host.transport?.state).toBe('closed');
    const held = host.files.get('phone-rear.solve.mp4');
    expect(held?.received).toBe(2 * 65_536);
    expect(held?.done).toBe(false);
    off();
    r.clips.attach(host.connect({ bytesPerSecond: 1_000_000 }));
    await pump(1000);
    expect(host.completed.at(-1)).toMatchObject({
      name: 'phone-rear.solve.mp4',
      resumedFrom: 2 * 65_536,
    });
    expect(host.transport?.state).toBe('open');

    r = rig({ e2e: { ignoreCuts: true } });
    const silent = new Host(r);
    r.clips.join(SESSION);
    r.clips.attach(silent.connect());
    await pump(10);
    silent.send(cutOf('solve', 0));
    await pump(ENCODER_SETTLE_MS + 1000);
    expect(r.saves).toHaveLength(0);
    expect(silent.received).toEqual([]);
  });
});
