// Helpers for the unit tests of the sync check (T2.5): the timer with the fake cube on a fake clock
// (session-harness.ts), a fake camera and a fake pipeline (recording-testing.ts), and a camera
// whose frames' motion and the cube's turns the test films. Nothing in the app imports this file,
// so it is not in the bundle.
import { TestBed } from '@angular/core/testing';
import type { MotionSample } from '@cubetrace/capture';
import type { FakeCube } from '@cubetrace/gan';

import { bluetoothNavigator } from '../cube/cube-testing';
import { FAKE_WEBCAM, FakeMediaDevices, settle } from '../device/fake-browser';
import { ready, setup, turn, type Setup } from '../session/session-harness';
import { CameraService } from './camera-service';
import { CAPTURE_STARTER, RecordingService } from './recording-service';
import { FakeCaptureStarter, statsOf, type FakeCapture } from './recording-testing';
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

export function rig(): Rig {
  const media = new FakeMediaDevices([FAKE_WEBCAM]);
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

/** The camera on, a cube connected (a session begins), the pipeline recording. */
export async function recording(r: Rig): Promise<{ fake: FakeCube; capture: FakeCapture }> {
  await r.camera.start();
  const fake = await ready(r.s);
  await update(r);
  const capture = r.starter.last;
  capture.emitStats(statsOf(5));
  await update(r);
  return { fake, capture };
}

/** How many turns each fake cube has made for the check: the next one turns U, or turns it back. */
const turned = new WeakMap<FakeCube, number>();

/**
 * The camera's frames for `ms` from now, one every 33.3 ms on the fake clock, sent to the motion
 * watch under way with `energy(frame time)`; the cube turns at those of `turns` (host ms) that come
 * in that time, in their place among the frames, as the check asks: U, then back (U'), and again.
 * The timers due on the way run (the check's ticks).
 */
export async function film(
  r: Rig,
  capture: FakeCapture,
  fake: FakeCube,
  ms: number,
  energy: (hostMs: number) => number,
  turns: readonly number[] = [],
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
    const sample: MotionSample = {
      timestampUs: (next - TIMESTAMP_OFFSET_MS) * 1000,
      arrivalHostMs: next,
      energy: energy(next),
      costMs: 0.9,
    };
    capture.watches.at(-1)?.onSample(sample);
    frame += 1;
  }
  r.s.timers.advance(end - r.s.perf.hostMs);
  await update(r);
}

/**
 * One turn per lag, 1.2 s apart from `start`, each lagged by its lag (ms) in the frames: a turn at a
 * frame's time minus its lag, so that its motion begins on that frame.
 */
export function clapperboard(start: number, lags: readonly number[]) {
  const onsets = lags.map((_, k) => start + FRAME_MS * 36 * (k + 1));
  const turns = onsets.map((onset, k) => onset - lags[k]);
  const energy = (hostMs: number): number =>
    onsets.some((onset) => hostMs >= onset - 1 && hostMs < onset + 150) ? 12 : 1;
  return { turns, energy, onsets };
}
