import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AttemptRecord } from '@cubetrace/core';

import { SESSION_A, testAttempt } from '../session/session-testing';
import { ClipViewing } from './clip-viewing';
import { SolveList, newest } from './solve-list';

async function render(
  attempts: readonly AttemptRecord[],
  inputs: { limit?: number | null; sessionId?: string | null; showStats?: boolean } = {},
): Promise<HTMLElement> {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(SolveList);
  fixture.componentRef.setInput('attempts', attempts);
  for (const [name, value] of Object.entries(inputs)) {
    fixture.componentRef.setInput(name, value);
  }
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

function indices(element: HTMLElement): string[] {
  return Array.from(element.querySelectorAll('[data-testid="solve-row"]'), (row) =>
    row.getAttribute('data-index'),
  ).map(String);
}

/** Attempts 1 to `count`, solved in 10 s plus a second per attempt. */
function attempts(count: number): AttemptRecord[] {
  return Array.from({ length: count }, (_, k) => testAttempt(k + 1, 10_000 + k * 1000));
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
      truncatedStart: false,
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

  it('marks the badge of an attempt whose clip begins later than asked', async () => {
    const clip = (segment: 'scramble' | 'solve', truncatedStart: boolean) => ({
      camera: 'laptop',
      segment,
      file: `laptop.${segment}.mp4`,
      bytes: 1_000_000,
      codec: 'avc1.640028',
      audio: null,
      width: 1920,
      height: 1080,
      crop: null,
      fpsNominal: 30,
      frames: 90,
      firstFrameHostMs: 1_790_000_000_000,
      framesFile: `laptop.${segment}.frames.json`,
      syncResidualMs: null,
      truncatedStart,
    });
    const element = await render([
      { ...testAttempt(1, 12_340), video: [clip('scramble', true), clip('solve', false)] },
      { ...testAttempt(2, 10_000), video: [clip('scramble', false), clip('solve', false)] },
      { ...testAttempt(3, 11_000), video: [clip('scramble', true), clip('solve', true)] },
    ]);
    const badges = Array.from(
      element.querySelectorAll<HTMLButtonElement>('[data-testid="clip-badge"]'),
    );

    expect(badges.map((badge) => badge.textContent.replace(/\s+/g, ' ').trim())).toEqual([
      '2 clips, 2.0 MB · late',
      '2 clips, 2.0 MB',
      '2 clips, 2.0 MB · late',
    ]);
    expect(badges[2].getAttribute('title')).toBe(
      'The scramble clip begins later than asked: its start was older than the 90 s kept in memory.',
    );
    expect(badges[2].getAttribute('aria-label')).toBe(
      'The clips of attempt 1: 2 clips, 2.0 MB. The scramble clip begins later than asked: its start was older than the 90 s kept in memory.',
    );
    expect(badges[0].getAttribute('title')).toBe(
      'Both clips begin later than asked: their starts were older than the 90 s kept in memory.',
    );
    expect(badges[1].getAttribute('title')).toBeNull();
  });

  it('has no rows before the first attempt', async () => {
    const element = await render([]);
    expect(element.querySelector('[data-testid="solve-row"]')).toBeNull();
    expect(element.textContent).toContain('No solves in this session yet.');
  });

  it('shows the newest `limit` solves, and under them how many there are and "See all"', async () => {
    const element = await render(attempts(15), { limit: 12, sessionId: SESSION_A });

    expect(indices(element)).toEqual([
      '15',
      '14',
      '13',
      '12',
      '11',
      '10',
      '9',
      '8',
      '7',
      '6',
      '5',
      '4',
    ]);
    // The statistics are the whole session's.
    expect(text(element, 'stat-count')).toBe('15');
    expect(text(element, 'stat-best')).toBe('10.00');
    expect(text(element, 'stat-ao12')).toBe('18.50');
    const footer = element.querySelector('[data-testid="solve-list-footer"]');
    expect(footer?.textContent.replace(/\s+/g, ' ').trim()).toBe(
      '15 solves in this session · See all',
    );
    expect(footer?.querySelector('a')?.getAttribute('href')).toBe(`/sessions/${SESSION_A}`);
  });

  it('shows all the solves with a limit they do not reach, and says "1 solve"', async () => {
    const element = await render(attempts(1), { limit: 12, sessionId: SESSION_A });
    expect(indices(element)).toEqual(['1']);
    expect(text(element, 'solve-list-footer')).toBe('1 solve in this session · See all');
  });

  it('has no footer without a limit, a session or a solve', async () => {
    expect(
      (await render(attempts(15), { sessionId: SESSION_A })).querySelectorAll(
        '[data-testid="solve-row"]',
      ),
    ).toHaveLength(15);
    TestBed.resetTestingModule();
    for (const [list, inputs] of [
      [attempts(15), { sessionId: SESSION_A }],
      [attempts(15), { limit: 12 }],
      [[], { limit: 12, sessionId: SESSION_A }],
    ] as const) {
      const element = await render(list, inputs);
      expect(element.querySelector('[data-testid="solve-list-footer"]')).toBeNull();
      TestBed.resetTestingModule();
    }
  });

  it('leaves the statistics out when asked', async () => {
    const element = await render(attempts(3), { showStats: false });
    expect(element.querySelector('[data-testid="session-stats"]')).toBeNull();
    expect(indices(element)).toEqual(['3', '2', '1']);
  });

  it('newest: the last `limit` attempts, newest first', () => {
    const all = attempts(5);
    expect(newest(all, 2).map((attempt) => attempt.index)).toEqual([5, 4]);
    expect(newest(all, 12).map((attempt) => attempt.index)).toEqual([5, 4, 3, 2, 1]);
    expect(newest(all, null).map((attempt) => attempt.index)).toEqual([5, 4, 3, 2, 1]);
    expect(newest(all, 0)).toEqual([]);
  });
});
