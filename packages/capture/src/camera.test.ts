/// <reference types="node" />
// Node's types for this file only: it reads the owner's probe reports (docs/devices/) with node:fs.
import { readFileSync } from 'node:fs';
import { SESSION_SCHEMA } from '@cubetrace/core';
import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, it, vi } from 'vitest';

import type { CameraChoice, ControlValues, JsonObject } from './index';
import {
  FrameRateMeter,
  applyControls,
  autoModeOf,
  buildConstraints,
  cameraInfo,
  cameraLabel,
  controlConstraints,
  controlValuesOf,
  controlsOf,
  facingFromLabel,
  facingOf,
  fallbackChoice,
  fitControls,
  hasControls,
  snapToRange,
  snapshot,
  watchFrames,
} from './index';

/** A probe report of docs/devices/ (T1.8's `/probe`): the camera's raw capabilities and settings. */
interface Probe {
  readonly camera: { readonly trackLabel: string };
  readonly capabilities: JsonObject;
  readonly settings: JsonObject;
}

function probe(name: string): Probe {
  return JSON.parse(
    readFileSync(new URL(`../../../docs/devices/${name}.json`, import.meta.url), 'utf8'),
  ) as Probe;
}

const MACBOOK = probe('2026-09-27-macbook-pro-2021-facetime');
const PHONE_FRONT = probe('2026-09-27-thinkphone-front');
const PHONE_REAR = probe('2026-09-27-thinkphone-rear');

/** A track that reports what a probed camera reported (the probes have redacted ids). */
function trackOf(report: Probe): {
  label: string;
  getSettings(): MediaTrackSettings;
  getCapabilities(): MediaTrackCapabilities;
} {
  return {
    label: report.camera.trackLabel,
    getSettings: () => structuredClone(report.settings),
    getCapabilities: () => structuredClone(report.capabilities),
  };
}

describe('buildConstraints', () => {
  it('asks the chosen camera for 1920 × 1080, ideally at 60 fps, without audio', () => {
    expect(buildConstraints({ deviceId: 'cam-1' })).toEqual({
      video: {
        deviceId: { exact: 'cam-1' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 },
      },
      audio: false,
    });
  });

  it('asks for the front camera where none was chosen yet', () => {
    expect(buildConstraints({ deviceId: null }).video).toEqual({
      facingMode: { ideal: 'user' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60 },
    });
  });

  it('asks for the rear camera where none was chosen when the choice says so (the camera device)', () => {
    expect(buildConstraints({ deviceId: null, facing: 'environment' }).video).toMatchObject({
      facingMode: { ideal: 'environment' },
    });
    // A camera chosen is asked for by its id, whatever the facing says.
    expect(buildConstraints({ deviceId: 'cam-1', facing: 'environment' }).video).not.toHaveProperty(
      'facingMode',
    );
  });

  it('asks for lower ideals, or exactly 60 fps, when the choice says so', () => {
    expect(
      buildConstraints({ deviceId: 'cam-1', width: 1280, height: 720, fps: 30 }).video,
    ).toMatchObject({ width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } });
    expect(buildConstraints({ deviceId: 'cam-1', exactFps: true }).video).toMatchObject({
      width: { ideal: 1920 },
      frameRate: { exact: 60 },
    });
  });
});

