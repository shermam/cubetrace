import type { MicrophoneInfo, MicrophoneProcessing } from '@cubetrace/core';

import { errorMessage } from '../shared/error-message';

// The recording's microphone (docs/PLAN.md, T2.12): how it is asked for, what the browser says it
// applied (the session's `cameras[].microphone`, docs/DATA-MODEL.md §6), and how the Recording part
// of Camera settings says it. Asked for with `{audio: true}`, Chrome applies its voice processing
// (echo cancellation, noise suppression, automatic gain control; on Android the platform's voice
// pipeline too), which takes a turn's click for noise: the owner's ThinkPhone clips had a TV's
// voices and none of the cube's sounds (docs/DEVICES.md, "Audio"). For the dataset the clicks are
// signal, since each turn clicks, so the microphone is recorded raw unless Settings say Voice.

/** `MediaTrackConstraints` with `voiceIsolation`, a newer constraint TypeScript's DOM lib lacks. */
export interface MicrophoneConstraints extends MediaTrackConstraints {
  voiceIsolation?: ConstrainBoolean;
}

/** `MediaTrackSettings` with `voiceIsolation`, which TypeScript's DOM lib lacks too. */
export interface MicrophoneSettings extends MediaTrackSettings {
  voiceIsolation?: boolean;
}

/** The parts of a microphone's track that {@link microphoneInfo} reads. */
export interface MicrophoneTrack {
  readonly label: string;
  getSettings(): MicrophoneSettings;
}

/** The microphone with the browser's defaults: the request for Voice, and the fallback. */
export const DEFAULT_MICROPHONE: MediaStreamConstraints = { audio: true };

/**
 * What `getUserMedia` is asked for to open the microphone as `processing` says. Raw: every voice
 * processing off, and one channel at 48 kHz as ideals, so that a device without them still opens
 * (Chromium's fake microphone, raw, gives two channels at 44.1 kHz: docs/TOOLCHAIN.md); booleans
 * and ideals never fail a request. Voice: the browser's defaults.
 */
export function microphoneConstraints(processing: MicrophoneProcessing): MediaStreamConstraints {
  if (processing === 'voice') {
    return DEFAULT_MICROPHONE;
  }
  const audio: MicrophoneConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    voiceIsolation: false,
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48_000 },
  };
  return { audio };
}

/**
 * The session's record of the microphone open on `track` (`cameras[].microphone`), asked for as
 * `processing` says: its label, and what the browser says it applied (`getSettings()`), each field
 * null when the browser does not report it, or reports something else than a switch or a positive
 * count. The device's id is not kept.
 */
export function microphoneInfo(
  track: MicrophoneTrack,
  processing: MicrophoneProcessing,
): MicrophoneInfo {
  const settings = track.getSettings();
  return {
    label: track.label,
    processing,
    echoCancellation: switchOf(settings.echoCancellation),
    noiseSuppression: switchOf(settings.noiseSuppression),
    autoGainControl: switchOf(settings.autoGainControl),
    voiceIsolation: switchOf(settings.voiceIsolation),
    sampleRate: positive(settings.sampleRate, false),
    channelCount: positive(settings.channelCount, true),
  };
}

/** The settings of a microphone's voice processing. */
type ProcessingSetting =
  'echoCancellation' | 'noiseSuppression' | 'autoGainControl' | 'voiceIsolation';

/** The voice processing a microphone can have, by its setting, in plain words. */
const PROCESSING: readonly (readonly [ProcessingSetting, string])[] = [
  ['echoCancellation', 'echo cancellation'],
  ['noiseSuppression', 'noise suppression'],
  ['autoGainControl', 'automatic gain control'],
  ['voiceIsolation', 'voice isolation'],
];

/**
 * The voice processing the browser kept on although Raw was asked for, in plain words ("noise
 * suppression"); none when Voice was asked for, or the browser turned it all off or does not say.
 */
export function processingKept(info: MicrophoneInfo): string[] {
  return info.processing === 'raw'
    ? PROCESSING.filter(([setting]) => info[setting] === true).map(([, name]) => name)
    : [];
}

/**
 * The microphone's part of the Recording part's codecs line: "mic raw", "mic voice", or, when the
 * browser kept some of its processing on although Raw was asked for, "mic: the browser kept
 * processing on".
 */
