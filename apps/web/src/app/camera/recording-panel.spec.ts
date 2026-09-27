import { TestBed } from '@angular/core/testing';

import { bluetoothNavigator } from '../cube/cube-testing';
import { FAKE_WEBCAM, FakeMediaDevices, settle } from '../device/fake-browser';
import { ready, setup, turn } from '../session/session-harness';
import { SettingsService } from '../settings/settings-service';
import { CameraService } from './camera-service';
import { RecordingPanel } from './recording-panel';
import { CAPTURE_STARTER, CLIP_TAIL_MS, ENCODER_SETTLE_MS } from './recording-service';
import { FakeCaptureStarter, statsOf } from './recording-testing';

describe('RecordingPanel', () => {
  async function render() {
    const media = new FakeMediaDevices([FAKE_WEBCAM]);
    const starter = new FakeCaptureStarter();
    const s = setup({
      navigator: { ...bluetoothNavigator(true), mediaDevices: media },
      providers: [{ provide: CAPTURE_STARTER, useValue: starter }],
    });
    const fixture = TestBed.createComponent(RecordingPanel);
    const element = fixture.nativeElement as HTMLElement;
    const update = async (): Promise<void> => {
      TestBed.tick();
      await settle();
      await fixture.whenStable();
    };
    await update();
    return { s, starter, element, update, camera: TestBed.inject(CameraService) };
  }

  function text(element: HTMLElement, testId: string): string | undefined {
    return element
      .querySelector(`[data-testid="${testId}"]`)
      ?.textContent.replace(/\s+/g, ' ')
      .trim();
  }

  it('says why it does not record, then what it records', async () => {
    const { s, starter, element, update, camera } = await render();
    expect(text(element, 'recording-state')).toBe('Off: the camera is off.');

    await camera.start();
    await update();
    expect(text(element, 'recording-state')).toBe(
      'Off: it starts with the session, once a cube is connected.',
    );

    await ready(s);
    await update();
    expect(text(element, 'recording-state')).toBe('Starting…');
    starter.last.emitStats(statsOf(12.34, { dropped: 1, bufferBytes: 1_500_000 }));
    await update();
    expect(text(element, 'recording-state')).toBe('Recording: every attempt gets its clips.');
    expect(text(element, 'recording-badge')).toBe('REC');
    const stats = element.querySelector('[data-testid="recording-stats"]');
    expect(stats?.getAttribute('data-buffer-seconds')).toBe('12.34');
    expect(stats?.getAttribute('data-dropped')).toBe('1');
    expect(stats?.textContent).toContain('30 per second in, 30 encoded, 1 dropped');
    expect(text(element, 'recording-buffer')).toBe('12.3 s, 1.5 MB');
    expect(text(element, 'recording-codecs')).toBe('vp09.00.40.08 at 4 Mbps, opus');
    expect(element.querySelector('[data-testid="storage-meter"]')).not.toBeNull();
  });

  it("says the video's bitrate and what an attempt takes at the video quality", async () => {
    const { s, starter, element, update, camera } = await render();
    const settings = TestBed.inject(SettingsService);
    // Not recording: at the bitrate of Settings' quality, resolution and frame rate.
    expect(text(element, 'recording-estimate')).toBe('≈ 20 MB per attempt at this quality');
    settings.setVideoQuality('high');
    await update();
    expect(text(element, 'recording-estimate')).toBe('≈ 40 MB per attempt at this quality');
    settings.setCameraResolution('720p');
    await update();
    expect(text(element, 'recording-estimate')).toBe('≈ 18 MB per attempt at this quality');
    settings.setCameraResolution('1080p');

    // Recording: at the bitrate the encoder took, here for frames at 60 fps; the codec first.
    await camera.start();
    await ready(s);
    await update();
    starter.last.emitStats(statsOf(3, { codec: null, bitrate: null }));
    await update();
    expect(text(element, 'recording-codecs')).toBe('choosing…, opus');
    starter.last.emitStats(
      statsOf(3, { codec: 'avc1.640028', bitrate: 12_000_000, audioCodec: 'mp4a.40.2' }),
    );
    await update();
    expect(text(element, 'recording-codecs')).toBe('avc1.640028 at 12 Mbps, mp4a.40.2');
    expect(text(element, 'recording-estimate')).toBe('≈ 60 MB per attempt at this quality');
    starter.last.emitStats(statsOf(4, { bitrate: 8_000_000, audioCodec: null }));
    await update();
    expect(text(element, 'recording-codecs')).toBe('vp09.00.40.08 at 8 Mbps, no audio');
  });

  it('says where the audio is when it is not encoded, and what a clip saved short lacks until dismissed', async () => {
    const { s, starter, element, update, camera } = await render();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await camera.start();
    const fake = await ready(s);
    await update();
    const audio = async (changes: Parameters<typeof statsOf>[1]): Promise<string | undefined> => {
      starter.last.emitStats(statsOf(5, changes));
      await update();
      return text(element, 'recording-codecs');
    };

    expect(await audio({ audioState: 'waiting', audioChunks: 0, audioCodec: null })).toBe(
      'vp09.00.40.08 at 4 Mbps, no audio yet (waiting for the microphone)',
    );
    expect(await audio({ audioState: 'stopped', audioCodec: null })).toBe(
      'vp09.00.40.08 at 4 Mbps, audio stopped',
    );
    expect(await audio({ audioState: 'off', audioChunks: 0, audioCodec: null })).toBe(
      'vp09.00.40.08 at 4 Mbps, no audio',
    );
    expect(await audio({})).toBe('vp09.00.40.08 at 4 Mbps, opus');

    // Two notices: both shown.
    starter.last.emitError({ message: 'Recording without audio: first.', fatal: false });
    starter.last.emitError({ message: 'The audio encoder failed.', fatal: false });
    await update();
    expect(
      Array.from(element.querySelectorAll('[data-testid="recording-notice"]'), (p) =>
        p.textContent.trim(),
      ),
    ).toEqual(['Recording without audio: first.', 'The audio encoder failed.']);

    turn(s, fake, 'R U F');
    s.timers.advance(CLIP_TAIL_MS + ENCODER_SETTLE_MS);
    await update();
    starter.last.saveNext({ truncatedStart: true }, { lateMs: 12_345, bufferSeconds: 89.7 });
    await update();
    expect(text(element, 'recording-clip-notice')).toBe(
      "Scramble clip of attempt 1 starts 12.3 s late: the buffer holds 90 s. The session's notes say so. Dismiss",
    );
    element
      .querySelector<HTMLButtonElement>('[data-testid="recording-clip-notice"] button')
      ?.click();
    await update();
    expect(element.querySelector('[data-testid="recording-clip-notice"]')).toBeNull();
  });

  it('shows the last clip, a clip that failed until dismissed, and why recording stopped', async () => {
    const { s, starter, element, update, camera } = await render();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await camera.start();
    const fake = await ready(s);
    await update();
    starter.last.emitStats(statsOf(5));

    turn(s, fake, 'R U F');
    s.timers.advance(CLIP_TAIL_MS + ENCODER_SETTLE_MS);
    await update();
    starter.last.saveNext({ frames: 131, bytes: 2_345_678 });
    await update();
    expect(text(element, 'recording-last-clip')).toBe(
      'Last clip: the scramble of attempt 1, 131 frames, 2.3 MB.',
    );

    turn(s, fake, "F' U' R'", 300);
    s.timers.advance(CLIP_TAIL_MS + ENCODER_SETTLE_MS);
    await update();
    starter.last.failNext('Error: QuotaExceededError');
    await update();
    expect(text(element, 'recording-failure')).toBe(
      "A clip could not be saved, and the session's notes say so: clip failed: solve of attempt 1: Error: QuotaExceededError Dismiss",
    );
    element.querySelector<HTMLButtonElement>('[data-testid="recording-failure"] button')?.click();
    await update();
    expect(element.querySelector('[data-testid="recording-failure"]')).toBeNull();

    starter.last.emitError({ message: 'No audio encoder: recording video only.', fatal: false });
    starter.last.emitError({ message: 'The video encoder failed: EncodingError', fatal: true });
    await update();
    expect(text(element, 'recording-notice')).toBe('No audio encoder: recording video only.');
    expect(text(element, 'recording-error')).toBe(
      'Recording stopped: The video encoder failed: EncodingError',
    );
    expect(text(element, 'recording-state')).toBe('Not recording.');
  });
});
