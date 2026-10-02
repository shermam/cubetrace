// users/{uid} in Firestore (docs/DATA-MODEL.md §10), schema version 1: the record of a cubetrace
// account, which the app writes at each sign-in (docs/PLAN.md, T3.0). The first of the cloud records;
// T3.1 adds the session index. Since T3.10 the record also carries `viewer`, the clip viewer's
// choice per camera (the view of the 3D cube and the mirror), written apart from the sign-in's
// record, merged, when the user changes it.
import { type Mirror, isMirror } from './orientation';

/**
 * How the clip viewer shows the clips of one camera (docs/PLAN.md T3.10): where the player's camera
 * looks at the 3D cube from, and the mirror applied to its orientation. Kept per camera label (the
 * clip's `camera`, docs/DATA-MODEL.md §7) on the device and, signed in, in the account.
 */
export interface ViewerChoice {
  /**
   * The player's camera latitude, in degrees: 0 level with the cube, 90 straight above it, −90
   * straight below (cubing.js's `cameraLatitude`).
   */
  readonly latitude: number;
  /**
   * The player's camera longitude, in degrees around the cube: 0 in front of it, 90 to its right,
   * 180 behind it, −90 to its left (cubing.js's `cameraLongitude`), in (−180, 180].
   */
  readonly longitude: number;
  /** The reflection applied to the orientation shown (`orientation.ts`). */
  readonly mirror: Mirror;
}

/** The choices by camera label. */
export type ViewerChoices = Readonly<Record<string, ViewerChoice>>;

/** The choice for a camera without one: the cube seen straight on from the front, no mirror. */
export const VIEWER_DEFAULT: ViewerChoice = { latitude: 0, longitude: 0, mirror: 'none' };

/**
 * At most this many cameras keep a choice: in the account's record (the rules check each entry of
 * `viewer` by its place, within the engine's budget of expressions, so the map is bounded) and on
 * the device (the oldest goes first).
 */
export const MAX_VIEWER_CHOICES = 8;

/** The angles are kept to tenths of a degree: far under what the picture shows. */
const TENTHS = 10;

/** `latitude` held to −90…90. */
export function clampLatitude(latitude: number): number {
  return Math.min(90, Math.max(-90, latitude));
}

/**
 * `longitude` brought into (−180, 180]: cubing.js keeps its longitude in [−180, 180), so a view from
 * behind reads 180 here and −180 there, the same direction.
 */
