import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';

import { durationText, msText } from '../rtc/device-info';
import { RTC_TIMERS } from '../rtc/rtc-timers';
import { SettingsService } from '../settings/settings-service';
import { fpsText, sharpnessText } from './camera-format';
import { qrCode, qrSvgPath } from './qr-code';
import { PAIRING_BLOCK_TEXT } from './pairing-block';
import {
  RECONNECT_WINDOW_MS,
  RemoteCamerasService,
  type RemoteCamera,
} from './remote-cameras-service';

/** The quiet zone around the QR code, in modules (the standard asks for four). */
const QUIET_ZONE = 4;

/** The token as shown under the QR code, in two halves: "7KQM 2XAB". */
export function tokenText(token: string): string {
  return `${token.slice(0, 4)} ${token.slice(4)}`;
}

/**
 * The Cameras section of Camera settings (docs/PLAN.md T4.1): Add camera publishes a pairing and
 * shows its QR code (the camera page's URL with the session and a one-time token, drawn by
 * `qr-code.ts`), the URL and the token to type; under it the phones paired (`RemoteCamerasService`),
 * each with its latest thumbnail, its name and label in the session, its state (connected,
 * reconnecting), its clock sync (syncing, or synced with the round trip and the offset), what it
 * reports (recording, frame rate, sharpness, framing, battery, a thermal hint, the clips it still has
 * to send) and Remove; and "Record remote cameras" (T4.2, on by default): whether each attempt's clips
 * are asked of the phones. The panel loads it only when Add camera is pressed (`@defer (when
 * addRequests() > 0)`), and counts the presses in `addRequests`, so that the first pairing starts as
 * the section appears.
 */
@Component({
  selector: 'app-remote-cameras',
  templateUrl: './remote-cameras.html',
  styleUrl: './remote-cameras.scss',
})
export class RemoteCameras {
  /** How many times Add camera was pressed before this section loaded (the panel's placeholder). */
  readonly addRequests = input(0);

  protected readonly service = inject(RemoteCamerasService);
  protected readonly settings = inject(SettingsService);
  private readonly timers = inject(RTC_TIMERS);
  /** The host clock, once a second while a camera is listed or a pairing shown: the durations. */
  private readonly now = signal(this.timers.now());
  private ticker: unknown = null;

  protected readonly blockText = computed(() => {
    const block = this.service.blocked();
    return block === null ? null : PAIRING_BLOCK_TEXT[block];
  });
  protected readonly qr = computed(() => {
    const pairing = this.service.pairing();
    return pairing === null ? null : qrCode(pairing.url);
  });
  protected readonly qrPath = computed(() => {
    const code = this.qr();
    return code === null ? '' : qrSvgPath(code, QUIET_ZONE);
  });
  protected readonly qrViewBox = computed(() => {
    const code = this.qr();
    const side = (code?.size ?? 0) + 2 * QUIET_ZONE;
    return `0 0 ${String(side)} ${String(side)}`;
  });
  protected readonly token = computed(() => {
    const pairing = this.service.pairing();
    return pairing === null ? '' : tokenText(pairing.token);
  });
  protected readonly expiresIn = computed(() => {
    const pairing = this.service.pairing();
    return pairing === null ? '' : durationText(pairing.expiresMs - this.now());
  });

  constructor() {
    let handled = 0;
    effect(() => {
      const requests = this.addRequests();
      if (requests > handled) {
        handled = requests;
        void this.service.addCamera();
      }
    });
    effect(() => {
      const busy = this.service.cameras().length > 0 || this.service.pairing() !== null;
      if (busy) {
        this.startTicking();
      } else {
        this.stopTicking();
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.stopTicking();
    });
  }

  protected add(): void {
    void this.service.addCamera();
  }

  protected cancel(): void {
    void this.service.cancelPairing();
  }

  protected remove(id: string): void {
    this.service.remove(id);
  }

  /**
   * "connected for 2 min 05 s", "reconnecting for 12 s (removed after 5 min)", "connecting…",
   * "waiting for the phone's last clips (2)" (its session ended, T4.2b).
   */
  protected stateText(camera: RemoteCamera): string {
    const since = durationText(this.now() - camera.sinceMs);
    switch (camera.state) {
      case 'connecting':
        return 'connecting…';
      case 'connected':
        return `connected for ${since}`;
      case 'reconnecting':
        return `reconnecting for ${since} (removed after ${durationText(RECONNECT_WINDOW_MS)} away)`;
      case 'finishing':
        return `waiting for the phone's last clips (${String(camera.clipsLeft)})`;
    }
  }

  /** The clock sync: "syncing · 4 samples · round trip 9.6 ms", or "synced · round trip … · offset … · drift … ppm". */
  protected syncText(camera: RemoteCamera): string {
    const sync = camera.sync;
    if (sync === null) {
      return 'syncing…';
    }
    const trip = `round trip ${msText(sync.rttMs)}`;
    if (!sync.converged) {
      return `syncing · ${String(sync.samples)} ${sync.samples === 1 ? 'sample' : 'samples'} · ${trip} · spread ${msText(sync.residualP95Ms)}`;
    }
    return `synced · ${trip} · offset ${msText(sync.offsetMs)} · drift ${sync.driftPpm.toFixed(1)} ppm`;
  }

  /**
   * What the phone reports: recording, frame rate, sharpness, framing, battery, a thermal hint, the
   * clips it has cut and not sent yet (T4.2).
   */
  protected reportText(camera: RemoteCamera): string {
    const report = camera.report;
    if (report === null) {
      return 'no report yet';
    }
    const parts = [
      report.recording ? 'recording' : 'not recording',
      report.fps === null ? null : fpsText(report.fps),
      report.sharpness === null ? null : `sharpness ${sharpnessText(report.sharpness)}`,
      report.framing === null
        ? 'full frame'
        : `framing ${String(report.framing.w)}×${String(report.framing.h)}`,
      report.battery === null
        ? null
        : `battery ${String(Math.round(report.battery.level * 100))}%${report.battery.charging ? ', charging' : ''}`,
      report.thermal === 'throttled' ? 'hot: the frame rate dropped' : null,
      report.pendingClips === 0
        ? null
        : `${String(report.pendingClips)} ${report.pendingClips === 1 ? 'clip' : 'clips'} to send`,
    ];
    return parts.filter((part) => part !== null).join(' · ');
  }

  private startTicking(): void {
    if (this.ticker !== null) {
      return;
    }
    const tick = (): void => {
      this.now.set(this.timers.now());
      this.ticker = this.timers.setTimeout(tick, 1000);
    };
    tick();
  }

  private stopTicking(): void {
    if (this.ticker !== null) {
      this.timers.clearTimeout(this.ticker);
      this.ticker = null;
    }
  }
}
