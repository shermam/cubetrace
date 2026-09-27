import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import {
  attemptPath,
  captureSupport,
  startCapture,
  type CaptureHandle,
  type CaptureStats,
} from '@cubetrace/capture';
import type { FramesJson, VideoClip } from '@cubetrace/core';

import { BROWSER_GLOBALS, hostNow, type BrowserGlobals } from '../device/browser-globals';
import { errorMessage } from '../shared/error-message';
import { summarizeCut, type CutSummary } from './cut-summary';

/** The counters kept for the JSON: the last two minutes. */
const STATS_KEPT = 120;

/**
 * Where "Mux and save" writes its clip: attempt 1 of a scratch session folder, `capture-lab`,
 * which has no session.json, so the Sessions page and the session store leave it alone. Every save
 * replaces the clip there.
 */
const LAB_SESSION = 'capture-lab';
const LAB_ATTEMPT = 1;
const LAB_CAMERA = 'lab';

/** The clip the lab saved last, read back from the origin private file system. */
export interface SavedClip {
  /** The clip's `video[]` entry, as `saveClip` returned it. */
  readonly clip: VideoClip;
  /** The attempt's folder, from the file system's root. */
  readonly folder: string;
  /** The files in that folder after the save. */
  readonly files: readonly { readonly name: string; readonly bytes: number }[];
  /** Its frames.json, summed up. */
  readonly frames: {
    readonly count: number;
    readonly t0HostMs: number;
    /** From the first frame to the end of the last (the median interval), ms. */
    readonly durationMs: number;
    readonly keyframes: readonly number[];
  };
  /** From the request to the answer, ms: cutting, then muxing and writing in the clip worker. */
  readonly latencyMs: number;
}

/** What the `<video>` said once it had the clip's metadata. */
interface ClipMetadata {
  readonly durationS: number;
  readonly width: number;
  readonly height: number;
}

interface CameraOption {
  readonly deviceId: string;
  readonly label: string;
}

