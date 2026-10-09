// A phone's status line (docs/PLAN.md T5.1): the words and colours of what a remote camera reports in
// its `state` messages, the twin of the host's own line under its preview (`CameraPreview`), from one
// pure function, so that the Timer page's line under a phone's picture, a tile's caption (in short)
// and the Cameras list's report never disagree.
import type { CameraState } from '@cubetrace/rtc';

import { fpsText, sharpnessText } from './camera-format';
import type { RemoteCameraPhase } from './remote-camera-registry';

/** What the line reads of a phone's last `state` (docs/RTC.md §1). */
export type RemoteReport = Pick<
  CameraState,
  | 'recording'
  | 'framing'
  | 'fps'
  | 'sharpness'
  | 'battery'
  | 'thermal'
  | 'pressure'
  | 'pressureSource'
  | 'pendingClips'
>;

/**
 * How a part reads: `ok` (green: the sharpness good), `warn` (amber: soft, a battery under 20% and
 * not charging, the frame rate dropped, fair pressure, reconnecting), `bad` (red: a battery under 10%
 * and not charging, serious or critical pressure, not recording, no report), `plain` (muted).
 */
export type StatusTone = 'ok' | 'warn' | 'bad' | 'plain';

/** The parts of the line, in their order. */
export type StatusKey =
  | 'report'
  | 'fps'
  | 'sharpness'
  | 'recording'
  | 'framing'
  | 'battery'
  | 'thermal'
  | 'pressure'
  | 'clips'
  | 'connection'
  | 'stale';

/** One part of the line: "sharpness 41", the value coloured by its tone. */
export interface StatusPart {
  readonly key: StatusKey;
  /** The words before the value, muted ("sharpness", "battery"); empty when the value says it all. */
  readonly label: string;
  /** The value, in its tone's colour ("41", "83%, charging", "recording", "reconnecting…"). */
  readonly value: string;
  readonly tone: StatusTone;
  /** The part in a tile's caption, where it says that something is wrong; null otherwise. */
  readonly short: string | null;
  /** What the part means (its title). */
  readonly title: string;
}

/** What the line is made from: the phone's last report and its connection, as the host sees them. */
export interface RemoteStatusInput {
  /** The phone's last `state`; null before the first. */
  readonly report: RemoteReport | null;
  /** When it came, on the host clock; null before the first. */
  readonly reportMs: number | null;
  /** The host clock now. */
  readonly nowMs: number;
  /**
   * Where the camera is, and since when on the host clock (the Cameras list's state; a connected
   * camera's is the start of its connection).
   */
  readonly state: RemoteCameraPhase;
  readonly sinceMs: number;
  /** The clock sync has converged. */
  readonly converged: boolean;
  /** The host's sharpness threshold (Settings → Camera): good from it up. */
  readonly sharpnessThreshold: number;
}

/**
 * `line`: the Timer page's, under a phone's picture (and, in short, its tile's caption): the frame
 * rate, the sharpness, the recording, the battery, the health (the frame rate dropped, the pressure),
 * the connection when it is not plainly connected, and a report that stopped coming. `list`: the
 * Cameras list's report, with the framing and the clips still to send, and without the connection,
 * which the list says on lines of its own.
 */
export type StatusForm = 'line' | 'list';

/** A connected phone whose last report is this old is said to have stopped (it sends one every 2 s). */
export const STALE_REPORT_MS = 10_000;

/** A battery under this many percent and not charging is amber; under {@link BATTERY_EMPTY_PERCENT}, red. */
export const BATTERY_LOW_PERCENT = 20;
export const BATTERY_EMPTY_PERCENT = 10;

const PRESSURE_TONE: Readonly<Record<NonNullable<CameraState['pressure']>, StatusTone>> = {
  nominal: 'plain',
  fair: 'warn',
  serious: 'bad',
  critical: 'bad',
};

const PRESSURE_MEANING: Readonly<Record<NonNullable<CameraState['pressure']>, string>> = {
  nominal: 'no adverse effect',
  fair: 'slightly elevated: it is warming up',
  serious: 'consistently high: it may be hot, and may slow down',
  critical: 'it is hot and must cool down',
};

/**
 * The parts of a phone's status line, in order (see {@link StatusForm}); before its first report,
 * "no report yet" in their place.
 */
export function remoteStatusLine(
  input: RemoteStatusInput,
  form: StatusForm = 'line',
): StatusPart[] {
  const report = input.report;
  const parts: StatusPart[] =
    report === null
      ? [part('report', '', 'no report yet', 'plain', null, 'The phone has sent no report yet.')]
      : reportParts(report, input.sharpnessThreshold, form);
  if (form === 'line') {
    const connection = connectionPart(input);
    if (connection !== null) {
      parts.push(connection);
    }
  }
  // From the last report, or from the connection's start when that came after it (a phone back from
  // a drop sends its first report at once: the one before the drop is no measure).
  const age = input.nowMs - Math.max(input.reportMs ?? input.sinceMs, input.sinceMs);
  if (input.state === 'connected' && age >= STALE_REPORT_MS) {
    const seconds = String(Math.floor(age / 1000));
    parts.push(
      part(
        'stale',
        '',
        `no report for ${seconds} s`,
        'bad',
        'no report',
        `The phone sends its state every 2 s: none came for ${seconds} s, although it is connected.`,
      ),
    );
  }
  return parts;
}

