import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { MemorySessionStore } from '@cubetrace/core';
import { FakeCube, MAC_FLAG_URL } from '@cubetrace/gan';

import { ConnectDialog } from '../connect/connect-dialog';
import { ConnectDialogService } from '../connect/connect-dialog-service';
import { asGanCube, bluetoothNavigator } from '../cube/cube-testing';
import { polyfillDialog, settle } from '../device/fake-browser';
import { type Setup, inverse, ready, setup, turn } from '../session/session-harness';
import { TimerClock } from './timer-clock';

/** The clock with the connect dialog, which the app shell holds once for every page. */
@Component({
  imports: [ConnectDialog, TimerClock],
  template: `<app-timer-clock /><app-connect-dialog />`,
})
class ClockWithDialog {}

describe('TimerClock', () => {
  function text(fixture: ComponentFixture<unknown>, testId: string): string {
    const element = fixture.nativeElement as HTMLElement;
    return (
      element.querySelector(`[data-testid="${testId}"]`)?.textContent.replace(/\s+/g, ' ').trim() ??
      ''
    );
  }

  function has(fixture: ComponentFixture<unknown>, testId: string): boolean {
    const element = fixture.nativeElement as HTMLElement;
    return element.querySelector(`[data-testid="${testId}"]`) !== null;
  }

  function button(fixture: ComponentFixture<unknown>, testId: string): HTMLButtonElement {
    const element = fixture.nativeElement as HTMLElement;
    const found = element.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (found === null) {
      throw new Error(`No button ${testId}.`);
    }
    return found;
  }

  describe('connecting a cube', () => {
    // One fixture for both: only the latest fixture's element is in the document, and a form
    // outside it does not submit.
    let clock: ComponentFixture<ClockWithDialog>;

    async function render(s: Setup): Promise<void> {
      await s.service.whenReady();
      clock = TestBed.createComponent(ClockWithDialog);
      await stable();
    }

    async function stable(): Promise<void> {
      await settle();
      await clock.whenStable();
    }

    function dialogElement(): HTMLDialogElement {
      const element = (clock.nativeElement as HTMLElement).querySelector('dialog');
      if (element === null) {
        throw new Error('No <dialog>.');
      }
      return element;
    }

    function dialogOpen(): boolean {
      return dialogElement().open;
    }

    /** The text of `testId` in the dialog. */
    function inDialog(testId: string): string {
      const element = dialogElement().querySelector(`[data-testid="${testId}"]`);
      return element?.textContent.replace(/\s+/g, ' ').trim() ?? '';
    }

    function connectButton(): HTMLButtonElement {
      return button(clock, 'timer-connect');
    }

    beforeAll(() => {
      polyfillDialog();
    });

    it('asks for a cube; one click on "Connect a cube" connects it, with no dialog before or after', async () => {
      const s = setup();
      await render(s);

      expect(text(clock, 'timer-status')).toBe('Connect a cube to start.');
      expect(text(clock, 'timer')).toBe('0.00');
      expect(text(clock, 'attempt-index')).toBe('Attempt 1');
      expect(button(clock, 'dnf').disabled).toBe(true);
      expect(button(clock, 'delete-last').disabled).toBe(true);
      expect(button(clock, 'new-session').disabled).toBe(true);
      expect(connectButton().textContent.trim()).toBe('Connect a cube');
      expect(text(clock, 'try-demo')).toBe('Try the demo');

      connectButton().click();
      await stable();
      // The click itself called connectGanCube, which opens Chrome's device picker.
      expect(s.connector.calls).toHaveLength(1);
      expect(connectButton().textContent.trim()).toBe('Connecting…');
      expect(connectButton().disabled).toBe(true);
      expect(connectButton().querySelector('.spinner')).not.toBeNull();
      expect(has(clock, 'connect-cancel')).toBe(true);
      expect(has(clock, 'try-demo')).toBe(false);
      expect(text(clock, 'timer-status')).toBe('Connecting the cube…');
      expect(dialogOpen()).toBe(false);

      s.connector.last.resolve(asGanCube(new FakeCube({ now: () => s.perf.hostMs })));
      await stable();
      expect(s.cube.status()).toBe('connected');
      expect(has(clock, 'timer-connect')).toBe(false);
      expect(dialogOpen()).toBe(false);
    });

    it('a cube whose MAC address Chrome cannot read: the dialog opens on the prompt and the flag steps; answering connects and closes it', async () => {
      const s = setup({ navigator: bluetoothNavigator(false) });
      await render(s);

      connectButton().click();
      await stable();
      expect(dialogOpen()).toBe(false);
      const answer = s.connector.last.macProvider({ name: 'GAN12ui_AB12', id: 'd1' }, true);
      await stable();
      expect(dialogOpen()).toBe(true);
      expect(TestBed.inject(ConnectDialogService).reason()).toBe('prompt');
      expect(inDialog('mac-device')).toBe('GAN12ui_AB12');
      const folded = dialogElement().querySelector<HTMLDetailsElement>(
        '[data-testid="flag-details"]',
      );
      expect(folded?.open).toBe(false);
      expect(folded?.querySelector('[data-testid="flag-url"]')?.textContent).toBe(MAC_FLAG_URL);

      const input = dialogElement().querySelector<HTMLInputElement>('[data-testid="mac-input"]');
      if (input === null) {
        throw new Error('No MAC input.');
      }
      input.value = 'AB:12:CD:34:EF:56';
      input.dispatchEvent(new Event('input'));
      await stable();
      dialogElement().querySelector<HTMLButtonElement>('form button')?.click();
      expect(await answer).toBe('AB:12:CD:34:EF:56');
      await stable();
      expect(dialogOpen()).toBe(false);
      expect(connectButton().textContent.trim()).toBe('Connecting…');

      s.connector.last.resolve(asGanCube(new FakeCube({ now: () => s.perf.hostMs })));
      await stable();
      expect(s.cube.status()).toBe('connected');
      expect(dialogOpen()).toBe(false);
    });

    it('a failure is written under the button, with Details; no dialog opens until Details is clicked', async () => {
      const s = setup();
      await render(s);

      connectButton().click();
      s.connector.last.reject(
        new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError'),
      );
      await stable();
      const message =
        "No cube was chosen: pick the cube in Chrome's list of devices to connect it.";
      expect(text(clock, 'connect-error')).toBe(`${message} Details`);
      expect(connectButton().textContent.trim()).toBe('Connect a cube');
      expect(connectButton().disabled).toBe(false);
      expect(dialogOpen()).toBe(false);

      button(clock, 'connect-details').click();
      await stable();
      expect(dialogOpen()).toBe(true);
      expect(TestBed.inject(ConnectDialogService).reason()).toBe('error');
      expect(inDialog('connect-error')).toBe(message);

      // Connecting again from the page clears the message.
      TestBed.inject(ConnectDialogService).close();
      await stable();
      connectButton().click();
      await stable();
      expect(has(clock, 'connect-error')).toBe(false);
      expect(s.connector.calls).toHaveLength(2);
    });

    it('Cancel gives up connecting', async () => {
      const s = setup();
      await render(s);

      connectButton().click();
      await stable();
      button(clock, 'connect-cancel').click();
      await stable();

      expect(s.cube.status()).toBe('disconnected');
      expect(connectButton().textContent.trim()).toBe('Connect a cube');
      expect(text(clock, 'timer-status')).toBe('Connect a cube to start.');
      expect(dialogOpen()).toBe(false);
    });

    it('in a browser without Web Bluetooth, the click opens the dialog, which says so and offers the demo cube', async () => {
      const s = setup({ navigator: {} });
      await render(s);
      expect(connectButton().disabled).toBe(false);
      expect(connectButton().getAttribute('aria-haspopup')).toBe('dialog');

      connectButton().click();
      await stable();
      expect(s.connector.calls).toHaveLength(0);
      expect(dialogOpen()).toBe(true);
      expect(TestBed.inject(ConnectDialogService).reason()).toBe('support');
      expect(inDialog('bluetooth-hint')).toContain(
        'This browser cannot connect to a Bluetooth cube.',
      );
      expect(dialogElement().querySelector('.actions')?.textContent).toContain('Demo cube');
    });

    it('"Try the demo" connects the demo cube with the address\'s ?demo, ?speed and ?misscramble', async () => {
      const s = setup();
      await render(s);
      await TestBed.inject(Router).navigateByUrl('/?demo=1&speed=20&misscramble=1');
      const startDemo = vi.spyOn(s.cube, 'startDemo');

      button(clock, 'try-demo').click();
      await stable();
      await stable();

      expect(startDemo).toHaveBeenCalledWith({ demo: '1', speed: '20', misscramble: '1' });
      expect(s.cube.status()).toBe('connected');
      expect(s.cube.demo()?.index).toBe(1);
      expect(dialogOpen()).toBe(false);
      await s.cube.disconnect();
    });

    it('while an attempt waits for its cube, "Reconnect" connects it again', async () => {
      const s = setup();
      const fake = await ready(s);
      await render(s);
      turn(s, fake, 'R U F');
      turn(s, fake, "F'", 1000);
      await fake.disconnect('The Bluetooth connection was closed.');
      await stable();

      expect(text(clock, 'timer-status')).toBe(
        'The cube disconnected: connect it again to go on with this attempt.',
      );
      expect(connectButton().textContent.trim()).toBe('Reconnect');
      connectButton().click();
      await stable();
      expect(s.connector.calls).toHaveLength(2);
      expect(connectButton().textContent.trim()).toBe('Connecting…');
      expect(dialogOpen()).toBe(false);
    });
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
    expect(has(fixture, 'save-status')).toBe(false);
  });

  it('says under a result which attempt it was and whether it is saved; nothing under a running time', async () => {
    const store = new MemorySessionStore();
    const saveAttempt = store.saveAttempt.bind(store);
    let release = (): void => undefined;
    store.saveAttempt = async (attempt) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await saveAttempt(attempt);
    };
    const s = setup({ store });
    const fake = await ready(s);
    const fixture = TestBed.createComponent(TimerClock);
    turn(s, fake, 'R U F');
    await s.service.whenSaved();
    await fixture.whenStable();
    // Armed, then solving: the session is saved, but the line is about this attempt only.
    expect(text(fixture, 'attempt-index')).toBe('Attempt 1');
    expect(has(fixture, 'save-status')).toBe(false);
    turn(s, fake, "F'", 1000);
    await fixture.whenStable();
    expect(text(fixture, 'timer-status')).toBe('Solving…');
    expect(has(fixture, 'result-index')).toBe(false);
    expect(has(fixture, 'save-status')).toBe(false);

    turn(s, fake, "U' R'", 500);
    await settle();
    await fixture.whenStable();
    expect(text(fixture, 'timer')).toBe('1.00');
    expect(text(fixture, 'result-index')).toBe('#1');
    expect(text(fixture, 'save-status')).toBe('Saving…');
    // Auto-advance: the next attempt is under way while the time shows the last one's result.
    expect(text(fixture, 'attempt-index')).toBe('Attempt 2');
    release();
    await s.service.whenSaved();
    await fixture.whenStable();
    expect(text(fixture, 'result-index')).toBe('#1');
    expect(text(fixture, 'save-status')).toBe('Saved');
  });

  it('says Not saved under a result whose record could not be written', async () => {
    const store = new MemorySessionStore();
    store.saveAttempt = () => Promise.reject(new Error('The disk is full.'));
    const s = setup({ store });
    const fake = await ready(s);
    const fixture = TestBed.createComponent(TimerClock);
    turn(s, fake, 'R U F');
    turn(s, fake, inverse('R U F'));
    await s.service.whenSaved();
    await fixture.whenStable();

    expect(text(fixture, 'result-index')).toBe('#1');
    expect(text(fixture, 'save-status')).toBe('Not saved');
    expect(text(fixture, 'save-error')).toBe('Not saved: The disk is full.');
  });
});
