// The Sessions page's rows (docs/PLAN.md T1.6b, T3.1): this device's sessions, the current one as the
// timer has it now, and, with an account signed in, the sessions of the account's index in the cloud,
// merged by id. Pure functions over the lists, so that the page only draws them.
import {
  sessionOfDocument,
  type AttemptRecord,
  type CloudSession,
  type SessionRecord,
} from '@cubetrace/core';

import type { CloudEntry } from '../cloud/session-index';
import type { SessionListItem } from '../session/session-service';
import { sessionMean } from '../session/session-stats';

/** Where a session is: on this device only, in the cloud's index only, or both. */
export type SessionPlace = 'device' | 'cloud' | 'both';

/** What a row's badge says. */
export const PLACE_LABELS: Readonly<Record<SessionPlace, string>> = {
  device: 'this device',
  cloud: 'cloud',
  both: 'both',
};

/** A session of the Sessions page signed in: this device's, the cloud's, or both, by id. */
export interface MergedSession {
  readonly id: string;
  /** Its record: this device's when it has the session, else the one its document copies. */
  readonly session: SessionRecord;
  readonly place: SessionPlace;
  /** This device's listing of it (attempts, mean, clips, files left out); null for the cloud's alone. */
  readonly local: SessionListItem | null;
  /** Its document in the cloud's index, as the page read it; null when the listing did not have it. */
  readonly cloud: CloudEntry<CloudSession> | null;
}

/**
 * This device's sessions with the current one as the timer has it now (`current` and its
 * `attempts`): its row follows its attempts while the page is open, and a session begun since the
 * page read the store is added. The others keep what the store said.
 */
export function withCurrent(
  items: readonly SessionListItem[],
  current: SessionRecord | null,
  attempts: readonly AttemptRecord[],
): SessionListItem[] {
  const rows = items.map((item) =>
    item.current === (item.session.id === current?.id) ? item : { ...item, current: !item.current },
  );
  if (current === null) {
    return rows;
  }
  const clips = attempts.flatMap((attempt) => attempt.video);
  const at = rows.findIndex((item) => item.session.id === current.id);
  const live: SessionListItem = {
    session: current,
    attempts: attempts.length,
    mean: sessionMean(attempts),
    clips: clips.length,
    clipBytes: clips.reduce((sum, clip) => sum + clip.bytes, 0),
    current: true,
    unreadable: at < 0 ? [] : rows[at].unreadable,
  };
  return at < 0
    ? newestFirst([live, ...rows], (item) => item.session)
    : rows.map((item, k) => (k === at ? live : item));
}

/**
 * This device's sessions and the cloud's, merged by id, newest first. A session of this device is
 * `both` when the cloud's listing has it, or when this page load wrote it to the index (`written`),
 * which a listing read earlier cannot know.
 */
export function mergeSessions(
  local: readonly SessionListItem[],
  cloud: readonly CloudEntry<CloudSession>[],
  written: ReadonlySet<string>,
): MergedSession[] {
  const inCloud = new Map(cloud.map((entry) => [entry.id, entry]));
  const rows: MergedSession[] = local.map((item) => {
    const id = item.session.id;
    const entry = inCloud.get(id) ?? null;
    return {
      id,
      session: item.session,
      place: entry !== null || written.has(id) ? 'both' : 'device',
      local: item,
      cloud: entry,
    };
  });
  const here = new Set(rows.map((row) => row.id));
  for (const entry of cloud) {
    if (!here.has(entry.id)) {
      rows.push({
        id: entry.id,
        session: sessionOfDocument(entry.document),
        place: 'cloud',
        local: null,
        cloud: entry,
      });
    }
  }
  return newestFirst(rows, (row) => row.session);
}

/** The host labels of `rows`' sessions, each once, in alphabetical order: the device filter's. */
export function hostLabels(rows: readonly MergedSession[]): string[] {
  return [...new Set(rows.map((row) => row.session.host.label))].sort((p, q) => p.localeCompare(q));
}

/** `items` by their session's creation, newest first (then by id, as the store lists them). */
function newestFirst<T>(items: readonly T[], session: (item: T) => SessionRecord): T[] {
  return [...items].sort((p, q) => {
    const a = session(p);
    const b = session(q);
    return b.createdMs - a.createdMs || a.id.localeCompare(b.id);
  });
}
