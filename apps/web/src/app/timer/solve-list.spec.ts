import { TestBed } from '@angular/core/testing';
import type { AttemptRecord } from '@cubetrace/core';

import { testAttempt } from '../session/session-testing';
import { ClipViewing } from './clip-viewing';
import { SolveList } from './solve-list';

async function render(attempts: readonly AttemptRecord[]): Promise<HTMLElement> {
  const fixture = TestBed.createComponent(SolveList);
  fixture.componentRef.setInput('attempts', attempts);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

function text(element: HTMLElement, testId: string): string {
  return element.querySelector(`[data-testid="${testId}"]`)?.textContent.trim() ?? '';
}

describe('SolveList', () => {
  it('lists the solves newest first, with their time, phases and flags', async () => {
    const element = await render([
      testAttempt(1, 12_340),
      testAttempt(2, null),
      testAttempt(3, 61_000, { corrected: true }),
    ]);

    const rows = Array.from(element.querySelectorAll('[data-testid="solve-row"]'));
    expect(rows.map((row) => row.getAttribute('data-index'))).toEqual(['3', '2', '1']);
    expect(rows.map((row) => row.querySelector('[data-testid="solve-time"]')?.textContent)).toEqual(
      ['1:01.00', 'DNF', '12.34'],
    );
    expect(
      rows.map((row) => Array.from(row.querySelectorAll('.flag'), (f) => f.textContent)),
    ).toEqual([['Corrected'], ['DNF'], []]);
    // A solve's mini bar has its eight phases; a DNF's is empty.
    expect(rows[0].querySelectorAll('g[data-phase]')).toHaveLength(8);
    expect(rows[1].querySelectorAll('g[data-phase]')).toHaveLength(0);
  });

  it('shows the session statistics', async () => {
    const times = [10_000, 12_000, 11_000, 13_000, 14_000];
    const element = await render(times.map((ms, k) => testAttempt(k + 1, ms)));

    expect(text(element, 'stat-count')).toBe('5');
    expect(text(element, 'stat-mean')).toBe('12.00');
    expect(text(element, 'stat-best')).toBe('10.00');
    expect(text(element, 'stat-ao5')).toBe('12.00');
    expect(text(element, 'stat-ao12')).toBe('–');
  });

  it("shows each attempt's clips on a badge that opens them", async () => {
    const clip = (segment: 'scramble' | 'solve', bytes: number) => ({
      camera: 'laptop',
      segment,
      file: `laptop.${segment}.mp4`,
      bytes,
      codec: 'vp09.00.40.08',
      audio: 'opus',
      width: 1920,
      height: 1080,
      crop: null,
      fpsNominal: 30,
      frames: 90,
      firstFrameHostMs: 1_790_000_000_000,
      framesFile: `laptop.${segment}.frames.json`,
      syncResidualMs: null,
    });
    const element = await render([
      { ...testAttempt(1, 12_340), video: [clip('scramble', 800_000), clip('solve', 3_450_000)] },
      testAttempt(2, 10_000),
      { ...testAttempt(3, 11_000), video: [clip('scramble', 900_000)] },
    ]);
    const badges = Array.from(
      element.querySelectorAll<HTMLButtonElement>('[data-testid="clip-badge"]'),
    );

    expect(badges.map((badge) => badge.textContent.trim())).toEqual([
      '1 clip, 900.0 kB',
      '2 clips, 4.3 MB',
    ]);
    expect(badges[1].getAttribute('aria-label')).toBe('The clips of attempt 1: 2 clips, 4.3 MB');
    badges[1].click();
    expect(TestBed.inject(ClipViewing).index()).toBe(1);
  });

  it('has no rows before the first attempt', async () => {
    const element = await render([]);
    expect(element.querySelector('[data-testid="solve-row"]')).toBeNull();
    expect(element.textContent).toContain('No solves in this session yet.');
  });
});
