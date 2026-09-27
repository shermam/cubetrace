import { TestBed } from '@angular/core/testing';
import { coreVersion } from '@cubetrace/core';
import { TimerPage } from './timer-page';

describe('TimerPage', () => {
  it('shows the version string of @cubetrace/core', async () => {
    const fixture = TestBed.createComponent(TimerPage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    expect(element.querySelector('h1')?.textContent).toBe('Timer');
    expect(element.querySelector('[data-testid="core-version"]')?.textContent).toBe(coreVersion());
  });
});
