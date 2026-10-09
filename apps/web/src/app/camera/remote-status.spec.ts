import {
  STALE_REPORT_MS,
  remoteStatusLine,
  shortParts,
  statusText,
  type RemoteReport,
  type RemoteStatusInput,
  type StatusPart,
} from './remote-status';

// A phone's status line (docs/PLAN.md T5.1): its words and colours from its last `state`, the same
// for the Timer page's line, a tile's caption and the Cameras list.

const REPORT: RemoteReport = {
  recording: true,
  framing: { x: 100, y: 200, w: 800, h: 600 },
  fps: 29.94,
  sharpness: 41.2,
  battery: { level: 0.83, charging: true },
  thermal: 'ok',
  pressure: null,
  pressureSource: null,
  pendingClips: 0,
};

function line(
  report: Partial<RemoteReport> | null,
  changes: Partial<RemoteStatusInput> = {},
): StatusPart[] {
  return remoteStatusLine({
    report: report === null ? null : { ...REPORT, ...report },
    reportMs: 100_000,
    nowMs: 101_000,
    state: 'connected',
    sinceMs: 40_000,
    converged: true,
    sharpnessThreshold: 20,
    ...changes,
  });
}

/** The part of `key`: its words and its tone. */
function partOf(parts: readonly StatusPart[], key: string): [string, string] | null {
  const found = parts.find((part) => part.key === key);
  return found === undefined
    ? null
    : [found.label === '' ? found.value : `${found.label} ${found.value}`, found.tone];
}

