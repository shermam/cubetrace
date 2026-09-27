import { type ComponentFixture, TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeStorageManager, FakeWakeLock, settle } from '../device/fake-browser';
import { SettingsPage } from './settings-page';

describe('SettingsPage', () => {
  let wakeLock: FakeWakeLock;
  let storage: FakeStorageManager;

  async function render(): Promise<ComponentFixture<SettingsPage>> {
    TestBed.configureTestingModule({
      providers: [{ provide: BROWSER_GLOBALS, useValue: { navigator: { wakeLock, storage } } }],
    });
    const fixture = TestBed.createComponent(SettingsPage);
    await settle();
    await fixture.whenStable();
    return fixture;
  }

  function text(fixture: ComponentFixture<SettingsPage>, testId: string): string | undefined {
    const element = (fixture.nativeElement as HTMLElement).querySelector(
      `[data-testid="${testId}"]`,
    );
    return element?.textContent.replace(/\s+/g, ' ').trim();
  }

  beforeEach(() => {
    wakeLock = new FakeWakeLock();
    storage = new FakeStorageManager({ grant: true, usage: 1_234_567, quota: 2_000_000_000 });
  });

  it('keeps the screen on while the switch is on', async () => {
    const fixture = await render();
    const element = fixture.nativeElement as HTMLElement;
    const toggle = element.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(toggle?.checked).toBe(false);
    expect(text(fixture, 'wake-lock-detail')).toBe(
      'The screen turns off after the system timeout.',
    );

    toggle?.click();
    await settle();
    await fixture.whenStable();
    expect(wakeLock.held()).toBe(1);
    expect(text(fixture, 'wake-lock-detail')).toBe(
      'The screen stays on while cubetrace is visible.',
    );

    toggle?.click();
    await settle();
    await fixture.whenStable();
    expect(wakeLock.held()).toBe(0);
  });

  it('shows the storage status and asks to keep the data', async () => {
    const fixture = await render();
    expect(text(fixture, 'storage-persistence')).toBe(
      'Best effort: the browser may delete cubetrace’s data when the disk runs short.',
    );
    expect(text(fixture, 'storage-usage')).toBe('Using 1.2 MB of the 2.0 GB this browser allows.');

    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((candidate) => candidate.textContent.trim() === 'Keep my data');
    button?.click();
    await settle();
    await fixture.whenStable();

    expect(storage.persistCalls).toBe(1);
    expect(text(fixture, 'storage-persistence')).toBe(
      'Persistent: the browser keeps cubetrace’s data until you delete it.',
    );
    expect(button?.disabled).toBe(true);
  });

  it('explains a refusal', async () => {
    storage.grant = false;
    const fixture = await render();

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button')?.click();
    await settle();
    await fixture.whenStable();

    expect(text(fixture, 'storage-refused')).toContain('The browser said no.');
  });
});
