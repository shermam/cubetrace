import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { DiagnosticsService } from '../diagnostics/diagnostics-service';
import { DEFAULT_CAMERA, SettingsService } from '../settings/settings-service';
import {
  HostCamera,
  LUMA_SAMPLER,
  cameraDevices,
  mediaDevicesOf,
  type CameraDevice,
  type HostCameraContext,
} from './host-camera';

/** A camera of the host that is on: the device it opens, and the mode its last opening asked for. */
interface Slot {
  readonly camera: HostCamera;
  /** The device it opens; null for the browser's default camera, until it opened (T5.5). */
  deviceId: string | null;
  /** The mode (`HostCamera.modeKey`) its last opening asked for; null before it was asked to open. */
  mode: string | null;
}

/**
 * The cameras of this device that the host records with (docs/PLAN.md T5.5): every video device of
 * the laptop with a switch of its own (`Settings.camerasOn`, by the browser's names for them), and a
 * `HostCamera` for each one on, which opens its device at its own resolution and frame rate
 * (`Settings.cameraModeFor`, Camera settings) and keeps its own controls, framing, sharpness meter
 * and watchdog. The cameras are in the order of the device list (the default camera, while its name
 * is unknown, first), and the first one is the one a single picture shows and the microphone records
 * with (`primary`).
 *
 * Turn on with nothing on turns on the first device (the front one on a phone), or, before the
 * browser names its cameras (before the permission), the default camera, whose name takes its place
 * once it opens ({@link DEFAULT_CAMERA}). A device that is listed but not connected any more is not
 * opened; the browser's names are listed again on `devicechange`, and whenever a camera opens (names
 * appear once a camera is allowed). The cameras open one at a time. On the camera device page (a
 * phone filming for another host, T4.1) the host's cameras are `suspended`: closed, and opened again
 * when the page goes. Only `CameraService` and the Camera settings change what is on.
 */
@Injectable({ providedIn: 'root' })
export class HostCamerasService {
  private readonly globals = inject(BROWSER_GLOBALS);
  private readonly prefs = inject(SettingsService);
  private readonly media = mediaDevicesOf(this.globals);
  private readonly context: HostCameraContext = {
    globals: this.globals,
    prefs: this.prefs,
    diagnostics: inject(DiagnosticsService),
    sampler: inject(LUMA_SAMPLER),
    media: this.media,
    refreshDevices: () => this.refreshDevices(),
  };

  private readonly devicesSignal = signal<readonly CameraDevice[]>([]);
  /** The devices were listed since the page loaded: before, the list says nothing yet. */
  private readonly listedSignal = signal(false);
  private readonly slotsSignal = signal<readonly Slot[]>([]);
  private readonly suspendedSignal = signal(false);
  /** The first listing of the devices, which every decision waits for. */
  private readonly firstListing: Promise<void>;
  /** The cameras' openings, one after the other. */
  private opening: Promise<void> = Promise.resolve();

  /** This device's cameras (see `cameraDevices`): names once the browser gives them. */
  readonly devices = this.devicesSignal.asReadonly();
  /** The cameras that are on (or opening, or failing), in the order of the device list. */
  readonly cameras = computed(() => this.slotsSignal().map((slot) => slot.camera));
  /**
   * The first camera: the one a single picture shows (a phone's pinned picture, T2.13), whose clips
   * have the microphone's sound (T5.5); null when none is on.
   */
  readonly primary = computed(() => this.cameras().at(0) ?? null);
  /** The host's cameras are closed for the camera device page (T4.1). */
  readonly suspended = this.suspendedSignal.asReadonly();

