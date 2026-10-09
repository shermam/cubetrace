// The round report (docs/PLAN.md T3.9, docs/DIAGNOSTICS.md): the diagnostics events of every
// account (users/{uid}/events, docs/DATA-MODEL.md §10) read as evidence of the manual rounds'
// checklists (docs/MANUAL-TESTS.md), so that the coordinator ticks them from what the devices
// recorded and the owner looks only at what no event can show. Pure: round-report.mts reads
// Firestore and prints what `roundReport` returns; report.test.ts runs it over a fixture of events.
// Plain TypeScript for Node 22 (type stripping: no enum, no parameter property); it imports no
// workspace package, as nothing under functions/ does.

/** An event as the report reads it: the document's fields, with the account and the id. */
export interface ReportEvent {
  readonly uid: string;
  readonly id: string;
  readonly tsMs: number;
  readonly kind: string;
  readonly app: { readonly version: string; readonly commit: string };
  readonly device: {
    readonly label: string;
    readonly platform: string;
    readonly installed: boolean;
  };
  readonly session: string | null;
  readonly attempt: number | null;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Whether an item's evidence is there (`ok`), not there (`none`), or shows a failure (`failed`). */
export type Status = 'ok' | 'none' | 'failed';

export interface ItemResult {
  readonly status: Status;
  /** The facts behind the status: the counts, the values, the builds; empty when there are none. */
  readonly facts: string;
}

/** One item of a checklist of docs/MANUAL-TESTS.md, and the events that are its evidence. */
export interface ChecklistItem {
  /** `1.5.3`: the section's task and the item's position. */
  readonly id: string;
  readonly round: string;
  /** The section of docs/MANUAL-TESTS.md: `T1.5 — cube connection`. */
  readonly section: string;
  readonly title: string;
  /** The kinds whose events are the evidence (docs/DIAGNOSTICS.md names their facts). */
  readonly kinds: readonly string[];
  /** What the events cannot show, which the owner still looks at; null when they show it all. */
  readonly eyes: string | null;
  readonly check: (q: Query) => ItemResult;
}

export interface EvaluatedItem extends ChecklistItem {
  readonly result: ItemResult;
}

/** What the report is made for. */
export interface ReportOptions {
  /** The days the events cover, back from `nowMs`. */
  readonly days: number;
  readonly nowMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A value of an event's facts as text, or null when it is not one (or absent). */
function text(event: ReportEvent, key: string): string | null {
  const value = event.data[key];
  return typeof value === 'string' ? value : null;
}

/** A value of an event's facts as a number, or null. */
function num(event: ReportEvent, key: string): number | null {
  const value = event.data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A value of an event's facts as a boolean, or null. */
function flag(event: ReportEvent, key: string): boolean | null {
  const value = event.data[key];
  return typeof value === 'boolean' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A document of users/{uid}/events as a {@link ReportEvent}, tolerant of what another version of the
 * app may write (a field more is kept in `data` only when it is there); null when the document is
 * not an event at all (no kind, no time).
 */
export function readEvent(uid: string, id: string, document: unknown): ReportEvent | null {
  if (!isRecord(document)) {
    return null;
  }
  const kind = document['kind'];
  const tsMs = document['tsMs'];
  if (typeof kind !== 'string' || typeof tsMs !== 'number' || !Number.isFinite(tsMs)) {
    return null;
  }
  const app = isRecord(document['app']) ? document['app'] : {};
  const device = isRecord(document['device']) ? document['device'] : {};
  const session = document['session'];
  const attempt = document['attempt'];
  return {
    uid,
    id,
    tsMs,
    kind,
    app: {
      version: typeof app['version'] === 'string' ? app['version'] : '?',
      commit: typeof app['commit'] === 'string' ? app['commit'] : '?',
    },
    device: {
      label: typeof device['label'] === 'string' ? device['label'] : '?',
      platform: typeof device['platform'] === 'string' ? device['platform'] : '',
      installed: device['installed'] === true,
    },
    session: typeof session === 'string' && session !== '' ? session : null,
    attempt: typeof attempt === 'number' && Number.isInteger(attempt) ? attempt : null,
    data: isRecord(document['data']) ? document['data'] : {},
  };
}

/**
 * Whether an event says something failed (the QA view's rule, apps/web diagnostics-summary.ts): an
 * `error.*` event, a clip that could not be saved, a sync check that failed, an upload that failed,
 * a cube that could not be connected for a reason other than the user's, a remote camera's cut that
 * failed, or a remote clip an attempt went without.
 */
export function isFailure(event: ReportEvent): boolean {
  const { kind, data } = event;
  if (kind.startsWith('error.') || kind === 'clip.failed') {
    return true;
  }
  if (kind === 'sync.check') {
    return data['outcome'] === 'failed';
  }
  if (kind === 'upload.state') {
    return data['state'] === 'failed';
  }
  if (kind === 'cube.failed') {
    return data['reason'] !== 'cancelled' && data['reason'] !== 'no-mac';
  }
  // T4.2: a remote camera's clip the phone could not cut, or that the attempt went without.
  if (kind === 'remote.cut') {
    return data['outcome'] === 'failed';
  }
  return kind === 'remote.clip.missing';
}

/** What a failure's facts say went wrong. */
export function failureMessage(event: ReportEvent): string {
  switch (event.kind) {
    case 'clip.failed':
      return [text(event, 'segment'), text(event, 'reason')].filter((p) => p !== null).join(': ');
    case 'sync.check':
      return text(event, 'message') ?? text(event, 'reason') ?? '';
    case 'upload.state':
      return text(event, 'error') ?? text(event, 'failedFile') ?? '';
    case 'cube.failed':
      return text(event, 'reason') ?? '';
    case 'remote.cut':
    case 'remote.clip.missing': {
      const clip = [text(event, 'camera'), text(event, 'segment')]
        .filter((part) => part !== null)
        .join(' ');
      const why = text(event, 'message') ?? text(event, 'reason') ?? '';
      return clip === '' ? why : `${clip}: ${why}`;
    }
    default:
      return [text(event, 'where'), text(event, 'message')].filter((p) => p !== null).join(': ');
  }
}

/** `2026-10-02` of host time `ms`, in UTC (the report is read anywhere). */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function when(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

function round(value: number, digits = 0): string {
  const factor = 10 ** digits;
  return String(Math.round(value * factor) / factor);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
}

/** `3 events on office-mbp, ThinkPhone`. */
function count(events: readonly ReportEvent[], what = 'event'): string {
  const devices = [...new Set(events.map((event) => event.device.label))].sort();
  const n = events.length;
  return `${String(n)} ${what}${n === 1 ? '' : 's'}${devices.length === 0 ? '' : ` on ${devices.join(', ')}`}`;
}

function ok(facts: string): ItemResult {
  return { status: 'ok', facts };
}

function none(facts = ''): ItemResult {
  return { status: 'none', facts };
}

function failed(facts: string): ItemResult {
  return { status: 'failed', facts };
}

/** `ok` with the facts when `events` has any, else `none` with `otherwise`. */
function found(events: readonly ReportEvent[], facts: string, otherwise = ''): ItemResult {
  return events.length > 0 ? ok(facts) : none(otherwise);
}

/** The events of the report's span, with the questions the checklist asks of them. */
export class Query {
  /** The events, oldest first. */
  readonly events: readonly ReportEvent[];
  readonly nowMs: number;
  private readonly byKind = new Map<string, ReportEvent[]>();

  constructor(events: readonly ReportEvent[], nowMs: number) {
    this.events = [...events].sort((p, q) => p.tsMs - q.tsMs || p.id.localeCompare(q.id));
    this.nowMs = nowMs;
    for (const event of this.events) {
      let list = this.byKind.get(event.kind);
      if (list === undefined) {
        list = [];
        this.byKind.set(event.kind, list);
      }
      list.push(event);
    }
  }

  /** The events of `kind`, oldest first. */
  of(kind: string): readonly ReportEvent[] {
    return this.byKind.get(kind) ?? [];
  }

  /** The events of `kind` that `pred` takes. */
  where(kind: string, pred: (event: ReportEvent) => boolean): ReportEvent[] {
    return this.of(kind).filter(pred);
  }

  /** The events of `kind` on Android devices (the installed app or Chrome there). */
  onPhone(kind: string, pred: (event: ReportEvent) => boolean = () => true): ReportEvent[] {
    return this.where(kind, (event) => isPhone(event) && pred(event));
  }

  /** The events of `kind` on the other devices: laptops. */
  onLaptop(kind: string, pred: (event: ReportEvent) => boolean = () => true): ReportEvent[] {
    return this.where(kind, (event) => !isPhone(event) && pred(event));
  }

  /**
   * The first event of `kind` that `pred` takes, on the same device as `after`, within `withinMs`
   * after it; null when there is none.
   */
  next(
    after: ReportEvent,
    kind: string,
    withinMs: number,
    pred: (event: ReportEvent) => boolean = () => true,
  ): ReportEvent | null {
    return (
      this.of(kind).find(
        (event) =>
          event.device.label === after.device.label &&
          event.uid === after.uid &&
          event.tsMs > after.tsMs &&
          event.tsMs - after.tsMs <= withinMs &&
          pred(event),
      ) ?? null
    );
  }

  /** The last event of `kind` that `pred` takes, on the same device as `before`, within `withinMs` before it. */
  previous(
    before: ReportEvent,
    kind: string,
    withinMs: number,
    pred: (event: ReportEvent) => boolean = () => true,
  ): ReportEvent | null {
    const earlier = this.of(kind).filter(
      (event) =>
        event.device.label === before.device.label &&
        event.uid === before.uid &&
        event.tsMs < before.tsMs &&
        before.tsMs - event.tsMs <= withinMs &&
        pred(event),
    );
    return earlier.at(-1) ?? null;
  }

  /** The events of every kind, by session, oldest first; the events of no session left out. */
  sessions(): Map<string, ReportEvent[]> {
    const out = new Map<string, ReportEvent[]>();
    for (const event of this.events) {
      if (event.session === null) {
        continue;
      }
      let list = out.get(event.session);
      if (list === undefined) {
        list = [];
        out.set(event.session, list);
      }
      list.push(event);
    }
    return out;
  }

  /** The `attempt.done` events of real cubes' sessions (not the demo's). */
  realAttempts(): ReportEvent[] {
    const demo = new Set(
      this.where('session.started', (event) => text(event, 'hardware') === 'simulated').map(
        (event) => event.session,
      ),
    );
    return this.where('attempt.done', (event) => !demo.has(event.session));
  }

  /** The most `attempt.done` of one session, and that session's device. */
  biggestSession(): { session: string; attempts: number; device: string } | null {
    let best: { session: string; attempts: number; device: string } | null = null;
    for (const [session, events] of this.sessions()) {
      const done = events.filter((event) => event.kind === 'attempt.done');
      if (done.length > 0 && (best === null || done.length > best.attempts)) {
        best = { session, attempts: done.length, device: done[0].device.label };
      }
    }
    return best;
  }
}

function isPhone(event: ReportEvent): boolean {
  return event.device.platform === 'Android' || event.device.platform === 'iOS';
}

function modelIs(pattern: RegExp): (event: ReportEvent) => boolean {
  return (event) => pattern.test(text(event, 'model') ?? '');
}

const GAN12 = /uifp|12\s*ui/iu;
const I3 = /i3/iu;

/** `model model (n)`: the models of `events`, each with its count. */
function models(events: readonly ReportEvent[]): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    const model = text(event, 'model') ?? '?';
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  return [...counts.entries()].map(([model, n]) => `${model} (${String(n)})`).join(', ');
}

/** The `cube.connected` events of real cubes (the driver's, not the demo's). */
function realCubes(q: Query, pred: (event: ReportEvent) => boolean = () => true): ReportEvent[] {
  return q.where('cube.connected', (event) => text(event, 'kind') === 'gan' && pred(event));
}

/** Unrequested disconnections of real cubes. */
function drops(q: Query): ReportEvent[] {
  return q.where(
    'cube.disconnected',
    (event) => text(event, 'kind') === 'gan' && flag(event, 'requested') === false,
  );
}

function dropFacts(event: ReportEvent): string {
  return `${when(event.tsMs)} ${event.device.label}: ${text(event, 'reason') ?? '?'}; idle ${round((num(event, 'idleMs') ?? 0) / 1000)} s, ${text(event, 'visibilityState') ?? '?'}${num(event, 'hiddenMs') === null ? '' : ` for ${round((num(event, 'hiddenMs') ?? 0) / 1000)} s`}, connected ${round((num(event, 'connectedMs') ?? 0) / MINUTE, 1)} min, battery ${String(num(event, 'battery') ?? '?')}`;
}

/** A cube connected within `withinMs` after `event`, on the same device. */
function reconnected(q: Query, event: ReportEvent, withinMs = 5 * MINUTE): ReportEvent | null {
  return q.next(event, 'cube.connected', withinMs, (next) => text(next, 'kind') === 'gan');
}

const R1 = 'Round 1 (v0.1.0)';
const R2 = 'Round 2 (v0.2.0)';
const R3 = 'Round 3 (v0.3.0)';
const T37 = 'After T3.7';
const T41 = 'After T4.1';
const RTC = 'T4.1 — remote cameras';
const T42 = 'After T4.2';
const REMOTE_CLIPS = 'T4.2 — remote clips';
const T43 = 'After T4.3';
const REMOTE_SYNC = 'T4.3 — remote sync check and live preview';
const T4 = 'After T4';
const RIG = 'T4.4 — the desk rig';
const T51 = 'After T5.1';
const PICTURES = "T5.1 — the phone's picture and its status line";

/** A median of `values` in ms as seconds, to one decimal, or `?` without one. */
function seconds(values: readonly number[]): string {
  const middle = median(values);
  return middle === null ? '?' : round(middle / 1000, 1);
}

/**
 * The longest stretch of a remote camera's clock sync converged, as the host's `rtc.clock` records
 * say it: from a convergence (or a minute's record) to the last minute's record before a withdrawal,
 * a record not converged or the end; with when it began and ended, and the withdrawals counted.
 */
function convergedStretch(q: Query): {
  ms: number;
  fromMs: number;
  toMs: number;
  withdrawn: number;
} {
  let best = { ms: 0, fromMs: 0, toMs: 0 };
  let withdrawn = 0;
  const since = new Map<string, number>();
  for (const e of q.onLaptop('rtc.clock')) {
    const camera = `${e.device.label}/${text(e, 'camera') ?? '?'}`;
    if (flag(e, 'converged') === true) {
      const start = since.get(camera) ?? e.tsMs;
      since.set(camera, start);
      if (e.tsMs - start > best.ms) {
        best = { ms: e.tsMs - start, fromMs: start, toMs: e.tsMs };
      }
    } else {
      if (text(e, 'why') === 'withdrawn') {
        withdrawn++;
      }
      since.delete(camera);
    }
  }
  return { ...best, withdrawn };
}

/**
 * The laptops' uploads done with every file of an attempt of `clips` clips: each clip's MP4 and frames
 * file, attempt.json, and gyro.json when the attempt's `attempt.done` says it has one (T3.7).
 */
function uploadsWith(q: Query, clips: number): ReportEvent[] {
  return q.onLaptop('upload.state', (e) => {
    if (text(e, 'state') !== 'done') {
      return false;
    }
    const done = q
      .where(
        'attempt.done',
        (a) => a.uid === e.uid && a.session === e.session && a.attempt === e.attempt,
      )
      .at(-1);
    const gyro = done !== undefined && (num(done, 'gyroSamples') ?? 0) > 0;
    return (num(e, 'files') ?? 0) >= 2 * clips + 1 + (gyro ? 1 : 0);
  });
}

/**
 * The phone's report that a host's `rtc.clock` event carries since T5.1 (`report`: the phone's last
 * `state`, one level of facts), or null: an event of an earlier build, or before the first report.
 */
function reportOf(event: ReportEvent): Readonly<Record<string, unknown>> | null {
  const report = event.data['report'];
  return isRecord(report) ? report : null;
}

/** A number of a phone's report, or null. */
function reportNum(report: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = report[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The laptops' `rtc.clock` events with a phone's report (T5.1), by the phone's host label, oldest
 * first: a phone's health over its sessions, a record a minute.
 */
function phoneReports(
  q: Query,
): Map<string, { event: ReportEvent; report: Readonly<Record<string, unknown>> }[]> {
  const out = new Map<
    string,
    { event: ReportEvent; report: Readonly<Record<string, unknown>> }[]
  >();
  for (const event of q.onLaptop('rtc.clock')) {
    const report = reportOf(event);
    if (report === null) {
      continue;
    }
    const peer = text(event, 'peer') ?? '?';
    out.set(peer, [...(out.get(peer) ?? []), { event, report }]);
  }
  return out;
}

/** `ThinkPhone: 24 reports, 29.9 fps, sharpness 41, battery 83% (medians)`. */
function healthFacts(
  peer: string,
  reports: readonly { report: Readonly<Record<string, unknown>> }[],
): string {
  const middle = (key: string, scale = 1): string => {
    const values = reports.flatMap(({ report }) => {
      const value = reportNum(report, key);
      return value === null ? [] : [value * scale];
    });
    const m = median(values);
    return m === null ? '?' : round(m, scale === 1 ? 1 : 0);
  };
  return `${peer}: ${String(reports.length)} ${reports.length === 1 ? 'report' : 'reports'}, ${middle('fps')} fps, sharpness ${middle('sharpness')}, battery ${middle('batteryLevel', 100)}% (medians)`;
}

/**
 * The checklists of docs/MANUAL-TESTS.md, item by item, with the events that are their evidence
 * (docs/DIAGNOSTICS.md has the same table): rounds 1 to 3, the items after T3.7, T4.1, T4.2 and
 * T4.3, the desk rig's after T4, and the items after T5.1.
 */
export const CHECKLIST: readonly ChecklistItem[] = [
  // ---- T1.5 — cube connection ----
  {
    id: '1.5.1',
    round: R1,
    section: 'T1.5 — cube connection',
    title: 'GAN 12 ui on a laptop with the flag on: no address asked, connected within 5 s',
    kinds: ['cube.connected'],
    eyes: null,
    check: (q) => {
      const hits = q.onLaptop(
        'cube.connected',
        (e) =>
          text(e, 'kind') === 'gan' &&
          text(e, 'mac') === 'driver' &&
          GAN12.test(text(e, 'model') ?? ''),
      );
      return found(
        hits,
        `${count(hits, 'connection')}; ${models(hits)}; connected in ${String(median(hits.map((e) => num(e, 'ms') ?? 0)) ?? '?')} ms (median); firmware ${[...new Set(hits.map((e) => text(e, 'firmware')))].join(', ')}`,
        'no connection with the address read by Chrome on a laptop',
      );
    },
  },
  {
    id: '1.5.2',
    round: R1,
    section: 'T1.5 — cube connection',
    title:
      'Flag off: the address typed connects; a wrong one fails within 5 s; remembered, the next connection does not ask; Cancel says no address was given',
    kinds: ['cube.connected', 'cube.failed'],
    eyes: 'that the failure names the address typed, and the dialog with the flag folded under it',
    check: (q) => {
      const typed = realCubes(q, (e) => text(e, 'mac') === 'typed');
      const stored = realCubes(q, (e) => text(e, 'mac') === 'stored');
      const wrong = q.where('cube.failed', (e) => text(e, 'mac') === 'typed');
      const cancelled = q.where('cube.failed', (e) => text(e, 'reason') === 'no-mac');
      const facts = `typed: ${count(typed, 'connection')}; remembered: ${count(stored, 'connection')}; failed with an address typed: ${count(wrong)} (${[...new Set(wrong.map((e) => text(e, 'reason')))].join(', ')}); no address given: ${count(cancelled)}`;
      return typed.length > 0 || stored.length > 0 ? ok(facts) : none(facts);
    },
  },
  {
    id: '1.5.3',
    round: R1,
    section: 'T1.5 — cube connection',
    title: 'Chrome\'s picker closed without choosing: "No cube was chosen…", no dialog',
    kinds: ['cube.failed'],
    eyes: 'the Details dialog with the hint, Connect cube and Demo cube',
    check: (q) => {
      const hits = q.where('cube.failed', (e) => text(e, 'reason') === 'cancelled');
      return found(hits, count(hits, 'picker closed'), 'no picker closed without a cube');
    },
  },
  {
    id: '1.5.4',
    round: R1,
    section: 'T1.5 — cube connection',
    title: 'The same on the ThinkPhone',
    kinds: ['cube.connected'],
    eyes: null,
    check: (q) => {
      const hits = q.onPhone('cube.connected', (e) => text(e, 'kind') === 'gan');
      return found(
        hits,
        `${count(hits, 'connection')}; ${models(hits)}; address ${[...new Set(hits.map((e) => text(e, 'mac')))].join(', ')}`,
        'no real cube connected on a phone',
      );
    },
  },
  {
    id: '1.5.5',
    round: R1,
    section: 'T1.5 — cube connection',
    title: 'The same with the GAN 356 i3',
    kinds: ['cube.connected'],
    eyes: null,
    check: (q) => {
      const hits = realCubes(q, modelIs(I3));
      return found(
        hits,
        `${count(hits, 'connection')}; ${models(hits)}; firmware ${[...new Set(hits.map((e) => text(e, 'firmware')))].join(', ')}`,
        'the i3 never connected',
      );
    },
  },
  {
    id: '1.5.6',
    round: R1,
    section: 'T1.5 — cube connection',
    title: "Scramble the cube, then connect: the state shown is the cube's",
    kinds: [],
    eyes: 'the net right after connecting',
    check: () => none('no event shows the net'),
  },
  {
    id: '1.5.7',
    round: R1,
    section: 'T1.5 — cube connection',
    title:
      'Faces turned slowly and fast: every move in order, cube time increasing, packets flagged',
    kinds: ['attempt.done'],
    eyes: 'the move log itself (Gap, Host, ■)',
    check: (q) => {
      const real = q.realAttempts();
      const replayed = real.filter((e) => flag(e, 'replayOk') === true);
      const broken = real.filter((e) => flag(e, 'replayOk') === false);
      if (real.length === 0) {
        return none('no attempt of a real cube');
      }
      const facts = `${String(replayed.length)} of ${String(real.length)} real attempts replay to solved (the move stream is whole)${
        broken.length > 0
          ? `; ${String(broken.length)} do not: ${broken
              .slice(0, 5)
              .map(
                (e) =>
                  `${e.device.label} attempt ${String(e.attempt ?? 0)} (${String(num(e, 'resyncs') ?? 0)} resyncs)`,
              )
              .join(', ')}`
          : ''
      }`;
      return broken.length > real.length / 10 ? failed(facts) : ok(facts);
    },
  },
  {
    id: '1.5.8',
    round: R1,
    section: 'T1.5 — cube connection',
    title: 'Walk away 30 s, turn: the connection is still alive',
    kinds: ['cube.disconnected', 'cube.connected'],
    eyes: null,
    check: (q) => {
      const dropped = drops(q);
      const early = dropped.filter(
        (e) => (num(e, 'idleMs') ?? 0) < 60_000 && text(e, 'visibilityState') === 'visible',
      );
      const long = q.where(
        'cube.disconnected',
        (e) => text(e, 'kind') === 'gan' && (num(e, 'connectedMs') ?? 0) >= 10 * MINUTE,
      );
      if (early.length > 0) {
        return failed(
          `${count(early, 'drop')} within a minute of a turn while the page was visible: ${early.slice(0, 3).map(dropFacts).join(' | ')}`,
        );
      }
      return found(
        long,
        `${count(long, 'connection')} that lasted 10 min or more (longest ${round(Math.max(...long.map((e) => num(e, 'connectedMs') ?? 0)) / MINUTE)} min); ${String(dropped.length)} unrequested disconnections in all`,
        'no connection of 10 minutes or more yet',
      );
    },
  },
  {
    id: '1.5.9',
    round: R1,
    section: 'T1.5 — cube connection',
    title: 'Cube turned off and on: Reconnect connects it again',
    kinds: ['cube.disconnected', 'cube.connected'],
    eyes: null,
    check: (q) => {
      const closed = drops(q).filter((e) =>
        /closed|lost|disconnected/iu.test(text(e, 'reason') ?? ''),
      );
      const back = closed.filter((e) => reconnected(q, e) !== null);
      return found(
        back,
        `${String(back.length)} of ${String(closed.length)} unrequested disconnections followed by a connection within 5 min`,
        closed.length === 0
          ? 'no unrequested disconnection'
          : `${String(closed.length)} unrequested disconnections, none reconnected within 5 min`,
      );
    },
  },
  {
    id: '1.5.10',
    round: R1,
    section: 'T1.5 — cube connection',
    title: 'Disconnect from the app, then connect again without reloading',
    kinds: ['cube.disconnected', 'cube.connected', 'app.start'],
    eyes: null,
    check: (q) => {
      const requested = q.where(
        'cube.disconnected',
        (e) =>
          text(e, 'kind') === 'gan' &&
          flag(e, 'requested') === true &&
          !/without a turn/iu.test(text(e, 'reason') ?? ''),
      );
      const again = requested.filter((e) => {
        const next = reconnected(q, e, HOUR);
        return next !== null && q.next(e, 'app.start', next.tsMs - e.tsMs) === null;
      });
      return found(
        again,
        `${String(again.length)} of ${String(requested.length)} disconnections on request followed by a connection in the same page`,
        'no disconnection on request followed by a connection',
      );
    },
  },
  {
    id: '1.5.11',
    round: R1,
    section: 'T1.5 — cube connection',
    title:
      'Mark as solved (T1.14): the net solved at once, the attempt begun again, nothing added, no stray moves after',
    kinds: ['cube.reset', 'attempt.done'],
    eyes: 'whether the net matched the cube after the reconnection, and the two moves after the reset',
    check: (q) => {
      const resets = q.where('cube.reset', (e) => text(e, 'kind') === 'gan');
      const soon = resets.filter((e) => q.next(e, 'attempt.done', 2000) !== null);
      const facts = `${count(resets, 'reset')}${soon.length > 0 ? `; ${String(soon.length)} followed by an attempt within 2 s (a record after a reset?)` : ''}`;
      return resets.length === 0
        ? none('no Mark as solved on a real cube')
        : soon.length > 0
          ? failed(facts)
          : ok(facts);
    },
  },
  {
    id: '1.5.12',
    round: R1,
    section: 'T1.5 — cube connection',
    title:
      'Idle disconnection (T1.14): set to 1, the cube disconnects after a minute without a turn; Reconnect takes one click',
    kinds: ['settings.changed', 'cube.disconnected', 'cube.connected'],
    eyes: null,
    check: (q) => {
      const set = q.where('settings.changed', (e) => text(e, 'key') === 'idleDisconnectMinutes');
      const idle = q.where('cube.disconnected', (e) =>
        /without a turn/iu.test(text(e, 'reason') ?? ''),
      );
      const back = idle.filter((e) => reconnected(q, e, HOUR) !== null);
      return found(
        idle,
        `${count(idle, 'idle disconnection')} (idle ${idle
          .map((e) => `${round((num(e, 'idleMs') ?? 0) / 1000)} s`)
          .slice(0, 5)
          .join(
            ', ',
          )}); ${String(back.length)} reconnected; setting changed ${String(set.length)} times (${set.map((e) => String(e.data['value'])).join(', ')})`,
        set.length > 0
          ? `the setting changed (${set.map((e) => String(e.data['value'])).join(', ')}) but no idle disconnection came`
          : 'no idle disconnection',
      );
    },
  },
  {
    id: '1.5.13',
    round: R1,
    section: 'T1.5 — cube connection',
    title:
      'Disconnect diagnostics (T1.14): 10 minutes in another tab or app, idle at 0: whether the cube stays connected, and the facts of the disconnection',
    kinds: ['cube.disconnected'],
    eyes: null,
    check: (q) => {
      const hidden = drops(q).filter((e) => num(e, 'hiddenMs') !== null);
      const stayed = q.where(
        'cube.disconnected',
        (e) => text(e, 'kind') === 'gan' && (num(e, 'connectedMs') ?? 0) >= 10 * MINUTE,
      );
      return found(
        [...hidden, ...stayed],
        hidden.length > 0
          ? `${count(hidden, 'disconnection')} while hidden: ${hidden.slice(0, 3).map(dropFacts).join(' | ')}`
          : `no disconnection while hidden; ${count(stayed, 'connection')} of 10 min or more`,
        'no disconnection while hidden, and no connection of 10 minutes',
      );
    },
  },
  // ---- T1.6 — timer ----
  {
    id: '1.6.1',
    round: R1,
    section: 'T1.6 — timer',
    title:
      'Connected while scrambled: "Solve the cube first"; solved: attempt 1 begins, the picture matches',
    kinds: [],
    eyes: 'the status line and the scramble picture',
    check: () => none('no event shows the status line'),
  },
  {
    id: '1.6.2',
    round: R1,
    section: 'T1.6 — timer',
    title:
      'Ten attempts in a row: armed when the cube matches, started on the first turn, stopped on solved, the next scramble at once',
    kinds: ['attempt.done'],
    eyes: 'the time against a stopwatch (0.2 s)',
    check: (q) => {
      const best = q.biggestSession();
      const real = q.realAttempts();
      const times = real.map((e) => num(e, 'timeMs')).filter((t): t is number => t !== null);
      if (best === null || best.attempts < 10) {
        return none(
          best === null ? 'no attempt' : `at most ${String(best.attempts)} attempts in one session`,
        );
      }
      return ok(
        `${String(best.attempts)} attempts in one session on ${best.device}; ${String(real.length)} real attempts in all, median time ${round((median(times) ?? 0) / 1000, 2)} s`,
      );
    },
  },
  {
    id: '1.6.3',
    round: R1,
    section: 'T1.6 — timer',
    title: 'A mis-scramble: the undo list, then the attempt arms and its row says Corrected',
    kinds: ['attempt.done'],
    eyes: 'the undo list greying out',
    check: (q) => {
      const hits = q.where('attempt.done', (e) => flag(e, 'scrambleCorrected') === true);
      return found(
        hits,
        `${count(hits, 'corrected attempt')}; extra moves ${hits
          .slice(0, 5)
          .map((e) => String(num(e, 'scrambleExtraMoves') ?? '?'))
          .join(', ')}`,
        'no attempt with a corrected scramble',
      );
    },
  },
  {
    id: '1.6.4',
    round: R1,
    section: 'T1.6 — timer',
    title: 'Scramble colours (T1.13) keep up with fast turning',
    kinds: [],
    eyes: 'the boxes on the scramble text',
    check: () => none('no event shows the colours'),
  },
  {
    id: '1.6.5',
    round: R1,
    section: 'T1.6 — timer',
    title: 'CFOP breakdown looks right for a solve narrated: eight phases in order',
    kinds: ['attempt.done'],
    eyes: 'the phases against the solve narrated',
    check: (q) => {
      const solved = q.realAttempts().filter((e) => text(e, 'status') === 'solved');
      const eight = solved.filter((e) => num(e, 'phases') === 8);
      return found(
        eight,
        `${String(eight.length)} of ${String(solved.length)} solved real attempts have all eight phases`,
        'no solved real attempt',
      );
    },
  },
  {
    id: '1.6.6',
    round: R1,
    section: 'T1.6 — timer',
    title:
      'Esc during a solve: DNF; Delete right after: the row goes; N before the first turn: a new scramble',
    kinds: ['attempt.done', 'attempt.deleted'],
    eyes: 'N before the first turn (nothing is recorded, so nothing is shown)',
    check: (q) => {
      const dnf = q.where('attempt.done', (e) => text(e, 'status') === 'dnf');
      const deleted = q.of('attempt.deleted');
      return found(
        [...dnf, ...deleted],
        `${count(dnf, 'DNF')}; ${count(deleted, 'deletion')}`,
        'no DNF and no Delete last',
      );
    },
  },
  {
    id: '1.6.7',
    round: R1,
    section: 'T1.6 — timer',
    title:
      '15-second inspection: the countdown once armed, started again from the pickup on the 12 ui',
    kinds: ['settings.changed', 'attempt.done'],
    eyes: 'whether putting the cube down after the scramble already counts as the pickup',
    check: (q) => {
      const on = q.where(
        'settings.changed',
        (e) => text(e, 'key') === 'inspection' && e.data['value'] === true,
      );
      const inspected = q.realAttempts().filter((e) => (num(e, 'inspectionMs') ?? 0) > 1000);
      const pickups = inspected.filter((e) => flag(e, 'pickup') === true);
      return found(
        inspected,
        `inspection turned on ${String(on.length)} times; ${count(inspected, 'attempt')} with an inspection over 1 s, ${String(pickups.length)} with a pickup; median inspection ${round((median(inspected.map((e) => num(e, 'inspectionMs') ?? 0)) ?? 0) / 1000, 1)} s`,
        on.length > 0
          ? 'inspection turned on, but no attempt with one'
          : 'inspection never turned on',
      );
    },
  },
  {
    id: '1.6.8',
    round: R1,
    section: 'T1.6 — timer',
    title: '"Next scramble right after a solve" off: the time stays, Next begins the next attempt',
    kinds: ['settings.changed', 'attempt.done'],
    eyes: null,
    check: (q) => {
      const off = q.where(
        'settings.changed',
        (e) => text(e, 'key') === 'autoAdvance' && e.data['value'] === false,
      );
      const after = off.filter((e) => q.next(e, 'attempt.done', HOUR) !== null);
      return found(
        after,
        `${String(after.length)} of ${String(off.length)} times the setting went off, an attempt followed within the hour`,
        'auto-advance never turned off',
      );
    },
  },
  {
    id: '1.6.9',
    round: R1,
    section: 'T1.6 — timer',
    title:
      'Cube turned off mid-solve: the time stops; back on and reconnected, the same attempt ends',
    kinds: ['cube.disconnected', 'cube.connected', 'attempt.done'],
    eyes: null,
    check: (q) => {
      const mid = q.where(
        'cube.disconnected',
        (e) => text(e, 'kind') === 'gan' && e.attempt !== null,
      );
      const resumed = mid.filter((e) => {
        const back = reconnected(q, e, HOUR);
        return (
          back !== null &&
          q.next(
            back,
            'attempt.done',
            HOUR,
            (d) => d.session === e.session && d.attempt === e.attempt,
          ) !== null
        );
      });
      return found(
        resumed,
        `${String(resumed.length)} of ${String(mid.length)} disconnections during an attempt were followed by that attempt's end after a reconnection`,
        mid.length === 0
          ? 'no disconnection during an attempt'
          : `${String(mid.length)} disconnections during an attempt, none resumed`,
      );
    },
  },
  {
    id: '1.6.10',
    round: R1,
    section: 'T1.6 — timer',
    title:
      'Reload mid-session, close and reopen: the solve list is back and the next attempt has the next number',
    kinds: ['app.start', 'attempt.done', 'session.started'],
    eyes: null,
    check: (q) => {
      const resumed = q.of('app.start').filter((start) => {
        const next = q.next(start, 'attempt.done', HOUR);
        if (next === null || next.session === null) {
          return false;
        }
        const began = q.of('session.started').find((s) => s.session === next.session);
        return began !== undefined && began.tsMs < start.tsMs && (next.attempt ?? 0) > 1;
      });
      return found(
        resumed,
        `${count(resumed, 'start')} resumed a session recorded before them (the next attempt numbered after the last)`,
        'no start resumed a session',
      );
    },
  },
  {
    id: '1.6.11',
    round: R1,
    section: 'T1.6 — timer',
    title:
      'Sessions page: the session listed; Export downloads the JSON; Delete asks first, then removes it',
    kinds: ['page.viewed', 'files.downloaded', 'session.deleted'],
    eyes: 'that the export validates against the schemas (the coordinator, with ajv)',
    check: (q) => {
      const views = q.where('page.viewed', (e) => text(e, 'page') === 'sessions');
      const exports = q.where('files.downloaded', (e) => text(e, 'what') === 'export');
      const deleted = q.of('session.deleted');
      const facts = `${count(views, 'view')}; ${count(exports, 'export')}; ${count(deleted, 'deletion')}`;
      return exports.length > 0 && deleted.length > 0 ? ok(facts) : none(facts);
    },
  },
  {
    id: '1.6.12',
    round: R1,
    section: 'T1.6 — timer',
    title:
      '"Screen on" while a cube is connected during a session; "Screen may sleep" after it disconnects',
    kinds: ['wake.lock', 'cube.disconnected'],
    eyes: null,
    check: (q) => {
      const active = q.where('wake.lock', (e) => text(e, 'status') === 'active');
      const released = q.where(
        'wake.lock',
        (e) =>
          text(e, 'status') === 'inactive' && q.previous(e, 'cube.disconnected', MINUTE) !== null,
      );
      return found(
        active.length > 0 && released.length > 0 ? active : [],
        `${count(active, 'lock')}; ${String(released.length)} released within a minute of a disconnection`,
        `${count(active, 'lock')}; ${String(released.length)} released after a disconnection`,
      );
    },
  },
  // ---- T1.7 — PWA on the phone ----
  {
    id: '1.7.1',
    round: R1,
    section: 'T1.7 — PWA on the phone',
    title: 'Installed on the ThinkPhone: opened from the home screen, standalone',
    kinds: ['app.start'],
    eyes: 'the icon and the name on the home screen',
    check: (q) => {
      const hits = q.onPhone('app.start', (e) => e.device.installed);
      return found(
        hits,
        `${count(hits, 'start')} of the installed app`,
        'no start of the installed app on a phone',
      );
    },
  },
  {
    id: '1.7.2',
    round: R1,
    section: 'T1.7 — PWA on the phone',
    title: 'Rotate the phone: the app follows, nothing scrolls sideways',
    kinds: [],
    eyes: 'the layout in landscape',
    check: () => none('no event shows the layout'),
  },
  {
    id: '1.7.3',
    round: R1,
    section: 'T1.7 — PWA on the phone',
    title:
      'Keep the screen on: "Screen on", kept past the timeout and across apps; off: "Screen may sleep"',
    kinds: ['wake.lock'],
    eyes: 'the screen staying on past the timeout',
    check: (q) => {
      const locks = q.onPhone('wake.lock');
      const on = locks.filter((e) => e.data['wanted'] === true);
      const off = locks.filter((e) => e.data['wanted'] === false);
      return found(
        on,
        `wanted ${String(on.length)} times and released ${String(off.length)} on a phone; ${count(locks, 'lock change')}: ${[...new Set(locks.map((e) => text(e, 'status')))].join(', ')}`,
        'the lock was never wanted on a phone',
      );
    },
  },
  {
    id: '1.7.4',
    round: R1,
    section: 'T1.7 — PWA on the phone',
    title: 'Keep my data in the installed app: Persistent',
    kinds: ['app.start', 'storage.persistence'],
    eyes: null,
    check: (q) => {
      const persisted = q.onPhone('app.start', (e) => text(e, 'persisted') === 'persistent');
      const granted = q.onPhone('storage.persistence', (e) => text(e, 'state') === 'persistent');
      const refused = q.onPhone('storage.persistence', (e) => flag(e, 'refused') === true);
      const facts = `${count(persisted, 'start')} persistent; granted ${String(granted.length)} times, refused ${String(refused.length)}`;
      return persisted.length > 0 || granted.length > 0
        ? ok(facts)
        : refused.length > 0
          ? failed(facts)
          : none(facts);
    },
  },
  {
    id: '1.7.5',
    round: R1,
    section: 'T1.7 — PWA on the phone',
    title:
      'The footer shows the build; after a deploy the new commit appears from the second launch',
    kinds: ['app.start'],
    eyes: null,
    check: (q) => {
      const updated = q.where('app.start', (e) => flag(e, 'updated') === true);
      const builds = [
        ...new Set(q.of('app.start').map((e) => `${e.app.version} · ${e.app.commit}`)),
      ];
      return found(
        updated,
        `${count(updated, 'update')}: ${updated
          .slice(0, 5)
          .map((e) => `${e.device.label} ${String(e.data['previousCommit'])} → ${e.app.commit}`)
          .join(', ')}; builds seen: ${builds.join(', ')}`,
        `no update seen; builds: ${builds.join(', ')}`,
      );
    },
  },
  {
    id: '1.7.6',
    round: R1,
    section: 'T1.7 — PWA on the phone',
    title: 'Airplane mode, opened from the home screen: it opens from the cache',
    kinds: ['app.start'],
    eyes: null,
    check: (q) => {
      const hits = q.onPhone('app.start', (e) => flag(e, 'online') === false && e.device.installed);
      return found(
        hits,
        `${count(hits, 'start')} offline`,
        'no start offline of the installed app',
      );
    },
  },
  {
    id: '1.7.7',
    round: R1,
    section: 'T1.7 — PWA on the phone',
    title: 'Laptop: installed as a window; no banner about missing APIs',
    kinds: ['app.start'],
    eyes: 'the banner',
    check: (q) => {
      const hits = q.onLaptop('app.start', (e) => e.device.installed);
      return found(
        hits,
        `${count(hits, 'start')} of the installed app`,
        'no start of the installed app on a laptop',
      );
    },
  },
  {
    id: '1.7.8',
    round: R1,
    section: 'T1.7 — PWA on the phone',
    title: 'Firefox or Safari: the banner names the missing APIs; the pages render',
    kinds: [],
    eyes: 'the banner (those browsers record nothing)',
    check: () => none('no event: the account never loads there'),
  },
  // ---- T2.1 — camera panel ----
  {
    id: '2.1.1',
    round: R2,
    section: 'T2.1 — camera panel',
    title: 'MacBook, FaceTime camera: 1920×1080 at 30 fps, no manual controls',
    kinds: ['camera.on', 'recording.started'],
    eyes: 'the preview (not mirrored) and the controls line',
    check: (q) => {
      const hits = q.onLaptop('camera.on', (e) => /facetime/iu.test(text(e, 'label') ?? ''));
      return found(
        hits,
        `${count(hits, 'camera on')}: ${[...new Set(hits.map((e) => `${String(num(e, 'width'))}×${String(num(e, 'height'))} at ${String(num(e, 'fps'))}`))].join(', ')}`,
        'the FaceTime camera never came on',
      );
    },
  },
  {
    id: '2.1.2',
    round: R2,
    section: 'T2.1 — camera panel',
    title: 'ThinkPhone: Front and Rear cameras, the front mirrored; upright frames at about 30 fps',
    kinds: ['camera.on', 'camera.switched'],
    eyes: 'the mirroring and the measured size',
    check: (q) => {
      const on = [...q.onPhone('camera.on'), ...q.onPhone('camera.switched')];
      const facings = [...new Set(on.map((e) => text(e, 'facing')))];
      return found(
        on.length > 0 && facings.includes('user') && facings.includes('environment') ? on : [],
        `${count(on, 'camera on or switched')}; facing ${facings.join(', ')}; ${[...new Set(on.map((e) => `${String(num(e, 'width'))}×${String(num(e, 'height'))} at ${String(num(e, 'fps'))}`))].join(', ')}`,
        on.length === 0 ? 'no camera on a phone' : `only facing ${facings.join(', ')} on a phone`,
      );
    },
  },
  {
    id: '2.1.3',
    round: R2,
    section: 'T2.1 — camera panel',
    title: 'ThinkPhone: Exposure, Focus, White balance, Zoom; Torch on the rear camera',
    kinds: [],
    eyes: 'the controls',
    check: () => none('no event shows the controls'),
  },
  {
    id: '2.1.4',
    round: R2,
    section: 'T2.1 — camera panel',
    title:
      'Manual exposure on the phone: time and ISO, kept across off, on and reload; Reset to auto',
    kinds: [],
    eyes: 'the picture and the controls',
    check: () => none('no event shows the controls'),
  },
  {
    id: '2.1.5',
    round: R2,
    section: 'T2.1 — camera panel',
    title: 'Focus on the front camera: Manual, then Auto again (reopened if needed)',
    kinds: [],
    eyes: 'the preview blinking',
    check: () => none('no event shows the controls'),
  },
  {
    id: '2.1.6',
    round: R2,
    section: 'T2.1 — camera panel',
    title: '"Exactly 60 fps" on each camera and resolution: 60 fps measured, or the notice and 30',
    kinds: ['settings.changed', 'camera.on', 'camera.switched', 'recording.started'],
    eyes: 'the measured frame rate and the notice',
    check: (q) => {
      const set = q.where(
        'settings.changed',
        (e) => text(e, 'key') === 'cameraFrameRate' && e.data['value'] === '60',
      );
      const sixty = q.where('recording.started', (e) => (num(e, 'fps') ?? 0) >= 59);
      return found(
        set,
        `asked for exactly 60 ${String(set.length)} times; ${count(sixty, 'recording')} at 60 fps${sixty.length > 0 ? `: ${[...new Set(sixty.map((e) => text(e, 'camera')))].join(', ')}` : ''}`,
        'never asked for exactly 60 fps',
      );
    },
  },
  {
    id: '2.1.7',
    round: R2,
    section: 'T2.1 — camera panel',
    title:
      'Sharpness meter: the numbers with the cube sharp, covered, moving, and the threshold between them',
    kinds: ['settings.changed'],
    eyes: 'the numbers (the meter is not in the events)',
    check: (q) => {
      const set = q.where('settings.changed', (e) => text(e, 'key') === 'sharpnessThreshold');
      return found(
        set,
        `the threshold set ${String(set.length)} times: ${set.map((e) => `${e.device.label} ${String(e.data['value'])}`).join(', ')}`,
        'the threshold never changed from 20',
      );
    },
  },
  {
    id: '2.1.8',
    round: R2,
    section: 'T2.1 — camera panel',
    title: 'Framing rectangle: dragged, kept per camera across reloads and orientations',
    kinds: ['sync.check'],
    eyes: 'the rectangle itself',
    check: (q) => {
      const tight = q.where('sync.check', (e) => flag(e, 'wide') === false);
      return found(
        tight,
        `${count(tight, 'sync check')} ran inside a rectangle (not the whole frame)`,
        'no sync check inside a rectangle',
      );
    },
  },
  {
    id: '2.1.9',
    round: R2,
    section: 'T2.1 — camera panel',
    title: 'Camera on across reloads: on, it opens again by itself; off, it stays off',
    kinds: ['app.start', 'camera.on'],
    eyes: 'the camera light on the other pages',
    check: (q) => {
      const reopened = q.of('app.start').filter((e) => q.next(e, 'camera.on', 20_000) !== null);
      return found(
        reopened,
        `${count(reopened, 'start')} opened the camera by themselves within 20 s`,
        'no start opened the camera by itself',
      );
    },
  },
  {
    id: '2.1.10',
    round: R2,
    section: 'T2.1 — camera panel',
    title: 'Permission denied: the panel says so and how to allow it (the system setting on a Mac)',
    kinds: ['error.app'],
    eyes: 'the words',
    check: (q) => {
      const hits = q.where(
        'error.app',
        (e) =>
          text(e, 'where') === 'camera' &&
          /denied|allow|permission|privacy/iu.test(text(e, 'message') ?? ''),
      );
      return found(
        hits,
        `${count(hits, 'refusal')}: ${[...new Set(hits.map((e) => text(e, 'message')))].slice(0, 2).join(' | ')} (expected here, so not a failure)`,
        'the camera was never refused',
      );
    },
  },
  {
    id: '2.1.11',
    round: R2,
    section: 'T2.1 — camera panel',
    title: 'Another app holding the camera: "in use by another app"',
    kinds: ['error.app'],
    eyes: null,
    check: (q) => {
      const hits = q.where(
        'error.app',
        (e) => text(e, 'where') === 'camera' && /in use/iu.test(text(e, 'message') ?? ''),
      );
      return found(
        hits,
        `${count(hits, 'time')} the camera was in use by another app (expected here)`,
        'the camera was never in use elsewhere',
      );
    },
  },
  // ---- T2.3 — clips (capture lab) ----
  {
    id: '2.3.1',
    round: R2,
    section: 'T2.3 — clips',
    title: 'Capture lab: a 3 s clip plays with its sound; its codecs written down',
    kinds: ['page.viewed'],
    eyes: 'the lab (its clips are not events)',
    check: (q) => {
      const hits = q.where('page.viewed', (e) => text(e, 'page') === 'capture-lab');
      return found(
        hits,
        `${count(hits, 'visit')} to the capture lab`,
        'the capture lab was never opened',
      );
    },
  },
  {
    id: '2.3.2',
    round: R2,
    section: 'T2.3 — clips',
    title: 'Capture lab: a 30 s cut, its time and size; no frame dropped',
    kinds: ['page.viewed'],
    eyes: 'the lab',
    check: (q) => {
      const hits = q.where('page.viewed', (e) => text(e, 'page') === 'capture-lab');
      return found(
        hits,
        `${count(hits, 'visit')} to the capture lab`,
        'the capture lab was never opened',
      );
    },
  },
  // ---- T2.4 — recording ----
  {
    id: '2.4.1',
    round: R2,
    section: 'T2.4 — recording',
    title:
      'Camera on, cube connected: recording, with H.264 and AAC; without Record audio, "no audio"',
    kinds: ['recording.started', 'settings.changed'],
    eyes: null,
    check: (q) => {
      const started = q.of('recording.started');
      const h264 = started.filter((e) => /^avc1/u.test(text(e, 'codec') ?? ''));
      const silent = started.filter((e) => flag(e, 'audio') === false);
      const codecs = [
        ...new Set(
          started.map(
            (e) =>
              `${e.device.label}: ${text(e, 'codec') ?? '?'} at ${round((num(e, 'bitrate') ?? 0) / 1e6, 1)} Mbps, ${text(e, 'audioCodec') ?? 'no audio'}`,
          ),
        ),
      ];
      return found(
        h264,
        `${count(started, 'recording')}; ${String(h264.length)} H.264; ${String(silent.length)} without audio asked; codecs: ${codecs.join(' | ')}`,
        started.length === 0 ? 'no recording' : `no H.264 recording; codecs: ${codecs.join(' | ')}`,
      );
    },
  },
  {
    id: '2.4.2',
    round: R2,
    section: 'T2.4 — recording',
    title: 'Three solves: each row gets "2 clips" about a second after; about 20 MB per attempt',
    kinds: ['attempt.done', 'clip.saved'],
    eyes: null,
    check: (q) => {
      const two = q.where('attempt.done', (e) => num(e, 'clips') === 2);
      const bytes = two.map((e) => num(e, 'clipBytes') ?? 0);
      const settle = two.map((e) => num(e, 'settledMs') ?? 0);
      return found(
        two.length >= 3 ? two : [],
        `${count(two, 'attempt')} with two clips; median ${round((median(bytes) ?? 0) / 1e6, 1)} MB per attempt, clips saved ${round((median(settle) ?? 0) / 1000, 1)} s after the end (median)`,
        `${String(two.length)} attempts with two clips`,
      );
    },
  },
  {
    id: '2.4.3',
    round: R2,
    section: 'T2.4 — recording',
    title: 'The badge opens the viewer: the clips play with sound, the moves follow, a click seeks',
    kinds: ['clips.viewed'],
    eyes: 'the highlighted move against the picture',
    check: (q) => {
      const hits = q.of('clips.viewed');
      return found(hits, count(hits, 'viewing'), 'the viewer was never opened');
    },
  },
  {
    id: '2.4.4',
    round: R2,
    section: 'T2.4 — recording',
    title:
      'The scramble clip begins 2–3 s before the first turn, the solve clip 3–4 s; both end 1 s after',
    kinds: ['clip.saved'],
    eyes: "the first move's time in the viewer's list",
    check: (q) => {
      const clips = q.of('clip.saved');
      const onTime = clips.filter((e) => flag(e, 'truncatedStart') === false);
      return found(
        onTime,
        `${String(onTime.length)} of ${String(clips.length)} clips begin where asked (not late)`,
        'no clip saved',
      );
    },
  },
  {
    id: '2.4.5',
    round: R2,
    section: 'T2.4 — recording',
    title: 'Download in the viewer gives five files, six with gyro.json; the MP4s play',
    kinds: ['files.downloaded'],
    eyes: 'the MP4s in the system player',
    check: (q) => {
      const hits = q.where('files.downloaded', (e) => text(e, 'what') === 'clips');
      return found(
        hits,
        `${count(hits, 'download')}: ${[...new Set(hits.map((e) => String(num(e, 'files'))))].join(', ')} files`,
        'no download from the viewer',
      );
    },
  },
  {
    id: '2.4.6',
    round: R2,
    section: 'T2.4 — recording',
    title:
      'A DNF during a solve: both clips; a DNF right after the scramble: the scramble clip only',
    kinds: ['attempt.done'],
    eyes: null,
    check: (q) => {
      const dnf = q.where('attempt.done', (e) => text(e, 'status') === 'dnf');
      const both = dnf.filter((e) => num(e, 'clips') === 2);
      const one = dnf.filter((e) => num(e, 'clips') === 1);
      return found(
        both.length > 0 && one.length > 0 ? dnf : [],
        `${count(dnf, 'DNF')}: ${String(both.length)} with both clips, ${String(one.length)} with the scramble's alone`,
        `${count(dnf, 'DNF')}: ${String(both.length)} with both clips, ${String(one.length)} with one`,
      );
    },
  },
  {
    id: '2.4.7',
    round: R2,
    section: 'T2.4 — recording',
    title: 'Mark as solved mid-solve: no row, no clip left; the restarted attempt gets its own',
    kinds: ['cube.reset', 'attempt.done'],
    eyes: "the attempt's folder",
    check: (q) => {
      const resets = q.where('cube.reset', (e) => e.attempt !== null);
      const own = resets.filter(
        (e) =>
          q.next(
            e,
            'attempt.done',
            HOUR,
            (d) => d.session === e.session && d.attempt === e.attempt && (num(d, 'clips') ?? 0) > 0,
          ) !== null,
      );
      return found(
        resets,
        `${count(resets, 'reset')} during an attempt; ${String(own.length)} followed by that attempt's end with clips`,
        'no Mark as solved during an attempt',
      );
    },
  },
  {
    id: '2.4.8',
    round: R2,
    section: 'T2.4 — recording',
    title:
      'Sessions page: the storage meter and "N clips, … MB" per session; the export is one JSON file',
    kinds: ['page.viewed', 'files.downloaded'],
    eyes: 'the meter',
    check: (q) => {
      const views = q.where('page.viewed', (e) => text(e, 'page') === 'sessions');
      return found(views, count(views, 'view'), 'the Sessions page was never opened');
    },
  },
  {
    id: '2.4.9',
    round: R2,
    section: 'T2.4 — recording',
    title:
      'Twenty minutes of solves with the camera on, the phone on its stand: warmth, slowdowns, frames dropped, storage used',
    kinds: ['recording.started', 'recording.stopped', 'attempt.done'],
    eyes: 'how warm the phone got',
    check: (q) => {
      const spans: string[] = [];
      for (const [, events] of q.sessions()) {
        const phone = events.filter(
          (e) => isPhone(e) && e.kind === 'attempt.done' && (num(e, 'clips') ?? 0) > 0,
        );
        if (phone.length > 1 && phone[phone.length - 1].tsMs - phone[0].tsMs >= 20 * MINUTE) {
          spans.push(
            `${phone[0].device.label}: ${String(phone.length)} attempts over ${round((phone[phone.length - 1].tsMs - phone[0].tsMs) / MINUTE)} min`,
          );
        }
      }
      const dropped = q.onPhone('recording.stopped', (e) => (num(e, 'dropped') ?? 0) > 0);
      const facts = `${spans.join('; ')}${dropped.length > 0 ? `; frames dropped: ${dropped.map((e) => String(num(e, 'dropped'))).join(', ')}` : '; no frame dropped'}`;
      return spans.length > 0
        ? dropped.length > 0
          ? failed(facts)
          : ok(facts)
        : none('no 20 minutes of recorded attempts on a phone');
    },
  },
  {
    id: '2.4.10',
    round: R2,
    section: 'T2.4 — recording',
    title:
      'A clip at the edge: camera off right after a solve still saves the clip; a scramble within 2 s of Turn on gets a late clip',
    kinds: ['clip.saved', 'camera.off'],
    eyes: null,
    check: (q) => {
      const late = q.where('clip.saved', (e) => flag(e, 'truncatedStart') === true);
      const edge = q.of('camera.off').filter((e) => q.previous(e, 'clip.saved', 5000) !== null);
      return found(
        late,
        `${count(late, 'late clip')} (late by ${late
          .slice(0, 5)
          .map((e) => `${round((num(e, 'lateMs') ?? 0) / 1000, 1)} s`)
          .join(', ')}); ${String(edge.length)} camera off within 5 s of a clip saved`,
        'no late clip',
      );
    },
  },
  // ---- T2.9 — a long scramble, a reconnection, the sound ----
  {
    id: '2.9.1',
    round: R2,
    section: 'T2.9 — a long scramble, a reconnection, the sound',
    title: 'A scramble with a 3-minute pause: both clips, the scramble clip about 61 s, not late',
    kinds: ['attempt.done', 'clip.saved'],
    eyes: null,
    check: (q) => {
      const long = q.where('attempt.done', (e) => (num(e, 'scrambleMs') ?? 0) >= 2 * MINUTE);
      const whole = long.filter((e) => num(e, 'clips') === 2 && num(e, 'clipsLate') === 0);
      return found(
        whole,
        `${String(whole.length)} of ${String(long.length)} attempts with a scramble over 2 min have both clips, none late`,
        long.length === 0
          ? 'no scramble over 2 minutes'
          : `${String(long.length)} long scrambles, none with both clips on time`,
      );
    },
  },
  {
    id: '2.9.2',
    round: R2,
    section: 'T2.9 — a long scramble, a reconnection, the sound',
    title:
      'A solve after a reconnection: the clock fit from the moves after it (a 0.99–1.01, residual tens of ms)',
    kinds: ['cube.disconnected', 'cube.connected', 'attempt.done'],
    eyes: null,
    check: (q) => {
      const mid = q.where(
        'cube.disconnected',
        (e) => text(e, 'kind') === 'gan' && e.attempt !== null,
      );
      const results = mid.flatMap((e) => {
        const back = reconnected(q, e, HOUR);
        const done =
          back === null
            ? null
            : q.next(
                back,
                'attempt.done',
                HOUR,
                (d) => d.session === e.session && d.attempt === e.attempt,
              );
        return done === null ? [] : [done];
      });
      const good = results.filter((d) => {
        const a = num(d, 'clockA');
        return a !== null && a > 0.99 && a < 1.01 && (num(d, 'clockResidualP95Ms') ?? 1e9) < 1000;
      });
      const facts = `${String(results.length)} attempts ended after a reconnection; fits: ${results
        .slice(0, 5)
        .map(
          (d) =>
            `a ${round(num(d, 'clockA') ?? 0, 4)}, p95 ${round(num(d, 'clockResidualP95Ms') ?? 0)} ms, ${String(num(d, 'clockSamples'))} samples`,
        )
        .join('; ')}`;
      return results.length === 0
        ? none('no attempt ended after a reconnection')
        : good.length === results.length
          ? ok(facts)
          : failed(facts);
    },
  },
  {
    id: '2.9.3',
    round: R2,
    section: 'T2.9 — a long scramble, a reconnection, the sound',
    title:
      'The sound: the audio codec in the Codecs line; a clip plays with sound, or the notes say why not',
    kinds: ['recording.started', 'audio.missing', 'clip.saved'],
    eyes: 'the sound itself',
    check: (q) => {
      const withAudio = q.where('clip.saved', (e) => flag(e, 'audio') === true);
      const missing = q.of('audio.missing');
      const facts = `${String(withAudio.length)} of ${String(q.of('clip.saved').length)} clips with sound; ${count(missing, 'clip')} without: ${[...new Set(missing.map((e) => text(e, 'cause')))].slice(0, 3).join(' | ')}`;
      return withAudio.length === 0
        ? none(facts)
        : missing.length > withAudio.length / 10
          ? failed(facts)
          : ok(facts);
    },
  },
  // ---- T2.7 — layout ----
  {
    id: '2.7.1',
    round: R2,
    section: 'T2.7 — layout',
    title: 'MacBook: scramble, time and preview in view together, the line under the preview',
    kinds: [],
    eyes: 'the layout',
    check: () => none('no event shows the layout'),
  },
  {
    id: '2.7.2',
    round: R2,
    section: 'T2.7 — layout',
    title:
      'ThinkPhone in portrait with the scramble over the picture off: all in view, nothing sideways',
    kinds: ['settings.changed'],
    eyes: 'the layout',
    check: (q) => {
      const off = q.onPhone(
        'settings.changed',
        (e) => text(e, 'key') === 'scrambleOverPicture' && e.data['value'] === false,
      );
      return found(
        off,
        `the setting turned off ${String(off.length)} times on a phone`,
        'the setting never turned off on a phone',
      );
    },
  },
  {
    id: '2.7.3',
    round: R2,
    section: 'T2.7 — layout',
    title: 'The preview stays in view through an attempt; the front camera mirrored',
    kinds: [],
    eyes: 'the layout',
    check: () => none('no event shows the layout'),
  },
  {
    id: '2.7.4',
    round: R2,
    section: 'T2.7 — layout',
    title: 'The sharpness number stays the same during a solve',
    kinds: [],
    eyes: 'the meter',
    check: () => none('no event shows the meter'),
  },
  {
    id: '2.7.5',
    round: R2,
    section: 'T2.7 — layout',
    title:
      'Fifteen solves or more: the last 12 listed, See all opens the session page with the same ao12',
    kinds: ['attempt.done', 'page.viewed'],
    eyes: 'the ao12 on both pages',
    check: (q) => {
      const best = q.biggestSession();
      const pages = q.where('page.viewed', (e) => text(e, 'page') === 'session');
      return found(
        best !== null && best.attempts >= 15 && pages.length > 0 ? pages : [],
        `${best === null ? 'no session' : `${String(best.attempts)} attempts in one session`}; ${count(pages, 'session page view')}`,
        `${best === null ? 'no session' : `at most ${String(best.attempts)} attempts in one session`}; ${count(pages, 'session page view')}`,
      );
    },
  },
  {
    id: '2.7.6',
    round: R2,
    section: 'T2.7 — layout',
    title:
      "The session's page: its facts, a clip badge that opens the viewer and downloads the files, Export, Delete",
    kinds: ['page.viewed', 'clips.viewed', 'files.downloaded', 'session.deleted'],
    eyes: null,
    check: (q) => {
      const pages = q.where('page.viewed', (e) => text(e, 'page') === 'session');
      const viewed = q
        .of('clips.viewed')
        .filter(
          (e) =>
            q.previous(
              e,
              'page.viewed',
              HOUR,
              (p) => text(p, 'page') === 'session' && p.session === e.session,
            ) !== null,
        );
      const facts = `${count(pages, 'view')}; ${String(viewed.length)} clips viewed from a session page; ${count(
        q.where('files.downloaded', (e) => text(e, 'what') === 'export'),
        'export',
      )}; ${count(q.of('session.deleted'), 'deletion')}`;
      return pages.length > 0 && viewed.length > 0 ? ok(facts) : none(facts);
    },
  },
  {
    id: '2.7.7',
    round: R2,
    section: 'T2.7 — layout',
    title: 'Camera settings: closed until the camera is on, then open; kept as left across reloads',
    kinds: [],
    eyes: 'the disclosure',
    check: () => none('no event shows the disclosure'),
  },
  // ---- T2.13 — the scramble over the picture (phone) ----
  {
    id: '2.13.1',
    round: R2,
    section: 'T2.13 — the scramble over the picture (phone)',
    title:
      'The picture at the top with the scramble over it; readable while solving; the setting off and on',
    kinds: ['settings.changed', 'attempt.done'],
    eyes: 'the strip, the hands and the moves on it',
    check: (q) => {
      const toggled = q.onPhone(
        'settings.changed',
        (e) => text(e, 'key') === 'scrambleOverPicture',
      );
      const recorded = q.onPhone('attempt.done', (e) => (num(e, 'clips') ?? 0) > 0);
      return found(
        recorded,
        `${count(recorded, 'attempt')} recorded on a phone; the setting toggled ${String(toggled.length)} times`,
        'no recorded attempt on a phone',
      );
    },
  },
  // ---- T2.5 — sync check ----
  {
    id: '2.5.1',
    round: R2,
    section: 'T2.5 — sync check',
    title:
      'The framing hint (T2.8): with the whole frame as the rectangle, the check asks for one first',
    kinds: ['sync.check'],
    eyes: 'the hint and its buttons',
    check: (q) => {
      const checks = q.of('sync.check');
      const tight = checks.filter((e) => flag(e, 'wide') === false);
      return found(
        tight,
        `${String(tight.length)} of ${String(checks.length)} checks ran inside a rectangle`,
        'no sync check',
      );
    },
  },
  {
    id: '2.5.2',
    round: R2,
    section: 'T2.5 — sync check',
    title:
      'A check: "Hold still", the countdown, "Turn n of 10", then "Camera lags the cube by X ms (±Y)"; the attempt back on its scramble',
    kinds: ['sync.check'],
    eyes: 'the panel through the check',
    check: (q) => {
      const passed = q.where('sync.check', (e) => text(e, 'outcome') === 'ok');
      return found(
        passed,
        `${count(passed, 'check')} passed: ${passed
          .slice(-6)
          .map(
            (e) =>
              `${e.device.label}/${text(e, 'camera') ?? '?'} ${round(num(e, 'offsetMs') ?? 0)} ±${round(num(e, 'spreadMs') ?? 0)} ms (${String(num(e, 'matched'))}/${String(num(e, 'of'))} matched, ${String(num(e, 'kept'))} kept)`,
          )
          .join('; ')}`,
        'no sync check passed',
      );
    },
  },
  {
    id: '2.5.3',
    round: R2,
    section: 'T2.5 — sync check',
    title: 'The offset is stable: two checks of one camera within 25 ms, both spreads under 83 ms',
    kinds: ['sync.check'],
    eyes: null,
    check: (q) => {
      const byCamera = new Map<string, ReportEvent[]>();
      for (const e of q.where('sync.check', (c) => text(c, 'outcome') === 'ok')) {
        const key = `${e.device.label}/${text(e, 'camera') ?? '?'}`;
        byCamera.set(key, [...(byCamera.get(key) ?? []), e]);
      }
      const facts: string[] = [];
      let stable = 0;
      let unstable = 0;
      for (const [camera, checks] of byCamera) {
        if (checks.length < 2) {
          continue;
        }
        const offsets = checks.map((e) => num(e, 'offsetMs') ?? 0);
        const spreads = checks.map((e) => num(e, 'spreadMs') ?? 0);
        const within =
          Math.max(...offsets) - Math.min(...offsets) <= 25 && Math.max(...spreads) < 83;
        if (within) {
          stable++;
        } else {
          unstable++;
        }
        facts.push(
          `${camera}: offsets ${offsets.map((o) => round(o)).join(', ')} ms, spreads ${spreads.map((s) => round(s)).join(', ')} ms${within ? '' : ' (apart)'}`,
        );
      }
      return stable + unstable === 0
        ? none('no camera with two checks passed')
        : unstable > 0
          ? failed(facts.join('; '))
          : ok(facts.join('; '));
    },
  },
  {
    id: '2.5.4',
    round: R2,
    section: 'T2.5 — sync check',
    title:
      'A failure says why (did not move, no motion, fewer than 4 matches), with Retry and the check data',
    kinds: ['sync.check', 'files.downloaded'],
    eyes: null,
    check: (q) => {
      const failures = q.where('sync.check', (e) => text(e, 'outcome') === 'failed');
      const reasons = [...new Set(failures.map((e) => text(e, 'reason') ?? '?'))];
      const data = q.where('files.downloaded', (e) => text(e, 'what') === 'sync-check');
      return found(
        failures,
        `${count(failures, 'failed check')}: ${reasons.join(', ')}; ${count(data, 'check data download')} (expected here, so not a failure)`,
        'no sync check failed',
      );
    },
  },
  {
    id: '2.5.5',
    round: R2,
    section: 'T2.5 — sync check',
    title: 'Not offered once a scramble has begun, nor during a solve, nor without a cube',
    kinds: [],
    eyes: 'the line under the picture',
    check: () => none('no event shows the offer'),
  },
  {
    id: '2.5.6',
    round: R2,
    section: 'T2.5 — sync check',
    title:
      'Three solves after a check: clock.cameras in the export, the later clips with syncResidualMs',
    kinds: ['sync.check', 'clip.saved'],
    eyes: 'the export (the coordinator)',
    check: (q) => {
      const withLag = q.where('clip.saved', (e) => num(e, 'syncResidualMs') !== null);
      return found(
        withLag,
        `${count(withLag, 'clip')} carry a camera lag: ${[...new Set(withLag.map((e) => `${e.device.label}/${text(e, 'camera') ?? '?'} ${round(num(e, 'syncResidualMs') ?? 0)} ms`))].slice(0, 6).join(', ')}`,
        'no clip with a camera lag',
      );
    },
  },
  {
    id: '2.5.7',
    round: R2,
    section: 'T2.5 — sync check',
    title: 'Capture lab: the motion bars, the pixel format, the lag and the cost per frame',
    kinds: ['page.viewed'],
    eyes: 'the lab',
    check: (q) => {
      const hits = q.where('page.viewed', (e) => text(e, 'page') === 'capture-lab');
      return found(
        hits,
        `${count(hits, 'visit')} to the capture lab`,
        'the capture lab was never opened',
      );
    },
  },
  {
    id: '2.5.8',
    round: R2,
    section: 'T2.5 — sync check',
    title: 'The "Camera lag" table of docs/DEVICES.md',
    kinds: ['sync.check'],
    eyes: 'the coordinator writes it from the checks above',
    check: (q) => {
      const passed = q.where('sync.check', (e) => text(e, 'outcome') === 'ok');
      return found(
        passed,
        `${String(passed.length)} checks to take the numbers from`,
        'no check passed',
      );
    },
  },
  // ---- T2.10 — video quality ----
  {
    id: '2.10.1',
    round: R2,
    section: 'T2.10 — video quality',
    title: 'Standard quality: 4 Mbps, a 20 s solve clip about 10 MB, about 20 MB per attempt',
    kinds: ['recording.started', 'clip.saved'],
    eyes: null,
    check: (q) => {
      const standard = q.where('recording.started', (e) => text(e, 'quality') === 'standard');
      const solves = q.where('clip.saved', (e) => text(e, 'segment') === 'solve');
      const perSecond = solves
        .filter((e) => (num(e, 'frames') ?? 0) > 0)
        .map((e) => (num(e, 'bytes') ?? 0) / ((num(e, 'frames') ?? 1) / 30));
      return found(
        standard,
        `${count(standard, 'recording')} at Standard (${[...new Set(standard.map((e) => round((num(e, 'bitrate') ?? 0) / 1e6, 1)))].join(', ')} Mbps); ${String(solves.length)} solve clips, median ${round((median(solves.map((e) => num(e, 'bytes') ?? 0)) ?? 0) / 1e6, 1)} MB, ${round(((median(perSecond) ?? 0) * 8) / 1e6, 1)} Mbps measured`,
        'no recording at Standard',
      );
    },
  },
  // ---- T2.12 — the microphone ----
  {
    id: '2.12.1',
    round: R2,
    section: 'T2.12 — the microphone',
    title:
      "A clip's sound has the cube's clicks; the panel says mic raw, no notice that the browser kept processing on",
    kinds: ['recording.started', 'recording.notice', 'clip.saved'],
    eyes: 'the clicks in the sound',
    check: (q) => {
      const raw = q.where('recording.started', (e) => text(e, 'processing') === 'raw');
      const kept = q.where('recording.notice', (e) =>
        /not raw|processing/iu.test(text(e, 'message') ?? ''),
      );
      const applied = [
        ...new Set(raw.map((e) => `${e.device.label}: ${JSON.stringify(e.data['applied'])}`)),
      ];
      const facts = `${count(raw, 'recording')} with the microphone raw; applied ${applied.join(' | ')}; ${count(kept, 'notice')} that the browser kept processing on`;
      return raw.length === 0 ? none(facts) : kept.length > 0 ? failed(facts) : ok(facts);
    },
  },
  // ---- T2.14 — two cameras in one session ----
  {
    id: '2.14.1',
    round: R2,
    section: 'T2.14 — two cameras in one session',
    title:
      'FaceTime then the Logitech then FaceTime again: laptop and laptop-2, a check each, the clips named after them',
    kinds: ['camera.switched', 'sync.check', 'clip.saved'],
    eyes: 'the export (the coordinator)',
    check: (q) => {
      const facts: string[] = [];
      let seen = 0;
      for (const [session, events] of q.sessions()) {
        const cameras = new Set(
          events.filter((e) => e.kind === 'clip.saved').map((e) => text(e, 'camera') ?? '?'),
        );
        if (cameras.size >= 2) {
          seen++;
          const checks = events
            .filter((e) => e.kind === 'sync.check' && text(e, 'outcome') === 'ok')
            .map((e) => `${text(e, 'camera') ?? '?'} ${round(num(e, 'offsetMs') ?? 0)} ms`);
          facts.push(
            `${session.slice(0, 8)}: clips of ${[...cameras].join(', ')}; checks ${checks.join(', ')}`,
          );
        }
      }
      return seen > 0
        ? ok(`${String(seen)} sessions with two cameras: ${facts.join('; ')}`)
        : none(
            `${count(q.onLaptop('camera.switched'), 'camera switch')} on a laptop, no session with clips of two cameras`,
          );
    },
  },
  // ---- T3.0 — account ----
  {
    id: '3.0.1',
    round: R3,
    section: 'T3.0 — account',
    title:
      'Signed out: Sign in in the header; no request to Firebase over a reload and a demo solve',
    kinds: [],
    eyes: 'DevTools → Network (events signed out are written later, and say nothing of requests)',
    check: () => none('no event shows the network'),
  },
  {
    id: '3.0.2',
    round: R3,
    section: 'T3.0 — account',
    title:
      "Sign in opens Google's window; the header shows the account; users/{uid} has the laptop's label",
    kinds: ['account.signin'],
    eyes: 'users/{uid} in the Firebase console (the coordinator)',
    check: (q) => {
      const hits = q.onLaptop('account.signin', (e) => text(e, 'outcome') === 'ok');
      return found(
        hits,
        `${count(hits, 'sign-in')} with the popup on a laptop`,
        'no sign-in with the popup on a laptop',
      );
    },
  },
  {
    id: '3.0.3',
    round: R3,
    section: 'T3.0 — account',
    title:
      "Reload: still signed in; Sign out, then Google's window closed without choosing: the cancellation said",
    kinds: ['account.signin', 'account.signout'],
    eyes: null,
    check: (q) => {
      const resumed = q.where('account.signin', (e) => text(e, 'outcome') === 'resumed');
      const out = q.of('account.signout');
      const cancelled = q.where(
        'account.signin',
        (e) =>
          text(e, 'outcome') === 'failed' &&
          /popup-closed|cancelled|user-cancelled/u.test(text(e, 'code') ?? ''),
      );
      const facts = `${count(resumed, 'start')} signed in again; ${count(out, 'sign-out')}; ${count(cancelled, 'cancelled sign-in')} (${[...new Set(cancelled.map((e) => text(e, 'code')))].join(', ')})`;
      return resumed.length > 0 && cancelled.length > 0 ? ok(facts) : none(facts);
    },
  },
  {
    id: '3.0.4',
    round: R3,
    section: 'T3.0 — account',
    title: 'The ThinkPhone, the installed app: Sign in with Google comes back signed in (T3.6)',
    kinds: ['account.signin'],
    eyes: null,
    check: (q) => {
      const hits = q.onPhone(
        'account.signin',
        (e) => text(e, 'outcome') === 'ok' && flag(e, 'installed') === true,
      );
      const failures = q.onPhone('account.signin', (e) => text(e, 'outcome') === 'failed');
      const facts = `${count(hits, 'sign-in')} in the installed app; ${count(failures, 'failure')}${failures.length === 0 ? '' : `: ${[...new Set(failures.map((e) => text(e, 'code')))].join(', ')}`}`;
      return hits.length > 0 ? ok(facts) : failures.length > 0 ? failed(facts) : none(facts);
    },
  },
  {
    id: '3.0.5',
    round: R3,
    section: 'T3.0 — account',
    title:
      'Signed in, airplane mode, the installed app opens signed in, the timer works and a solve is saved',
    kinds: ['app.start', 'account.signin', 'attempt.done'],
    eyes: null,
    check: (q) => {
      const offline = q.onPhone(
        'app.start',
        (e) => flag(e, 'online') === false && e.device.installed,
      );
      const solved = offline.filter(
        (e) =>
          q.next(e, 'account.signin', 2 * MINUTE, (s) => text(s, 'outcome') === 'resumed') !==
            null && q.next(e, 'attempt.done', 30 * MINUTE) !== null,
      );
      return found(
        solved,
        `${String(solved.length)} of ${String(offline.length)} offline starts of the installed app came back signed in and recorded an attempt`,
        offline.length === 0
          ? 'no offline start of the installed app'
          : `${String(offline.length)} offline starts, none signed in with an attempt`,
      );
    },
  },
  {
    id: '3.0.6',
    round: R3,
    section: 'T3.0 — account',
    title: 'Sign out: Sign in again; a reload stays signed out, no Firebase request',
    kinds: ['account.signout', 'app.start'],
    eyes: 'the Network panel',
    check: (q) => {
      const out = q.of('account.signout');
      return found(out, count(out, 'sign-out'), 'no sign-out');
    },
  },
  // ---- T3.1 — the session index ----
  {
    id: '3.1.1',
    round: R3,
    section: 'T3.1 — the session index',
    title:
      'Signed in, a solve on the real cube: sessions/{id} and its attempt in the console, with device, video and upload',
    kinds: ['attempt.done', 'error.app'],
    eyes: 'the documents in the Firebase console (the coordinator, or the QA view)',
    check: (q) => {
      const real = q.realAttempts();
      const refused = q.where('error.app', (e) => text(e, 'where') === 'index');
      const facts = `${count(real, 'real attempt')}; ${count(refused, 'index refusal')}${refused.length > 0 ? `: ${[...new Set(refused.map((e) => text(e, 'message')))].slice(0, 2).join(' | ')}` : ''}`;
      return real.length === 0 ? none(facts) : refused.length > 0 ? failed(facts) : ok(facts);
    },
  },
  {
    id: '3.1.2',
    round: R3,
    section: 'T3.1 — the session index',
    title:
      'On the ThinkPhone, the MacBook\'s session as "cloud" (read-only), the phone\'s own as "both", the device filter',
    kinds: ['page.viewed'],
    eyes: 'the badges and the filter',
    check: (q) => {
      const views = q.onPhone('page.viewed', (e) => text(e, 'page') === 'sessions');
      return found(
        views,
        count(views, 'Sessions page view'),
        'the Sessions page was never opened on a phone',
      );
    },
  },
  {
    id: '3.1.3',
    round: R3,
    section: 'T3.1 — the session index',
    title:
      'A solve on the phone, then the MacBook\'s Sessions page reloaded: the phone\'s session as "cloud"',
    kinds: ['attempt.done', 'page.viewed'],
    eyes: 'the badge',
    check: (q) => {
      const phone = q.onPhone('attempt.done');
      const later = q
        .onLaptop('page.viewed', (e) => text(e, 'page') === 'sessions')
        .filter((e) => phone.some((p) => p.tsMs < e.tsMs));
      return found(
        phone.length > 0 ? later : [],
        `${count(phone, 'attempt')} on a phone, then ${String(later.length)} Sessions page views on a laptop`,
        'no attempt on a phone followed by the Sessions page on a laptop',
      );
    },
  },
  {
    id: '3.1.4',
    round: R3,
    section: 'T3.1 — the session index',
    title: 'Sessions recorded signed out: once signed in, the catch-up writes them ("both")',
    kinds: ['account.signout', 'attempt.done', 'account.signin'],
    eyes: 'the document appearing in the console',
    check: (q) => {
      const caught = q.of('account.signout').filter((e) => {
        const done = q.next(e, 'attempt.done', 2 * HOUR);
        return done !== null && q.next(done, 'account.signin', 2 * HOUR) !== null;
      });
      return found(
        caught,
        `${String(caught.length)} sign-outs followed by an attempt and a sign-in`,
        'no attempt recorded signed out and then signed in',
      );
    },
  },
  {
    id: '3.1.5',
    round: R3,
    section: 'T3.1 — the session index',
    title:
      'Airplane mode on the phone, a solve: a dashed badge, a write waiting; back online, the document reaches the console',
    kinds: ['network.changed', 'app.start', 'attempt.done'],
    eyes: 'the dashed badge',
    check: (q) => {
      const offline = [
        ...q.onPhone('network.changed', (e) => flag(e, 'online') === false),
        ...q.onPhone('app.start', (e) => flag(e, 'online') === false),
      ];
      const solved = offline.filter(
        (e) =>
          q.next(e, 'attempt.done', 30 * MINUTE) !== null &&
          q.next(e, 'network.changed', 2 * HOUR, (n) => flag(n, 'online') === true) !== null,
      );
      return found(
        solved,
        `${String(solved.length)} of ${String(offline.length)} offline spells on a phone had an attempt and then the network back`,
        offline.length === 0
          ? 'the phone was never offline'
          : `${String(offline.length)} offline spells, none with an attempt and the network back`,
      );
    },
  },
  {
    id: '3.1.6',
    round: R3,
    section: 'T3.1 — the session index',
    title: "The QA view on each device: today's attempts per device, and this device's last sync",
    kinds: ['page.viewed'],
    eyes: 'the numbers',
    check: (q) => {
      const views = q.where('page.viewed', (e) => text(e, 'page') === 'qa');
      const devices = new Set(views.map((e) => e.device.label));
      return found(
        devices.size >= 2 ? views : [],
        count(views, 'QA view'),
        `${count(views, 'QA view')} (on one device only)`,
      );
    },
  },
  {
    id: '3.1.7',
    round: R3,
    section: 'T3.1 — the session index',
    title: 'Signed out on a device: the Sessions page without badges, filter or QA link',
    kinds: [],
    eyes: 'the page (the events say nothing of the account)',
    check: () => none('no event shows the page signed out'),
  },
  // ---- T3.3 — uploads ----
  {
    id: '3.3.1',
    round: R3,
    section: 'T3.3 — uploads',
    title: 'The MacBook: Upload sessions and Keep local copies on, no Wi-Fi only',
    kinds: ['settings.changed'],
    eyes: 'Settings → Uploads',
    check: (q) => {
      const changes = q.onLaptop('settings.changed', (e) =>
        ['uploadSessions', 'keepLocalCopies', 'wifiOnly'].includes(text(e, 'key') ?? ''),
      );
      return ok(
        changes.length === 0
          ? 'the defaults were never changed on a laptop'
          : `changed on a laptop: ${changes.map((e) => `${text(e, 'key') ?? '?'} ${String(e.data['value'])}`).join(', ')}`,
      );
    },
  },
  {
    id: '3.3.2',
    round: R3,
    section: 'T3.3 — uploads',
    title:
      'A solve with the camera on: ↑ 1 then nothing, "Up to date", the files in the bucket, upload.state done',
    kinds: ['attempt.done', 'upload.state'],
    eyes: 'the bucket (the coordinator, with gcloud or rclone)',
    check: (q) => {
      const done = q.where('upload.state', (e) => text(e, 'state') === 'done');
      const failures = q.where('upload.state', (e) => text(e, 'state') === 'failed');
      const delays = done
        .map((e) => {
          const ended = q.previous(
            e,
            'attempt.done',
            24 * HOUR,
            (d) => d.session === e.session && d.attempt === e.attempt,
          );
          return ended === null ? null : e.tsMs - ended.tsMs;
        })
        .filter((d): d is number => d !== null);
      const facts = `${count(done, 'attempt')} uploaded (${[...new Set(done.map((e) => String(num(e, 'files'))))].join(', ')} files), median ${round((median(delays) ?? 0) / 1000)} s after the end; ${count(failures, 'failure')}${failures.length > 0 ? `: ${[...new Set(failures.map((e) => text(e, 'error')))].slice(0, 2).join(' | ')}` : ''}`;
      return done.length === 0 ? none(facts) : failures.length > 0 ? failed(facts) : ok(facts);
    },
  },
  {
    id: '3.3.3',
    round: R3,
    section: 'T3.3 — uploads',
    title: "The QA view: today's row counts the attempt, its bytes uploaded, Pending 0 B",
    kinds: ['page.viewed'],
    eyes: 'the numbers',
    check: (q) => {
      const views = q.where('page.viewed', (e) => text(e, 'page') === 'qa');
      return found(views, count(views, 'QA view'), 'the QA view was never opened');
    },
  },
  {
    id: '3.3.4',
    round: R3,
    section: 'T3.3 — uploads',
    title:
      'Twenty solves in a row: the attempts upload as they come; session.json again two minutes after the last',
    kinds: ['attempt.done', 'upload.state'],
    eyes: "the functions' log for session.json (the coordinator)",
    check: (q) => {
      let best: { session: string; attempts: number; done: number } | null = null;
      for (const [session, events] of q.sessions()) {
        // The attempts that stayed: those ended, less those deleted right after (Delete last).
        const deleted = new Set(
          events.filter((e) => e.kind === 'attempt.deleted').map((e) => e.attempt),
        );
        const attempts = events.filter(
          (e) => e.kind === 'attempt.done' && !deleted.has(e.attempt),
        ).length;
        const done = new Set(
          events
            .filter((e) => e.kind === 'upload.state' && text(e, 'state') === 'done')
            .map((e) => e.attempt),
        ).size;
        if (attempts >= 20 && (best === null || attempts > best.attempts)) {
          best = { session, attempts, done };
        }
      }
      return best === null
        ? none('no session of 20 attempts')
        : best.done >= best.attempts
          ? ok(
              `${String(best.attempts)} attempts in session ${best.session.slice(0, 8)}, ${String(best.done)} uploaded`,
            )
          : failed(
              `${String(best.attempts)} attempts in session ${best.session.slice(0, 8)}, only ${String(best.done)} uploaded`,
            );
    },
  },
  {
    id: '3.3.5',
    round: R3,
    section: 'T3.3 — uploads',
    title:
      'Wi-Fi off during an upload: "Offline", then on by itself; a reload resumes without a second signature',
    kinds: ['upload.paused', 'upload.resumed', 'app.start'],
    eyes: "the functions' log (the coordinator)",
    check: (q) => {
      const offline = q.where('upload.paused', (e) => text(e, 'reason') === 'offline');
      const resumed = offline.filter((e) => q.next(e, 'upload.resumed', 2 * HOUR) !== null);
      return found(
        offline,
        `${count(offline, 'pause')} offline, ${String(resumed.length)} resumed`,
        'the uploads were never paused offline',
      );
    },
  },
  {
    id: '3.3.6',
    round: R3,
    section: 'T3.3 — uploads',
    title:
      'Keep local copies off: the uploaded clips leave the device, "in the cloud", storage down',
    kinds: ['settings.changed', 'storage.deleted'],
    eyes: 'the badges and the viewer',
    check: (q) => {
      const off = q.where(
        'settings.changed',
        (e) => text(e, 'key') === 'keepLocalCopies' && e.data['value'] === false,
      );
      const deleted = q.of('storage.deleted');
      const bytes = deleted.reduce((sum, e) => sum + (num(e, 'bytes') ?? 0), 0);
      return found(
        deleted,
        `${count(deleted, 'deletion')}, ${String(deleted.reduce((sum, e) => sum + (num(e, 'files') ?? 0), 0))} clips, ${round(bytes / 1e6)} MB; the setting turned off ${String(off.length)} times`,
        off.length > 0
          ? 'the setting turned off, but no clip left a device'
          : 'the setting never turned off',
      );
    },
  },
  {
    id: '3.3.7',
    round: R3,
    section: 'T3.3 — uploads',
    title:
      'ThinkPhone, Wi-Fi only on, on mobile data: "Waiting for Wi-Fi"; Wi-Fi on: uploaded, the clips in the cloud',
    kinds: ['upload.paused', 'upload.resumed', 'storage.deleted'],
    eyes: null,
    check: (q) => {
      const wifi = q.onPhone('upload.paused', (e) => text(e, 'reason') === 'wifi');
      const resumed = wifi.filter((e) => q.next(e, 'upload.resumed', 24 * HOUR) !== null);
      return found(
        wifi,
        `${count(wifi, 'pause')} for Wi-Fi, ${String(resumed.length)} resumed`,
        'the uploads never waited for Wi-Fi on a phone',
      );
    },
  },
  {
    id: '3.3.8',
    round: R3,
    section: 'T3.3 — uploads',
    title: 'Wi-Fi only off on the phone, on mobile data: it uploads',
    kinds: ['settings.changed', 'upload.state'],
    eyes: 'navigator.connection, if it waited anyway',
    check: (q) => {
      const off = q.onPhone(
        'settings.changed',
        (e) => text(e, 'key') === 'wifiOnly' && e.data['value'] === false,
      );
      const uploaded = off.filter(
        (e) => q.next(e, 'upload.state', 24 * HOUR, (u) => text(u, 'state') === 'done') !== null,
      );
      return found(
        uploaded,
        `${String(uploaded.length)} of ${String(off.length)} times Wi-Fi only went off on a phone, an upload finished after it`,
        off.length === 0
          ? 'Wi-Fi only never turned off on a phone'
          : 'Wi-Fi only turned off, no upload finished after it',
      );
    },
  },
  {
    id: '3.3.9',
    round: R3,
    section: 'T3.3 — uploads',
    title: 'A demo session signed in: nothing in the panel, nothing in the bucket',
    kinds: ['session.started', 'upload.state'],
    eyes: null,
    check: (q) => {
      const demo = q.where('session.started', (e) => text(e, 'hardware') === 'simulated');
      const uploaded = q
        .of('upload.state')
        .filter((e) => demo.some((d) => d.session === e.session));
      const facts = `${count(demo, 'demo session')}; ${String(uploaded.length)} upload events of them`;
      return demo.length === 0 ? none(facts) : uploaded.length > 0 ? failed(facts) : ok(facts);
    },
  },
  {
    id: '3.3.10',
    round: R3,
    section: 'T3.3 — uploads',
    title:
      'Upload sessions off: a new solve stays on the device; on again, it goes; sign out mid-upload, sign in, it resumes',
    kinds: ['settings.changed', 'upload.state', 'account.signout', 'account.signin'],
    eyes: null,
    check: (q) => {
      const off = q.where(
        'settings.changed',
        (e) => text(e, 'key') === 'uploadSessions' && e.data['value'] === false,
      );
      const on = q.where(
        'settings.changed',
        (e) => text(e, 'key') === 'uploadSessions' && e.data['value'] === true,
      );
      const outMid = q
        .of('account.signout')
        .filter(
          (e) =>
            q.previous(e, 'upload.state', 5 * MINUTE, (u) => text(u, 'state') === 'uploading') !==
            null,
        );
      return found(
        off.length > 0 && on.length > 0 ? off : [],
        `uploads turned off ${String(off.length)} times and on ${String(on.length)}; ${count(outMid, 'sign-out')} within 5 min of an upload under way`,
        'uploads never turned off and on',
      );
    },
  },
  {
    id: '3.3.11',
    round: R3,
    section: 'T3.3 — uploads',
    title: 'Storage past 70% on the phone: the oldest uploaded clips deleted until under 60%',
    kinds: ['storage.deleted'],
    eyes: null,
    check: (q) => {
      const hits = q.onPhone('storage.deleted');
      return found(
        hits,
        `${count(hits, 'deletion')}: ${hits
          .slice(0, 5)
          .map(
            (e) =>
              `${String(num(e, 'files'))} clips, ${round((num(e, 'bytes') ?? 0) / 1e6)} MB, ${round((num(e, 'usageBefore') ?? 0) / 1e9, 2)} → ${round((num(e, 'usageAfter') ?? 0) / 1e9, 2)} GB (${round(num(e, 'percent') ?? 0)}% after)`,
          )
          .join('; ')}`,
        'no clip deleted by policy on a phone',
      );
    },
  },
  // ---- T3.4 — the cubes' MAC addresses, synced ----
  {
    id: '3.4.1',
    round: R3,
    section: "T3.4 — the cubes' MAC addresses, synced",
    title: 'The ThinkPhone before signing in: the cube typed in round 1 still listed',
    kinds: [],
    eyes: 'Settings → Cube MAC addresses',
    check: () => none('no event shows the list'),
  },
  {
    id: '3.4.2',
    round: R3,
    section: "T3.4 — the cubes' MAC addresses, synced",
    title: 'Sign in on the ThinkPhone: "Synced with your account", the document in the console',
    kinds: ['cubes.synced'],
    eyes: 'the document (the coordinator)',
    check: (q) => {
      const hits = q.onPhone('cubes.synced', (e) => (num(e, 'count') ?? 0) >= 1);
      return found(
        hits,
        `${count(hits, 'merge')} with ${[...new Set(hits.map((e) => String(num(e, 'count'))))].join(', ')} cubes`,
        'no merge with a cube on a phone',
      );
    },
  },
  {
    id: '3.4.3',
    round: R3,
    section: "T3.4 — the cubes' MAC addresses, synced",
    title:
      "The MacBook, reloaded: the phone's cube listed; with the flag off it connects without asking",
    kinds: ['cubes.synced', 'cube.connected'],
    eyes: null,
    check: (q) => {
      const merged = q.onLaptop('cubes.synced', (e) => (num(e, 'count') ?? 0) >= 1);
      const stored = q.onLaptop(
        'cube.connected',
        (e) => text(e, 'kind') === 'gan' && text(e, 'mac') === 'stored',
      );
      return found(
        merged.length > 0 && stored.length > 0 ? stored : [],
        `${count(merged, 'merge')} on a laptop with a cube; ${count(stored, 'connection')} with a stored address`,
        `${count(merged, 'merge')} on a laptop with a cube; ${count(stored, 'connection')} with a stored address`,
      );
    },
  },
  {
    id: '3.4.4',
    round: R3,
    section: "T3.4 — the cubes' MAC addresses, synced",
    title:
      'Edit and Remove on the MacBook follow in the console; the ThinkPhone, reloaded, follows; typed again, it comes back',
    kinds: ['cubes.synced'],
    eyes: 'the console and the lists',
    check: (q) => {
      const merges = q.of('cubes.synced');
      return found(
        merges,
        `${count(merges, 'merge')}; counts ${merges
          .slice(-6)
          .map((e) => `${e.device.label} ${String(num(e, 'count'))}`)
          .join(', ')}`,
        'no merge',
      );
    },
  },
  {
    id: '3.4.5',
    round: R3,
    section: "T3.4 — the cubes' MAC addresses, synced",
    title: 'Airplane mode on the ThinkPhone, Remove: "1 change waits to be sent"; online, it goes',
    kinds: [],
    eyes: 'Settings (the merges carry no deletions)',
    check: () => none('no event shows the change waiting'),
  },
  {
    id: '3.4.6',
    round: R3,
    section: "T3.4 — the cubes' MAC addresses, synced",
    title:
      'Sign out on the MacBook: the list stays; a cube added signed out reaches the console at the next sign-in',
    kinds: ['account.signout', 'cubes.synced'],
    eyes: 'the console',
    check: (q) => {
      const after = q
        .onLaptop('account.signout')
        .filter((e) => q.next(e, 'cubes.synced', 24 * HOUR) !== null);
      return found(
        after,
        `${String(after.length)} sign-outs on a laptop followed by a merge`,
        'no sign-out followed by a merge on a laptop',
      );
    },
  },
  {
    id: '3.4.7',
    round: R3,
    section: "T3.4 — the cubes' MAC addresses, synced",
    title: 'No MAC address in an export, nor in the uploaded attempt.json and session.json',
    kinds: [],
    eyes: 'the files (the coordinator searches them); the events themselves carry none by construction',
    check: () => none('no event shows the files'),
  },
  // ---- After T3.7 ----
  {
    id: '3.7.1',
    round: T37,
    section: "the cube's whole record",
    title:
      "One attempt with the camera on: gyro.json beside the record, six files downloaded, the build and the moves' counters in attempt.json, the QA view's Gyro column",
    kinds: ['attempt.done', 'files.downloaded', 'upload.state'],
    eyes: "attempt.json's fields and the session's battery in the console (the coordinator)",
    check: (q) => {
      const gyro = q.realAttempts().filter((e) => (num(e, 'gyroSamples') ?? 0) > 0);
      const six = q.where(
        'files.downloaded',
        (e) => text(e, 'what') === 'clips' && num(e, 'files') === 6,
      );
      const rates = [
        ...new Set(gyro.map((e) => `${e.device.label} ${round(num(e, 'gyroRateHz') ?? 0)} Hz`)),
      ];
      return found(
        gyro,
        `${count(gyro, 'real attempt')} with a gyro file (${rates.join(', ')}); ${count(six, 'download')} of six files; ${count(
          q.where(
            'upload.state',
            (e) => text(e, 'state') === 'done' && (num(e, 'files') ?? 0) >= 6,
          ),
          'upload',
        )} of six files or more`,
        'no real attempt with a gyro file',
      );
    },
  },
  // ---- After T4.1 ----
  {
    id: '4.1.1',
    round: T41,
    section: RTC,
    title:
      'The pairing: the QR scanned on the ThinkPhone, "Connected" within a few seconds, the MacBook lists the phone with a picture every 2 s and its report',
    kinds: ['rtc.paired', 'rtc.connected'],
    eyes: 'the picture and the report line; the time from the scan to "Connected"',
    check: (q) => {
      const hosts = q.onLaptop('rtc.paired');
      const phones = q.onPhone('rtc.paired');
      return found(
        hosts.length > 0 && phones.length > 0 ? hosts : [],
        `${count(hosts, 'pairing')} on a laptop (${[...new Set(hosts.map((e) => text(e, 'peer')))].join(', ')} as ${[...new Set(hosts.map((e) => text(e, 'camera')))].join(', ')}), ${count(phones, 'pairing')} on a phone; the hellos ${String(median(hosts.map((e) => num(e, 'ms') ?? 0)) ?? '?')} ms after the offer (median)`,
        hosts.length > 0 ? 'no pairing on a phone' : 'no pairing on a laptop',
      );
    },
  },
  {
    id: '4.1.2',
    round: T41,
    section: RTC,
    title:
      'The clock sync: synced within about 25 s, the round trip and the offset on both devices, synced over five minutes',
    kinds: ['rtc.clock'],
    eyes: "the phone's Clock line against the MacBook's",
    check: (q) => {
      const converged = q.where('rtc.clock', (e) => text(e, 'why') === 'converged');
      const minutes = q.where('rtc.clock', (e) => text(e, 'why') === 'minute');
      const withdrawn = q.where('rtc.clock', (e) => text(e, 'why') === 'withdrawn');
      return found(
        converged,
        `${count(converged, 'convergence')}; round trip ${String(median(converged.map((e) => num(e, 'rttMs') ?? 0)) ?? '?')} ms, drift ${String(median(minutes.map((e) => num(e, 'driftPpm') ?? 0)) ?? '?')} ppm, spread ${String(median(converged.map((e) => num(e, 'residualP95Ms') ?? 0)) ?? '?')} ms (medians); ${count(minutes, 'minute record')}, ${count(withdrawn, 'withdrawal')}`,
        'no clock sync converged',
      );
    },
  },
  {
    id: '4.1.3',
    round: T41,
    section: RTC,
    title:
      'The code typed: Remove, Add camera again, the code typed on the phone: connected again, the same label',
    kinds: ['rtc.disconnected', 'rtc.paired', 'rtc.connected'],
    eyes: 'the code typed in lower case with spaces',
    check: (q) => {
      const removed = q.onLaptop(
        'rtc.disconnected',
        (e) => text(e, 'reason') === 'removed by the host',
      );
      const after = removed.filter((e) => q.next(e, 'rtc.paired', 10 * MINUTE) !== null);
      return found(
        after,
        `${count(after, 'removal')} followed by a pairing within 10 minutes`,
        removed.length > 0 ? 'a removal, but no pairing after it' : 'no camera removed',
      );
    },
  },
  {
    id: '4.1.4',
    round: T41,
    section: RTC,
    title:
      'Walk away and back: reconnecting on both within half a minute, connected again within a minute without a new code',
    kinds: ['rtc.disconnected', 'rtc.connected'],
    eyes: 'how long each took',
    check: (q) => {
      const back = q.where('rtc.connected', (e) => flag(e, 'reconnection') === true);
      const drops = q.where(
        'rtc.disconnected',
        (e) =>
          !/^(left|host left|removed|gave up|the session ended|the host page closed|the page closed|the user left)/u.test(
            text(e, 'reason') ?? '',
          ),
      );
      return found(
        back,
        `${count(back, 'reconnection')} (${count(back.filter(isPhone), 'on a phone')}); ${count(drops, 'drop')} after ${String(median(drops.map((e) => num(e, 'durationMs') ?? 0)) ?? '?')} ms connected (median)`,
        drops.length > 0 ? 'drops, but no reconnection' : 'no drop',
      );
    },
  },
  {
    id: '4.1.5',
    round: T41,
    section: RTC,
    title:
      'Lock and unlock the phone: 20 s survived; 6 minutes let go after 5 and paired again with a new code; the screen on while connected',
    kinds: ['rtc.disconnected', 'rtc.paired', 'wake.lock'],
    eyes: 'what Android did to the page in the background',
    check: (q) => {
      const gaveUp = q.where('rtc.disconnected', (e) =>
        (text(e, 'reason') ?? '').startsWith('gave up'),
      );
      const again = gaveUp.filter((e) => q.next(e, 'rtc.paired', 30 * MINUTE) !== null);
      const locks = q.onPhone('wake.lock', (e) => text(e, 'status') === 'active');
      return found(
        again,
        `${count(gaveUp, 'camera given up')} after five minutes, ${count(again, 'paired again')} within half an hour; the phone's screen held ${count(locks, 'time')}`,
        gaveUp.length > 0
          ? 'given up, but not paired again'
          : 'no camera given up after five minutes',
      );
    },
  },
  {
    id: '4.1.6',
    round: T41,
    section: RTC,
    title:
      'Leave: the list empty at once, the entry kept, session.json with remote and the clock fit',
    kinds: ['rtc.disconnected'],
    eyes: "the session's page and the export (the coordinator)",
    check: (q) => {
      const left = q.onLaptop('rtc.disconnected', (e) =>
        (text(e, 'reason') ?? '').startsWith('left:'),
      );
      return found(
        left,
        `${count(left, 'Leave')} heard by a laptop, after ${String(median(left.map((e) => num(e, 'connectedMs') ?? 0)) ?? '?')} ms paired (median)`,
        'no Leave heard by a laptop',
      );
    },
  },
  {
    id: '4.1.7',
    round: T41,
    section: RTC,
    title: 'A second phone listed as phone-rear-2; a phone with a used code refused',
    kinds: ['rtc.paired', 'rtc.failed'],
    eyes: null,
    check: (q) => {
      const second = q.onLaptop('rtc.paired', (e) => /-2$/u.test(text(e, 'camera') ?? ''));
      const refused = q.onPhone('rtc.failed', (e) => text(e, 'step') === 'check');
      return found(
        second,
        `${count(second, 'second camera')} (${[...new Set(second.map((e) => text(e, 'camera')))].join(', ')}); ${count(refused, 'code refused')} on a phone`,
        'no second camera paired',
      );
    },
  },
  {
    id: '4.1.8',
    round: T41,
    section: RTC,
    title: 'A demo session pairs, and is listed as "both"',
    kinds: ['rtc.paired', 'session.started'],
    eyes: 'the Sessions page',
    check: (q) => {
      const demo = new Set(
        q
          .where('session.started', (e) => text(e, 'hardware') === 'simulated')
          .map((e) => e.session),
      );
      const paired = q.onLaptop('rtc.paired', (e) => demo.has(e.session));
      return found(
        paired,
        `${count(paired, 'pairing')} in a demo session`,
        'no pairing in a demo session',
      );
    },
  },
  // ---- After T4.2 ----
  {
    id: '4.2.1',
    round: T42,
    section: REMOTE_CLIPS,
    title:
      "Three solves with the phone paired: each attempt gets the phone's two clips within seconds of its end, its window widened by the margin, the clock sync converged or not",
    kinds: ['remote.cut', 'remote.clip'],
    eyes: "the phone's Clips line, back to none after each attempt",
    check: (q) => {
      const clips = q.onLaptop('remote.clip', (e) => flag(e, 'late') !== true);
      const sent = q.onLaptop('remote.cut', (e) => text(e, 'outcome') === 'sent');
      const early = sent.filter((e) => flag(e, 'converged') === false);
      // A clip the phone could not cut or the host could not read; those given up for the wait or
      // a phone that left are 4.2.5's.
      const failures = [
        ...q.onLaptop('remote.cut', (e) => text(e, 'outcome') === 'failed'),
        ...q.onLaptop('remote.clip.missing', (e) =>
          ['cut-failed', 'refused'].includes(text(e, 'reason') ?? ''),
        ),
      ];
      const labels = [...new Set(clips.map((e) => text(e, 'camera')))].join(', ');
      const facts = `${count(clips, 'remote clip')} (${labels || 'no camera'}); ${String(sent.length)} ${sent.length === 1 ? 'cut' : 'cuts'} sent, ${String(early.length)} before the clock sync converged, margin ${String(median(sent.map((e) => num(e, 'marginMs') ?? 0)) ?? '?')} ms; transfer ${seconds(clips.map((e) => num(e, 'transferMs') ?? 0))} s at ${round((median(clips.map((e) => num(e, 'bytesPerSecond') ?? 0)) ?? 0) / 1e6, 2)} MB/s (medians)${failures.length === 0 ? '' : `; ${count(failures, 'failure')}: ${failures.map(failureMessage).slice(-3).join('; ')}`}`;
      if (failures.length > 0) {
        return failed(facts);
      }
      return clips.length > 0 ? ok(facts) : none('no remote clip on a laptop');
    },
  },
  {
    id: '4.2.2',
    round: T42,
    section: REMOTE_CLIPS,
    title:
      "The attempt's folder has four clips, the laptop's and the phone's, attempt.json names them by label; the clip viewer switches between the cameras",
    kinds: ['attempt.done', 'clips.viewed'],
    eyes: "the viewer's buttons and pictures; attempt.json (the coordinator)",
    check: (q) => {
      const four = q.realAttempts().filter((e) => (num(e, 'clips') ?? 0) >= 4);
      const settled = four.filter((e) => flag(e, 'settled') === true);
      const viewed = q.where('clips.viewed', (e) => (num(e, 'clips') ?? 0) >= 4);
      return found(
        four,
        `${count(four, 'real attempt')} with four clips or more (${String(settled.length)} with nothing left to come, ${seconds(settled.map((e) => num(e, 'settledMs') ?? 0))} s after the end, median); ${count(viewed, 'viewing')} of four clips or more`,
        'no real attempt with four clips',
      );
    },
  },
  {
    id: '4.2.3',
    round: T42,
    section: REMOTE_CLIPS,
    title:
      "The bucket: the attempt's folder lists nine files, the phone's clips beside the laptop's",
    kinds: ['upload.state'],
    eyes: "the bucket's listing (the coordinator)",
    check: (q) => {
      const nine = q.where(
        'upload.state',
        (e) => text(e, 'state') === 'done' && (num(e, 'files') ?? 0) >= 9,
      );
      return found(
        nine,
        `${count(nine, 'upload')} of nine files or more`,
        'no upload of nine files',
      );
    },
  },
  {
    id: '4.2.4',
    round: T42,
    section: REMOTE_CLIPS,
    title:
      "Walk away right after a solve, the phone's clip on its way: back in reach, the clip comes, its transfer resumed where it stopped",
    kinds: ['remote.clip', 'rtc.connected'],
    eyes: "the phone's Clips line while away",
    check: (q) => {
      const resumed = q.onLaptop('remote.clip', (e) => (num(e, 'resumedBytes') ?? 0) > 0);
      const afterReconnection = q.onLaptop(
        'remote.clip',
        (e) =>
          q.previous(e, 'rtc.connected', 2 * MINUTE, (c) => flag(c, 'reconnection') === true) !==
          null,
      );
      return found(
        [...resumed, ...afterReconnection],
        `${count(resumed, 'clip')} resumed in the middle of a file (${String(median(resumed.map((e) => num(e, 'resumedBytes') ?? 0)) ?? '?')} bytes held, median); ${count(afterReconnection, 'clip')} within two minutes of a reconnection`,
        'no clip after a reconnection',
      );
    },
  },
  {
    id: '4.2.5',
    round: T42,
    section: REMOTE_CLIPS,
    title:
      "The phone's Wi-Fi off once its clip is cut, for three minutes: two minutes after the end the attempt is uploaded without it and the notes name the camera; Wi-Fi on, the clip comes late and is uploaded as an addition",
    kinds: ['remote.clip.missing', 'remote.clip.late', 'upload.state'],
    eyes: "the session's notes; the bucket's listing after the addition (the coordinator)",
    check: (q) => {
      const missing = q.onLaptop('remote.clip.missing');
      const late = q.onLaptop('remote.clip.late');
      const reasons = [...new Set(missing.map((e) => text(e, 'reason')))].join(', ');
      return found(
        late,
        `${count(missing, 'clip')} given up (${reasons || '–'}), ${count(late, 'late clip')} attached ${seconds(late.map((e) => num(e, 'afterEndMs') ?? 0))} s after the attempt's end (median)`,
        missing.length > 0
          ? `${count(missing, 'clip')} given up (${reasons}), none came late`
          : 'no clip given up',
      );
    },
  },
  {
    id: '4.2.6',
    round: T42,
    section: REMOTE_CLIPS,
    title:
      '"Record remote cameras" off: the phone stays connected and records nothing for the session; on again, the next attempt has its clips',
    kinds: ['settings.changed', 'remote.cut'],
    eyes: "the phone's Clips line",
    check: (q) => {
      const switched = (on: boolean): ReportEvent[] =>
        q.where(
          'settings.changed',
          (e) => text(e, 'key') === 'recordRemoteCameras' && flag(e, 'value') === on,
        );
      const off = switched(false);
      const back = switched(true).filter(
        (e) => q.next(e, 'remote.cut', HOUR, (c) => text(c, 'outcome') === 'sent') !== null,
      );
      return found(
        off.length > 0 ? back : [],
        `${count(off, 'switch')} off, ${count(back, 'switch')} on followed by a cut within the hour`,
        off.length > 0 ? 'switched off, but no cut after it was on again' : 'never switched off',
      );
    },
  },
  // ---- After T4.3 ----
  {
    id: '4.3.1',
    round: T43,
    section: REMOTE_SYNC,
    title:
      "A sync check on the paired phone: its rectangle drawn around the cube on the phone, Sync check on its line under the MacBook's preview, five flicks: the phone's lag and its spread",
    kinds: ['sync.check'],
    eyes: "the panel naming the phone; the lag beside the MacBook's own camera's",
    check: (q) => {
      const checks = q.onLaptop('sync.check', (e) => flag(e, 'remote') === true);
      const passed = checks.filter((e) => text(e, 'outcome') === 'ok');
      const failures = checks.filter(isFailure);
      const own = q.onLaptop(
        'sync.check',
        (e) => flag(e, 'remote') !== true && text(e, 'outcome') === 'ok',
      );
      const middle = (events: readonly ReportEvent[], key: string): string =>
        String(median(events.map((e) => num(e, key) ?? 0)) ?? '?');
      const cameras = [...new Set(passed.map((e) => text(e, 'camera')))].join(', ');
      const facts = `${count(passed, 'check')} of a phone's camera passed (${cameras || 'none'}): lag ${middle(passed, 'offsetMs')} ms, spread ${middle(passed, 'spreadMs')} ms, ${String(passed.filter((e) => flag(e, 'clockConverged') === true).length)} with the clock sync converged, its round trip ${middle(passed, 'clockRttMs')} ms (medians); the MacBook's own camera ${middle(own, 'offsetMs')} ms${failures.length === 0 ? '' : `; ${count(failures, 'failed check')}: ${failures.map(failureMessage).slice(-3).join('; ')}`}`;
      if (passed.length === 0) {
        return failures.length > 0 ? failed(facts) : none("no sync check of a phone's camera");
      }
      return ok(facts);
    },
  },
  {
    id: '4.3.2',
    round: T43,
    section: REMOTE_SYNC,
    title:
      "The phone's later clips take its lag: the solves after the check have the phone's clips with its lag as their syncResidualMs, the moves in step with its picture in the clip viewer",
    kinds: ['remote.clip'],
    eyes: "the moves against the phone's picture in the clip viewer",
    check: (q) => {
      const clips = q.onLaptop('remote.clip');
      const taken = clips.filter((e) => num(e, 'syncResidualMs') !== null);
      const lags = [...new Set(taken.map((e) => num(e, 'syncResidualMs') ?? 0))];
      return found(
        taken,
        `${count(taken, 'remote clip')} of ${String(clips.length)} with the lag of a check (${lags
          .slice(-4)
          .map((lag) => `${round(lag)} ms`)
          .join(', ')})`,
        clips.length > 0 ? 'remote clips, none with the lag of a check' : 'no remote clip',
      );
    },
  },
  {
    id: '4.3.3',
    round: T43,
    section: REMOTE_SYNC,
    title:
      "The live preview: the phone's picture in a tile over the MacBook's preview within seconds of the pairing, moving with the phone's camera; a tap swaps it with the main picture, and back",
    kinds: ['preview.started'],
    eyes: "the tile's picture moving, its framing rectangle, the swap at a tap",
    check: (q) => {
      const started = q.onPhone('preview.started');
      const sizes = [
        ...new Set(
          started.map(
            (e) =>
              `${String(num(e, 'width') ?? '?')}×${String(num(e, 'height') ?? '?')} / ${String(num(e, 'scale') ?? '?')}`,
          ),
        ),
      ];
      const caps = [
        ...new Set(
          started.map(
            (e) =>
              `${String(num(e, 'maxKbps') ?? '?')} kbps and ${String(num(e, 'maxFps') ?? '?')} fps`,
          ),
        ),
      ];
      return found(
        started,
        `${count(started, 'preview')} sent (${sizes.join(', ')}; at most ${caps.join(', ')})`,
        'no live preview sent by a phone',
      );
    },
  },
  {
    id: '4.3.4',
    round: T43,
    section: REMOTE_SYNC,
    title:
      '"Live preview from phones" off and on in turns, a few minutes each, while the phone records: the recording\'s frame rate with and without the preview, and the encoder\'s time per frame',
    kinds: ['settings.changed', 'preview.stopped', 'preview.started'],
    eyes: "the phone's temperature, and the Camera page's frame rate",
    check: (q) => {
      const off = q.where(
        'settings.changed',
        (e) => text(e, 'key') === 'livePreviewFromPhones' && flag(e, 'value') === false,
      );
      // A span with the preview: its stop by the switch; one without it: the start that ended it.
      const withIt = q.onPhone(
        'preview.stopped',
        (e) => text(e, 'why') === 'off' && (num(e, 'recordingSeconds') ?? 0) > 0,
      );
      const without = q.onPhone(
        'preview.started',
        (e) =>
          (num(e, 'recordingSeconds') ?? 0) > 0 &&
          q.previous(e, 'preview.stopped', HOUR, (p) => text(p, 'why') === 'off') !== null,
      );
      const middle = (events: readonly ReportEvent[], key: string): string =>
        String(median(events.map((e) => num(e, key) ?? 0)) ?? '?');
      const encoders = [...new Set(withIt.map((e) => text(e, 'encoder') ?? '?'))].join(', ');
      return found(
        off.length > 0 && withIt.length > 0 && without.length > 0 ? withIt : [],
        `the recording at ${middle(withIt, 'recordingFps')} fps with the preview (least ${middle(withIt, 'recordingFpsMin')}, ${middle(withIt, 'recordingDropped')} frames dropped), ${middle(without, 'recordingFps')} fps without (least ${middle(without, 'recordingFpsMin')}, ${middle(without, 'recordingDropped')} dropped), over ${String(withIt.length)} and ${String(without.length)} spans; the preview ${middle(withIt, 'fps')} fps at ${middle(withIt, 'kbps')} kbps, ${middle(withIt, 'encodeMsPerFrame')} ms a frame (${encoders}), the CPU holding it back ${middle(withIt, 'cpuLimitedShare')} of the time (medians)`,
        off.length === 0
          ? 'the live preview never switched off'
          : 'switched off, but no span with and without the preview on a phone',
      );
    },
  },
  {
    id: '4.3.5',
    round: T43,
    section: REMOTE_SYNC,
    title:
      "Twenty minutes of solves on the rig, the phone paired and its preview on: the clock sync stays converged for 20 minutes (issue #61), every attempt has the phone's clips",
    kinds: ['rtc.clock', 'remote.clip'],
    eyes: "the phone's temperature after 20 minutes (by hand), and the rig",
    check: (q) => {
      const stretch = convergedStretch(q);
      const clips = q.onLaptop('remote.clip', (e) => flag(e, 'late') !== true);
      const facts = `the clock sync converged for ${round(stretch.ms / MINUTE, 1)} minutes at the longest, ${String(stretch.withdrawn)} ${stretch.withdrawn === 1 ? 'withdrawal' : 'withdrawals'}; ${count(clips, 'remote clip')}`;
      return stretch.ms >= 20 * MINUTE ? ok(facts) : none(facts);
    },
  },
  // ---- After T4: the desk rig ----
  {
    id: '4.4.1',
    round: T4,
    section: RIG,
    title:
      "The rig paired: the ThinkPhone on its stand at another angle than the MacBook's camera, the lamp on, the framing rectangles around the cube; Add camera, the QR scanned, \"Connected\", synced within seconds, the phone's tile over the MacBook's preview",
    kinds: ['rtc.paired', 'rtc.clock', 'preview.started'],
    eyes: 'the angle, the light and both framings; the time from the scan to "Connected"',
    check: (q) => {
      const paired = q.onLaptop('rtc.paired');
      const synced = paired.flatMap((e) => {
        const clock = q.next(e, 'rtc.clock', 5 * MINUTE, (c) => text(c, 'why') === 'converged');
        return clock === null ? [] : [{ paired: e, clock }];
      });
      const previews = q.onPhone('preview.started');
      const facts = `${count(paired, 'pairing')}, ${String(synced.length)} synced within five minutes, ${seconds(synced.map((p) => p.clock.tsMs - p.paired.tsMs))} s after the pairing, round trip ${String(median(synced.map((p) => num(p.clock, 'rttMs') ?? 0)) ?? '?')} ms (medians); ${count(previews, 'live preview')} sent`;
      return synced.length > 0 && previews.length > 0
        ? ok(facts)
        : none(paired.length === 0 ? 'no pairing on a laptop' : facts);
    },
  },
  {
    id: '4.4.2',
    round: T4,
    section: RIG,
    title:
      "The sync checks: the MacBook's own, due by itself before the first scramble, and the phone's, from its line under the preview with its rectangle drawn on the phone: both pass (spreads under 83 ms) in the session",
    kinds: ['sync.check'],
    eyes: "the two lags side by side, and the phone's clock line during its check",
    check: (q) => {
      const passed = q.onLaptop('sync.check', (e) => text(e, 'outcome') === 'ok');
      const sessions = new Set(
        passed
          .filter((e) => flag(e, 'remote') === true)
          .filter((p) =>
            passed.some(
              (e) =>
                flag(e, 'remote') !== true &&
                e.uid === p.uid &&
                e.device.label === p.device.label &&
                e.session === p.session,
            ),
          )
          .map((e) => e.session),
      );
      const inBoth = passed.filter((e) => sessions.has(e.session));
      const lag = (events: readonly ReportEvent[]): string =>
        `${String(median(events.map((e) => num(e, 'offsetMs') ?? 0)) ?? '?')} ms (±${String(median(events.map((e) => num(e, 'spreadMs') ?? 0)) ?? '?')})`;
      const failures = q.onLaptop('sync.check', (e) => flag(e, 'remote') === true && isFailure(e));
      const facts = `both passed in ${String(sessions.size)} ${sessions.size === 1 ? 'session' : 'sessions'}: the MacBook's camera lags ${lag(inBoth.filter((e) => flag(e, 'remote') !== true))}, the phone's ${lag(inBoth.filter((e) => flag(e, 'remote') === true))} (medians)${failures.length === 0 ? '' : `; ${count(failures, 'failed check')} of a phone's camera: ${failures.map(failureMessage).slice(-3).join('; ')}`}`;
      if (sessions.size > 0) {
        return ok(facts);
      }
      return failures.length > 0 ? failed(facts) : none('no session with both checks passed');
    },
  },
  {
    id: '4.4.3',
    round: T4,
    section: RIG,
    title:
      "Three solves on the rig: each attempt has four clips within seconds of its end, the phone's Clips line back each time, the phone's clips taking its lag; each attempt uploaded with every file (ten with gyro.json)",
    kinds: ['attempt.done', 'remote.clip', 'upload.state'],
    eyes: "the phone's Clips line after each solve",
    check: (q) => {
      const four = q
        .realAttempts()
        .filter((e) => !isPhone(e) && (num(e, 'clips') ?? 0) >= 4 && flag(e, 'settled') === true);
      const perSession = new Map<string, number>();
      for (const e of four) {
        const key = `${e.uid}/${e.session ?? '?'}`;
        perSession.set(key, (perSession.get(key) ?? 0) + 1);
      }
      const most = Math.max(0, ...perSession.values());
      const lagged = q.onLaptop('remote.clip', (e) => num(e, 'syncResidualMs') !== null);
      const whole = uploadsWith(q, 4);
      const facts = `${String(most)} ${most === 1 ? 'attempt' : 'attempts'} in one session with four clips or more and nothing left to come (${seconds(four.map((e) => num(e, 'settledMs') ?? 0))} s after the end, median); ${count(lagged, 'remote clip')} with the phone's lag; ${count(whole, 'upload')} with every file`;
      return most >= 3 && lagged.length > 0 && whole.length > 0 ? ok(facts) : none(facts);
    },
  },
  {
    id: '4.4.4',
    round: T4,
    section: RIG,
    title:
      "The clip viewer of one of them: four buttons naming the cameras, the phone's solve playing with its moves and the 3D cube in step with its picture; Download gives the four clips with their frame times, gyro.json and attempt.json",
    kinds: ['clips.viewed', 'files.downloaded'],
    eyes: "the moves and the 3D cube against the phone's picture: early or late, by how much",
    check: (q) => {
      const viewed = q.where('clips.viewed', (e) => (num(e, 'clips') ?? 0) >= 4);
      const downloads = q.where(
        'files.downloaded',
        (e) => text(e, 'what') === 'clips' && (num(e, 'files') ?? 0) >= 9,
      );
      const sizes = [...new Set(downloads.map((e) => String(num(e, 'files'))))].join(', ');
      return found(
        viewed.length > 0 && downloads.length > 0 ? viewed : [],
        `${count(viewed, 'viewing')} of four clips or more; ${count(downloads, 'download')} of nine files or more (${sizes || '–'})`,
        viewed.length > 0
          ? 'viewed, but no download of nine files or more'
          : 'no viewing of four clips',
      );
    },
  },
  {
    id: '4.4.5',
    round: T4,
    section: RIG,
    title:
      '"Live preview from phones" off for a minute: the tile shows the phone\'s picture every 2 s; on again: live again within seconds',
    kinds: ['settings.changed', 'preview.stopped', 'preview.started'],
    eyes: 'the tile, live and every 2 s',
    check: (q) => {
      const off = q.where(
        'settings.changed',
        (e) => text(e, 'key') === 'livePreviewFromPhones' && flag(e, 'value') === false,
      );
      const stopped = q.onPhone('preview.stopped', (e) => text(e, 'why') === 'off');
      const again = q.onPhone(
        'preview.started',
        (e) => q.previous(e, 'preview.stopped', HOUR, (p) => text(p, 'why') === 'off') !== null,
      );
      return found(
        off.length > 0 && stopped.length > 0 ? again : [],
        `${count(off, 'switch')} off, ${count(stopped, 'preview')} stopped by it, ${count(again, 'preview')} started again after one`,
        off.length === 0
          ? 'the live preview never switched off'
          : 'switched off, but no preview stopped and started again on a phone',
      );
    },
  },
  {
    id: '4.4.6',
    round: T4,
    section: RIG,
    title:
      "Twenty minutes of solves on the rig, the preview on: the clock sync converged throughout (issue #61), every attempt in that time with the phone's clips",
    kinds: ['rtc.clock', 'attempt.done'],
    eyes: "the phone's temperature and battery after 20 minutes (by hand), and whether its Camera page said it may be hot",
    check: (q) => {
      const stretch = convergedStretch(q);
      const within = q
        .realAttempts()
        .filter((e) => !isPhone(e) && e.tsMs >= stretch.fromMs && e.tsMs <= stretch.toMs);
      const four = within.filter((e) => (num(e, 'clips') ?? 0) >= 4);
      const facts = `the clock sync converged for ${round(stretch.ms / MINUTE, 1)} minutes at the longest, ${String(stretch.withdrawn)} ${stretch.withdrawn === 1 ? 'withdrawal' : 'withdrawals'}; ${String(four.length)} of the ${String(within.length)} attempts in that stretch with four clips or more`;
      return stretch.ms >= 20 * MINUTE && within.length > 0 && four.length === within.length
        ? ok(facts)
        : none(facts);
    },
  },
  {
    id: '4.4.7',
    round: T4,
    section: RIG,
    title:
      "Walk out of the Wi-Fi's reach with the phone right after a solve, for a minute, and back: both connect again without a new code, and the clip on its way comes, resumed where it stopped",
    kinds: ['rtc.disconnected', 'rtc.connected', 'remote.clip'],
    eyes: 'how long each device took to say connected again',
    check: (q) => {
      const back = q.onLaptop('rtc.connected', (e) => flag(e, 'reconnection') === true);
      const gaps = back.flatMap((e) => {
        const drop = q.previous(e, 'rtc.disconnected', 5 * MINUTE);
        return drop === null ? [] : [e.tsMs - drop.tsMs];
      });
      const followed = back.filter((e) => q.next(e, 'remote.clip', 2 * MINUTE) !== null);
      const resumed = q.onLaptop('remote.clip', (e) => (num(e, 'resumedBytes') ?? 0) > 0);
      return found(
        followed,
        `${count(back, 'reconnection')}, ${seconds(gaps)} s after the drop (median), ${String(followed.length)} followed by a clip within two minutes; ${count(resumed, 'clip')} resumed in the middle of a file`,
        back.length > 0 ? 'reconnections, but no clip after them' : 'no reconnection on a laptop',
      );
    },
  },
  {
    id: '4.4.8',
    round: T4,
    section: RIG,
    title:
      "The phone's Wi-Fi off for three minutes right after a solve: two minutes after the end the attempt is uploaded without the phone's clip, the notes naming the camera; Wi-Fi on: the phone back, its clip late and uploaded as an addition",
    kinds: ['remote.clip.missing', 'rtc.connected', 'remote.clip.late'],
    eyes: "the session's notes; the bucket's listing after the addition (the coordinator)",
    check: (q) => {
      const missing = q.onLaptop('remote.clip.missing', (e) => text(e, 'reason') === 'wait');
      const late = q.onLaptop('remote.clip.late');
      const afterReturn = late.filter(
        (e) =>
          q.previous(e, 'rtc.connected', 5 * MINUTE, (c) => flag(c, 'reconnection') === true) !==
          null,
      );
      return found(
        missing.length > 0 ? afterReturn : [],
        `${count(missing, 'clip')} given up after the two minutes, ${count(late, 'late clip')} attached ${seconds(late.map((e) => num(e, 'afterEndMs') ?? 0))} s after the attempt's end (median), ${String(afterReturn.length)} once the phone was back`,
        missing.length > 0
          ? `${count(missing, 'clip')} given up after the two minutes, none late once the phone was back`
          : 'no clip given up after the two minutes',
      );
    },
  },
  {
    id: '4.4.9',
    round: T4,
    section: RIG,
    title:
      'New session right after a solve: the MacBook lists the phone as "waiting for the phone\'s last clips" for a few seconds, the last attempt gets them, then the phone is let go ("the session ended"); Add camera again pairs it to the new session',
    kinds: ['session.started', 'remote.clip', 'rtc.disconnected', 'rtc.paired'],
    eyes: "the waiting line on the MacBook, and the phone's words",
    check: (q) => {
      // A clip of a session that ended, stored after the next session began: the phone was held.
      const held = q.onLaptop('remote.clip').flatMap((e) => {
        const next = q.previous(
          e,
          'session.started',
          20_000,
          (s) => s.session !== null && s.session !== e.session,
        );
        return next === null ? [] : [e.tsMs - next.tsMs];
      });
      const letGo = q.onLaptop(
        'rtc.disconnected',
        (e) => text(e, 'reason') === 'the session ended',
      );
      const timedOut = q.onLaptop('rtc.disconnected', (e) =>
        (text(e, 'reason') ?? '').startsWith('the session ended;'),
      );
      const again = letGo.filter((e) => q.next(e, 'rtc.paired', 30 * MINUTE) !== null);
      const facts = `${String(held.length)} ${held.length === 1 ? 'clip' : 'clips'} of an ended session stored after New session, ${seconds(held)} s after it (median); ${String(letGo.length)} ${letGo.length === 1 ? 'camera' : 'cameras'} let go once the session's clips were in, ${String(timedOut.length)} after the 15 s; ${String(again.length)} paired again within half an hour`;
      if (held.length > 0 && letGo.length > 0) {
        return ok(facts);
      }
      return timedOut.length > 0 ? failed(facts) : none(facts);
    },
  },
  {
    id: '4.4.10',
    round: T4,
    section: RIG,
    title:
      'The second phone, if at hand (a name of its own in Settings → This device): paired while the first is connected, listed as phone-rear-2 with a tile and a sync check of its own; each attempt with six clips, uploaded with every file (fourteen with gyro.json)',
    kinds: ['rtc.paired', 'attempt.done', 'upload.state'],
    eyes: "the two tiles over the preview, and the second phone's check",
    check: (q) => {
      const second = q.onLaptop('rtc.paired', (e) => /-2$/u.test(text(e, 'camera') ?? ''));
      const six = q.realAttempts().filter((e) => !isPhone(e) && (num(e, 'clips') ?? 0) >= 6);
      const whole = uploadsWith(q, 6);
      return found(
        second.length > 0 && six.length > 0 ? six : [],
        `${count(second, 'second camera')} paired (${[...new Set(second.map((e) => text(e, 'camera')))].join(', ')}); ${count(six, 'real attempt')} with six clips or more; ${count(whole, 'upload')} with every file`,
        second.length > 0
          ? 'a second camera paired, but no attempt with six clips'
          : 'no second camera paired',
      );
    },
  },
  // ---- After T5.1: the phone's picture and its status line ----
  {
    id: '5.1.1',
    round: T51,
    section: PICTURES,
    title:
      "The phone's picture as large as the MacBook's, with the ThinkPhone, then with the Moto g60: side by side in the wide window, one under the other once it is narrowed, the phone's status line under its picture",
    kinds: ['rtc.clock'],
    eyes: "the two pictures' sizes, side by side and narrowed; the line's words against the phone's Camera page",
    check: (q) => {
      const phones = phoneReports(q);
      const facts = [...phones.entries()]
        .map(([peer, reports]) => healthFacts(peer, reports))
        .join('; ');
      if (phones.size >= 2) {
        return ok(facts);
      }
      return none(phones.size === 0 ? "no phone's report in an rtc.clock event" : facts);
    },
  },
  {
    id: '5.1.2',
    round: T51,
    section: PICTURES,
    title:
      "The phone's focus set to manual on its own Camera page and left out of focus for two minutes: the sharpness soft (amber) on the line under its picture, then good again back on automatic",
    kinds: ['rtc.clock'],
    eyes: "the amber value on the line, and in the tile's caption",
    check: (q) => {
      const found = [...phoneReports(q).entries()].flatMap(([peer, reports]) => {
        const soft = reports.filter(({ report }) => report['soft'] === true);
        const back = soft.filter(({ event }) =>
          reports.some(
            ({ event: later, report }) => later.tsMs > event.tsMs && report['soft'] === false,
          ),
        );
        const least = Math.min(
          ...soft.map(({ report }) => reportNum(report, 'sharpness') ?? Infinity),
        );
        return soft.length === 0
          ? []
          : [
              {
                peer,
                good: back.length > 0,
                facts: `${peer}: soft in ${String(soft.length)} of ${String(reports.length)} reports (sharpness ${Number.isFinite(least) ? round(least, 1) : '?'} at the least)${back.length > 0 ? ', good again after' : ', not good again after'}`,
              },
            ];
      });
      const facts = found.map((f) => f.facts).join('; ');
      return found.some((f) => f.good) ? ok(facts) : none(facts || 'no soft picture reported');
    },
  },
  {
    id: '5.1.3',
    round: T51,
    section: PICTURES,
    title:
      "The phone unplugged with its battery under 20%: the line's battery in amber, red under 10%; plugged in again: charging",
    kinds: ['rtc.clock'],
    eyes: 'the colours of the battery on the line',
    check: (q) => {
      const low = [...phoneReports(q).entries()].flatMap(([peer, reports]) => {
        const unplugged = reports.filter(
          ({ report }) =>
            report['batteryCharging'] === false && (reportNum(report, 'batteryLevel') ?? 1) < 0.2,
        );
        const least = Math.min(
          ...unplugged.map(({ report }) => reportNum(report, 'batteryLevel') ?? 1),
        );
        return unplugged.length === 0
          ? []
          : [
              `${peer}: ${String(unplugged.length)} ${unplugged.length === 1 ? 'report' : 'reports'} unplugged under 20%, ${round(least * 100)}% at the least`,
            ];
      });
      return low.length > 0 ? ok(low.join('; ')) : none('no phone reported under 20% unplugged');
    },
  },
  {
    id: '5.1.4',
    round: T51,
    section: PICTURES,
    title:
      "Twenty minutes on the rig: the phone's health over them on its line: its pressure word if its Chrome has the Compute Pressure API ('PressureObserver' in window in its console), the frame rate dropped if it did",
    kinds: ['rtc.clock'],
    eyes: "the phone's temperature by hand after twenty minutes, and whether 'PressureObserver' is in its window",
    check: (q) => {
      const phones = [...phoneReports(q).entries()].map(([peer, reports]) => {
        const spanMs = (reports.at(-1)?.event.tsMs ?? 0) - (reports[0]?.event.tsMs ?? 0);
        const states = new Map<string, number>();
        const sources = new Set<string>();
        for (const { report } of reports) {
          const pressure = report['pressure'];
          if (typeof pressure === 'string') {
            states.set(pressure, (states.get(pressure) ?? 0) + 1);
          }
          const source = report['pressureSource'];
          if (typeof source === 'string') {
            sources.add(source);
          }
        }
        const pressure =
          states.size === 0
            ? 'no pressure (the API absent or refused)'
            : `pressure ${[...states.entries()].map(([state, n]) => `${state} (${String(n)})`).join(', ')} from ${[...sources].join(', ')}`;
        const throttled = reports.filter(({ report }) => report['thermal'] === 'throttled').length;
        return {
          long: spanMs >= 20 * MINUTE,
          facts: `${peer}: ${round(spanMs / MINUTE, 1)} minutes of reports, ${pressure}, the frame rate dropped in ${String(throttled)}`,
        };
      });
      const facts = phones.map((phone) => phone.facts).join('; ');
      return phones.some((phone) => phone.long) ? ok(facts) : none(facts || "no phone's report");
    },
  },
  {
    id: '5.1.5',
    round: T51,
    section: PICTURES,
    title:
      '"Pictures from phones" on small tiles: the phone\'s picture a tile over the MacBook\'s, its caption saying what is wrong in short; then the same size again',
    kinds: ['settings.changed'],
    eyes: "the tile's caption",
    check: (q) => {
      const changes = q.where('settings.changed', (e) => text(e, 'key') === 'remotePictures');
      const tiles = changes.filter((e) => text(e, 'value') === 'tiles');
      const back = tiles.filter((e) =>
        changes.some((later) => later.tsMs > e.tsMs && text(later, 'value') === 'equal'),
      );
      return found(
        back,
        `${count(tiles, 'switch')} to tiles, ${String(back.length)} back to the same size`,
        tiles.length > 0 ? 'switched to tiles, never back' : 'never switched to tiles',
      );
    },
  },
];

/** The checklist against the events: each item with its result. */
export function evaluate(events: readonly ReportEvent[], nowMs: number): EvaluatedItem[] {
  const q = new Query(events, nowMs);
  return CHECKLIST.map((item) => ({ ...item, result: item.check(q) }));
}

const MARK: Readonly<Record<Status, string>> = { ok: '✅', none: '⬜', failed: '❗' };

/** `text` as one cell of a Markdown table. */
function cell(value: string): string {
  return value
    .replace(/\|/gu, '\\|')
    .replace(/\s*\n\s*/gu, ' ')
    .trim();
}

/** The events of every account per device and day, as Markdown tables. */
function deviceTables(events: readonly ReportEvent[]): string[] {
  const lines: string[] = [];
  const byDevice = new Map<string, ReportEvent[]>();
  for (const event of events) {
    const key = `${event.uid}\u0000${event.device.label}`;
    byDevice.set(key, [...(byDevice.get(key) ?? []), event]);
  }
  for (const [key, list] of [...byDevice.entries()].sort(([p], [q]) => p.localeCompare(q))) {
    const [uid, label] = key.split('\u0000');
    const last = list[list.length - 1];
    const starts = list.filter((e) => e.kind === 'app.start');
    const lastStart = starts.at(-1);
    lines.push(
      `### ${label} (${last.device.platform || 'unknown platform'}${last.device.installed ? ', installed' : ''}; account ${uid.slice(0, 6)}…)`,
      '',
      lastStart === undefined
        ? 'No start among these events.'
        : `Last start ${when(lastStart.tsMs)} UTC on build ${lastStart.app.version} · ${lastStart.app.commit}; builds seen: ${[...new Set(list.map((e) => `${e.app.version} · ${e.app.commit}`))].join(', ')}.`,
      '',
      '| Day (UTC) | Events | Attempts | Clips | Uploads done | Failures | Kinds |',
      '|---|---|---|---|---|---|---|',
    );
    const byDay = new Map<string, ReportEvent[]>();
    for (const event of list) {
      const day = utcDay(event.tsMs);
      byDay.set(day, [...(byDay.get(day) ?? []), event]);
    }
    for (const [day, dayEvents] of [...byDay.entries()].sort(([p], [q]) => p.localeCompare(q))) {
      const kinds = new Map<string, number>();
      for (const event of dayEvents) {
        kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
      }
      const kindList = [...kinds.entries()]
        .sort(([p, m], [q, n]) => n - m || p.localeCompare(q))
        .map(([kind, n]) => `${kind}×${String(n)}`)
        .join(', ');
      lines.push(
        `| ${day} | ${String(dayEvents.length)} | ${String(dayEvents.filter((e) => e.kind === 'attempt.done').length)} | ${String(dayEvents.filter((e) => e.kind === 'clip.saved').length)} | ${String(dayEvents.filter((e) => e.kind === 'upload.state' && e.data['state'] === 'done').length)} | ${String(dayEvents.filter(isFailure).length)} | ${cell(kindList)} |`,
      );
    }
    lines.push('');
  }
  return lines;
}

/**
 * The report, as Markdown: the events per device and day, the checklists with ✅ (the evidence is
 * there, with its facts), ⬜ (it is not) or ❗ (the events show a failure), and the last 20 failures.
 */
export function roundReport(events: readonly ReportEvent[], options: ReportOptions): string {
  const { days, nowMs } = options;
  const accounts = new Set(events.map((event) => event.uid));
  const devices = new Set(events.map((event) => `${event.uid}/${event.device.label}`));
  const lines: string[] = [
    `# cubetrace round report: the last ${String(days)} days, to ${when(nowMs)} UTC`,
    '',
    `${String(events.length)} events of ${String(accounts.size)} account${accounts.size === 1 ? '' : 's'} and ${String(devices.size)} device${devices.size === 1 ? '' : 's'}, from ${events.length === 0 ? '–' : when(Math.min(...events.map((e) => e.tsMs)))} to ${events.length === 0 ? '–' : when(Math.max(...events.map((e) => e.tsMs)))} UTC. The checklists are those of docs/MANUAL-TESTS.md, read as docs/DIAGNOSTICS.md maps them: ✅ the evidence is there (its facts beside it), ⬜ it is not, ❗ the events show a failure; "Still needs eyes" is what no event can show.`,
    '',
    '## Events per device and day',
    '',
    ...(events.length === 0 ? ['No event.', ''] : deviceTables(events)),
    '## Checklists',
    '',
  ];
  const evaluated = evaluate(events, nowMs);
  const totals = { ok: 0, none: 0, failed: 0 };
  let section = '';
  for (const item of evaluated) {
    const heading = `${item.round} — ${item.section}`;
    if (heading !== section) {
      if (section !== '') {
        lines.push('');
      }
      section = heading;
      lines.push(
        `### ${heading}`,
        '',
        '| # | Item | Evidence | Status | Facts | Still needs eyes |',
        '|---|---|---|---|---|---|',
      );
    }
    totals[item.result.status]++;
    lines.push(
      `| ${item.id} | ${cell(item.title)} | ${item.kinds.length === 0 ? '–' : item.kinds.map((kind) => `\`${kind}\``).join(', ')} | ${MARK[item.result.status]} | ${cell(item.result.facts) || '–'} | ${item.eyes === null ? '–' : cell(item.eyes)} |`,
    );
  }
  lines.push(
    '',
    `**${String(evaluated.length)} items: ${String(totals.ok)} ✅, ${String(totals.none)} ⬜, ${String(totals.failed)} ❗.** ${String(evaluated.filter((item) => item.eyes !== null).length)} still need eyes for part or all of them.`,
    '',
    '## Last 20 failures',
    '',
  );
  const failures = [...events]
    .filter(isFailure)
    .sort((p, q) => q.tsMs - p.tsMs)
    .slice(0, 20);
  if (failures.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push(
      '| When (UTC) | Device | Kind | Session / attempt | What |',
      '|---|---|---|---|---|',
    );
    for (const event of failures) {
      lines.push(
        `| ${when(event.tsMs)} | ${cell(event.device.label)} | \`${event.kind}\` | ${event.session === null ? '–' : `${event.session.slice(0, 8)}…${event.attempt === null ? '' : ` / ${String(event.attempt)}`}`} | ${cell(failureMessage(event)) || '–'} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