/** The line as text: "29.9 fps · sharpness 41 · recording · battery 83%, charging". */
export function statusText(parts: readonly StatusPart[]): string {
  return parts.map((p) => (p.label === '' ? p.value : `${p.label} ${p.value}`)).join(' · ');
}

/** The parts a tile's caption shows, in short: those that say something is wrong. */
export function shortParts(parts: readonly StatusPart[]): StatusPart[] {
  return parts.filter((p) => p.short !== null);
}

function reportParts(report: RemoteReport, threshold: number, form: StatusForm): StatusPart[] {
  const parts: StatusPart[] = [
    part(
      'fps',
      '',
      report.fps === null ? '– fps' : fpsText(report.fps),
      'plain',
      null,
      "The phone's frame rate over the last second, as it measures it.",
    ),
    sharpnessPart(report.sharpness, threshold),
    report.recording
      ? part('recording', '', 'recording', 'plain', null, "The phone's recording runs.")
      : part(
          'recording',
          '',
          'not recording',
          'bad',
          'not recording',
          "The phone's recording does not run: it has no clips to give.",
        ),
  ];
  if (form === 'list') {
    parts.push(
      part(
        'framing',
        '',
        report.framing === null
          ? 'full frame'
          : `framing ${String(report.framing.w)}×${String(report.framing.h)}`,
        'plain',
        null,
        "The phone's framing rectangle, in the pixels of its frames.",
      ),
    );
  }
  const battery = report.battery;
  if (battery !== null) {
    const percent = Math.round(battery.level * 100);
    const tone: StatusTone = battery.charging
      ? 'plain'
      : percent < BATTERY_EMPTY_PERCENT
        ? 'bad'
        : percent < BATTERY_LOW_PERCENT
          ? 'warn'
          : 'plain';
    parts.push(
      part(
        'battery',
        'battery',
        `${String(percent)}%${battery.charging ? ', charging' : ''}`,
        tone,
        tone === 'plain' ? null : `${String(percent)}%`,
        battery.charging
          ? "The phone's battery, charging."
          : "The phone's battery, not charging: plug the phone in.",
      ),
    );
  }
  if (report.thermal === 'throttled') {
    parts.push(
      part(
        'thermal',
        '',
        'hot: the frame rate dropped',
        'warn',
        'hot',
        "The phone's frame rate fell under 80% of what its camera promised: it may be hot.",
      ),
    );
  }
  const pressure = report.pressure;
  if (pressure !== null) {
    const source = report.pressureSource === 'thermals' ? 'its thermals' : 'its CPU';
    parts.push(
      part(
        'pressure',
        'pressure',
        pressure,
        PRESSURE_TONE[pressure],
        pressure === 'nominal' ? null : `pressure ${pressure}`,
        `The phone's Compute Pressure state, from ${source}: ${PRESSURE_MEANING[pressure]}.`,
      ),
    );
  }
  if (form === 'list' && report.pendingClips > 0) {
    const clips = report.pendingClips;
    parts.push(
      part(
        'clips',
        '',
        `${String(clips)} ${clips === 1 ? 'clip' : 'clips'} to send`,
        'plain',
        null,
        'Clips cut on the phone that this device has not received yet.',
      ),
    );
  }
  return parts;
}

function sharpnessPart(value: number | null, threshold: number): StatusPart {
  const limit = String(threshold);
  if (value === null) {
    return part(
      'sharpness',
      'sharpness',
      '–',
      'plain',
      null,
      "Sharpness of the phone's framing rectangle: not measured yet.",
    );
  }
  return value >= threshold
    ? part(
        'sharpness',
        'sharpness',
        sharpnessText(value),
        'ok',
        null,
        `Sharpness of the phone's framing rectangle: good (${limit} or more, Settings).`,
      )
    : part(
        'sharpness',
        'sharpness',
        sharpnessText(value),
        'warn',
        'soft',
        `Sharpness of the phone's framing rectangle: soft (under ${limit}, Settings).`,
      );
}

/** The connection when it is not plainly connected, or the clock sync before it converged. */
function connectionPart(input: RemoteStatusInput): StatusPart | null {
  switch (input.state) {
    case 'connecting':
      return part('connection', '', 'connecting…', 'plain', null, 'The phone is connecting.');
    case 'reconnecting':
      return part(
        'connection',
        '',
        'reconnecting…',
        'warn',
        'reconnecting…',
        'The connection dropped: the phone calls again by itself for five minutes.',
      );
    case 'finishing':
      return part(
        'connection',
        '',
        'sending its last clips',
        'plain',
        null,
        'The session ended: the phone stays until its last clips are in, 15 s at most.',
      );
    case 'connected':
      return input.converged
        ? null
        : part(
            'connection',
            '',
            'clock syncing…',
            'plain',
            null,
            "The clock sync has not converged yet: the phone's clips are cut all the same, with a wider margin.",
          );
  }
}

function part(
  key: StatusKey,
  label: string,
  value: string,
  tone: StatusTone,
  short: string | null,
  title: string,
): StatusPart {
  return { key, label, value, tone, short, title };
}
