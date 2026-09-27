import { type ComponentFixture, TestBed } from '@angular/core/testing';

import { ConnectDialogService } from '../connect/connect-dialog-service';
import { settle } from '../device/fake-browser';
import { inverse, ready, setup, turn } from '../session/session-harness';
import { TimerClock } from './timer-clock';

describe('TimerClock', () => {
  function text(fixture: ComponentFixture<TimerClock>, testId: string): string {
    const element = fixture.nativeElement as HTMLElement;
    return element.querySelector(`[data-testid="${testId}"]`)?.textContent.trim() ?? '';
  }

  function button(fixture: ComponentFixture<TimerClock>, testId: string): HTMLButtonElement {
    const element = fixture.nativeElement as HTMLElement;
    const found = element.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (found === null) {
      throw new Error(`No button ${testId}.`);
    }
    return found;
  }

  it('asks for a cube, and opens the connect dialog', async () => {
    const s = setup();
    await s.service.whenReady();
    const fixture = TestBed.createComponent(TimerClock);
    await fixture.whenStable();

    expect(text(fixture, 'timer-status')).toBe('Connect a cube to start.');
    expect(text(fixture, 'timer')).toBe('0.00');
    expect(text(fixture, 'attempt-index')).toBe('Attempt 1');
    expect(button(fixture, 'dnf').disabled).toBe(true);
    expect(button(fixture, 'delete-last').disabled).toBe(true);
    expect(button(fixture, 'new-session').disabled).toBe(true);
    button(fixture, 'timer-connect').click();
    expect(TestBed.inject(ConnectDialogService).isOpen()).toBe(true);
  });

  it('follows the attempt, and enables DNF, Delete last and New session when they apply', async () => {
    const s = setup();
    const fake = await ready(s);
    const fixture = TestBed.createComponent(TimerClock);
    await fixture.whenStable();

    expect(text(fixture, 'timer-status')).toBe('Scramble the cube as shown.');
    expect(button(fixture, 'skip').textContent).toContain('Skip scramble');
    turn(s, fake, 'R U F');
    await fixture.whenStable();
    expect(text(fixture, 'timer-status')).toBe('Ready: the timer starts with your first turn.');
    expect(text(fixture, 'timer')).toBe('0.00');
    expect(button(fixture, 'skip').disabled).toBe(true);
    expect(button(fixture, 'dnf').disabled).toBe(false);

    turn(s, fake, inverse('R U F'), 1000);
    await settle();
    await fixture.whenStable();
    expect(text(fixture, 'timer')).toBe('2.00');
    expect(text(fixture, 'attempt-index')).toBe('Attempt 2');
    expect(button(fixture, 'delete-last').disabled).toBe(false);
    expect(button(fixture, 'new-session').disabled).toBe(false);
    await s.service.whenSaved();
    await fixture.whenStable();
    expect(text(fixture, 'save-status')).toBe('Saved');

    button(fixture, 'delete-last').click();
    await fixture.whenStable();
    expect(s.service.attempts()).toEqual([]);
    expect(text(fixture, 'attempt-index')).toBe('Attempt 1');
  });
});