describe('fallbackChoice', () => {
  const chosen: CameraChoice = { deviceId: 'gone', width: 1920, height: 1080, fps: 60 };
  const overconstrained = (constraint: string) => ({
    name: 'OverconstrainedError',
    message: '',
    constraint,
  });

  it('opens the default camera when the chosen one is gone', () => {
    expect(fallbackChoice(chosen, overconstrained('deviceId'))).toEqual({
      choice: { ...chosen, deviceId: null },
      why: 'device',
    });
    expect(
      fallbackChoice(chosen, new DOMException('Requested device not found', 'NotFoundError')),
    ).toMatchObject({ why: 'device' });
    // No camera chosen and none found: nothing lower to try.
    expect(fallbackChoice({ deviceId: null }, { name: 'NotFoundError' })).toBeNull();
  });

  it('asks for the best rate when exactly 60 fps is refused', () => {
    const exact = { ...chosen, deviceId: 'cam', exactFps: true };
    expect(fallbackChoice(exact, overconstrained('frameRate'))).toEqual({
      choice: { ...exact, exactFps: false },
      why: 'frame-rate',
    });
    expect(fallbackChoice({ ...exact, exactFps: false }, overconstrained('frameRate'))).toBeNull();
  });

  it('tries 1280 × 720 at 30 fps once a camera could not start in a higher mode', () => {
    const cam = { ...chosen, deviceId: 'cam' };
    expect(fallbackChoice(cam, { name: 'NotReadableError', message: 'Could not start' })).toEqual({
      choice: { deviceId: 'cam', width: 1280, height: 720, fps: 30 },
      why: 'mode',
    });
    expect(fallbackChoice({ deviceId: null }, { name: 'AbortError' })).toMatchObject({
      why: 'mode',
    });
    expect(
      fallbackChoice(
        { deviceId: 'cam', width: 1280, height: 720, fps: 30 },
        {
          name: 'NotReadableError',
        },
      ),
    ).toBeNull();
  });

  it('leaves the rest to the user: permission, security, anything unknown', () => {
    for (const error of [
      new DOMException('Permission denied', 'NotAllowedError'),
      { name: 'SecurityError' },
      new TypeError('bad constraints'),
      'weird',
      null,
    ]) {
      expect(fallbackChoice(chosen, error)).toBeNull();
    }
  });
});

describe('snapshot', () => {
  it("copies the MacBook's settings and capabilities as JSON, without the device ids", () => {
    const { settings, capabilities } = snapshot(trackOf(MACBOOK));
    expect(settings).toEqual({
      aspectRatio: 1.7777777777777777,
      backgroundBlur: false,
      frameRate: 30,
      height: 1080,
      resizeMode: 'none',
      width: 1920,
    });
    expect(capabilities).toEqual({
      aspectRatio: { max: 1920, min: 0.0005208333333333333 },
      backgroundBlur: [false],
      facingMode: [],
      frameRate: { max: 30, min: 0 },
      height: { max: 1920, min: 1 },
      resizeMode: ['none', 'crop-and-scale'],
      width: { max: 1920, min: 1 },
    });
    expect(JSON.parse(JSON.stringify(capabilities))).toEqual(capabilities);
  });

  it("keeps the phone's Image Capture keys, ranges as {min, max, step}", () => {
    const { settings, capabilities } = snapshot(trackOf(PHONE_REAR));
    expect(capabilities['exposureTime']).toEqual({ max: 2880, min: 0.832, step: 0.1 });
    expect(capabilities['torch']).toBe(true);
    expect(capabilities['focusMode']).toEqual(['manual', 'single-shot', 'continuous']);
    expect(settings).toMatchObject({ exposureMode: 'continuous', torch: false, zoom: 1 });
    expect(settings).not.toHaveProperty('deviceId');
    expect(capabilities).not.toHaveProperty('groupId');
  });

  it('drops what JSON cannot hold and ranges that are not finite', () => {
    const { settings, capabilities } = snapshot({
      getSettings: () =>
        ({
          width: 1920,
          frameRate: Number.NaN,
          zoom: Infinity,
          label: undefined,
          nested: { ideal: 5, f: () => 1 },
        }) as unknown as MediaTrackSettings,
      getCapabilities: () =>
        ({
          focusDistance: { min: 0, max: Infinity, step: 0.01 },
          iso: { min: 100, max: 1600, step: -1 },
          modes: ['manual', undefined, 3],
        }) as unknown as MediaTrackCapabilities,
    });
    expect(settings).toEqual({ width: 1920, nested: { ideal: 5 } });
    expect(capabilities).toEqual({
      focusDistance: { min: 0, step: 0.01 },
      iso: { min: 100, max: 1600 },
      modes: ['manual', 3],
    });
  });
});

