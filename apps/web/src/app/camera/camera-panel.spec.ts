import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { LumaSampler, type Canvas2D } from '@cubetrace/capture';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import {
  FAKE_FACETIME,
  FAKE_PHONE_FRONT,
  FAKE_PHONE_REAR,
  FAKE_WEBCAM,
  FakeLocalStorage,
  FakeMediaDevices,
  FakeVideoFrames,
  mediaError,
  settle,
  type FakeCamera,
} from '../device/fake-browser';
import { SettingsService } from '../settings/settings-service';
import { CameraPanel } from './camera-panel';
import { CameraService, LUMA_SAMPLER } from './camera-service';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) Chrome/141.0.0.0 Mobile Safari/537.36';

/** A canvas whose pixels are squares of 20, dark and light: a sharp picture. */
class CheckerCanvas implements Canvas2D<CanvasImageSource> {
  drawImage(): void {
    // The pattern is fixed.
  }

  getImageData(_sx: number, _sy: number, sw: number, sh: number): { data: Uint8ClampedArray } {
    const data = new Uint8ClampedArray(sw * sh * 4);
    for (let i = 0; i < sw * sh; i++) {
      const value = (Math.floor((i % sw) / 20) + Math.floor(i / sw / 20)) % 2 ? 40 : 220;
      data.set([value, value, value, 255], i * 4);
    }
    return { data };
  }
}

