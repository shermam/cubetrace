// users/{uid} in Firestore (docs/DATA-MODEL.md §10), schema version 1: the record of a cubetrace
// account, which the app writes at each sign-in (docs/PLAN.md, T3.0). The first of the cloud records;
// T3.1 adds the session index.

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
 * fields are replaced with the same or newer values.
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