describe('controlsOf', () => {
  it('finds no control on the MacBook: exposure, focus and white balance are automatic', () => {
    const controls = controlsOf(MACBOOK.capabilities, MACBOOK.settings);
    expect(controls).toEqual({
      exposureModes: [],
      exposureTime: null,
      iso: null,
      focusModes: [],
      focusDistance: null,
      whiteBalanceModes: [],
      colorTemperature: null,
      zoom: null,
      torch: false,
    });
    expect(hasControls(controls)).toBe(false);
  });

  it("finds manual exposure, focus, white balance and zoom on the ThinkPhone's front camera", () => {
    const controls = controlsOf(PHONE_FRONT.capabilities, PHONE_FRONT.settings);
    expect(controls).toEqual({
      exposureModes: ['continuous', 'manual'],
      exposureTime: { min: 0.5, max: 2501.6, step: 0.1 },
      iso: { min: 100, max: 1594, step: 1 },
      // Only "manual" is listed; its setting says "continuous", so there is an automatic focus.
      focusModes: ['continuous', 'manual'],
      focusDistance: { min: 0, max: 3.192782163619995, step: 0.009999999776482582 },
      whiteBalanceModes: ['continuous', 'manual'],
      colorTemperature: { min: 2850, max: 7000, step: 50 },
      zoom: { min: 1, max: 8, step: 0.1 },
      torch: false,
    });
    expect(hasControls(controls)).toBe(true);
    // Without the settings, the modes are the listed ones.
    expect(controlsOf(PHONE_FRONT.capabilities).focusModes).toEqual(['manual']);
  });

  it("finds the rear camera's torch and its three focus modes", () => {
    const controls = controlsOf(PHONE_REAR.capabilities, PHONE_REAR.settings);
    expect(controls.torch).toBe(true);
    expect(controls.focusModes).toEqual(['continuous', 'single-shot', 'manual']);
    expect(controls.exposureTime).toEqual({ min: 0.832, max: 2880, step: 0.1 });
    expect(autoModeOf(controls.focusModes)).toBe('continuous');
    expect(autoModeOf(['single-shot', 'manual'])).toBe('single-shot');
    expect(autoModeOf(['manual'])).toBeNull();
  });

  it('ignores ranges that allow a single value and unknown modes', () => {
    const controls = controlsOf({
      iso: { min: 100, max: 100 },
      zoom: { min: 1, max: 4 },
      exposureMode: ['manual', 'sometimes'],
      torch: [false, true],
    });
    expect(controls.iso).toBeNull();
    expect(controls.zoom).toEqual({ min: 1, max: 4 });
    expect(controls.exposureModes).toEqual(['manual']);
    expect(controls.torch).toBe(true);
  });
});

describe('control values', () => {
  const front = controlsOf(PHONE_FRONT.capabilities, PHONE_FRONT.settings);

  it("reads the current values from the settings (the front camera's auto exposure: 30.9 ms)", () => {
    expect(controlValuesOf(PHONE_FRONT.settings)).toEqual({
      exposureMode: 'continuous',
      exposureTime: 309.245,
      iso: 100,
      focusMode: 'continuous',
      focusDistance: 0.3310000002384186,
      whiteBalanceMode: 'continuous',
      colorTemperature: 0,
      zoom: 1,
    });
    expect(controlValuesOf(MACBOOK.settings)).toEqual({});
  });

  it('fits values to what the camera has: listed modes, numbers in range and on steps', () => {
    const values: ControlValues = {
      exposureMode: 'manual',
      exposureTime: 20.04,
      iso: 99_999,
      focusMode: 'single-shot',
      whiteBalanceMode: 'manual',
      colorTemperature: 0,
      zoom: 2.34,
      torch: true,
    };
    expect(fitControls(values, front)).toEqual({
      exposureMode: 'manual',
      exposureTime: 20,
      iso: 1594,
      whiteBalanceMode: 'manual',
      colorTemperature: 2850,
      zoom: 2.3,
    });
    expect(fitControls(values, controlsOf(MACBOOK.capabilities))).toEqual({});
  });

  it('snaps to steps counted from the minimum, without floating-point dust', () => {
    expect(snapToRange(0.3, { min: 0, max: 1, step: 0.1 })).toBe(0.3);
    expect(snapToRange(1.87, { min: 0.832, max: 2880, step: 0.1 })).toBe(1.832);
    expect(snapToRange(-5, { min: 1, max: 8, step: 0.1 })).toBe(1);
    expect(snapToRange(7.5, { min: 1, max: 8 })).toBe(7.5);
    expect(snapToRange(4460, { min: 2850, max: 7000, step: 50 })).toBe(4450);
  });

  it('groups the constraints so that a refused group leaves the others alone', () => {
    expect(
      controlConstraints({
        zoom: 2,
        exposureTime: 20,
        exposureMode: 'manual',
        focusMode: 'continuous',
        torch: false,
      }),
    ).toEqual([
      { exposureMode: 'manual', exposureTime: 20 },
      { focusMode: 'continuous' },
      { zoom: 2 },
      { torch: false },
    ]);
    expect(controlConstraints({})).toEqual([]);
  });

  it('applies them as advanced constraints, and nothing when there is nothing to apply', async () => {
    const applyConstraints = vi.fn<(constraints?: MediaTrackConstraints) => Promise<void>>(() =>
      Promise.resolve(),
    );
    await applyControls({ applyConstraints }, { iso: 400, exposureMode: 'manual' });
    await applyControls({ applyConstraints }, {});
    expect(applyConstraints.mock.calls).toEqual([
      [{ advanced: [{ exposureMode: 'manual', iso: 400 }] }],
    ]);

    const refuse = vi.fn(() => Promise.reject(new DOMException('no', 'OverconstrainedError')));
    await expect(applyControls({ applyConstraints: refuse }, { zoom: 3 })).rejects.toThrow('no');
  });
});

