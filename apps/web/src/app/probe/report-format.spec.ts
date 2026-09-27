import type { ProbeReport } from './probe-report';
import { reportFileName, sectionRows, withLabel } from './report-format';

describe('sectionRows', () => {
  it('flattens a section into dotted keys, with one row per group of numbers', () => {
    const rows = sectionRows({
      screen: { width: 1920, orientation: 'landscape-primary' },
      intervalMs: { count: 2, p50: 16.7 },
      exposureMode: ['manual', 'continuous'],
      facingMode: [],
      model: '',
      secureContext: true,
      deviceMemory: { missing: 'navigator.deviceMemory' },
    });

    expect(rows).toEqual([
      { key: 'screen.width', value: '1920', absent: false },
      { key: 'screen.orientation', value: 'landscape-primary', absent: false },
      { key: 'intervalMs', value: 'count=2, p50=16.7', absent: false },
      { key: 'exposureMode', value: 'manual, continuous', absent: false },
      { key: 'facingMode', value: '(none)', absent: false },
      { key: 'model', value: '""', absent: false },
      { key: 'secureContext', value: 'true', absent: false },
      { key: 'deviceMemory', value: 'not available: navigator.deviceMemory', absent: true },
    ]);
  });

  it('writes lists of flat objects as one row per item, and nested lists by index', () => {
    expect(
      sectionRows({
        brands: [{ brand: 'Chromium', version: '141' }],
        failedAttempts: [{ requested: { width: { ideal: 1920 } }, error: 'OverconstrainedError' }],
      }),
    ).toEqual([
      { key: 'brands[0]', value: 'brand=Chromium, version=141', absent: false },
      { key: 'failedAttempts[0].requested.width', value: 'ideal=1920', absent: false },
      { key: 'failedAttempts[0].error', value: 'OverconstrainedError', absent: false },
    ]);
  });

  it('gives an absent section a single status row', () => {
    expect(sectionRows({ error: 'NotAllowedError: denied' })).toEqual([
      { key: 'status', value: 'error: NotAllowedError: denied', absent: true },
    ]);
    expect(sectionRows({ skipped: 'no camera API' })).toEqual([
      { key: 'status', value: 'skipped: no camera API', absent: true },
    ]);
  });
});

describe('reportFileName', () => {
  const lateEvening = new Date(2026, 8, 27, 23, 30).toISOString();

  it('is probe-<label>-<local date>.json with the label reduced to a slug', () => {
    expect(reportFileName('ThinkPhone rear (1080p)', lateEvening)).toBe(
      'probe-thinkphone-rear-1080p-2026-09-27.json',
    );
    expect(reportFileName('Câmera traseira', lateEvening)).toBe(
      'probe-camera-traseira-2026-09-27.json',
    );
  });

  it('copes with an empty label and a bad date', () => {
    expect(reportFileName('  ', lateEvening)).toBe('probe-unlabelled-2026-09-27.json');
    expect(reportFileName('g60', 'not a date')).toBe('probe-g60-undated.json');
  });
});

describe('withLabel', () => {
  it('replaces the label, trimmed, and keeps the order of the keys', () => {
    const report = { generatedAt: '2026-09-27T12:00:00.000Z', label: 'old', device: {} };

    const relabelled = withLabel(report as unknown as ProbeReport, '  g60 front ');

    expect(relabelled.label).toBe('g60 front');
    expect(Object.keys(relabelled)).toEqual(['generatedAt', 'label', 'device']);
  });
});
