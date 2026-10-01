import { Component, type ElementRef, computed, inject, signal, viewChild } from '@angular/core';

import { videoQualityOptions } from '../camera/video-quality';
import { type StoragePersistence, StorageService } from '../device/storage-service';
import { WAKE_LOCK_TEXT, WakeLockService } from '../device/wake-lock-service';
import { formatBytes } from '../shared/format-bytes';
import {
  CAMERA_FRAME_RATES,
  CAMERA_FRAME_RATE_TEXT,
  CAMERA_RESOLUTIONS,
  CAMERA_RESOLUTION_TEXT,
  type CubeMac,
  SHARPNESS_THRESHOLD_DEFAULT,
  SettingsService,
  VIDEO_QUALITIES,
} from './settings-service';

const PERSISTENCE_TEXT: Readonly<Record<StoragePersistence, string>> = {
  unsupported: 'This browser has no Storage API, so it cannot be asked to keep the data.',
  unknown: 'Checking whether the browser keeps the data…',
  persistent: 'Persistent: the browser keeps cubetrace’s data until you delete it.',
  'best-effort': 'Best effort: the browser may delete cubetrace’s data when the disk runs short.',
};

/**
 * `/settings`: the screen wake lock and storage persistence (T1.7), then what the timer and the
 * cube connection use (T1.6a): the host label, the cubes' MAC addresses, the idle disconnection
 * (T1.14), inspection, auto-advance, the scramble over the picture on a phone (T2.13), the camera's
 * resolution, frame rate and sharpness threshold (T2.1), Record audio (T2.4), the video quality
 * (T2.10) and the demo speed, all kept by `SettingsService`.
 */
@Component({
  selector: 'app-settings-page',
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.scss',
})
export class SettingsPage {
  protected readonly wakeLock = inject(WakeLockService);
  protected readonly storage = inject(StorageService);
  protected readonly settings = inject(SettingsService);
  protected readonly wakeLockText = computed(() => WAKE_LOCK_TEXT[this.wakeLock.status()]);
  protected readonly persistenceText = PERSISTENCE_TEXT;
  protected readonly canPersist = computed(() => {
    const persistence = this.storage.persistence();
    return persistence === 'unknown' || persistence === 'best-effort';
  });

  private readonly macForm = viewChild.required<ElementRef<HTMLFormElement>>('macForm');
  protected readonly macName = signal('');
  protected readonly macAddress = signal('');
  /** The name of the entry being edited; null while adding. */
  protected readonly editing = signal<string | null>(null);
  protected readonly macError = signal<string | null>(null);
  protected readonly speedError = signal<string | null>(null);
  protected readonly idleError = signal<string | null>(null);
  protected readonly thresholdError = signal<string | null>(null);
  protected readonly resolutions = CAMERA_RESOLUTIONS.map((value) => ({
    value,
    label: CAMERA_RESOLUTION_TEXT[value],
  }));
  protected readonly frameRates = CAMERA_FRAME_RATES.map((value) => ({
    value,
    label: CAMERA_FRAME_RATE_TEXT[value],
  }));
  /** Each quality with its bitrate and size per attempt at the resolution and frame rate chosen. */
  protected readonly qualities = computed(() =>
    videoQualityOptions(this.settings.cameraResolution(), this.settings.cameraFrameRate()),
  );
  protected readonly sharpnessDefault = SHARPNESS_THRESHOLD_DEFAULT;

  constructor() {
    void this.storage.refresh();
  }

  protected setKeepAwake(on: boolean): void {
    void (on ? this.wakeLock.request() : this.wakeLock.release());
  }

  protected keepData(): void {
    void this.storage.persist();
  }

  protected saveMac(event: Event): void {
    event.preventDefault();
    const result = this.settings.saveCubeMac(
      this.macName(),
      this.macAddress(),
      this.editing() ?? undefined,
    );
    if (result.ok) {
      this.cancelEdit();
    } else {
      this.macError.set(result.error);
    }
  }

  protected editMac(entry: CubeMac): void {
    this.editing.set(entry.name);
    this.macName.set(entry.name);
    this.macAddress.set(entry.mac);
    this.macError.set(null);
  }

  protected cancelEdit(): void {
    this.editing.set(null);
    this.macName.set('');
    this.macAddress.set('');
    this.macError.set(null);
    // The fields may hold text that the bindings have not seen yet: clear them in the page too.
    this.macForm().nativeElement.reset();
  }

  protected removeMac(name: string): void {
    this.settings.removeCubeMac(name);
    if (this.editing() === name) {
      this.cancelEdit();
    }
  }

  protected setDemoSpeed(text: string): void {
    const speed = text.trim() === '' ? Number.NaN : Number(text);
    this.speedError.set(
      this.settings.setDemoSpeed(speed) ? null : 'The speed must be a number from 0.1 to 100.',
    );
  }

  protected setIdleMinutes(text: string): void {
    const minutes = text.trim() === '' ? Number.NaN : Number(text);
    this.idleError.set(
      this.settings.setIdleDisconnectMinutes(minutes)
        ? null
        : 'The minutes must be a whole number from 0 to 60.',
    );
  }

  protected setCameraResolution(value: string): void {
    const resolution = CAMERA_RESOLUTIONS.find((option) => option === value);
    if (resolution !== undefined) {
      this.settings.setCameraResolution(resolution);
    }
  }

  protected setCameraFrameRate(value: string): void {
    const rate = CAMERA_FRAME_RATES.find((option) => option === value);
    if (rate !== undefined) {
      this.settings.setCameraFrameRate(rate);
    }
  }

  protected setVideoQuality(value: string): void {
    const quality = VIDEO_QUALITIES.find((option) => option === value);
    if (quality !== undefined) {
      this.settings.setVideoQuality(quality);
    }
  }

  protected setSharpnessThreshold(text: string): void {
    const threshold = text.trim() === '' ? Number.NaN : Number(text);
    this.thresholdError.set(
      this.settings.setSharpnessThreshold(threshold)
        ? null
        : 'The threshold must be a number above 0 (100000 at most).',
    );
  }

  /** Decimal units, as Chrome shows storage: "0 B", "12.3 kB", "1.2 GB". */
  protected bytes(count: number): string {
    return formatBytes(count);
  }
}