/**
 * `/capture-lab`: the capture pipeline (docs/PLAN.md, T2.2) on its own, for development and the
 * owner's rounds on the real devices. It encodes the chosen camera into the in-memory ring buffer,
 * shows the pipeline's counters once per second and cuts the last seconds, printing what came out
 * as JSON (with the frame times docs/DEVICES.md measures `VideoFrame.timestamp` from). "Mux and
 * save" (T2.3) has the workers cut the last seconds, mux them into an MP4 and write it with its
 * frames.json into a scratch folder of the origin private file system, and plays it back from
 * there. Not in the navigation: it is reached by its address, like a tool.
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
  /** The video track's frame rate setting: the saved clip's `fpsNominal`. */
  private frameRate = 30;

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
  protected readonly saving = signal(false);
  protected readonly saved = signal<SavedClip | undefined>(undefined);
  protected readonly savedJson = computed(() => {
    const saved = this.saved();
    return saved === undefined ? '' : JSON.stringify(saved, null, 2);
  });
  /** An object URL of the saved MP4, read back from the file system, for the `<video>`. */
  protected readonly clipUrl = signal<string | undefined>(undefined);
  protected readonly clipMetadata = signal<ClipMetadata | undefined>(undefined);
  /** One text, not several interpolations: they would add Angular's code for them to `main`. */
  protected readonly clipMetadataText = computed(() => {
    const metadata = this.clipMetadata();
    const saved = this.saved();
    if (metadata === undefined || saved === undefined) {
      return 'Loading the MP4…';
    }
    return (
      `The video element reads ${String(metadata.durationS)} s at ${String(metadata.width)}×` +
      `${String(metadata.height)}; the frames file says ${String(saved.frames.count)} frames ` +
      `over ${String(saved.frames.durationMs)} ms.`
    );
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      void this.release();
      this.setClipUrl(undefined);
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

  protected save(): void {
    void this.saveLastSeconds();
  }

  protected onClipMetadata(video: HTMLVideoElement): void {
    this.clipMetadata.set({
      durationS: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
    });
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
      this.frameRate = settings.frameRate ?? 30;
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

  /**
   * Has the workers cut, mux and write the last seconds as the solve clip of attempt 1 of the lab's
   * scratch folder (`LAB_SESSION`), then reads the files back: their names and sizes, the frames
   * file, and the MP4 as an object URL for the `<video>`.
   */
  private async saveLastSeconds(): Promise<void> {
    const handle = this.handle;
    const storage = this.globals.navigator?.storage;
    if (handle === undefined) {
      return;
    }
    if (typeof storage?.getDirectory !== 'function') {
      this.status.set('The clip was not saved: this browser has no origin private file system.');
      return;
    }
    this.saving.set(true);
    try {
      const root = await storage.getDirectory();
      const [sessionsName, sessionName, ...attemptNames] = attemptPath(LAB_SESSION, LAB_ATTEMPT);
      // saveClip writes only into the folder of a session that exists.
      const sessions = await root.getDirectoryHandle(sessionsName, { create: true });
      const session = await sessions.getDirectoryHandle(sessionName, { create: true });
      const endHostMs = hostNow(this.globals);
      const clip = await handle.saveClip({
        startHostMs: endHostMs - this.seconds() * 1000,
        endHostMs,
        sessionId: LAB_SESSION,
        index: LAB_ATTEMPT,
        camera: LAB_CAMERA,
        segment: 'solve',
        fpsNominal: this.frameRate,
      });
      const latencyMs = hostNow(this.globals) - endHostMs;
      let folder = session;
      for (const name of attemptNames) {
        folder = await folder.getDirectoryHandle(name);
      }
      const files: { name: string; bytes: number }[] = [];
      for await (const entry of folder.values()) {
        if (entry.kind === 'file') {
          files.push({ name: entry.name, bytes: (await entry.getFile()).size });
        }
      }
      const frames = JSON.parse(
        await (await (await folder.getFileHandle(clip.framesFile)).getFile()).text(),
      ) as FramesJson;
      const mp4 = await (await folder.getFileHandle(clip.file)).getFile();
      this.clipMetadata.set(undefined);
      this.setClipUrl(this.globals.URL?.createObjectURL(mp4));
      this.saved.set({
        clip,
        folder: attemptPath(LAB_SESSION, LAB_ATTEMPT).join('/'),
        files: files.sort((p, q) => p.name.localeCompare(q.name)),
        frames: {
          count: frames.dtMs.length,
          t0HostMs: frames.t0HostMs,
          durationMs: round(framesDurationMs(frames.dtMs), 1),
          keyframes: frames.keyframes,
        },
        latencyMs: round(latencyMs, 1),
      });
      this.status.set(
        `Saved ${clip.file}: ${String(clip.frames)} frames, ${String(clip.bytes)} bytes, in ` +
          `${String(round(latencyMs, 1))} ms.`,
      );
    } catch (error: unknown) {
      this.status.set(`The clip was not saved: ${errorMessage(error)}`);
    } finally {
      this.saving.set(false);
    }
  }

  /** Shows `url` in the `<video>`, letting go of the previous clip's. */
  private setClipUrl(url: string | undefined): void {
    const previous = this.clipUrl();
    if (previous !== undefined) {
      this.globals.URL?.revokeObjectURL(previous);
    }
    this.clipUrl.set(url);
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

/**
 * A clip's length from its frame intervals: from the first frame to the last, plus the median
 * interval for the last frame's own duration (frames.json does not keep it).
 */
function framesDurationMs(dtMs: readonly number[]): number {
  const intervals = dtMs.slice(1);
  const sorted = [...intervals].sort((a, b) => a - b);
  const last = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)];
  return intervals.reduce((sum, dt) => sum + dt, 0) + last;
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
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