describe('remoteStatusLine', () => {
  it("says a connected phone's frame rate, sharpness, recording and battery, as the host's own line does", () => {
    const parts = line({});
    expect(statusText(parts)).toBe('29.9 fps · sharpness 41 · recording · battery 83%, charging');
    expect(parts.map((part) => [part.key, part.tone])).toEqual([
      ['fps', 'plain'],
      ['sharpness', 'ok'],
      ['recording', 'plain'],
      ['battery', 'plain'],
    ]);
    // Nothing wrong: nothing in a tile's caption.
    expect(shortParts(parts)).toEqual([]);
    expect(parts[1].title).toBe(
      "Sharpness of the phone's framing rectangle: good (20 or more, Settings).",
    );
  });

  it('colours the sharpness by the host’s threshold: soft in amber under it', () => {
    expect(partOf(line({ sharpness: 12.5 }), 'sharpness')).toEqual(['sharpness 13', 'warn']);
    expect(partOf(line({ sharpness: 4.25 }), 'sharpness')).toEqual(['sharpness 4.3', 'warn']);
    expect(partOf(line({ sharpness: 20 }), 'sharpness')).toEqual(['sharpness 20', 'ok']);
    expect(partOf(line({ sharpness: 30 }, { sharpnessThreshold: 50 }), 'sharpness')).toEqual([
      'sharpness 30',
      'warn',
    ]);
    expect(partOf(line({ sharpness: null, fps: null }), 'sharpness')).toEqual([
      'sharpness –',
      'plain',
    ]);
    expect(partOf(line({ fps: null }), 'fps')).toEqual(['– fps', 'plain']);
    expect(shortParts(line({ sharpness: 12.5 })).map((part) => part.short)).toEqual(['soft']);
  });

  it('says not recording in red', () => {
    const parts = line({ recording: false });
    expect(partOf(parts, 'recording')).toEqual(['not recording', 'bad']);
    expect(shortParts(parts).map((part) => part.short)).toEqual(['not recording']);
  });

  it('colours the battery: amber under 20% and not charging, red under 10%; charging, plain', () => {
    const battery = (level: number, charging: boolean): [string, string] | null =>
      partOf(line({ battery: { level, charging } }), 'battery');
    expect(battery(0.83, false)).toEqual(['battery 83%', 'plain']);
    expect(battery(0.2, false)).toEqual(['battery 20%', 'plain']);
    expect(battery(0.19, false)).toEqual(['battery 19%', 'warn']);
    expect(battery(0.195, false)).toEqual(['battery 20%', 'plain']);
    expect(battery(0.1, false)).toEqual(['battery 10%', 'warn']);
    expect(battery(0.09, false)).toEqual(['battery 9%', 'bad']);
    expect(battery(0.09, true)).toEqual(['battery 9%, charging', 'plain']);
    expect(battery(0.15, true)).toEqual(['battery 15%, charging', 'plain']);
    expect(shortParts(line({ battery: { level: 0.15, charging: false } }))[0].short).toBe('15%');
    // The browser says nothing of a battery: no part.
    expect(partOf(line({ battery: null }), 'battery')).toBeNull();
  });

  it('says the health: the frame rate dropped in amber, the pressure state from fair up', () => {
    const hot = line({ thermal: 'throttled' });
    expect(partOf(hot, 'thermal')).toEqual(['hot: the frame rate dropped', 'warn']);
    expect(shortParts(hot).map((part) => part.short)).toEqual(['hot']);
    expect(partOf(line({ thermal: null }), 'thermal')).toBeNull();

    const pressure = (state: RemoteReport['pressure']): [string, string] | null =>
      partOf(line({ pressure: state, pressureSource: 'thermals' }), 'pressure');
    expect(pressure(null)).toBeNull();
    expect(pressure('nominal')).toEqual(['pressure nominal', 'plain']);
    expect(pressure('fair')).toEqual(['pressure fair', 'warn']);
    expect(pressure('serious')).toEqual(['pressure serious', 'bad']);
    expect(pressure('critical')).toEqual(['pressure critical', 'bad']);
    const serious = line({ pressure: 'serious', pressureSource: 'cpu', thermal: 'throttled' });
    expect(statusText(serious)).toBe(
      '29.9 fps · sharpness 41 · recording · battery 83%, charging · hot: the frame rate dropped · pressure serious',
    );
    expect(shortParts(serious).map((part) => part.short)).toEqual(['hot', 'pressure serious']);
    expect(serious.find((part) => part.key === 'pressure')?.title).toBe(
      "The phone's Compute Pressure state, from its CPU: consistently high: it may be hot, and may slow down.",
    );
    expect(shortParts(line({ pressure: 'nominal', pressureSource: 'cpu' }))).toEqual([]);
  });

  it('says the connection when it is not plainly connected: reconnecting, connecting, the clock syncing', () => {
    expect(partOf(line({}, { state: 'reconnecting' }), 'connection')).toEqual([
      'reconnecting…',
      'warn',
    ]);
    expect(shortParts(line({}, { state: 'reconnecting' })).map((part) => part.short)).toEqual([
      'reconnecting…',
    ]);
    expect(partOf(line(null, { state: 'connecting' }), 'connection')).toEqual([
      'connecting…',
      'plain',
    ]);
    expect(partOf(line({}, { converged: false }), 'connection')).toEqual([
      'clock syncing…',
      'plain',
    ]);
    expect(partOf(line({}, { state: 'finishing' }), 'connection')).toEqual([
      'sending its last clips',
      'plain',
    ]);
    expect(partOf(line({}), 'connection')).toBeNull();
  });

  it('says in red when the reports stop for 10 s while connected; not while reconnecting', () => {
    const at = (ms: number, changes: Partial<RemoteStatusInput> = {}): StatusPart[] =>
      line({}, { reportMs: 100_000, nowMs: 100_000 + ms, ...changes });
    expect(partOf(at(STALE_REPORT_MS - 1), 'stale')).toBeNull();
    expect(partOf(at(STALE_REPORT_MS), 'stale')).toEqual(['no report for 10 s', 'bad']);
    expect(partOf(at(64_500), 'stale')).toEqual(['no report for 64 s', 'bad']);
    expect(shortParts(at(12_000)).map((part) => part.short)).toEqual(['no report']);
    expect(partOf(at(64_500, { state: 'reconnecting' }), 'stale')).toBeNull();
    // Back from a drop 3 s ago, its last report from before it: counted from the connection.
    expect(partOf(at(70_000, { sinceMs: 167_000 }), 'stale')).toBeNull();
    expect(partOf(at(80_000, { sinceMs: 167_000 }), 'stale')).toEqual([
      'no report for 13 s',
      'bad',
    ]);
    // No report at all since it connected 12 s ago.
    const none = line(null, { reportMs: null, sinceMs: 100_000, nowMs: 112_000 });
    expect(statusText(none)).toBe('no report yet · no report for 12 s');
    expect(statusText(line(null, { reportMs: null, sinceMs: 100_000, nowMs: 101_000 }))).toBe(
      'no report yet',
    );
  });

  it("gives the Cameras list's report: the framing and the clips to send, not the connection", () => {
    const list = (report: Partial<RemoteReport>, changes: Partial<RemoteStatusInput> = {}) =>
      statusText(
        remoteStatusLine(
          {
            report: { ...REPORT, ...report },
            reportMs: 100_000,
            nowMs: 101_000,
            state: 'connected',
            sinceMs: 40_000,
            converged: false,
            sharpnessThreshold: 20,
            ...changes,
          },
          'list',
        ),
      );
    expect(list({ pendingClips: 2, pressure: 'fair', pressureSource: 'thermals' })).toBe(
      '29.9 fps · sharpness 41 · recording · framing 800×600 · battery 83%, charging · pressure fair · 2 clips to send',
    );
    expect(list({ framing: null, pendingClips: 1 }, { state: 'reconnecting' })).toBe(
      '29.9 fps · sharpness 41 · recording · full frame · battery 83%, charging · 1 clip to send',
    );
  });
});
