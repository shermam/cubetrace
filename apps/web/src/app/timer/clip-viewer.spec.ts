import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { AttemptRecord, VideoClip } from '@cubetrace/core';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { polyfillDialog, settle } from '../device/fake-browser';
import { ATTEMPT_FILES } from '../session/attempt-files';
import { SESSION_A, testAttempt } from '../session/session-testing';
import { ClipViewer, attemptFileName, clipMoves, moveAt } from './clip-viewer';
import { ClipViewing } from './clip-viewing';

/** testAttempt's moves: the scramble R U F at 100, 200, 300 ms, the solve at 1400, 2400, 3400. */
function clip(segment: 'scramble' | 'solve', firstFrameHostMs: number): VideoClip {
  return {
    camera: 'laptop',
    segment,
    file: `laptop.${segment}.mp4`,
    bytes: 1_234_567,
    codec: 'vp09.00.40.08',
    audio: 'opus',
    width: 1920,
    height: 1080,
    crop: null,
    fpsNominal: 30,
    frames: 150,
    firstFrameHostMs,
    framesFile: `laptop.${segment}.frames.json`,
    syncResidualMs: null,
    truncatedStart: false,
  };
}

const ATTEMPT: AttemptRecord = {
  ...testAttempt(3, 2000),
  video: [clip('scramble', -2000), clip('solve', -1000)],
};

describe('clipMoves and moveAt', () => {
  it('time the moves of the clip’s segment from its first frame, and find the one shown', () => {
    const solve = ATTEMPT.video[1];
    const moves = clipMoves(ATTEMPT, solve);
    expect(moves.map((move) => [move.m, move.seconds])).toEqual([
      ["F'", 2.4],
      ["U'", 3.4],
      ["R'", 4.4],
    ]);
    expect([0, 2.39, 2.4, 3.5, 99].map((seconds) => moveAt(moves, solve, seconds))).toEqual([
      -1, -1, 0, 1, 2,
    ]);
    expect(clipMoves(ATTEMPT, ATTEMPT.video[0]).map((move) => move.m)).toEqual(['R', 'U', 'F']);
    expect(attemptFileName(ATTEMPT, 'laptop.solve.mp4')).toBe(
      `cubetrace-session-${SESSION_A}-attempt-0003-laptop.solve.mp4`,
    );
  });
});

