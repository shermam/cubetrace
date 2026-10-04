import { Injectable, computed, signal, type Signal } from '@angular/core';
import type { ClapperboardFrame, FrameSize, MotionMeterInfo } from '@cubetrace/capture';
import type { CropRect, RemoteClockRecord } from '@cubetrace/core';

/** Where a remote camera is, as the Cameras list says (`RemoteCameraState`). */
export type RemoteCameraPhase = 'connecting' | 'connected' | 'reconnecting' | 'finishing';

/**
 * A remote camera as the Timer page's preview area and the sync check see it (T4.3): its names, its
 * state, what it reports of its picture, and its live preview's track.
 */
export interface RemoteCameraEntry {
  /** Its id in the Cameras list, kept across its reconnections. */
  readonly id: string;
  /** The phone's host label (`ThinkPhone`). */
  readonly name: string;
  /** Its label in the session (`phone-rear`); null before the phone has a camera. */
  readonly label: string | null;
  /** The session it films: the one it was paired in. */
  readonly session: string;
  readonly state: RemoteCameraPhase;
  /** The clock sync has an answer: its frame times can be placed on the host clock. */
  readonly synced: boolean;
  /** The clock sync has converged. */
  readonly converged: boolean;
  /** The phone's capture pipeline runs, as its last report says. */
  readonly recording: boolean;
  /** Its framing rectangle in its frames' pixels, and their size, as it reports them. */
  readonly framing: CropRect | null;
  readonly frame: FrameSize | null;
  /** The browser's name of the phone's camera (`camera 0, facing back`); empty when unknown. */
  readonly deviceLabel: string;
  /** The live preview's track (T4.3), once the phone's offer brought one; null otherwise. */
  readonly preview: MediaStreamTrack | null;
  /** The latest thumbnail, as an object URL: the picture while the track does not flow. */
  readonly thumbnail: string | null;
}

/** What gives the registry its cameras and measures their motion: the Cameras section's service. */
export interface RemoteCameraSource {
  readonly cameras: Signal<readonly RemoteCameraEntry[]>;
  /**
   * Starts measuring the motion of camera `id`'s frames inside its framing rectangle for a sync
   * check (the phone measures, `sync-start`), each frame given with its times on the host clock
   * through the clock sync; `onError` when it cannot be (the phone's word, its connection's end).
   * Returns the stop, or null when the camera is not connected.
   */
  watchMotion(
    id: string,
    onSample: (sample: ClapperboardFrame) => void,
    onError: (message: string) => void,
    onMeter: (meter: MotionMeterInfo) => void,
  ): (() => void) | null;
  /** The record of the clock estimate that places camera `id`'s frame times now; null without one. */
  clockRecord(id: string): RemoteClockRecord | null;
}

/**
 * The host's remote cameras, for the parts of the Timer page that show or measure them without the
 * connection's code (T4.3): the preview area's tiles of their live pictures and the sync check of a
 * remote camera. The Cameras section's `RemoteCamerasService`, a lazy chunk with @cubetrace/rtc that
 * loads at the first Add camera, provides them; until then there are none, and nothing here loads
 * that chunk.
 */
@Injectable({ providedIn: 'root' })
export class RemoteCameraRegistry {
  private readonly source = signal<RemoteCameraSource | null>(null);

  /** The remote cameras listed, in the order they paired; none before the Cameras section loads. */
  readonly cameras = computed(() => this.source()?.cameras() ?? []);

  /** The Cameras section's service gives its cameras (once, when it is made). */
  provide(source: RemoteCameraSource): void {
    this.source.set(source);
  }

  /** The camera `id`, while it is listed; null otherwise. */
  find(id: string): RemoteCameraEntry | null {
    return this.cameras().find((camera) => camera.id === id) ?? null;
  }

  /** See {@link RemoteCameraSource.watchMotion}: null without the Cameras section, or the camera. */
  watchMotion(
    id: string,
    onSample: (sample: ClapperboardFrame) => void,
    onError: (message: string) => void,
    onMeter: (meter: MotionMeterInfo) => void,
  ): (() => void) | null {
    return this.source()?.watchMotion(id, onSample, onError, onMeter) ?? null;
  }

  /** See {@link RemoteCameraSource.clockRecord}. */
  clockRecord(id: string): RemoteClockRecord | null {
    return this.source()?.clockRecord(id) ?? null;
  }
}