describe('facing and labels', () => {
  it('takes the facing from the settings, else from the label', () => {
    expect(facingOf(PHONE_FRONT.settings, 'whatever')).toBe('user');
    expect(facingOf(PHONE_REAR.settings, 'whatever')).toBe('environment');
    expect(facingOf(MACBOOK.settings, MACBOOK.camera.trackLabel)).toBe('unknown');
    expect(facingOf({}, 'camera 1, facing front')).toBe('user');
    expect(facingOf({ facingMode: 'left' }, 'camera 0, facing back')).toBe('environment');
    expect(facingFromLabel('Microsoft Camera Rear')).toBe('environment');
    expect(facingFromLabel('Frontier USB camera')).toBe('unknown');
  });

  it('labels the camera laptop or phone, from the host label, and front or rear', () => {
    expect(cameraLabel('macOS laptop', 'unknown')).toBe('laptop');
    expect(cameraLabel('office-mbp', 'user')).toBe('laptop-front');
    expect(cameraLabel('Android phone', 'user')).toBe('phone-front');
    expect(cameraLabel('iPhone', 'environment')).toBe('phone-rear');
    expect(cameraLabel('ThinkPhone', 'unknown')).toBe('phone');
  });
});

describe('cameraInfo', () => {
  it("builds the session's entry for the ThinkPhone's front camera", () => {
    const crop = { x: 0, y: 420, w: 1080, h: 1080 };
    const info = cameraInfo(
      'Android phone',
      { deviceId: 'secret-id', exactFps: true },
      trackOf(PHONE_FRONT),
      crop,
    );
    expect(info).toEqual({
      label: 'phone-front',
      local: true,
      facing: 'user',
      deviceLabel: 'camera 1, facing front',
      settings: snapshot(trackOf(PHONE_FRONT)).settings,
      capabilities: snapshot(trackOf(PHONE_FRONT)).capabilities,
      constraints: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { exact: 60 } },
      crop,
      mode: 'full',
      microphone: null,
    });
    expect(JSON.stringify(info)).not.toContain('secret-id');
    expect(info.crop).not.toBe(crop);
  });

  it("is a valid camera of session.json's schema 2, for each probed camera", () => {
    const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
    ajv.addSchema(SESSION_SCHEMA);
    const validate = ajv.getSchema(`${String(SESSION_SCHEMA['$id'])}#/$defs/camera`);
    expect(validate).toBeDefined();
    const entries = [
      cameraInfo('macOS laptop', { deviceId: 'id' }, trackOf(MACBOOK), null),
      cameraInfo('Android phone', { deviceId: null }, trackOf(PHONE_FRONT), {
        x: 0,
        y: 420,
        w: 1080,
        h: 1080,
      }),
      cameraInfo('Android phone', { deviceId: 'id', exactFps: true }, trackOf(PHONE_REAR), null),
    ];
    for (const entry of entries) {
      expect(validate?.(entry), JSON.stringify(validate?.errors)).toBe(true);
    }
    expect(entries.map((entry) => entry.label)).toEqual(['laptop', 'phone-front', 'phone-rear']);
  });

  it('labels the MacBook camera "laptop", facing unknown', () => {
    const info = cameraInfo('macOS laptop', { deviceId: null }, trackOf(MACBOOK), null);
    expect(info).toMatchObject({
      label: 'laptop',
      facing: 'unknown',
      deviceLabel: 'FaceTime HD Camera (3A71:F4B5)',
      crop: null,
      mode: 'full',
    });
    expect(info.constraints).toMatchObject({ facingMode: { ideal: 'user' } });
  });
});