  constructor() {
    const destroyRef = inject(DestroyRef);
    const media = this.media;
    if (media !== null) {
      const onDeviceChange = (): void => {
        void this.refreshDevices();
      };
      media.addEventListener('devicechange', onDeviceChange);
      destroyRef.onDestroy(() => {
        media.removeEventListener('devicechange', onDeviceChange);
      });
    }
    destroyRef.onDestroy(() => {
      for (const slot of this.slotsSignal()) {
        slot.camera.destroy();
      }
      this.slotsSignal.set([]);
    });
    this.firstListing = this.refreshDevices();
    // The cameras on open as the page loads, once the devices are listed.
    void this.reconcile();
    // The cameras follow the settings (which are on, and in which mode), the device list and the
    // camera device page.
    effect(() => {
      this.prefs.camerasOn();
      this.devicesSignal();
      this.listedSignal();
      this.suspendedSignal();
      for (const slot of this.slotsSignal()) {
        slot.camera.modeKey();
      }
      untracked(() => {
        void this.reconcile();
      });
    });
  }

  /** Lists this device's cameras again (names appear once a camera is allowed). */
  async refreshDevices(): Promise<void> {
    if (this.media !== null) {
      try {
        this.devicesSignal.set(cameraDevices(await this.media.enumerateDevices()));
      } catch {
        // The list stays as it was.
      }
    }
    this.listedSignal.set(true);
  }

  /** Whether `device` is switched on (Settings), opening or open. */
  isOn(device: CameraDevice): boolean {
    return this.prefs.camerasOn().includes(device.label);
  }

  /**
   * Turn on: with no camera on, the first device (the front one on a phone; before the browser names
   * them, the default camera); with none of those on connected, the first device too. Resolves once
   * the cameras on have opened, or failed to.
   */
  async turnOn(): Promise<void> {
    await this.firstListing;
    const wanted = this.prefs.camerasOn();
    const named = this.devicesSignal().filter((device) => device.label !== '');
    const connected =
      wanted.includes(DEFAULT_CAMERA) ||
      (named.length === 0 && wanted.length > 0) ||
      named.some((device) => wanted.includes(device.label));
    if (!connected) {
      this.prefs.setCamerasOn([...wanted, this.firstDevice()?.label ?? DEFAULT_CAMERA]);
    }
    await this.reconcile();
  }

  /** Turn off: every camera off, kept off across loads. */
  turnOff(): void {
    this.prefs.setCamerasOn([]);
    void this.reconcile();
  }

  /**
   * A device's switch (Camera settings): on, it opens beside the others, the last; off, it closes
   * and the others go on. Resolves once the cameras on have opened, or failed to.
   */
  async setOn(device: CameraDevice, on: boolean): Promise<void> {
    const cameras = this.prefs.camerasOn();
    this.prefs.setCamerasOn(
      on ? [...cameras, device.label] : cameras.filter((camera) => camera !== device.label),
    );
    await this.reconcile();
  }

  /** The device `deviceId` alone on (a single camera chosen, as before T5.5). */
  async only(deviceId: string): Promise<void> {
    const device = this.devicesSignal().find((candidate) => candidate.deviceId === deviceId);
    if (device === undefined) {
      return;
    }
    this.prefs.setCamerasOn([device.label]);
    await this.reconcile();
  }

  /**
   * Closes the host's cameras while the camera device page films with this device's camera (true),
   * and opens them again as Settings say once it goes (false); resolves once they have opened.
   */
  async suspend(suspended: boolean): Promise<void> {
    this.suspendedSignal.set(suspended);
    await this.reconcile();
  }

  /** The device the cameras turn on with: the first one facing the user, else the first one. */
  private firstDevice(): CameraDevice | null {
    const named = this.devicesSignal().filter((device) => device.label !== '');
    return named.find((device) => device.facing === 'user') ?? named.at(0) ?? null;
  }

