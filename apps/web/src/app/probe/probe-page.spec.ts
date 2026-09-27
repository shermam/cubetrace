import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ProbePage } from './probe-page';

/** The first element matching `selector` whose text is `text`; fails the test when there is none. */
function byText(root: HTMLElement, selector: string, text: string): HTMLElement {
  const found = Array.from(root.querySelectorAll<HTMLElement>(selector)).find(
    (element) => element.textContent.trim() === text,
  );
  if (!found) {
    throw new Error(`no ${selector} with the text "${text}"`);
  }
  return found;
}

/** The rows of the section titled `title`, as [key, value] pairs. */
function sectionRows(root: HTMLElement, title: string): string[][] {
  const section = byText(root, 'section h2', title).closest('section');
  return Array.from(section?.querySelectorAll('tbody tr') ?? [], (row) =>
    Array.from(row.children, (cell) => cell.textContent.trim()),
  );
}

describe('ProbePage', () => {
  let fixture: ComponentFixture<ProbePage>;
  let element: HTMLElement;

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    fixture = TestBed.createComponent(ProbePage);
    element = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  it('shows the controls before anything runs', () => {
    expect(element.querySelector('h1')?.textContent).toBe('Device probe');
    expect(byText(element, 'button', 'Run probe').hasAttribute('disabled')).toBe(false);
    expect(byText(element, 'button', 'Copy report').hasAttribute('disabled')).toBe(true);
    expect(element.querySelector('[data-testid="probe-status"]')?.textContent).toBe('Not run yet.');
    expect(element.querySelector('section')).toBeNull();
  });

  it('runs in a browser without the probed APIs and reports each one as missing', async () => {
    const label = element.querySelector<HTMLInputElement>('#probe-label');
    if (!label) {
      throw new Error('no label field');
    }
    label.value = 'jsdom';
    label.dispatchEvent(new Event('input'));

    byText(element, 'button', 'Run probe').click();
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(element.querySelector('[data-testid="probe-status"]')?.textContent).toMatch(/^Done/);
    });

    expect(sectionRows(element, 'Camera')).toEqual([
      ['status', 'not available: navigator.mediaDevices'],
    ]);
    expect(sectionRows(element, 'Frame timing')).toEqual([['status', 'skipped: no camera API']]);
    expect(sectionRows(element, 'H.264 encoders')).toEqual([
      ['status', 'not available: VideoEncoder'],
    ]);
    expect(sectionRows(element, 'Bluetooth')).toContainEqual([
      'availability',
      'not available: navigator.bluetooth',
    ]);
    const json = element.querySelector('[data-testid="report-json"]')?.textContent ?? '';
    const report = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(report)).toEqual([
      'generatedAt',
      'label',
      'device',
      'camera',
      'capabilities',
      'settings',
      'timing',
      'encoders',
      'worker',
      'storage',
      'bluetooth',
      'hints',
    ]);
    expect(report['label']).toBe('jsdom');
  });

  it('shows the JSON to copy by hand when there is no clipboard', async () => {
    byText(element, 'button', 'Run probe').click();
    await vi.waitFor(async () => {
      await fixture.whenStable();
      expect(byText(element, 'button', 'Copy report').hasAttribute('disabled')).toBe(false);
    });

    byText(element, 'button', 'Copy report').click();
    await fixture.whenStable();

    expect(element.querySelector('.notice')?.textContent).toBe(
      'The clipboard is not available here: select the report JSON below and copy it.',
    );
    expect(element.querySelector('details')?.open).toBe(true);
  });
});
