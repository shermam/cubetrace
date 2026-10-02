import { type ComponentFixture, TestBed } from '@angular/core/testing';

import { ACCOUNT_LOADER } from '../auth/account-backend';
import { FakeAccountBackend } from '../auth/fake-account';
import { BROWSER_GLOBALS } from '../device/browser-globals';
import { FakeLocalStorage, FakeStorageManager, FakeWakeLock, settle } from '../device/fake-browser';
import { SettingsPage } from './settings-page';
import { SETTINGS_STORAGE_KEY, SettingsService } from './settings-service';

describe('SettingsPage', () => {
  let wakeLock: FakeWakeLock;
  let storage: FakeStorageManager;
  let localStorage: FakeLocalStorage;

  async function render(
    navigator: Record<string, unknown> = {},
  ): Promise<ComponentFixture<SettingsPage>> {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: BROWSER_GLOBALS,
          useValue: {
            navigator: {
              wakeLock,
              storage,
              userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
              ...navigator,
            },
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

  it('says, signed in, that the cube list is synced with the account and when it last merged; nothing signed out', async () => {
    const backend = new FakeAccountBackend();
    TestBed.overrideProvider(ACCOUNT_LOADER, { useValue: backend.loader });
    const fixture = await render();
    expect(text(fixture, 'cube-macs-sync')).toBeUndefined();

    buttonNamed(fixture, 'Sign in with Google').click();
    await update(fixture);
    await update(fixture);
    expect(text(fixture, 'cube-macs-sync')).toMatch(
      /^Synced with your account\. Last merged .+\.$/,
    );

    type(input(fixture, '#mac-name'), 'GAN12ui_AB12');
    type(input(fixture, '#mac-address'), 'ab-12-cd-34-ef-56');
    buttonNamed(fixture, 'Add').click();
    await update(fixture);
    expect(backend.cubeWrites).toEqual(['users/ada-uid/cubes/GAN12ui_AB12']);
    expect(backend.cubes.get('ada-uid')?.get('GAN12ui_AB12')?.mac).toBe('AB:12:CD:34:EF:56');

    // Offline, the change waits to be sent, and the line says so.
    backend.online = false;
    buttonNamed(fixture, 'Remove GAN12ui_AB12').click();
    await update(fixture);
    expect(text(fixture, 'cube-macs-sync')).toMatch(/ 1 change waits to be sent\.$/);
    backend.goOnline();
    await update(fixture);
    expect(text(fixture, 'cube-macs-sync')).not.toContain('wait');
    expect(text(fixture, 'cube-macs-sync-error')).toBeUndefined();

    buttonNamed(fixture, 'Sign out').click();
    await update(fixture);
    expect(text(fixture, 'cube-macs-sync')).toBeUndefined();
  });

  it('keeps the idle disconnection, from 0 to 60 whole minutes', async () => {
    const fixture = await render();
    const idle = input(fixture, '#idle-minutes');
    const label = (fixture.nativeElement as HTMLElement).querySelector('label[for="idle-minutes"]');
    expect(label?.textContent.trim()).toBe(
      'Disconnect the cube after this many minutes without a turn',
    );
    expect(idle.value).toBe('5');

    type(idle, '1');
    await update(fixture);
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null')).toMatchObject({
      idleDisconnectMinutes: 1,
    });

    for (const bad of ['61', '2.5', '-1', '']) {
      type(idle, bad);
      await update(fixture);
      expect(text(fixture, 'idle-error')).toBe('The minutes must be a whole number from 0 to 60.');
    }
    expect(TestBed.inject(SettingsService).idleDisconnectMinutes()).toBe(1);

    type(idle, '0');
    await update(fixture);
    expect(text(fixture, 'idle-error')).toBeUndefined();
    expect(TestBed.inject(SettingsService).idleDisconnectMinutes()).toBe(0);
  });

  it('keeps the camera resolution, frame rate and sharpness threshold', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    const resolution = root.querySelector<HTMLSelectElement>('#camera-resolution');
    const rate = root.querySelector<HTMLSelectElement>('#camera-frame-rate');
    const threshold = input(fixture, '#sharpness-threshold');
    const options = (select: HTMLSelectElement | null) =>
      Array.from(select?.options ?? [], (option) => option.text.trim());
    expect(options(resolution)).toEqual(['1920×1080', '1280×720']);
    expect(options(rate)).toEqual(['Best (asks for 60 fps)', 'Exactly 60 fps', '30 fps']);
    expect(resolution?.value).toBe('1080p');
    expect(rate?.value).toBe('best');
    expect(threshold.value).toBe('20');

    const choose = (select: HTMLSelectElement | null, value: string): void => {
      if (select) {
        select.value = value;
        select.dispatchEvent(new Event('change'));
      }
    };
    choose(resolution, '720p');
    choose(rate, '60');
    type(threshold, '12.5');
    await update(fixture);
    const settings = TestBed.inject(SettingsService);
    expect(settings.cameraResolution()).toBe('720p');
    expect(settings.cameraFrameRate()).toBe('60');
    expect(settings.sharpnessThreshold()).toBe(12.5);
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null')).toMatchObject({
      cameraResolution: '720p',
      cameraFrameRate: '60',
      sharpnessThreshold: 12.5,
    });

    for (const bad of ['0', '-4', 'soft', '']) {
      type(threshold, bad);
      await update(fixture);
      expect(text(fixture, 'threshold-error')).toBe(
        'The threshold must be a number above 0 (100000 at most).',
      );
    }
    expect(settings.sharpnessThreshold()).toBe(12.5);
  });

  it('keeps the video quality, Standard by default, its choices at the resolution and frame rate', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    const quality = root.querySelector<HTMLSelectElement>('#video-quality');
    const options = (): string[] =>
      Array.from(quality?.options ?? [], (option) => option.text.trim());
    expect(options()).toEqual([
      'Standard (4 Mbps, ≈ 20 MB per attempt)',
      'High (8 Mbps, ≈ 40 MB per attempt)',
      'Maximum (12 Mbps, ≈ 60 MB per attempt)',
    ]);
    expect(quality?.value).toBe('standard');

    if (quality) {
      quality.value = 'high';
      quality.dispatchEvent(new Event('change'));
    }
    await update(fixture);
    const settings = TestBed.inject(SettingsService);
    expect(settings.videoQuality()).toBe('high');
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null')).toMatchObject({
      videoQuality: 'high',
    });

    // Exactly 60 fps: 1.5 times as much.
    settings.setCameraFrameRate('60');
    await update(fixture);
    expect(options()).toEqual([
      'Standard (6 Mbps, ≈ 30 MB per attempt)',
      'High (12 Mbps, ≈ 60 MB per attempt)',
      'Maximum (18 Mbps, ≈ 90 MB per attempt)',
    ]);
    expect(quality?.value).toBe('high');
  });

  it('keeps Record audio, on by default', async () => {
    const fixture = await render();
    const box = input(fixture, '[data-testid="record-audio"]');
    expect(box.checked).toBe(true);

    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await update(fixture);

    expect(TestBed.inject(SettingsService).recordAudio()).toBe(false);
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null')).toMatchObject({
      recordAudio: false,
    });
  });

  it('keeps Scramble over the picture, a switch of the Timer section, on by default', async () => {
    const fixture = await render();
    const box = input(fixture, '[data-testid="scramble-over-picture"]');
    expect(box.closest('section')?.getAttribute('aria-labelledby')).toBe('timer-heading');
    expect(box.closest('label')?.textContent.trim()).toBe('Scramble over the picture (phone)');
    expect(box.checked).toBe(true);

    box.click();
    await update(fixture);
    expect(TestBed.inject(SettingsService).scrambleOverPicture()).toBe(false);
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null')).toMatchObject({
      scrambleOverPicture: false,
    });

    box.click();
    await update(fixture);
    expect(TestBed.inject(SettingsService).scrambleOverPicture()).toBe(true);
  });

  it('keeps the microphone, Raw by default, and says what each choice does', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    const microphone = root.querySelector<HTMLSelectElement>('#microphone-processing');
    expect(Array.from(microphone?.options ?? [], (option) => option.text.trim())).toEqual([
      'Raw',
      'Voice',
    ]);
    expect(microphone?.value).toBe('raw');
    expect(root.querySelector('label[for="microphone-processing"]')?.textContent.trim()).toBe(
      'Microphone',
    );
    expect(text(fixture, 'microphone-hint')).toMatch(
      /^Raw keeps the cube's clicks; Voice lets the browser suppress noise for speech\. /,
    );

    if (microphone) {
      microphone.value = 'voice';
      microphone.dispatchEvent(new Event('change'));
    }
    await update(fixture);
    expect(TestBed.inject(SettingsService).microphoneProcessing()).toBe('voice');
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null')).toMatchObject({
      microphoneProcessing: 'voice',
    });
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

  it('ends with the account (Sign in with Google, what it does, then the account and Sign out) and the uploads', async () => {
    const backend = new FakeAccountBackend();
    TestBed.overrideProvider(ACCOUNT_LOADER, { useValue: backend.loader });
    const fixture = await render();
    const sections = (fixture.nativeElement as HTMLElement).querySelectorAll('section');
    const account = sections[sections.length - 2];
    expect(account.id).toBe('account');
    expect(account.querySelector('h2')?.textContent).toBe('Account');
    expect(sections[sections.length - 1].id).toBe('uploads');
    expect(text(fixture, 'account-hint')).toBe(
      'Signing in with Google records your name, your email and the label of this device, ' +
        '“Linux laptop”, in your cubetrace account, and keeps an index of your sessions there: ' +
        'their records without the moves, so that the Sessions page of each of your devices lists ' +
        'them all (demo sessions stay on the device). Their files are uploaded as Uploads, below, ' +
        'says.',
    );
    expect(backend.loads).toBe(0);

    buttonNamed(fixture, 'Sign in with Google').click();
    await update(fixture);
    expect(text(fixture, 'account-name')).toBe('Ada Lovelace');
    expect(text(fixture, 'account-email')).toBe('ada@example.com');
    buttonNamed(fixture, 'Sign out').click();
    await update(fixture);
    expect(buttonNamed(fixture, 'Sign in with Google')).toBeDefined();
  });

  it("keeps the uploads' switches: on a laptop, uploads on, local copies kept, no Wi-Fi only", async () => {
    const fixture = await render();
    const upload = input(fixture, '[data-testid="upload-sessions"]');
    const keep = input(fixture, '[data-testid="keep-local-copies"]');
    expect(upload.checked).toBe(true);
    expect(keep.checked).toBe(true);
    expect(text(fixture, 'upload-wifi-only')).toBeUndefined();
    expect(text(fixture, 'uploads-hint')).toContain(
      "Demo sessions never go, nor anything signed out, nor the cubes' MAC addresses.",
    );
    expect(text(fixture, 'keep-local-hint')).toContain(
      "once the browser's storage is 70% full, the oldest uploaded clips are deleted first, until it is under 60%.",
    );

    upload.checked = false;
    upload.dispatchEvent(new Event('change'));
    keep.checked = false;
    keep.dispatchEvent(new Event('change'));
    await update(fixture);
    const settings = TestBed.inject(SettingsService);
    expect(settings.uploadSessions()).toBe(false);
    expect(settings.keepLocalCopies()).toBe(false);
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      uploadSessions: false,
      keepLocalCopies: false,
    });
  });

  it('shows Wi-Fi only on a phone whose browser says the network type, on by default, local copies off', async () => {
    const fixture = await render({
      userAgent:
        'Mozilla/5.0 (Linux; Android 15; motorola edge 50 neo) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      connection: Object.assign(new EventTarget(), { type: 'wifi', effectiveType: '4g' }),
    });
    const wifi = input(fixture, '[data-testid="upload-wifi-only"]');
    expect(wifi.checked).toBe(true);
    expect(input(fixture, '[data-testid="keep-local-copies"]').checked).toBe(false);
    wifi.checked = false;
    wifi.dispatchEvent(new Event('change'));
    await update(fixture);
    expect(TestBed.inject(SettingsService).wifiOnly()).toBe(false);
  });
});