  /**
   * Makes the cameras what Settings say: a camera for each device on that is listed, the default
   * camera while the browser names none, none while suspended; each opened in its mode (again when
   * its mode changed). Resolves once the openings asked for have run.
   */
  private reconcile(): Promise<void> {
    const wanted = this.prefs.camerasOn();
    const slots = this.slotsSignal();
    if (this.suspendedSignal() || wanted.length === 0) {
      this.retire(slots);
      return this.opening;
    }
    if (!this.listedSignal()) {
      return this.firstListing.then(() => this.reconcile());
    }
    const named = this.devicesSignal().filter((device) => device.label !== '');
    // The default camera, named: the first device facing the user, else the first.
    if (wanted.includes(DEFAULT_CAMERA) && named.length > 0) {
      const opening = slots.some((slot) => slot.deviceId === null);
      const first = this.firstDevice();
      if (!opening && first !== null) {
        this.prefs.setCamerasOn(
          wanted.map((camera) => (camera === DEFAULT_CAMERA ? first.label : camera)),
        );
        return this.reconcile();
      }
    }
    let next: Slot[];
    if (named.length === 0) {
      // The browser names no camera (no permission yet): the cameras open keep on, and the default
      // camera opens to ask for it.
      next = slots.length > 0 ? [...slots] : [this.slot(null)];
    } else {
      const unbound = slots.filter(
        (slot) =>
          slot.deviceId === null &&
          (wanted.includes(DEFAULT_CAMERA) || slot.camera.status() === 'starting'),
      );
      const devices = named.filter((device) => wanted.includes(device.label));
      next = [
        ...unbound,
        ...devices.map(
          (device) =>
            slots.find((slot) => slot.deviceId === device.deviceId) ?? this.slot(device.deviceId),
        ),
      ];
    }
    this.retire(slots.filter((slot) => !next.includes(slot)));
    // Written only when it changed: the effect that calls this reads it.
    const now = this.slotsSignal();
    if (next.length !== now.length || next.some((slot, k) => slot !== now[k])) {
      this.slotsSignal.set(next);
    }
    for (const slot of next) {
      const mode = slot.camera.modeKey();
      if (slot.mode !== mode) {
        slot.mode = mode;
        this.opening = this.opening.then(() =>
          this.slotsSignal().includes(slot) ? slot.camera.open() : undefined,
        );
      }
    }
    return this.opening;
  }

  /** A camera for the device `deviceId` (null: the default camera, until it opens). */
  private slot(deviceId: string | null): Slot {
    const slot: Slot = {
      camera: new HostCamera(this.context, {
        role: () => 'host',
        device: () => Promise.resolve(slot.deviceId),
        facing: () => 'user',
        mode: () => this.prefs.cameraModeFor(this.nameOf(slot)),
        fallBackToDefault: false,
        opened: (opened, label) => {
          this.bound(slot, opened, label);
        },
      }),
      deviceId,
      mode: null,
    };
    return slot;
  }

  /** The browser's name of the camera of `slot`: as it opened, else as the device list has it. */
  private nameOf(slot: Slot): string {
    const label = slot.camera.label();
    if (label !== '') {
      return label;
    }
    const id = slot.deviceId;
    return id === null
      ? DEFAULT_CAMERA
      : (this.devicesSignal().find((device) => device.deviceId === id)?.label ?? DEFAULT_CAMERA);
  }

  /**
   * The camera of `slot` opened on the device `deviceId`: the default camera is that device from now
   * on, and its name takes the default camera's place in Settings.
   */
  private bound(slot: Slot, deviceId: string, label: string): void {
    if (slot.deviceId !== null) {
      return;
    }
    slot.deviceId = deviceId;
    const wanted = this.prefs.camerasOn();
    if (wanted.includes(DEFAULT_CAMERA) && label !== '') {
      this.prefs.setCamerasOn(wanted.map((camera) => (camera === DEFAULT_CAMERA ? label : camera)));
    }
  }

  /** Turns the cameras of `slots` off and forgets them. */
  private retire(slots: readonly Slot[]): void {
    if (slots.length === 0) {
      return;
    }
    for (const slot of slots) {
      slot.camera.stop();
    }
    this.slotsSignal.update((all) => all.filter((slot) => !slots.includes(slot)));
  }
}
