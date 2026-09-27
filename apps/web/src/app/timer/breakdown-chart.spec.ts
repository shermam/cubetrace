import { TestBed } from '@angular/core/testing';
import { PHASE_NAMES, type AttemptRecord } from '@cubetrace/core';

import { testAttempt } from '../session/session-testing';
import { PHASE_COLOURS } from './breakdown';
import { BreakdownChart } from './breakdown-chart';

async function render(attempts: readonly AttemptRecord[]): Promise<HTMLElement> {
  const fixture = TestBed.createComponent(BreakdownChart);
  fixture.componentRef.setInput('attempts', attempts);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('BreakdownChart', () => {
  it('says the breakdown comes after the first solve', async () => {
    const element = await render([testAttempt(1, null)]);
    expect(element.textContent).toContain('The CFOP breakdown appears after the first solve.');
    expect(element.querySelector('svg')).toBeNull();
  });

  it('draws the last solve and the average as eight segments each, with a legend', async () => {
    const element = await render([
      testAttempt(1, 4000),
      testAttempt(2, 2000),
      testAttempt(3, null),
    ]);

    const last = element.querySelector('[data-testid="breakdown-last"]');
    const average = element.querySelector('[data-testid="breakdown-average"]');
    expect(last?.textContent).toContain('Last solve (#2)');
    expect(last?.textContent).toContain('2.00');
    expect(average?.textContent).toContain('Session average (2 solves)');
    expect(average?.textContent).toContain('3.00');
    const phases = last?.querySelectorAll('g[data-phase]') ?? [];
    expect(Array.from(phases, (g) => g.getAttribute('data-phase'))).toEqual(PHASE_NAMES);
    expect(Array.from(phases, (g) => g.querySelector('rect')?.getAttribute('fill'))).toEqual(
      PHASE_NAMES.map((name) => PHASE_COLOURS[name]),
    );
    expect(phases[0]?.querySelector('title')?.textContent).toMatch(/^Cross: \d+ ms, \d+ moves?$/);
    // On one scale: the average (3 s) fills the width, the last solve (2 s) two thirds of it.
    const end = (bar: Element | null): number =>
      Math.max(
        ...Array.from(bar?.querySelectorAll('g[data-phase] > rect:first-of-type') ?? [], (rect) => {
          return (
            Number.parseFloat(rect.getAttribute('x') ?? '0') +
            Number.parseFloat(rect.getAttribute('width') ?? '0')
          );
        }),
      );
    expect(end(last)).toBeCloseTo(66.667, 2);
    expect(end(average)).toBeCloseTo(100, 6);

    const legend = Array.from(element.querySelectorAll('.legend li'), (li) =>
      li.textContent.trim(),
    );
    expect(legend).toEqual(['Cross', 'F2L 1', 'F2L 2', 'F2L 3', 'F2L 4', 'EOLL', 'OCLL', 'PLL']);
    const rows = element.querySelectorAll('table tbody tr');
    expect(rows).toHaveLength(8);
  });
});
