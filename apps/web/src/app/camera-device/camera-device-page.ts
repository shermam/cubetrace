import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { framingPercent } from '@cubetrace/capture';
import { normalizeToken } from '@cubetrace/rtc';

import { AccountControl } from '../auth/account-control';
import { AuthService } from '../auth/auth-service';
import { CameraControls } from '../camera/camera-controls';
import { fpsText, sharpnessText, sizeText } from '../camera/camera-format';
import { CameraService } from '../camera/camera-service';
import { FramingEditor } from '../camera/framing-editor';
import { SharpnessMeter } from '../camera/sharpness-meter';
import { showStream } from '../camera/video';
import { WAKE_LOCK_TEXT, WakeLockService } from '../device/wake-lock-service';
import { durationText, msText } from '../rtc/device-info';
import { RTC_TIMERS } from '../rtc/rtc-timers';
import { SettingsService } from '../settings/settings-service';
import { CameraDeviceCapture } from './camera-device-capture';
import { CameraDevicePreview } from './camera-device-preview';
import { CameraDeviceService, type CameraDeviceState } from './camera-device-service';
import { CameraDeviceSync } from './camera-device-sync';

/** The connection's state in a word, for the pill. */
export const STATE_TEXT: Readonly<Record<CameraDeviceState, string>> = {
  idle: 'Not joined',
  'signed-out': 'Sign in to join',
  checking: 'Checking the code…',
  refused: 'Not joined',
  joining: 'Joining…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  left: 'Left',
  'host-gone': 'The host is gone',
};

/**
 * `/camera` (docs/PLAN.md T4.1): the phone as a camera of another device's session. Reached from the
 * QR code the host shows (`?session=<id>&token=<t>`) or by typing the code under it, signed in to the
 * same account (Sign in is here when it is not). It turns the camera on (the rear one by default, the
 * controls of Camera settings here too), runs the capture pipeline from the start
 * (`CameraDeviceCapture`), shows the preview with the framing rectangle and the sharpness meter, the
 * host's name, the connection's state, the clock sync as the host measures it, the battery and a
 * thermal hint, the clips cut for the host and not yet in its hands (T4.2), whether it sends the host
 * its live picture and whether the host's sync check measures it (T4.3), and Leave; it holds the
 * wake lock while joined and asks to keep the screen on and the phone plugged in
 * (`CameraDeviceService`). It never shows the timer and never starts a session
 * of its own; leaving the page leaves the session, and the camera goes back to what it was.
 */
@Component({
  selector: 'app-camera-device-page',
  imports: [AccountControl, CameraControls, FramingEditor, SharpnessMeter],
  templateUrl: './camera-device-page.html',
  styleUrl: './camera-device-page.scss',
})
export class CameraDevicePage {
  protected readonly service = inject(CameraDeviceService);
  protected readonly camera = inject(CameraService);
  protected readonly capture = inject(CameraDeviceCapture);
  /** The host's sync check of this camera, and the live preview (T4.3). */
  protected readonly syncCheck = inject(CameraDeviceSync);
  protected readonly livePreview = inject(CameraDevicePreview);
  protected readonly auth = inject(AuthService);
  protected readonly wakeLock = inject(WakeLockService);
  private readonly settings = inject(SettingsService);
  private readonly route = inject(ActivatedRoute);
  private readonly timers = inject(RTC_TIMERS);
  private readonly preview = viewChild<ElementRef<HTMLVideoElement>>('preview');

