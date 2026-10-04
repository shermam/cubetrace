import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import type { MotionMeterInfo, MotionSample } from '@cubetrace/capture';
import {
  MAX_MOTION_FRAMES,
  type MessageLink,
  type MotionReport,
  type SyncMeter,
} from '@cubetrace/rtc';

import { CameraService } from '../camera/camera-service';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { e2eRemote } from '../rtc/e2e-remote';
import { RTC_TIMERS } from '../rtc/rtc-timers';
import { CameraDeviceCapture } from './camera-device-capture';

/** How often the phone sends the motion it measured for the host's sync check (`sync-motion`), ms. */
export const MOTION_BATCH_MS = 250;

/**
 * A check measures for this long at most without the host's `sync-stop`, ms: the host's check asks
 * for ten turns after 20 s at most for the first, so a page that never says stop (gone, or another
 * build) does not keep the phone measuring.
 */
export const SYNC_MAX_MS = 5 * 60_000;

/** The check under way: its id, its connection, the stop of the capture's watch, what is to send. */
interface Run {
  readonly id: number;
  readonly link: MessageLink;
  readonly stop: () => void;
  readonly startedMs: number;
  frames: MotionReport[];
  timer: unknown;
}

/**
 * The host's sync check of this phone's camera (docs/PLAN.md T4.3, docs/RTC.md §10): on `sync-start`
 * the phone measures the motion of each of its frames inside its framing rectangle, through its
 * capture worker (`CameraDeviceCapture.watchMotion`, the measure of the host's own check: the changed
 * area of a 160- or 320-pixel luma plane), and sends it to the host in batches four times a second
 * (`sync-motion`: each frame's own timestamp, its arrival in the worker and its reception by the page
 * on this phone's clock, its two measures and their cost), with how the worker reads the frames
 * (`sync-meter`), until `sync-stop`, the connection's end or {@link SYNC_MAX_MS}. The host places the
 * times on its own clock with the clock sync and matches the motion against the cube's turns: the
 * analysis is the host's, the phone only measures. A phone that cannot measure (not recording, its
 * frames unreadable) says so (`sync-error`), which ends the host's check, and so does a recording
 * that stops during a check (the camera off or changed: its frames are another camera's, or none).
 * `active` says a check is under way, for the Camera page.
 */
@Injectable({ providedIn: 'root' })
export class CameraDeviceSync {
  private readonly capture = inject(CameraDeviceCapture);
  private readonly camera = inject(CameraService);
  private readonly timers = inject(RTC_TIMERS);
  /** The end-to-end suite's settings, in a development build (`E2eRemote`). */
  private readonly hooks = e2eRemote(inject(BROWSER_GLOBALS));

  private readonly activeSignal = signal(false);
  /** The host's sync check measures this camera now. */
  readonly active = this.activeSignal.asReadonly();

  private run: Run | null = null;

  constructor() {
    // The recording stops during a check: the pipeline's watch ends without a word, so the host is
    // told here, at once, rather than seeing its frames stop.
    effect(() => {
      const recording = this.capture.status() === 'recording';
      untracked(() => {
        const run = this.run;
        if (!recording && run !== null) {
          this.stop();
          run.link.trySend({
            type: 'sync-error',
            id: run.id,
            message: 'the phone stopped recording',
          });
        }
      });
    });
  }

  /** A connection with the host is open: its checks are measured. Returns what stops listening. */
  attach(link: MessageLink): () => void {
    const offs = [
      link.on('sync-start', (message) => {
        this.start(link, message.id);
      }),
      link.on('sync-stop', (message) => {
        if (this.run?.link === link && this.run.id === message.id) {
          this.stop();
        }
      }),
    ];
    return () => {
      for (const off of offs) {
        off();
      }
      if (this.run?.link === link) {
        this.stop();
      }
    };
  }

  private start(link: MessageLink, id: number): void {
    this.stop();
    // The end-to-end suite's phone runs its connection's clock ahead of its capture's (RTC_TIMERS):
    // the frames' arrivals are put on the connection's clock, as its clips' times are.
    const offsetMs = this.hooks.clockOffsetMs ?? 0;
    const frames: MotionReport[] = [];
    const stop = this.capture.watchMotion(
      this.camera.framing(),
      (sample) => {
        frames.push(report(sample, offsetMs, this.timers.now()));
      },
      (message) => {
        if (this.run?.id === id && this.run.link === link) {
          this.stop();
          link.trySend({ type: 'sync-error', id, message });
        }
      },
      (meter) => {
        link.trySend({ type: 'sync-meter', id, meter: meterOf(meter) });
      },
    );
    if (stop === null) {
      link.trySend({ type: 'sync-error', id, message: 'the phone is not recording' });
      return;
    }
    this.run = { id, link, stop, startedMs: this.timers.now(), frames, timer: null };
    this.activeSignal.set(true);
    this.schedule();
  }

  private schedule(): void {
    const run = this.run;
    if (run === null) {
      return;
    }
    run.timer = this.timers.setTimeout(() => {
      run.timer = null;
      if (this.run !== run) {
        return;
      }
      this.flush(run);
      if (this.timers.now() - run.startedMs >= SYNC_MAX_MS) {
        this.stop();
      } else {
        this.schedule();
      }
    }, MOTION_BATCH_MS);
  }

  /** Sends what was measured since the last batch, in batches the protocol takes. */
  private flush(run: Run): void {
    while (run.frames.length > 0) {
      const frames = run.frames.splice(0, MAX_MOTION_FRAMES);
      run.link.trySend({ type: 'sync-motion', id: run.id, frames });
    }
  }

  private stop(): void {
    const run = this.run;
    if (run === null) {
      return;
    }
    this.run = null;
    run.stop();
    if (run.timer !== null) {
      this.timers.clearTimeout(run.timer);
    }
    this.flush(run);
    this.activeSignal.set(false);
  }
}

/** A frame's motion as `sync-motion` carries it: its times on the connection's clock. */
function report(sample: MotionSample, offsetMs: number, receivedMs: number): MotionReport {
  return {
    timestampUs: sample.timestampUs,
    arrivalMs: sample.arrivalHostMs + offsetMs,
    receivedMs,
    mean: Math.min(255, Math.max(0, sample.mean)),
    changed: Math.min(1, Math.max(0, sample.changed)),
    costMs: Math.max(0, sample.costMs),
  };
}

/** How the capture worker reads the frames, as `sync-meter` carries it: whole pixels. */
function meterOf(meter: MotionMeterInfo): SyncMeter['meter'] {
  const whole = (value: number, least: number): number => Math.max(least, Math.round(value));
  return {
    format: meter.format,
    path: meter.path,
    frameWidth: whole(meter.frameWidth, 1),
    frameHeight: whole(meter.frameHeight, 1),
    region: {
      x: whole(meter.region.x, 0),
      y: whole(meter.region.y, 0),
      w: whole(meter.region.w, 1),
      h: whole(meter.region.h, 1),
    },
    planeWidth: whole(meter.planeWidth, 1),
    planeHeight: whole(meter.planeHeight, 1),
    changeLevels: meter.changeLevels,
  };
}