describe('FrameRateMeter', () => {
  /** Frames every `intervalMs` on the camera's clock, from `startSeconds`, numbered from `first`. */
  function feed(
    meter: FrameRateMeter,
    count: number,
    intervalMs: number,
    startSeconds = 10,
    first = 1,
  ): void {
    for (let i = 0; i < count; i++) {
      meter.add({ mediaTime: startSeconds + (i * intervalMs) / 1000, presentedFrames: first + i });
    }
  }

  it('measures 30 fps over the last second of the camera clock, whatever the track says', () => {
    const meter = new FrameRateMeter();
    feed(meter, 20, 1000 / 30);
    expect(meter.fps()).toBeNull(); // 0.63 s so far
    feed(meter, 70, 1000 / 30, 10 + 20 / 30, 21);
    expect(meter.fps()).toBeCloseTo(30, 6);
  });

  it('counts frames that no callback saw, through presentedFrames', () => {
    const meter = new FrameRateMeter();
    // 60 fps, but the page sees every other frame.
    for (let i = 0; i < 120; i++) {
      meter.add({ mediaTime: 5 + (i * 2) / 60, presentedFrames: 1 + i * 2 });
    }
    expect(meter.fps()).toBeCloseTo(60, 6);
  });

  it('counts callbacks where there is no presentedFrames, and ignores a frame seen twice', () => {
    const meter = new FrameRateMeter();
    for (let i = 0; i < 40; i++) {
      meter.add({ mediaTime: i / 20 });
      meter.add({ mediaTime: i / 20 });
    }
    expect(meter.fps()).toBeCloseTo(20, 6);
  });

  it('starts again when the stream restarts (its clock goes back)', () => {
    const meter = new FrameRateMeter();
    feed(meter, 60, 1000 / 30, 100, 1);
    expect(meter.fps()).toBeCloseTo(30, 6);
    feed(meter, 10, 1000 / 20, 0.5, 61);
    expect(meter.fps()).toBeNull();
    feed(meter, 30, 1000 / 20, 1, 71);
    expect(meter.fps()).toBeCloseTo(20, 6);
    meter.reset();
    expect(meter.fps()).toBeNull();
  });
});

describe('watchFrames', () => {
  /** A `<video>`'s requestVideoFrameCallback that runs when the test presents a frame. */
  class FakeVideo {
    private next = 1;
    readonly pending = new Map<number, (now: number, metadata: { n: number }) => void>();
    readonly cancelled: number[] = [];

    requestVideoFrameCallback(callback: (now: number, metadata: { n: number }) => void): number {
      const handle = this.next++;
      this.pending.set(handle, callback);
      return handle;
    }

    cancelVideoFrameCallback(handle: number): void {
      this.cancelled.push(handle);
      this.pending.delete(handle);
    }

    present(n: number): void {
      const callbacks = [...this.pending.values()];
      this.pending.clear();
      for (const callback of callbacks) {
        callback(n * 33, { n });
      }
    }
  }

  it('calls back on every frame until stopped, then cancels the pending callback', () => {
    const video = new FakeVideo();
    const seen: number[] = [];
    const stop = watchFrames(video, (metadata) => seen.push(metadata.n));
    video.present(1);
    video.present(2);
    expect(seen).toEqual([1, 2]);
    expect(video.pending.size).toBe(1);
    stop();
    expect(video.pending.size).toBe(0);
    expect(video.cancelled).toHaveLength(1);
    video.present(3);
    expect(seen).toEqual([1, 2]);
  });

  it('asks for no further frame when stopped from its own callback', () => {
    const video = new FakeVideo();
    const seen: number[] = [];
    const stop: () => void = watchFrames(video, (metadata) => {
      seen.push(metadata.n);
      stop();
    });
    video.present(1);
    video.present(2);
    expect(seen).toEqual([1]);
    expect(video.pending.size).toBe(0);
    expect(video.cancelled).toEqual([]);
  });
});
