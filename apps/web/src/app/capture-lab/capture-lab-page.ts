import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import {
  captureSupport,
  startCapture,
  type CaptureHandle,
  type CaptureStats,
} from '@cubetrace/capture';

import { BROWSER_GLOBALS, hostNow, type BrowserGlobals } from '../device/browser-globals';
import { errorMessage } from '../shared/error-message';
import { summarizeCut, type CutSummary } from './cut-summary';

/** The counters kept for the JSON: the last two minutes. */
const STATS_KEPT = 120;

interface CameraOption {
  readonly deviceId: string;
  readonly label: string;
}

/**
 * `/capture-lab`: the capture pipeline (docs/PLAN.md, T2.2) on its own, for development and the
 * owner's rounds on the real devices. It encodes the chosen camera into the in-memory ring buffer,
 * shows the pipeline's counters once per second and cuts the last seconds, printing what came out
 * as JSON (with the frame times docs/DEVICES.md measures `VideoFrame.timestamp` from). Nothing is
 * saved. Not in the navigation: it is reached by its address, like a tool.
 */
@Component({
  selector: 'app-capture-lab-page',
  templateUrl: './capture-lab-page.html',
  styleUrl: './capture-lab-page.scss',
})
export class CaptureLabPage {
  private readonly globals = inject(BROWSER_GLOBALS);
  private handle: CaptureHandle | undefined;
  private stream: MediaStream | undefined;

  /** The browser APIs the pipeline needs that this browser lacks, as a sentence; '' in Chrome. */
  protected readonly missing = missingApis(this.globals);
  protected readonly cameras = signal<readonly CameraOption[]>([]);
  protected readonly selectedCamera = signal('');
  protected readonly audio = signal(true);
  protected readonly seconds = signal(3);
  protected readonly running = signal(false);
  protected readonly busy = signal(false);
  protected readonly status = signal('Not started.');
  protected readonly errors = signal<readonly string[]>([]);
  protected readonly stats = signal<readonly CaptureStats[]>([]);
  protected readonly counters = computed(() => counterRows(this.stats().at(-1)));
  protected readonly statsJson = computed(() => JSON.stringify(this.stats()));
  protected readonly lastCut = signal<CutSummary | undefined>(undefined);
  protected readonly cutJson = computed(() => {
    const cut = this.lastCut();
    return cut === undefined ? '' : JSON.stringify(cut, null, 2);
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      void this.release();
    });
  }

  protected start(): void {
    void this.startCapture();
  }

  protected stop(): void {
    void this.stopCapture();
  }

  protected cut(): void {
    void this.cutLastSeconds();
  }

  protected setSeconds(text: string): void {
    const value = Number(text);
    if (Number.isFinite(value) && value > 0) {
      this.seconds.set(Math.min(value, 90));
    }
  }

  private async startCapture(): Promise<void> {
    const mediaDevices = this.globals.navigator?.mediaDevices;
    if (mediaDevices === undefined || this.missing !== '') {
      return;
    }
    this.busy.set(true);
    this.status.set('Opening the camera…');
    this.errors.set([]);
    this.stats.set([]);
    this.lastCut.set(undefined);
    try {
      const deviceId = this.selectedCamera();
      const stream = await mediaDevices.getUserMedia({
        // As the camera panel opens it (docs/PLAN.md, T2.1): 1080p at up to 60 fps.
        video: {
          ...(deviceId === '' ? {} : { deviceId: { exact: deviceId } }),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 60 },
        },
        audio: this.audio(),
      });
      this.stream = stream;
      const handle = startCapture(stream, { audio: this.audio() });
      this.handle = handle;
      handle.onStats((stats) => {
        this.stats.update((all) => [...all, stats].slice(-STATS_KEPT));
      });
      handle.onError((error) => {
        this.errors.update((all) => [...all, error.message]);
        if (error.fatal) {
          this.status.set(`Recording stopped: ${error.message}`);
        }
      });
      const track = stream.getVideoTracks().at(0);
      const settings = track?.getSettings() ?? {};
      this.running.set(true);
      this.status.set(
        `Recording ${track?.label ?? 'the camera'}: ${String(settings.width)}×` +
          `${String(settings.height)} at ${String(settings.frameRate)} fps (the track's settings).`,
      );
      await this.listCameras(mediaDevices, settings.deviceId);
    } catch (error: unknown) {
      this.status.set(`Could not start: ${errorMessage(error)}`);
      await this.release();
    } finally {
      this.busy.set(false);
    }
  }

  private async stopCapture(): Promise<void> {
    this.busy.set(true);
    await this.release();
    this.status.set('Stopped.');
    this.busy.set(false);
  }

  private async cutLastSeconds(): Promise<void> {
    const handle = this.handle;
    if (handle === undefined) {
      return;
    }
    const endHostMs = hostNow(this.globals);
    const startHostMs = endHostMs - this.seconds() * 1000;
    try {
      const cut = await handle.cut(startHostMs, endHostMs);
      const latencyMs = hostNow(this.globals) - endHostMs;
      const summary = summarizeCut(cut, {
        startHostMs,
        endHostMs,
        latencyMs,
        timeOrigin: this.globals.performance?.timeOrigin ?? 0,
      });
      this.lastCut.set(summary);
      this.status.set(
        `Cut ${String(summary.video.chunks)} frames (${String(summary.video.durationMs)} ms of ` +
          `video) in ${String(summary.latencyMs)} ms.`,
      );
    } catch (error: unknown) {
      this.status.set(`The cut failed: ${errorMessage(error)}`);
    }
  }

  private async listCameras(mediaDevices: MediaDevices, current: string | undefined) {
    const devices = await mediaDevices.enumerateDevices();
    const cameras = devices
      .filter((device) => device.kind === 'videoinput')
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label === '' ? `Camera ${String(index + 1)}` : device.label,
      }));
    this.cameras.set(cameras);
    if (current !== undefined && cameras.some((camera) => camera.deviceId === current)) {
      this.selectedCamera.set(current);
    }
  }

  /** Stops the pipeline and the camera. */
  private async release(): Promise<void> {
    const handle = this.handle;
    const stream = this.stream;
    this.handle = undefined;
    this.stream = undefined;
    this.running.set(false);
    await handle?.stop();
    for (const track of stream?.getTracks() ?? []) {
      track.stop();
    }
  }
}

