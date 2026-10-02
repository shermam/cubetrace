// users/{uid}/events/{eventId} in Firestore (docs/DATA-MODEL.md §10, docs/PLAN.md T3.9,
// docs/DIAGNOSTICS.md), schema version 1: a diagnostics event, one fact about the app's own use on
// one of the account's devices (the app started, a cube connected, an attempt ended, a clip saved,
// an upload moved on, an error), written by the device that saw it, never changed or deleted by the
// app. The coordinator's round report reads them in place of the owner's notes on the manual rounds.
// Never a MAC address, an email, a file's contents or a user agent: `sanitizeEventData` holds every
// event to the shapes below and scrubs what looks like one.
import type { AppBuild } from './session';

/** The device that saw an event, as its account knows it. */
export interface EventDevice {
  /** The host label the account records (Settings → This device, `host.label` of session.json). */
  label: string;
  /** The platform, such as `macOS` or `Android` (`host.platform`); empty when unknown. */
  platform: string;
  /** The app runs installed (display mode `standalone`), not in a browser tab. */
  installed: boolean;
}

/** A fact of an event: text (at most {@link EVENT_TEXT_MAX_LENGTH} characters), a number, a boolean or null. */
export type EventValue = string | number | boolean | null;

/** The facts of an event: at most {@link EVENT_DATA_MAX_KEYS} of them, one level of nesting at most. */
export type EventData = Record<string, EventValue | Record<string, EventValue>>;

/** users/{uid}/events/{eventId}, schema version 1 (docs/DATA-MODEL.md §10). */
export interface CloudEvent {
  schema: 1;
  /** When it happened: host ms (docs/DATA-MODEL.md §1) on the device's clock. */
  tsMs: number;
  /** What happened: a dotted lowercase name of the catalogue (docs/DIAGNOSTICS.md), `attempt.done`. */
  kind: string;
  /** The build that wrote it. */
  app: AppBuild;
  device: EventDevice;
  /** The session it belongs to, when it belongs to one. */
  session?: string;
  /** The attempt it belongs to (its index), when it belongs to one. */
  attempt?: number;
  data: EventData;
}

/** The document and its id, as the device writes them in one batch. */
export interface CloudEventWrite {
  /** The document's id ({@link eventId}): `<tsMs as 13 digits>-<8 hex>`, so that ids sort by time. */
  readonly id: string;
  readonly event: CloudEvent;
}

/** A kind: lowercase words of letters and digits, two or more, joined by dots. */
export const EVENT_KIND = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/u;

/** The most characters of a kind. */
export const EVENT_KIND_MAX_LENGTH = 64;

/** The most facts of one event. */
export const EVENT_DATA_MAX_KEYS = 32;

/** The most characters of a text fact; longer ones are cut, with an ellipsis. */
export const EVENT_TEXT_MAX_LENGTH = 500;

/** An event's id: the event's time as 13 digits, a dash and 8 hex digits. */
export const EVENT_ID = /^\d{13}-[0-9a-f]{8}$/u;

/** Whether `kind` is a kind the documents take. */
export function isEventKind(kind: string): boolean {
  return kind.length <= EVENT_KIND_MAX_LENGTH && EVENT_KIND.test(kind);
}

/**
 * The id of an event at host time `tsMs` with the random `suffix` (8 hex digits): the time as 13
 * digits (ms since 1970 fit until the year 2286) and the suffix, so that the ids of a device sort by
 * time and two events of one millisecond differ. Throws on a suffix of another shape.
 */
export function eventId(tsMs: number, suffix: string): string {
  if (!/^[0-9a-f]{8}$/u.test(suffix)) {
    throw new RangeError(`An event id's suffix is 8 hex digits, got "${suffix}".`);
  }
  const whole = Math.max(0, Math.floor(Number.isFinite(tsMs) ? tsMs : 0));
  return `${String(whole).padStart(13, '0').slice(-13)}-${suffix}`;
}

/** A MAC address as text, with colons or dashes, in either case: never in an event. */
const MAC_IN_TEXT = /\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/giu;

