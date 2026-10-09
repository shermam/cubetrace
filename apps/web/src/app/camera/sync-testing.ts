// Helpers for the unit tests of the sync check (T2.5): the timer with the fake cube on a fake clock
// (session-harness.ts), a fake camera and a fake pipeline (recording-testing.ts), and a camera
// whose frames' motion and the cube's turns the test films. Nothing in the app imports this file,
// so it is not in the bundle.
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ClapperboardFrame, MotionMeterInfo, MotionSample } from '@cubetrace/capture';
import type { RemoteClockRecord } from '@cubetrace/core';
import type { FakeCube } from '@cubetrace/gan';

import { bluetoothNavigator } from '../cube/cube-testing';
import { FAKE_WEBCAM, FakeMediaDevices, settle, type FakeCamera } from '../device/fake-browser';
import { ready, setup, turn, type Setup } from '../session/session-harness';
import { CameraService } from './camera-service';
import { CAPTURE_STARTER, RecordingService } from './recording-service';
import { FakeCaptureStarter, statsOf, type FakeCapture } from './recording-testing';
import type { RemoteCameraEntry, RemoteCameraSource } from './remote-camera-registry';
import { SyncService } from './sync-service';

/** The camera's frames: 30 per second, their timestamps this far behind their arrival (ms). */
export const FRAME_MS = 1000 / 30;
const TIMESTAMP_OFFSET_MS = 1_789_000_000_000;

export interface Rig {
  readonly s: Setup;
  readonly starter: FakeCaptureStarter;
  readonly sync: SyncService;
  readonly recording: RecordingService;
  readonly camera: CameraService;
}

/** The timer, the recording and the sync check, with these cameras (the first one is chosen). */
export function rig(cameras: readonly FakeCamera[] = [FAKE_WEBCAM]): Rig {
  const media = new FakeMediaDevices(cameras);
  const starter = new FakeCaptureStarter();
  const s = setup({
    navigator: { ...bluetoothNavigator(true), mediaDevices: media },
    providers: [{ provide: CAPTURE_STARTER, useValue: starter }],
  });
  return {
    s,
    starter,
    sync: TestBed.inject(SyncService),
    recording: TestBed.inject(RecordingService),
    camera: TestBed.inject(CameraService),
  };
}

/** Runs the effects and lets the starts and stops they ask for finish. */
export async function update(r: Rig): Promise<void> {
  TestBed.tick();
  await r.recording.settled();
  await settle();
  TestBed.tick();
}

/** A framing rectangle around the cube: a quarter of the fake camera's 1920 × 1080 frames. */
export const AROUND_THE_CUBE = { x: 720, y: 270, w: 960, h: 540 };

/**
 * The camera on (the framing rectangle around the cube unless `framed` is false: the whole frame,
 * the default), a cube connected (a session begins), the pipeline recording.
 */
export async function recording(
  r: Rig,
  options: { readonly framed?: boolean } = {},
): Promise<{ fake: FakeCube; capture: FakeCapture }> {
  await r.camera.start();
  if (options.framed !== false) {
    r.camera.setFraming(AROUND_THE_CUBE);
  }
  const fake = await ready(r.s);
  await update(r);
  const capture = r.starter.last;
  capture.emitStats(statsOf(5));
  await update(r);
  return { fake, capture };
}

/** How many turns each fake cube has made for the check: the next one turns U, or turns it back. */
const turned = new WeakMap<FakeCube, number>();

/** A still picture's changed area: 3 pixels in 10,000. */
export const STILL = (): number => 0.0003;

/**
 * The camera's frames for `ms` from now, one every 33.3 ms on the fake clock, sent to the motion
 * watch under way with their changed area `energy(frame time)` (and a mean difference in proportion);
 * the cube turns at those of `turns` (host ms) that come in that time, in their place among the
 * frames, as the check asks: U, then back (U'), and again. The timers due on the way run (the
 * check's ticks, the timer's wait after it).
 */
export async function film(
  r: Rig,
  capture: FakeCapture,
  fake: FakeCube,
  ms: number,
  energy: (hostMs: number) => number,
  turns: readonly number[] = [],
): Promise<void> {
  await filmTo(
    r,
    (sample) => {
      capture.watches.at(-1)?.onSample(sample);
    },
    fake,
    ms,
    energy,
    turns,
  );
}

/**
 * {@link film} into `sink`: a remote camera's watch (T4.3), whose frames come with when the phone's
 * page received them (`receivedHostMs`, 2 ms after their arrival, on the host clock).
 */