describe('ClipViewer', () => {
  let urls: string[];
  let revoked: string[];
  let reads: string[];
  let fixture: ComponentFixture<ClipViewer>;

  async function render(
    missing: readonly string[] = [],
    attempt: AttemptRecord = ATTEMPT,
  ): Promise<HTMLElement> {
    urls = [];
    revoked = [];
    reads = [];
    polyfillDialog();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BROWSER_GLOBALS,
          useValue: {
            URL: {
              createObjectURL: (blob: Blob) => {
                const url = `blob:${String(urls.length)}:${blob.type}`;
                urls.push(url);
                return url;
              },
              revokeObjectURL: (url: string) => {
                revoked.push(url);
              },
            },
          },
        },
        {
          provide: ATTEMPT_FILES,
          useValue: {
            read: (sessionId: string, index: number, name: string) => {
              reads.push(`${sessionId}/${String(index)}/${name}`);
              return missing.includes(name)
                ? Promise.reject(
                    new DOMException('A requested file was not found.', 'NotFoundError'),
                  )
                : Promise.resolve(
                    new Blob([name], {
                      type: name.endsWith('.mp4') ? 'video/mp4' : 'application/json',
                    }),
                  );
            },
          },
        },
      ],
    });
    TestBed.inject(ClipViewing).open(3);
    fixture = TestBed.createComponent(ClipViewer);
    fixture.componentRef.setInput('attempt', attempt);
    await update();
    return fixture.nativeElement as HTMLElement;
  }

  async function update(): Promise<void> {
    await settle();
    await fixture.whenStable();
  }

  function video(element: HTMLElement): HTMLVideoElement {
    const found = element.querySelector('video');
    if (found === null) {
      throw new Error('No video.');
    }
    return found;
  }

  /** A move as listed: its time and the move. */
  function moveText(item: Element): string {
    return `${item.querySelector('.t')?.textContent ?? ''} ${item.querySelector('.m')?.textContent ?? ''}`;
  }

  function current(element: HTMLElement): string[] {
    return Array.from(element.querySelectorAll('[data-testid="clip-move"].current'), moveText);
  }

  it("opens modal on the solve's clip, read from the attempt's folder behind an object URL", async () => {
    const element = await render();

    expect(element.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    expect(reads).toEqual([`${SESSION_A}/3/laptop.solve.mp4`]);
    expect(video(element).getAttribute('src')).toBe('blob:0:video/mp4');
    expect(
      Array.from(element.querySelectorAll('[data-testid="clip-segment"]'), (button) => [
        button.textContent.trim(),
        button.getAttribute('aria-pressed'),
      ]),
    ).toEqual([
      ['Scramble', 'false'],
      ['Solve', 'true'],
    ]);
    expect(element.querySelector('[data-testid="clip-facts"]')?.textContent.trim()).toBe(
      'laptop.solve.mp4: 1920×1080, 150 frames, 1.2 MB, vp09.00.40.08, opus.',
    );
    expect(Array.from(element.querySelectorAll('[data-testid="clip-move"]'), moveText)).toEqual([
      "2.40 s F'",
      "3.40 s U'",
      "4.40 s R'",
    ]);
    expect(
      element.querySelector('[data-testid="clip-move"] button')?.getAttribute('aria-label'),
    ).toBe("F' at 2.40 s");
  });

  it('highlights the move the video shows, and goes to a move clicked', async () => {
    const element = await render();
    const player = video(element);
    let position = 0;
    Object.defineProperty(player, 'currentTime', {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        position = value;
      },
    });
    expect(current(element)).toEqual([]);

    position = 3.5;
    player.dispatchEvent(new Event('timeupdate'));
    await update();
    expect(current(element)).toEqual(["3.40 s U'"]);

    element.querySelectorAll<HTMLButtonElement>('[data-testid="clip-move"] button')[2].click();
    expect(position).toBe(4.4);
    player.dispatchEvent(new Event('seeked'));
    await update();
    expect(current(element)).toEqual(["4.40 s R'"]);
  });

  it('shows the other clip when chosen, letting go of the first one’s URL', async () => {
    const element = await render();
    element.querySelector<HTMLButtonElement>('[data-segment="scramble"]')?.click();
    await update();

    expect(reads.at(-1)).toBe(`${SESSION_A}/3/laptop.scramble.mp4`);
    expect(revoked).toEqual(['blob:0:video/mp4']);
    expect(video(element).getAttribute('src')).toBe('blob:1:video/mp4');
    expect(current(element)).toEqual([]);
    expect(element.querySelectorAll('[data-testid="clip-move"]')).toHaveLength(3);

    fixture.destroy();
    expect(revoked).toEqual(['blob:0:video/mp4', 'blob:1:video/mp4']);
  });

  it('marks a clip that begins later than asked, its start older than the buffer', async () => {
    const element = await render();
    fixture.componentRef.setInput('attempt', {
      ...ATTEMPT,
      video: [{ ...clip('scramble', -2000), truncatedStart: true }, clip('solve', -1000)],
    });
    await update();
    element.querySelector<HTMLButtonElement>('[data-segment="scramble"]')?.click();
    await update();

    expect(
      Array.from(element.querySelectorAll('[data-testid="clip-segment"]'), (button) =>
        button.textContent.replace(/\s+/g, ' ').trim(),
      ),
    ).toEqual(['Scramble · late', 'Solve']);
    expect(element.querySelector('[data-testid="clip-facts"]')?.textContent.trim()).toBe(
      'laptop.scramble.mp4: 1920×1080, 150 frames, 1.2 MB, vp09.00.40.08, opus. It begins later ' +
        'than asked: its start was older than the 90 s kept in memory.',
    );
  });

  it('downloads both clips, their frame times and attempt.json, named after the attempt', async () => {
    const element = await render();
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });

    element.querySelector<HTMLButtonElement>('[data-testid="clip-download"]')?.click();
    await update();

    const prefix = `cubetrace-session-${SESSION_A}-attempt-0003-`;
    expect(names).toEqual([
      `${prefix}laptop.scramble.mp4`,
      `${prefix}laptop.scramble.frames.json`,
      `${prefix}laptop.solve.mp4`,
      `${prefix}laptop.solve.frames.json`,
      `${prefix}attempt.json`,
    ]);
    expect(element.querySelector('[data-testid="clip-download-error"]')).toBeNull();
  });

  it('says a clip deleted once uploaded is in the cloud, in place of its video, and downloads what is here', async () => {
    const solveGone: AttemptRecord = {
      ...ATTEMPT,
      video: [clip('scramble', -2000), { ...clip('solve', -1000), local: false }],
    };
    const element = await render([], solveGone);
    expect(reads).toEqual([]);
    expect(element.querySelector('video')).toBeNull();
    expect(element.querySelector('[data-testid="clip-cloud"]')?.textContent).toContain(
      'In the cloud: this clip was deleted from this device once its upload was confirmed',
    );
    expect(
      Array.from(element.querySelectorAll('[data-testid="clip-segment"]'), (button) =>
        button.textContent.replace(/\s+/g, ' ').trim(),
      ),
    ).toEqual(['Scramble', 'Solve · in the cloud']);
    // Its moves are still listed, by their time into the clip.
    expect(element.querySelectorAll('[data-testid="clip-move"]')).toHaveLength(3);
    expect(element.querySelector('.actions .muted')?.textContent.trim()).toBe(
      'the clip on this device, the frame times and attempt.json',
    );

    // The scramble's clip is here: it plays.
    element.querySelector<HTMLButtonElement>('[data-segment="scramble"]')?.click();
    await update();
    expect(reads).toEqual([`${SESSION_A}/3/laptop.scramble.mp4`]);
    expect(video(element).getAttribute('src')).toBe('blob:0:video/mp4');

    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    element.querySelector<HTMLButtonElement>('[data-testid="clip-download"]')?.click();
    await update();
    const prefix = `cubetrace-session-${SESSION_A}-attempt-0003-`;
    expect(names).toEqual([
      `${prefix}laptop.scramble.mp4`,
      `${prefix}laptop.scramble.frames.json`,
      `${prefix}laptop.solve.frames.json`,
      `${prefix}attempt.json`,
    ]);

    fixture.componentRef.setInput('attempt', {
      ...solveGone,
      video: solveGone.video.map((c) => ({ ...c, local: false })),
    });
    await update();
    expect(element.querySelector('.actions .muted')?.textContent.trim()).toBe(
      'the frame times and attempt.json (the clips are in the cloud)',
    );
  });

  it('says so when a file cannot be read, and closes', async () => {
    const element = await render(['laptop.solve.mp4', 'laptop.scramble.frames.json']);
    expect(element.querySelector('[data-testid="clip-error"]')?.textContent.trim()).toBe(
      'The clip could not be read: A requested file was not found.',
    );
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    element.querySelector<HTMLButtonElement>('[data-testid="clip-download"]')?.click();
    await update();
    expect(element.querySelector('[data-testid="clip-download-error"]')?.textContent.trim()).toBe(
      'The files could not be downloaded: A requested file was not found.',
    );

    element.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
    await update();
    expect(TestBed.inject(ClipViewing).index()).toBeNull();
  });
});
