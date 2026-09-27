import { type ComponentFixture, TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeLocalStorage, FakeStorageManager, FakeWakeLock, settle } from '../device/fake-browser';
import { SettingsPage } from './settings-page';
import { SETTINGS_STORAGE_KEY, SettingsService } from './settings-service';

describe('SettingsPage', () => {
  let wakeLock: FakeWakeLock;
  let storage: FakeStorageManager;
  let localStorage: FakeLocalStorage;

  async function render(): Promise<ComponentFixture<SettingsPage>> {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BROWSER_GLOBALS,
          useValue: {
            navigator: { wakeLock, storage, userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' },
            localStorage,
          },
        },
      ],
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

  function input(fixture: ComponentFixture<SettingsPage>, selector: string): HTMLInputElement {
    const found = (fixture.nativeElement as HTMLElement).querySelector(selector);
    if (!(found instanceof HTMLInputElement)) {
      throw new Error(`No input matches ${selector}.`);
    }
    return found;
  }

  function buttonNamed(fixture: ComponentFixture<SettingsPage>, name: string): HTMLButtonElement {
    const found = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ).find((b) => (b.getAttribute('aria-label') ?? b.textContent.trim()) === name);
    if (found === undefined) {
      throw new Error(`No button "${name}".`);
    }
    return found;
  }

  /** Types into an input as a person does: `input` events, then `change` when it loses focus. */
  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('change'));
  }

  async function update(fixture: ComponentFixture<SettingsPage>): Promise<void> {
    await settle();
    await fixture.whenStable();
  }

  /** The stored addresses as listed: name and address per row, or the row's text. */
  function macList(fixture: ComponentFixture<SettingsPage>): string[][] {
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll(
      '[data-testid="cube-macs"] li',
    );
    return Array.from(rows, (row) => {
      const name = row.querySelector('.mac-name');
      const mac = row.querySelector('code');
      return name && mac
        ? [name.textContent.trim(), mac.textContent.trim()]
        : [row.textContent.trim()];
    });
  }

  beforeEach(() => {
    wakeLock = new FakeWakeLock();
    storage = new FakeStorageManager({ grant: true, usage: 1_234_567, quota: 2_000_000_000 });
    localStorage = new FakeLocalStorage();
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

  it('adds, edits and removes cube MAC addresses, and refuses an invalid one', async () => {
    const fixture = await render();
    expect(macList(fixture)).toEqual([['None stored.']]);

    type(input(fixture, '#mac-name'), 'GAN12ui_AB12');
    type(input(fixture, '#mac-address'), 'ab-12-cd-34-ef-56');
    buttonNamed(fixture, 'Add').click();
    await update(fixture);
    expect(macList(fixture)).toEqual([['GAN12ui_AB12', 'AB:12:CD:34:EF:56']]);
    expect(input(fixture, '#mac-name').value).toBe('');

    type(input(fixture, '#mac-name'), 'GAN356i3_CD34');
    type(input(fixture, '#mac-address'), 'AB:12:CD:34:EF');
    buttonNamed(fixture, 'Add').click();
    await update(fixture);
    expect(text(fixture, 'mac-error')).toContain('"AB:12:CD:34:EF" is not a MAC address');
    expect(macList(fixture)).toEqual([['GAN12ui_AB12', 'AB:12:CD:34:EF:56']]);

    buttonNamed(fixture, 'Edit GAN12ui_AB12').click();
    await update(fixture);
    expect(input(fixture, '#mac-address').value).toBe('AB:12:CD:34:EF:56');
    type(input(fixture, '#mac-address'), '11:22:33:44:55:66');
    buttonNamed(fixture, 'Save').click();
    await update(fixture);
    expect(macList(fixture)).toEqual([['GAN12ui_AB12', '11:22:33:44:55:66']]);
    expect(TestBed.inject(SettingsService).macFor('GAN12ui_AB12')).toBe('11:22:33:44:55:66');

    buttonNamed(fixture, 'Remove GAN12ui_AB12').click();
    await update(fixture);
    expect(macList(fixture)).toEqual([['None stored.']]);
  });

  it('keeps the host label, inspection, auto-advance and the demo speed', async () => {
    const fixture = await render();
    const host = input(fixture, '#host-label');
    expect(host.placeholder).toBe('Linux laptop');

    type(host, 'office-mbp');
    const [inspection, autoAdvance] = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>(
        'section[aria-labelledby="timer-heading"] input',
      ),
    );
    expect([inspection.checked, autoAdvance.checked]).toEqual([false, true]);
    inspection.click();
    autoAdvance.click();
    type(input(fixture, '#demo-speed'), '20');
    await update(fixture);

    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null')).toMatchObject({
      hostLabel: 'office-mbp',
      inspection: true,
      autoAdvance: false,
      demoSpeed: 20,
    });

    type(input(fixture, '#demo-speed'), '500');
    await update(fixture);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'The speed must be a number from 0.1 to 100.',
    );
    expect(TestBed.inject(SettingsService).demoSpeed()).toBe(20);
  });
});