export async function filmTo(
  r: Rig,
  sink: (sample: ClapperboardFrame) => void,
  fake: FakeCube,
  ms: number,
  energy: (hostMs: number) => number,
  turns: readonly number[] = [],
  received = false,
): Promise<void> {
  const start = r.s.perf.hostMs;
  const end = start + ms;
  // The turns of this stretch of time: those before it were filmed already.
  const pending = turns.filter((at) => at > start).sort((a, b) => a - b);
  for (let frame = 1; start + frame * FRAME_MS <= end + 0.001;) {
    const next = start + frame * FRAME_MS;
    const turnAt = pending[0] as number | undefined;
    if (turnAt !== undefined && turnAt <= next) {
      r.s.timers.advance(turnAt - r.s.perf.hostMs);
      const count = turned.get(fake) ?? 0;
      turned.set(fake, count + 1);
      turn(r.s, fake, count % 2 === 0 ? 'U' : "U'", 0);
      pending.shift();
      continue;
    }
    r.s.timers.advance(next - r.s.perf.hostMs);
    const changed = energy(next);
    const sample: MotionSample = {
      timestampUs: (next - TIMESTAMP_OFFSET_MS) * 1000,
      arrivalHostMs: next,
      mean: Math.round(changed * 400 * 1000) / 1000,
      changed,
      costMs: 0.9,
    };
    sink(received ? { ...sample, receivedHostMs: next + 2 } : sample);
    frame += 1;
  }
  r.s.timers.advance(end - r.s.perf.hostMs);
  await update(r);
}

/** A turn's motion, the changed area of the frames from two before its middle to two after. */
const TURN = [0.01, 0.02, 0.03, 0.02, 0.01];

/**
 * One turn per lag, `everyMs` apart from `start` (1.2 s, a whole number of frames), each lagged by
 * its lag (ms) in the frames: a turn at a frame's time minus its lag, so that its motion (1 to 3% of
 * the pixels changed, over five frames, rising to that frame and falling as it rose) has its middle,
 * the check's event (T2.11), on that frame. `events` are those frames' times.
 */
export function clapperboard(start: number, lags: readonly number[], everyMs = FRAME_MS * 36) {
  const events = lags.map((_, k) => start + everyMs * (k + 1));
  const turns = events.map((event, k) => event - lags[k]);
  const energy = (hostMs: number): number => {
    for (const event of events) {
      const frame = Math.round((hostMs - event) / FRAME_MS);
      if (Math.abs(frame) <= 2 && Math.abs(hostMs - event - frame * FRAME_MS) < 1) {
        return TURN[frame + 2];
      }
    }
    return STILL();
  };
  return { turns, energy, events };
}

// ---- A remote camera (T4.3) ----

/** The phone's clock sync, as RemoteCamerasService records it before any check. */
export const REMOTE_CLOCK: RemoteClockRecord = {
  offsetMs: -2400.5,
  driftPpm: 3.1,
  rttMs: 7.5,
  samples: 12,
  residualP95Ms: 1.2,
  since: 1_790_000_000_000,
  converged: true,
};

/** A watch of a phone's motion: its handlers, and whether it was stopped. */
export interface RemoteWatch {
  readonly id: string;
  readonly onSample: (sample: ClapperboardFrame) => void;
  readonly onError: (message: string) => void;
  readonly onMeter: (meter: MotionMeterInfo) => void;
  stopped: boolean;
}

/** The Cameras section's side of the registry, as the test drives it. */
export class FakeRemoteSource implements RemoteCameraSource {
  readonly cameras = signal<readonly RemoteCameraEntry[]>([]);
  readonly watches: RemoteWatch[] = [];
  clock: RemoteClockRecord | null = { ...REMOTE_CLOCK, offsetMs: -2401, converged: false };

  watchMotion(
    id: string,
    onSample: (sample: ClapperboardFrame) => void,
    onError: (message: string) => void,
    onMeter: (meter: MotionMeterInfo) => void,
  ): (() => void) | null {
    const camera = this.cameras().find((c) => c.id === id);
    if (camera?.state !== 'connected') {
      return null;
    }
    const watch: RemoteWatch = { id, onSample, onError, onMeter, stopped: false };
    this.watches.push(watch);
    return () => {
      watch.stopped = true;
    };
  }

  clockRecord(): RemoteClockRecord | null {
    return this.clock;
  }

  /** The cameras whose drift was reset (T5.2), in order. */
  readonly resets: string[] = [];

  resetDrift(id: string): void {
    this.resets.push(id);
  }

  /** The frames of the check under way go to its watch. */
  readonly sink = (sample: ClapperboardFrame): void => {
    this.watches.at(-1)?.onSample(sample);
  };

  /** Changes the phone's entry. */
  change(changes: Partial<RemoteCameraEntry>): void {
    this.cameras.update((cameras) => cameras.map((camera) => ({ ...camera, ...changes })));
  }
}

/** The phone, connected to `session` (the one under way), its framing around the cube. */
export function remotePhone(
  session: string,
  changes: Partial<RemoteCameraEntry> = {},
): RemoteCameraEntry {
  return {
    id: 'peer-1',
    name: 'ThinkPhone',
    label: 'phone-rear',
    session,
    state: 'connected',
    sinceMs: 0,
    synced: true,
    converged: false,
    recording: true,
    framing: { x: 140, y: 610, w: 800, h: 700 },
    frame: { width: 1080, height: 1920 },
    deviceLabel: 'camera 0, facing back',
    preview: null,
    thumbnail: null,
    report: null,
    reportMs: null,
    drift: [],
    ...changes,
  };
}
