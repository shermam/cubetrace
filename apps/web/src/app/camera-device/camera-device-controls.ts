import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { CONTROL_NAMES } from '@cubetrace/capture';
import {
  MAX_CONTROLS_MESSAGE,
  type ControlsReport,
  type MessageLink,
  type SetControls,
} from '@cubetrace/rtc';

import { CameraService } from '../camera/camera-service';
import { RTC_TIMERS } from '../rtc/rtc-timers';

/** What `controls` says, without its time: what decides whether it changed. */
type ControlsBody = Omit<ControlsReport, 'remoteMs'>;

/**
 * The phone's camera controls, set from the host (docs/PLAN.md T5.2, docs/RTC.md §11): over each
 * connection (`attach`), the phone answers the host's `set-controls` through `CameraService`, as its
 * own panel does (`setControl` for each control, in their order: persisted for the camera in its
 * Settings; `resetControls` for Reset to auto, which opens the camera again), then sends `controls`
 * (what the camera has, its values, what the app applied, what the camera changed by itself), or
 * `controls-failed` with the camera's refusal (and `controls` after it, as things stand). It sends
 * `controls` after each of its hellos (`report`, `CameraDeviceService`), and whenever they change
 * otherwise: the watchdog saw a drift or its end, or the phone's own panel changed a control.
 */
@Injectable({ providedIn: 'root' })
export class CameraDeviceControls {
  private readonly camera = inject(CameraService);
  private readonly timers = inject(RTC_TIMERS);

  private link: MessageLink | null = null;
  /** The last `controls` sent over this connection, without its time. */
  private sent = '';

  /** The `controls` as they are now, without the time; null while the camera is not on. */
  private readonly body = computed<ControlsBody | null>(() => {
    const controls = this.camera.controls();
    if (controls === null || this.camera.status() !== 'on') {
      return null;
    }
    return {
      type: 'controls',
      controls,
      values: this.camera.values(),
      applied: this.camera.applied(),
      drift: [...this.camera.drift()],
    };
  });

  constructor() {
    // They changed (a drift seen or over, the phone's own panel): the host gets them.
    effect(() => {
      const body = this.body();
      untracked(() => {
        if (body !== null) {
          this.send(body, false);
        }
      });
    });
  }

  /** A connection with the host, its hellos exchanged: its `set-controls` answered. */
  attach(link: MessageLink): () => void {
    this.link = link;
    this.sent = '';
    const off = link.on('set-controls', (message) => {
      void this.apply(link, message);
    });
    return () => {
      off();
      if (this.link === link) {
        this.link = null;
      }
    };
  }

  /** `controls` now, whether they changed or not: after each hello the phone sends. */
  report(): void {
    const body = this.body();
    if (body !== null) {
      this.send(body, true);
    }
  }

  private async apply(link: MessageLink, message: SetControls): Promise<void> {
    if (this.camera.status() !== 'on' || this.camera.controls() === null) {
      link.trySend({ type: 'controls-failed', message: "The phone's camera is not on." });
      return;
    }
    const refusals: string[] = [];
    if ('reset' in message) {
      await this.camera.resetControls();
    } else {
      for (const name of CONTROL_NAMES) {
        const value = message.values[name];
        if (value !== undefined) {
          const refused = await this.camera.setControl(name, value);
          if (refused !== null) {
            refusals.push(refused);
          }
        }
      }
    }
    if (this.link !== link) {
      return;
    }
    if (this.camera.status() !== 'on') {
      refusals.push(this.camera.error() ?? "The phone's camera went off.");
    }
    if (refusals.length > 0) {
      link.trySend({
        type: 'controls-failed',
        message: refusals.join(' ').slice(0, MAX_CONTROLS_MESSAGE),
      });
    }
    this.report();
  }

  private send(body: ControlsBody, always: boolean): void {
    const link = this.link;
    if (link === null || !link.open) {
      return;
    }
    const key = JSON.stringify(body);
    if (!always && key === this.sent) {
      return;
    }
    this.sent = key;
    link.trySend({ ...body, remoteMs: this.timers.now() });
  }
}