describe('CameraPanel', () => {
  let media: FakeMediaDevices;
  let frames: FakeVideoFrames;
  let fixture: ComponentFixture<CameraPanel>;

  async function render(
    cameras: readonly FakeCamera[] = [FAKE_WEBCAM],
    userAgent = MAC,
  ): Promise<void> {
    media = new FakeMediaDevices(cameras);
    frames = new FakeVideoFrames();
    // jsdom's <video> does not play.
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BROWSER_GLOBALS,
          useValue: {
            navigator: { mediaDevices: media, userAgent },
            localStorage: new FakeLocalStorage(),
          },
        },
        {
          provide: LUMA_SAMPLER,
          useValue: new LumaSampler<CanvasImageSource>(() => new CheckerCanvas()),
        },
      ],
    });
    fixture = TestBed.createComponent(CameraPanel);
    await update();
  }

  async function update(): Promise<void> {
    await settle();
    await fixture.whenStable();
  }

  // jsdom's <video> presents no frames: the tests present them, through `frames`. Installed for
  // the whole file, since the preview's watch is cancelled when TestBed destroys the panel.
  beforeAll(() => {
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: (callback: VideoFrameRequestCallback) => frames.requestVideoFrameCallback(callback),
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
      configurable: true,
      value: (handle: number) => {
        frames.cancelVideoFrameCallback(handle);
      },
    });
  });

  afterAll(() => {
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
    Reflect.deleteProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function element(testId: string): HTMLElement | null {
    return (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${testId}"]`);
  }

  function text(testId: string): string | undefined {
    return element(testId)?.textContent.replace(/\s+/g, ' ').trim();
  }

  async function turnOn(): Promise<void> {
    element('camera-toggle')?.click();
    await update();
  }

  /** Edit: the framing rectangle over the larger picture. */
  async function edit(): Promise<void> {
    element('camera-framing-edit')?.click();
    await update();
  }

  it('is off at first; turned on, it shows the picture, the track and what is measured', async () => {
    await render();

    const section = element('camera-section');
    expect(section?.tagName).toBe('DETAILS');
    expect(section?.hasAttribute('open')).toBe(false);
    expect(section?.querySelector('summary h2')?.textContent).toBe('Camera settings');
    expect(text('camera-state')).toBe('Off');
    expect(text('camera-toggle')).toBe('Turn on');
    expect(element('camera-off')).not.toBeNull();
    expect(element('camera-framing-video')).toBeNull();

    await turnOn();
    expect(text('camera-toggle')).toBe('Turn off');
    const camera = TestBed.inject(CameraService);
    // The larger picture only while the framing is edited.
    expect(element('camera-framing-video')).toBeNull();
    expect(text('camera-framing-edit')).toBe('Edit');
    await edit();
    expect(text('camera-framing-edit')).toBe('Done');
    expect(element('camera-framing-edit')?.getAttribute('aria-pressed')).toBe('true');
    const video = element('camera-framing-video') as HTMLVideoElement;
    expect(video.muted).toBe(true);
    expect(video.srcObject).toBe(camera.stream());
    // It is for the framing: the preview beside the clock measures the frames.
    expect(frames.waiting).toBe(0);
    expect(text('camera-track')).toBe('1920×1080 at 20 fps');
    expect(text('camera-measured')).toBe('measuring…');
    expect(text('camera-framing-rect')).toBe('full frame, 1920×1080');
    expect(text('camera-sharpness-value')).toBe('–');

    const preview = document.createElement('video');
    camera.watchPreview(preview);
    frames.present(20, 50);
    await update();
    expect(text('camera-measured')).toBe('20.0 fps, frames 1920×1080');
    expect(text('camera-state')).toBe('1920×1080 · 20.0 fps');
    // Twice a second: at the first frame and 500 ms after it.
    expect(element('camera-sharpness')?.getAttribute('data-samples')).toBe('2');
    expect(element('camera-sharpness')?.getAttribute('data-good')).toBe('true');
    expect(Number(text('camera-sharpness-value'))).toBeGreaterThan(1000);
    expect(text('camera-sharpness-verdict')).toBe('good');

    await edit();
    expect(element('camera-framing-video')).toBeNull();
    element('camera-toggle')?.click();
    await update();
    expect(text('camera-state')).toBe('Off');
    expect(element('camera-framing-edit')).toBeNull();
    expect(media.liveTracks()).toEqual([]);
  });

  it('opens by itself the first time the camera is on, then stays as it was left', async () => {
    await render();
    const settings = TestBed.inject(SettingsService);
    const details = (): HTMLDetailsElement => element('camera-section') as HTMLDetailsElement;
    expect(settings.cameraSettingsOpen()).toBeNull();

    await turnOn();
    expect(details().open).toBe(true);
    expect(settings.cameraSettingsOpen()).toBe(true);

    // Closed by hand: kept closed, also when the camera is turned on again and after a reload.
    details().open = false;
    details().dispatchEvent(new Event('toggle'));
    await update();
    expect(settings.cameraSettingsOpen()).toBe(false);
    element('camera-toggle')?.click();
    await update();
    await turnOn();
    expect(details().open).toBe(false);
    fixture.destroy();
    fixture = TestBed.createComponent(CameraPanel);
    await update();
    expect(details().open).toBe(false);

    // Opened by hand: open after a reload.
    details().open = true;
    details().dispatchEvent(new Event('toggle'));
    await update();
    expect(settings.cameraSettingsOpen()).toBe(true);
    fixture.destroy();
    fixture = TestBed.createComponent(CameraPanel);
    await update();
    expect(details().open).toBe(true);
  });

  it('opens to the framing editor when the sync check asks for it, and leaving the page closes the editor', async () => {
    await render();
    const camera = TestBed.inject(CameraService);
    const details = (): HTMLDetailsElement => element('camera-section') as HTMLDetailsElement;
    await turnOn();
    details().open = false;
    details().dispatchEvent(new Event('toggle'));
    await update();
    expect(element('camera-framing-video')).toBeNull();

    // "Edit the framing" under the preview (T2.8).
    camera.setFramingEditing(true);
    await update();
    expect(details().open).toBe(true);
    expect(element('camera-framing-video')).not.toBeNull();
    expect(text('camera-framing-edit')).toBe('Done');

    // Done closes it; so does leaving the page.
    element('camera-framing-edit')?.click();
    await update();
    expect(camera.framingEditing()).toBe(false);
    expect(element('camera-framing-video')).toBeNull();
    await edit();
    expect(camera.framingEditing()).toBe(true);
    fixture.destroy();
    expect(camera.framingEditing()).toBe(false);
  });

  it('has the resolution, frame rate, video quality and audio of Settings', async () => {
    await render();
    const settings = TestBed.inject(SettingsService);
    const resolution = element('camera-panel-resolution') as HTMLSelectElement;
    const rate = element('camera-panel-frame-rate') as HTMLSelectElement;
    const quality = element('camera-panel-video-quality') as HTMLSelectElement;
    const audio = element('camera-panel-audio') as HTMLInputElement;
    const options = (select: HTMLSelectElement): string[] =>
      Array.from(select.options, (option) => option.text.trim());
    expect(options(resolution)).toEqual(['1920×1080', '1280×720']);
    expect(options(quality)).toEqual([
      'Standard (4 Mbps, ≈ 20 MB per attempt)',
      'High (8 Mbps, ≈ 40 MB per attempt)',
      'Maximum (12 Mbps, ≈ 60 MB per attempt)',
    ]);
    expect(resolution.value).toBe('1080p');
    expect(rate.value).toBe('best');
    expect(quality.value).toBe('standard');
    expect(audio.checked).toBe(true);

    resolution.value = '720p';
    resolution.dispatchEvent(new Event('change'));
    rate.value = '30';
    rate.dispatchEvent(new Event('change'));
    quality.value = 'maximum';
    quality.dispatchEvent(new Event('change'));
    audio.click();
    await update();
    expect(settings.cameraResolution()).toBe('720p');
    expect(settings.cameraFrameRate()).toBe('30');
    expect(settings.videoQuality()).toBe('maximum');
    expect(settings.recordAudio()).toBe(false);
    // The choices follow the resolution and frame rate.
    expect(options(quality)).toEqual([
      'Standard (1.8 Mbps, ≈ 9 MB per attempt)',
      'High (3.6 Mbps, ≈ 18 MB per attempt)',
      'Maximum (5.3 Mbps, ≈ 27 MB per attempt)',
    ]);
    expect(quality.value).toBe('maximum');
  });

  it('names the cameras Front and Rear on a phone, and mirrors only the front one', async () => {
    await render([FAKE_PHONE_FRONT, FAKE_PHONE_REAR], ANDROID);
    await turnOn();

    const select = element('camera-device') as HTMLSelectElement;
    expect(Array.from(select.options, (option) => option.text.trim())).toEqual([
      'Front camera',
      'Rear camera',
    ]);
    expect(select.value).toBe('phone-front');
    await edit();
    expect(element('camera-frame')?.classList.contains('mirrored')).toBe(true);

    select.value = 'phone-rear';
    select.dispatchEvent(new Event('change'));
    await update();
    expect(TestBed.inject(CameraService).label()).toBe('camera 0, facing back');
    expect(element('camera-frame')?.classList.contains('mirrored')).toBe(false);
  });

  it('shows only the controls a camera has', async () => {
    await render([FAKE_FACETIME]);
    await turnOn();
    expect(text('camera-no-controls')).toContain('This camera has no manual controls');
    expect(element('camera-reset')).toBeNull();
    TestBed.resetTestingModule();

    await render([FAKE_WEBCAM]);
    await turnOn();
    const legends = (): string[] =>
      Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('legend'), (legend) =>
        legend.textContent.trim(),
      );
    expect(legends()).toEqual(['Exposure', 'Focus']);
    expect(text('control-exposureTime-value')).toBe('5.0 ms (1/200 s)');
    expect(element('control-torch')).toBeNull();
    expect(element('camera-reset')).not.toBeNull();
    TestBed.resetTestingModule();

    await render([FAKE_PHONE_REAR], ANDROID);
    await turnOn();
    expect(legends()).toEqual(['Exposure', 'Focus', 'White balance', 'Zoom']);
    expect(text('control-exposureTime-value')).toBe('4.9 ms (1/205 s)');
    expect(text('control-colorTemperature-value')).toBe('auto');
    expect(element('control-torch')).not.toBeNull();
    const focus = element('control-focusMode') as HTMLSelectElement;
    expect(Array.from(focus.options, (option) => option.text.trim())).toEqual([
      'Auto',
      'Auto (once)',
      'Manual',
    ]);
  });

  it('applies a mode, a slider when it is let go, and the torch', async () => {
    await render([FAKE_PHONE_REAR], ANDROID);
    await turnOn();
    const track = media.tracks[0];

    const mode = element('control-exposureMode') as HTMLSelectElement;
    mode.value = 'manual';
    mode.dispatchEvent(new Event('change'));
    await update();
    expect(track.applied.at(-1)).toEqual({ advanced: [{ exposureMode: 'manual' }] });

    const zoom = element('control-zoom') as HTMLInputElement;
    zoom.value = '500';
    zoom.dispatchEvent(new Event('input'));
    await update();
    expect(text('control-zoom-value')).toBe('4.5×');
    expect(track.applied).toHaveLength(1);
    zoom.dispatchEvent(new Event('change'));
    await update();
    expect(track.applied.at(-1)).toEqual({ advanced: [{ zoom: 4.5 }] });
    expect(text('control-zoom-value')).toBe('4.5×');

    const torch = element('control-torch') as HTMLInputElement;
    torch.click();
    await update();
    expect(track.applied.at(-1)).toEqual({ advanced: [{ torch: true }] });
    expect(torch.checked).toBe(true);

    element('camera-reset')?.click();
    await update();
    expect(media.tracks).toHaveLength(2);
    expect(TestBed.inject(SettingsService).cameraControlsFor('camera 0, facing back')).toEqual({});
  });

  it('says why the camera did not open, or what it did instead', async () => {
    await render([FAKE_FACETIME]);
    media.failures.push(mediaError('NotAllowedError', 'Permission denied'));
    await turnOn();
    expect(text('camera-state')).toBe('Not working');
    expect(text('camera-error')).toMatch(/^The camera permission was denied/);
    expect(element('camera-error')?.getAttribute('role')).toBe('alert');
    expect(text('camera-toggle')).toBe('Turn off');

    TestBed.inject(SettingsService).setCameraFrameRate('60');
    await update();
    element('camera-toggle')?.click();
    await update();
    await turnOn();
    expect(text('camera-error')).toBeUndefined();
    expect(text('camera-notice')).toBe(
      'This camera has no mode at exactly 60 fps at 1920×1080: it opened at its best rate.',
    );
  });

  describe('the framing rectangle', () => {
    /** The preview drawn 480 × 270 CSS pixels (a quarter of the frames' 1920 × 1080). */
    function layout(): HTMLElement {
      const frame = element('camera-frame');
      if (frame === null) {
        throw new Error('No preview.');
      }
      frame.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 100, y: 50, width: 480, height: 270 });
      return frame;
    }

    function pointer(type: string, x: number, y: number, target?: Element | null): void {
      (target ?? element('camera-framing'))?.dispatchEvent(
        new PointerEvent(type, { clientX: x, clientY: y, pointerId: 7, button: 0, bubbles: true }),
      );
    }

    function stored(): unknown {
      return TestBed.inject(CameraService).framing();
    }

    it('moves when its inside is dragged and resizes from a corner; kept when let go', async () => {
      await render();
      await turnOn();
      await edit();
      layout();
      TestBed.inject(CameraService).setFraming({ x: 480, y: 270, w: 960, h: 540 });
      await update();
      const framing = element('camera-framing');
      expect(framing?.style.left).toBe('25%');
      expect(framing?.style.width).toBe('50%');

      // The middle of the rectangle, seen at (340, 185), dragged 24 px right and 12 down.
      pointer('pointerdown', 340, 185);
      pointer('pointermove', 364, 197);
      await update();
      expect(framing?.style.left).toBe('30%');
      expect(stored()).toEqual({ x: 480, y: 270, w: 960, h: 540 });
      pointer('pointerup', 364, 197);
      await update();
      expect(stored()).toEqual({ x: 576, y: 318, w: 960, h: 540 });
      expect(text('camera-framing-rect')).toBe('576, 318, 960×540');

      // Its bottom-right corner, seen at (484, 265), a few pixels off, dragged out.
      pointer('pointerdown', 480, 262);
      pointer('pointermove', 520, 300);
      pointer('pointerup', 520, 300);
      await update();
      expect(stored()).toEqual({ x: 576, y: 318, w: 1120, h: 692 });

      // A cancelled drag puts it back.
      pointer('pointerdown', 340, 185);
      pointer('pointermove', 100, 50);
      pointer('pointercancel', 100, 50);
      await update();
      expect(stored()).toEqual({ x: 576, y: 318, w: 1120, h: 692 });

      element('camera-full-frame')?.click();
      await update();
      expect(stored()).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    });

    it('on a mirrored preview, follows the pointer as seen', async () => {
      await render([FAKE_PHONE_FRONT], ANDROID);
      await turnOn();
      await edit();
      layout();
      TestBed.inject(CameraService).setFraming({ x: 480, y: 270, w: 960, h: 540 });
      await update();

      pointer('pointerdown', 340, 185);
      pointer('pointermove', 364, 185);
      pointer('pointerup', 364, 185);
      await update();
      // 24 px to the right as seen is 96 frame pixels to the left.
      expect(stored()).toEqual({ x: 384, y: 270, w: 960, h: 540 });

      // A handle names its corner in the frame: north-west is on the right as seen.
      pointer('pointerdown', 460, 118, element('camera-framing')?.querySelector('.nw'));
      pointer('pointermove', 470, 108);
      pointer('pointerup', 470, 108);
      await update();
      expect(stored()).toEqual({ x: 344, y: 230, w: 1000, h: 580 });
    });

    it('moves with the arrow keys and resizes with Shift and the arrow keys', async () => {
      await render();
      await turnOn();
      await edit();
      TestBed.inject(CameraService).setFraming({ x: 480, y: 270, w: 960, h: 540 });
      await update();
      const framing = element('camera-framing');
      expect(framing?.getAttribute('tabindex')).toBe('0');

      const press = (key: string, shiftKey = false): KeyboardEvent => {
        const event = new KeyboardEvent('keydown', {
          key,
          shiftKey,
          bubbles: true,
          cancelable: true,
        });
        framing?.dispatchEvent(event);
        return event;
      };
      expect(press('ArrowRight').defaultPrevented).toBe(true);
      press('ArrowUp');
      press('ArrowDown', true);
      press('ArrowLeft', true);
      expect(press('a').defaultPrevented).toBe(false);
      await update();
      // Steps of 2% of 1080: 22 pixels.
      expect(stored()).toEqual({ x: 502, y: 248, w: 938, h: 562 });
    });
  });
});