/** An email address as text: never in an event. */
const EMAIL_IN_TEXT = /[^\s@"'<>()]+@[^\s@"'<>()]+\.[^\s@"'<>()]+/gu;

/**
 * `text` without what an event must never carry: a MAC address (`AB:12:CD:34:EF:56`, dashes or
 * lowercase too) becomes `[mac]` and an email address `[email]`; then cut to
 * {@link EVENT_TEXT_MAX_LENGTH} characters, with an ellipsis.
 */
export function scrubEventText(text: string): string {
  const scrubbed = text.replace(MAC_IN_TEXT, '[mac]').replace(EMAIL_IN_TEXT, '[email]');
  return scrubbed.length <= EVENT_TEXT_MAX_LENGTH
    ? scrubbed
    : `${scrubbed.slice(0, EVENT_TEXT_MAX_LENGTH - 1)}…`;
}

/** `value` as a fact, or undefined for what cannot be one (a function, a symbol, deeper nesting). */
function eventValue(value: unknown): EventValue | undefined {
  switch (typeof value) {
    case 'string':
      return scrubEventText(value);
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'boolean':
      return value;
    case 'bigint':
      return Number(value);
    case 'object':
      if (value === null) {
        return null;
      }
      if (Array.isArray(value)) {
        // A list reads as one text: `laptop.scramble.mp4, laptop.solve.mp4`.
        return scrubEventText(
          (value as unknown[])
            .map((item) => {
              const flat = eventValue(item);
              return flat === undefined || typeof flat === 'object' ? '' : String(flat);
            })
            .filter((item) => item !== '')
            .join(', '),
        );
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * `input` as the facts of an event: its first {@link EVENT_DATA_MAX_KEYS} fields, each a
 * {@link EventValue} (text scrubbed and cut, a number that is not finite read as null, a list as one
 * text) or a map of them (one level: anything deeper is left out), and nothing else (undefined,
 * functions, symbols). Pure: the service calls it on every event, so it allocates little.
 */
export function sanitizeEventData(input: Readonly<Record<string, unknown>>): EventData {
  const out: EventData = {};
  let keys = 0;
  for (const [key, value] of Object.entries(input)) {
    if (keys >= EVENT_DATA_MAX_KEYS) {
      break;
    }
    const flat = eventValue(value);
    if (flat !== undefined) {
      out[key] = flat;
      keys++;
      continue;
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested: Record<string, EventValue> = {};
      for (const [name, inner] of Object.entries(value as Record<string, unknown>)) {
        const leaf = eventValue(inner);
        if (leaf !== undefined) {
          nested[name] = leaf;
        }
      }
      out[key] = nested;
      keys++;
    }
  }
  return out;
}

/** What a device records for an event. */
export interface CloudEventInput {
  tsMs: number;
  kind: string;
  app: AppBuild;
  device: EventDevice;
  session?: string | null;
  attempt?: number | null;
  data: Readonly<Record<string, unknown>>;
}

/**
 * users/{uid}/events/{eventId} of `input`: its facts sanitized ({@link sanitizeEventData}), its
 * session and attempt only when it belongs to one. Throws a RangeError on a kind that is not one
 * ({@link isEventKind}), or an attempt that is not a positive integer.
 */
export function cloudEvent(input: CloudEventInput): CloudEvent {
  if (!isEventKind(input.kind)) {
    throw new RangeError(
      `An event's kind is a dotted lowercase name of at most ${String(EVENT_KIND_MAX_LENGTH)} characters, got "${input.kind}".`,
    );
  }
  const attempt = input.attempt ?? null;
  if (attempt !== null && (!Number.isSafeInteger(attempt) || attempt < 1)) {
    throw new RangeError(`An event's attempt is a positive integer, got ${String(attempt)}.`);
  }
  const session = input.session ?? null;
  return {
    schema: 1,
    tsMs: input.tsMs,
    kind: input.kind,
    app: { version: input.app.version, commit: input.app.commit },
    device: {
      label: input.device.label,
      platform: input.device.platform,
      installed: input.device.installed,
    },
    ...(session !== null && session !== '' ? { session } : {}),
    ...(attempt !== null ? { attempt } : {}),
    data: sanitizeEventData(input.data),
  };
}
