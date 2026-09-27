import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { LumaSampler, type Canvas2D } from '@cubetrace/capture';

import { bluetoothNavigator } from '../cube/cube-testing';
import {
  FAKE_PHONE_FRONT,
  FAKE_WEBCAM,
  FakeMediaDevices,
  FakeVideoFrames,
  settle,
  type FakeCamera,
} from '../device/fake-browser';
import { StorageService } from '../device/storage-service';
import { ready, setup, turn, type Setup } from '../session/session-harness';
import { CameraPreview } from './camera-preview';
import { CameraService, LUMA_SAMPLER } from './camera-service';
import { CAPTURE_STARTER, CLIP_TAIL_MS, ENCODER_SETTLE_MS } from './recording-service';
import { FakeCaptureStarter, statsOf } from './recording-testing';

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

describe('CameraPreview', () => {
  let frames: FakeVideoFrames;
  let fixture: ComponentFixture<CameraPreview>;
  let s: Setup;
  let starter: FakeCaptureStarter;

  async function render(cameras: readonly FakeCamera[] = [FAKE_WEBCAM]): Promise<CameraService> {
    frames = new FakeVideoFrames();
    starter = new FakeCaptureStarter();
    // jsdom's <video> does not play.
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    s = setup({
      navigator: { ...bluetoothNavigator(true), mediaDevices: new FakeMediaDevices(cameras) },
      providers: [
        { provide: CAPTURE_STARTER, useValue: starter },
        {
          provide: LUMA_SAMPLER,
          useValue: new LumaSampler<CanvasImageSource>(() => new CheckerCanvas()),
        },
      ],
    });
    fixture = TestBed.createComponent(CameraPreview);
    await update();
    return TestBed.inject(CameraService);
  }

  async function update(): Promise<void> {
    TestBed.tick();
    await settle();
    await fixture.whenStable();
  }

  // jsdom's <video> presents no frames: the tests present them, through `frames`.
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

  function host(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function element(testId: string): HTMLElement | null {
    return host().querySelector(`[data-testid="${testId}"]`);
  }

  function text(testId: string): string | undefined {
    return element(testId)?.textContent.replace(/\s+/g, ' ').trim();
  }

  function samples(): number {
    return TestBed.inject(CameraService).sharpnessSamples();
  }

  it('is not there while the camera is off; on, it plays the camera with the framing rectangle', async () => {
    const camera = await render();
    expect(host().classList.contains('shown')).toBe(false);
    expect(element('camera-preview-box')).toBeNull();

    await camera.start();
    await update();
    expect(host().classList.contains('shown')).toBe(true);
    const video = element('camera-preview') as HTMLVideoElement;
    expect(video.muted).toBe(true);
    expect(video.srcObject).toBe(camera.stream());
    expect(element('camera-preview-box')?.querySelector('.frame')?.classList).not.toContain(
      'mirrored',
    );
    // The preview measures the frames.
    expect(frames.waiting).toBe(1);
    const framing = element('camera-preview-framing');
    expect([framing?.style.left, framing?.style.width]).toEqual(['0%', '100%']);
    camera.setFraming({ x: 480, y: 270, w: 960, h: 540 });
    await update();
    expect([framing?.style.left, framing?.style.top, framing?.style.width]).toEqual([
      '25%',
      '25%',
      '50%',
    ]);
    expect(text('camera-status')).toBe('– fps · sharpness – · idle · storage 0%');

    frames.present(20, 50);
    await update();
    expect(text('camera-status-fps')).toBe('20.0 fps');
    const sharpness = element('camera-status-sharpness');
    expect(sharpness?.getAttribute('data-good')).toBe('true');
    expect(sharpness?.querySelector('.value')?.classList).toContain('good');
    expect(Number(sharpness?.querySelector('.value')?.textContent)).toBeGreaterThan(1000);
    expect(sharpness?.title).toBe(
      'Sharpness of the framing rectangle: good (20 or more, Settings).',
    );

    camera.stop();
    await update();
    expect(host().classList.contains('shown')).toBe(false);
    expect(element('camera-preview')).toBeNull();
    expect(frames.waiting).toBe(0);
  });

  it('is mirrored for a front camera, rectangle included', async () => {
    const camera = await render([FAKE_PHONE_FRONT]);
    await camera.start();
    await update();
    expect(element('camera-preview-box')?.querySelector('.frame')?.classList).toContain('mirrored');
    expect(element('camera-preview-framing')).not.toBeNull();
  });

  it('holds the sharpness meter while an attempt is armed or solving', async () => {
    const camera = await render();
    await camera.start();
    const fake = await ready(s);
    await update();
    expect(s.service.phase()).toBe('scrambling');
    frames.present(1, 40);
    expect(samples()).toBe(1);

    // Scrambled: armed, then solving; 2 s of frames each, and no measurement.
    turn(s, fake, 'R U F');
    await update();
    expect(s.service.phase()).toBe('armed');
    frames.present(50, 40);
    expect(samples()).toBe(1);
    turn(s, fake, "F'");
    await update();
    expect(s.service.phase()).toBe('solving');
    frames.present(50, 40);
    expect(samples()).toBe(1);
    // Solved: measured again at once, then twice a second.
    turn(s, fake, "U' R'");
    await update();
    expect(s.service.phase()).not.toBe('solving');
    frames.present(26, 40);
    expect(samples()).toBe(3);
  });

  it('says what the recording does, and how full storage is', async () => {
    const camera = await render();
    await camera.start();
    await update();
    expect(text('camera-status-recording')).toBe('idle');

    // A cube, so a session: the pipeline starts, then records.
    const fake = await ready(s);
    await update();
    expect(text('camera-status-recording')).toBe('starting');
    starter.last.emitStats(statsOf(5));
    await update();
    const recording = element('camera-status-recording');
    expect(recording?.getAttribute('data-status')).toBe('recording');
    expect(recording?.querySelector('.dot')).not.toBeNull();

    // The scramble's clip is saved a second after the scramble.
    turn(s, fake, 'R U F');
    s.timers.advance(CLIP_TAIL_MS + ENCODER_SETTLE_MS);
    await update();
    expect(text('camera-status-recording')).toBe('saving');
    starter.last.saveNext();
    await update();
    expect(text('camera-status-recording')).toBe('recording');

    s.storage.usage = 850_000_000;
    await TestBed.inject(StorageService).refresh();
    await update();
    const storage = element('camera-status-storage');
    expect(storage?.textContent.trim()).toBe('storage 85%');
    expect(storage?.getAttribute('data-level')).toBe('warn');

    starter.last.emitError({ message: 'The video encoder failed: EncodingError', fatal: true });
    await update();
    expect(text('camera-status-recording')).toBe('stopped');
  });
});
