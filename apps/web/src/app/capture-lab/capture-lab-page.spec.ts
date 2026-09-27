import { type ComponentFixture, TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { settle } from '../device/fake-browser';
import { CaptureLabPage } from './capture-lab-page';

/** Stands for a browser API (a constructor) the page only checks the presence of. */
const present = (): void => undefined;

// The pipeline itself needs Chrome (MediaStreamTrackProcessor, WebCodecs, a module worker), so it
// runs in apps/web/e2e/capture.spec.ts; these tests cover what the page does around it.
describe('CaptureLabPage', () => {
  async function render(globals: object): Promise<ComponentFixture<CaptureLabPage>> {
    TestBed.configureTestingModule({
      providers: [{ provide: BROWSER_GLOBALS, useValue: globals }],
    });
    const fixture = TestBed.createComponent(CaptureLabPage);
    await fixture.whenStable();
    return fixture;
  }

  function text(fixture: ComponentFixture<CaptureLabPage>, testId: string): string | undefined {
    const element = (fixture.nativeElement as HTMLElement).querySelector(
      `[data-testid="${testId}"]`,
    );
    return element?.textContent.replace(/\s+/g, ' ').trim();
  }

  function buttons(fixture: ComponentFixture<CaptureLabPage>): HTMLButtonElement[] {
    return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
  }

  function button(fixture: ComponentFixture<CaptureLabPage>, name: string): HTMLButtonElement {
    const found = buttons(fixture).find((element) => element.textContent.trim() === name);
    if (found === undefined) {
      throw new Error(`No button "${name}".`);
    }
    return found;
  }

  it('names what a browser without the capture APIs lacks, and offers nothing to press', async () => {
    const fixture = await render({ navigator: {} });

    expect(text(fixture, 'lab-unsupported')).toBe(
      'This browser lacks MediaStreamTrackProcessor, VideoEncoder, Worker and camera access ' +
        '(navigator.mediaDevices): the capture pipeline needs Chrome.',
    );
    expect(buttons(fixture)).toEqual([]);
  });

  it('opens the camera at 1080p with audio, and says why when it is refused', async () => {
    const getUserMedia = vi.fn(() =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
    );
    const fixture = await render({
      MediaStreamTrackProcessor: present,
      VideoEncoder: present,
      Worker: present,
      navigator: { mediaDevices: { getUserMedia } },
    });
    expect(text(fixture, 'lab-unsupported')).toBeUndefined();
    expect(text(fixture, 'lab-status')).toBe('Not started.');
    expect(button(fixture, 'Stop').disabled).toBe(true);
    expect(button(fixture, 'Cut the last 3 s').disabled).toBe(true);
    expect(button(fixture, 'Mux and save the last 3 s').disabled).toBe(true);
    // The sync check needs the camera running.
    expect(button(fixture, 'Sync check').disabled).toBe(true);
    expect(text(fixture, 'lab-sync-status')).toBe(
      'Not run yet: start the camera, connect a cube (the cube button at the top), then Sync check.',
    );
    expect(text(fixture, 'lab-clip-files')).toBeUndefined();

    button(fixture, 'Start').click();
    await settle();
    await fixture.whenStable();

    expect(getUserMedia).toHaveBeenCalledWith({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
      audio: true,
    });
    expect(text(fixture, 'lab-status')).toBe('Could not start: Permission denied');
    expect(button(fixture, 'Start').disabled).toBe(false);
    expect(button(fixture, 'Stop').disabled).toBe(true);
  });

  it('asks for video only when Audio is unticked, and cuts as many seconds as typed', async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new Error('no camera here')));
    const fixture = await render({
      MediaStreamTrackProcessor: present,
      VideoEncoder: present,
      Worker: present,
      navigator: { mediaDevices: { getUserMedia } },
    });
    const element = fixture.nativeElement as HTMLElement;
    const audio = element.querySelector<HTMLInputElement>('#lab-audio');
    const seconds = element.querySelector<HTMLInputElement>('#lab-seconds');
    if (audio === null || seconds === null) {
      throw new Error('the fields are missing');
    }

    audio.click();
    seconds.value = '10';
    seconds.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    button(fixture, 'Start').click();
    await settle();

    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: false }));
    expect(button(fixture, 'Cut the last 10 s').disabled).toBe(true);
    expect(button(fixture, 'Mux and save the last 10 s').disabled).toBe(true);
  });
});