export function microphoneText(info: MicrophoneInfo): string {
  return processingKept(info).length > 0
    ? 'mic: the browser kept processing on'
    : `mic ${info.processing}`;
}

/**
 * The notice when the browser kept some of its voice processing on although Raw was asked for,
 * which the recording notes once in the session; null otherwise.
 */
export function processingNotice(info: MicrophoneInfo): string | null {
  const kept = processingKept(info);
  return kept.length === 0
    ? null
    : `The microphone is not raw: the browser kept its ${sentenceList(kept)} on although Raw was ` +
        "asked for, so the sound may lack the cube's clicks.";
}

/** A setting that is a switch: true or false; Chrome's echo cancellation modes count as on. */
function switchOf(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  // Newer Chrome reports echo cancellation as a mode when it is on: 'all' or 'remote-only'.
  return value === 'all' || value === 'remote-only' ? true : null;
}

/** A finite number above 0 (a whole one when `whole`), or null. */
function positive(value: unknown, whole: boolean): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    (!whole || Number.isInteger(value))
    ? value
    : null;
}

/** "a", "a and b", "a, b and c". */
function sentenceList(items: readonly string[]): string {
  return items.length < 2
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The microphone as a recording opened it: its stream, the session's record of it (null when the
 * stream has no audio track), and a notice when it is not as asked for (the browser kept its voice
 * processing on, or refused the raw request); or no stream, with the notice that says why.
 */
export type OpenedMicrophone =
  | {
      readonly stream: MediaStream;
      readonly info: MicrophoneInfo | null;
      readonly notice: string | null;
    }
  | { readonly stream: null; readonly info: null; readonly notice: string };

/**
 * Opens the microphone as `processing` says (T2.12: raw, every voice processing off; voice, the
 * browser's defaults), for the recording of this device's camera (`RecordingService`) and of a
 * camera device's (T4.1). Should the browser refuse the raw request (an `OverconstrainedError`,
 * which its booleans and ideals ought never to cause), the microphone is asked for again with the
 * browser's defaults, and the notice says so; when the browser kept some processing on although Raw
 * was asked for, the notice says that instead. Without a stream the notice says why the video is
 * recorded without sound.
 */
export async function openMicrophone(
  media: Pick<MediaDevices, 'getUserMedia'> | undefined,
  processing: MicrophoneProcessing,
): Promise<OpenedMicrophone> {
  if (typeof media?.getUserMedia !== 'function') {
    return {
      stream: null,
      info: null,
      notice: 'Recording without audio: this browser gives no microphone.',
    };
  }
  let stream: MediaStream;
  let refusal: { readonly error: unknown } | null = null;
  try {
    try {
      stream = await media.getUserMedia(microphoneConstraints(processing));
    } catch (error: unknown) {
      if (processing !== 'raw' || errorName(error) !== 'OverconstrainedError') {
        throw error;
      }
      refusal = { error };
      stream = await media.getUserMedia(DEFAULT_MICROPHONE);
    }
  } catch (error: unknown) {
    return {
      stream: null,
      info: null,
      notice: `Recording without audio: ${microphoneProblem(error)}`,
    };
  }
  const track = stream.getAudioTracks().at(0);
  const info = track === undefined ? null : microphoneInfo(track, processing);
  const notice =
    refusal !== null ? rawRefused(refusal.error) : info === null ? null : processingNotice(info);
  return { stream, info, notice };
}

/** The `name` of what was thrown, such as `NotAllowedError`; null when it has none. */
function errorName(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : null;
}

/** The notice when the browser refused the raw microphone, naming the constraint it refused. */
function rawRefused(error: unknown): string {
  const constraint: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'constraint') : undefined;
  const refused = typeof constraint === 'string' && constraint !== '' ? ` (${constraint})` : '';
  return (
    `The microphone could not be opened raw: the browser refused the request${refused}, so it ` +
    "is recorded with the browser's voice processing."
  );
}

/** Why the microphone could not be had, in plain words. */
function microphoneProblem(error: unknown): string {
  switch (errorName(error)) {
    case 'NotAllowedError':
      return 'the microphone was not allowed (Chrome asks once; the site settings can change it).';
    case 'NotFoundError':
      return 'this device has no microphone.';
    case 'NotReadableError':
      return 'the microphone is in use by another app.';
    default:
      return `the microphone could not be opened (${errorMessage(error)}).`;
  }
}