export function normalizeLongitude(longitude: number): number {
  if (longitude > -180 && longitude <= 180) {
    // As it is: the wrap's arithmetic would put floating noise on a value already in range.
    return longitude;
  }
  const wrapped = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** The angles rounded to a tenth of a degree, `0` for `−0`. */
function rounded(degrees: number): number {
  const value = Math.round(degrees * TENTHS) / TENTHS;
  return Object.is(value, -0) ? 0 : value;
}

/**
 * A choice as it is kept: the latitude clamped and the longitude normalized, both rounded to a tenth
 * of a degree (the drag's floating angles would otherwise never compare equal).
 */
export function viewerChoice(latitude: number, longitude: number, mirror: Mirror): ViewerChoice {
  return {
    latitude: rounded(clampLatitude(latitude)),
    longitude: normalizeLongitude(rounded(normalizeLongitude(longitude))),
    mirror,
  };
}

/** Whether two choices show the same thing: the same angles (−180 and 180 alike) and mirror. */
export function sameViewerChoice(a: ViewerChoice, b: ViewerChoice): boolean {
  return (
    Math.abs(a.latitude - b.latitude) < 1e-6 &&
    Math.abs(normalizeLongitude(a.longitude) - normalizeLongitude(b.longitude)) < 1e-6 &&
    a.mirror === b.mirror
  );
}

/** Whether `value` is a choice as the schema has it: the angles in their ranges, a known mirror. */
export function isViewerChoice(value: unknown): value is ViewerChoice {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const latitude: unknown = Reflect.get(value, 'latitude');
  const longitude: unknown = Reflect.get(value, 'longitude');
  const mirror: unknown = Reflect.get(value, 'mirror');
  return (
    typeof latitude === 'number' &&
    Number.isFinite(latitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    typeof longitude === 'number' &&
    Number.isFinite(longitude) &&
    longitude >= -180 &&
    longitude <= 180 &&
    isMirror(mirror)
  );
}

/**
 * The choices of a record's `viewer` (or of the device's settings), as far as they are well formed:
 * each entry whose label is not empty and whose value is a choice, normalized ({@link viewerChoice});
 * the others are left out, as is anything that is not a map (a record written before T3.10 has
 * none). At most {@link MAX_VIEWER_CHOICES}, the first ones.
 */
export function parseViewerChoices(value: unknown): ViewerChoices {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const choices: Record<string, ViewerChoice> = {};
  let count = 0;
  for (const [label, choice] of Object.entries(value)) {
    if (label === '' || !isViewerChoice(choice) || count >= MAX_VIEWER_CHOICES) {
      continue;
    }
    choices[label] = viewerChoice(choice.latitude, choice.longitude, choice.mirror);
    count++;
  }
  return choices;
}

/**
 * The device's choices merged with the account's at a sign-in: the device's for the cameras it has
 * set, the account's for the cameras it has not (appended after the device's, so that the device's
 * oldest still go first when there are too many). A camera neither has set keeps the defaults
 * ({@link VIEWER_DEFAULT}), which are never stored.
 */
export function mergeViewerChoices(device: ViewerChoices, account: ViewerChoices): ViewerChoices {
  const merged: Record<string, ViewerChoice> = { ...device };
  for (const [label, choice] of Object.entries(account)) {
    if (!(label in merged)) {
      merged[label] = choice;
    }
  }
  return merged;
}

/**
 * The choices of `next` that `known` does not hold the same: what a device writes to the account
 * after a merge (the cameras the account lacks, and those where the device's choice won) and after a
 * change.
 */
export function changedViewerChoices(known: ViewerChoices, next: ViewerChoices): ViewerChoices {
  const changed: Record<string, ViewerChoice> = {};
  for (const [label, choice] of Object.entries(next)) {
    const held = known[label] as ViewerChoice | undefined;
    if (held === undefined || !sameViewerChoice(held, choice)) {
      changed[label] = choice;
    }
  }
  return changed;
}

/** users/{uid}, schema version 1 (docs/DATA-MODEL.md §10). */
export interface UserRecord {
  schema: 1;
  /**
   * When the account was created: Firebase Authentication's creation time of the account, in ms since
   * 1970-01-01 UTC. The same on every device, so every sign-in writes the value already there.
   */
  createdMs: number;
  /** The account's name, as Google gives it; null without one. */
  displayName: string | null;
  /** The account's email address, as Google gives it; null without one. */
  email: string | null;
  /**
   * The devices the account was used on, by host label (Settings → This device, which session.json
   * records as `host.label`): each one's host clock, in ms, when it last signed in or started signed
   * in.
   */
  devices: Record<string, number>;
  /**
   * The clip viewer's choice per camera label (T3.10), which the viewer's changes write apart from
   * the sign-in's record: absent from it, and from a record written before T3.10.
   */
  viewer?: ViewerChoices;
}

/** What a sign-in on a device records: the account, the device's host label and its host clock. */
export interface UserRecordInput {
  createdMs: number;
  displayName: string | null;
  email: string | null;
  hostLabel: string;
  nowMs: number;
}

/**
 * users/{uid} as a sign-in on one device writes it: merged into the stored document (Firestore's
 * `set` with `merge`), its `devices` entry is added to the other devices' entries, and the other
 * fields are replaced with the same or newer values; `viewer`, written on its own, is left as it is.
 */
export function userRecord(input: UserRecordInput): UserRecord {
  return {
    schema: 1,
    createdMs: input.createdMs,
    displayName: input.displayName,
    email: input.email,
    devices: { [input.hostLabel]: input.nowMs },
  };
}