  protected readonly stateText = computed(() => STATE_TEXT[this.service.state()]);
  /** The connection is on, or on its way: the preview and the facts are shown. */
  protected readonly joined = computed(() => {
    const state = this.service.state();
    return state === 'joining' || state === 'connected' || state === 'reconnecting';
  });
  /** The host clock, once a second while joined: the durations. */
  private readonly now = signal(this.timers.now());
  private ticker: unknown = null;
  protected readonly sinceText = computed(() => durationText(this.now() - this.service.since()));
  protected readonly hostText = computed(() => {
    const host = this.service.hostDevice();
    return host === null ? 'the host' : `${host.label} (${host.platform})`;
  });
  /** The clock sync as the host reports it. */
  protected readonly clockText = computed(() => {
    const clock = this.service.clock();
    if (clock === null) {
      return `syncing · ${String(this.service.pings())} ${this.service.pings() === 1 ? 'ping' : 'pings'} answered`;
    }
    const facts = `round trip ${msText(clock.rttMs)} · offset ${msText(clock.offsetMs)}`;
    return clock.converged ? `synced · ${facts}` : `syncing · ${facts}`;
  });
  protected readonly batteryText = computed(() => {
    const battery = this.service.battery();
    if (battery === null) {
      return null;
    }
    return `Battery ${String(Math.round(battery.level * 100))}%${battery.charging ? ', charging' : ', not charging: plug the phone in'}`;
  });
  protected readonly thermalText = computed(() =>
    this.service.thermal() === 'throttled'
      ? 'The frame rate dropped under 80% of what the camera promised: the phone may be hot.'
      : null,
  );
  protected readonly wakeLockText = computed(() => WAKE_LOCK_TEXT[this.wakeLock.status()]);
  /** The live picture the host gets (T4.3): sent, or not asked for. */
  protected readonly previewText = computed(() => {
    if (this.livePreview.sending()) {
      return 'a live picture goes to the host (a fifth of the resolution, at most 300 kbps)';
    }
    return this.livePreview.wanted()
      ? 'asked for by the host; it goes once the camera is on'
      : 'none: the host does not ask for it (Live preview from phones, on the host)';
  });
  /** The clips cut for the host and not yet in its hands (T4.2). */
  protected readonly clipsText = computed(() => {
    const pending = this.service.pendingClips();
    return pending === 0
      ? 'each attempt’s clips go to the host as they are cut'
      : `${String(pending)} ${pending === 1 ? 'clip waits' : 'clips wait'} for the host; kept on this phone until it has them`;
  });
  /** The frames' proportions, 16:9 until they are known. */
  protected readonly aspect = computed(() => {
    const size = this.camera.frameSize();
    return size === null ? 16 / 9 : size.width / size.height;
  });
  protected readonly box = computed(() => {
    const rect = this.camera.framing();
    const size = this.camera.frameSize();
    return rect === null || size === null ? null : framingPercent(rect, size);
  });
  protected readonly pictureLine = computed(() => {
    const fps = this.camera.measuredFps();
    const size = this.camera.frameSize();
    const sharpness = this.camera.sharpness();
    const parts = [
      fps === null ? 'measuring…' : fpsText(fps),
      size === null ? null : sizeText(size),
      sharpness === null ? null : `sharpness ${sharpnessText(sharpness)}`,
      this.recordingWord(),
    ];
    return parts.filter((part) => part !== null).join(' · ');
  });
  protected readonly editing = this.camera.framingEditing;
  protected readonly code = signal('');

  constructor() {
    const wasOn = this.settings.cameraOn();
    // The camera device's role: its own choice of camera, the rear one by default.
    void this.camera.setRole('camera-device').then(() => {
      if (this.camera.status() === 'off') {
        void this.camera.start();
      }
    });
    this.capture.setWanted(true);
    // The QR's URL, or a link pasted into the address bar: joined unless it is joined already.
    const params = this.route.snapshot.queryParamMap;
    const sessionId = params.get('session');
    const token = params.get('token');
    if (sessionId !== null && sessionId !== '' && token !== null) {
      const normalized = normalizeToken(token);
      const joined = this.service.joined();
      if (normalized === null) {
        this.service.typed(token);
      } else if (joined?.sessionId !== sessionId || joined.token !== normalized) {
        this.service.join({ sessionId, token: normalized });
      }
    }
    // The preview plays the camera's stream, measures its frames and gives the thumbnails.
    effect((onCleanup) => {
      const video = this.preview()?.nativeElement;
      const stream = this.camera.stream();
      if (video === undefined || stream === null) {
        return;
      }
      const release = showStream(video, stream);
      const stop = this.camera.watchPreview(video);
      this.service.setPreview(video);
      onCleanup(() => {
        this.service.setPreview(null);
        stop();
        release();
      });
    });
    effect(() => {
      const joined = this.joined();
      untracked(() => {
        if (joined) {
          this.startTicking();
        } else {
          this.stopTicking();
        }
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.stopTicking();
      this.service.leave();
      this.capture.setWanted(false);
      this.camera.setFramingEditing(false);
      void this.camera.setRole('host').then(() => {
        if (!wasOn) {
          this.camera.stop();
        }
      });
    });
  }

  /** The code typed, or the link pasted. */
  protected join(event: Event): void {
    event.preventDefault();
    if (this.service.typed(this.code())) {
      this.code.set('');
    }
  }

  protected leave(): void {
    this.service.leave();
  }

  protected again(): void {
    this.service.reset();
  }

  protected toggleEditing(): void {
    this.camera.setFramingEditing(!this.editing());
  }

  protected select(deviceId: string): void {
    void this.camera.select(deviceId);
  }

  private recordingWord(): string {
    switch (this.capture.status()) {
      case 'off':
        return 'not recording';
      case 'starting':
        return 'starting';
      case 'recording':
        return 'recording';
      case 'error':
        return 'recording stopped';
    }
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