/** The latest counters as the table's rows; dashes before the first second. */
function counterRows(
  stats: CaptureStats | undefined,
): { label: string; testId: string; value: string }[] {
  const value = (key: keyof CaptureStats): string => {
    const found = stats?.[key];
    return found === undefined ? '–' : found === null ? 'none' : String(found);
  };
  return [
    { label: 'Frames arrived per second', testId: 'lab-fps', value: value('fps') },
    { label: 'Frames encoded per second', testId: 'lab-encoded-fps', value: value('encodedFps') },
    {
      label: 'Frames dropped (encoder queue over 8)',
      testId: 'lab-dropped',
      value: value('dropped'),
    },
    { label: 'Encoder queue', testId: 'lab-queue', value: value('queue') },
    { label: 'Buffer, seconds', testId: 'lab-buffer-seconds', value: value('bufferSeconds') },
    { label: 'Buffer, bytes', testId: 'lab-buffer-bytes', value: value('bufferBytes') },
    { label: 'Video codec', testId: 'lab-codec', value: value('codec') },
    { label: 'Audio codec', testId: 'lab-audio-codec', value: value('audioCodec') },
  ];
}

/** "MediaStreamTrackProcessor, VideoEncoder and camera access", or '' when nothing is missing. */
function missingApis(globals: BrowserGlobals): string {
  const missing = [...captureSupport(globals).missing];
  if (typeof globals.navigator?.mediaDevices?.getUserMedia !== 'function') {
    missing.push('camera access (navigator.mediaDevices)');
  }
  return missing.length < 2
    ? missing.join('')
    : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1) ?? ''}`;
}
