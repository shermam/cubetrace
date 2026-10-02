import { cloudSession, type SessionRecord } from '@cubetrace/core';

import type { CloudEntry } from '../cloud/session-index';
import { attemptWithClips, realSession } from '../cloud/cloud-testing';
import type { SessionListItem } from '../session/session-service';
import { SESSION_A, SESSION_B, testAttempt } from '../session/session-testing';
import { hostLabels, mergeSessions, withCurrent } from './session-merge';

const SESSION_C = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
const OWNER = 'ada-uid';

/** A session of this device as the store lists it. */
function item(session: SessionRecord, attempts: number, current = false): SessionListItem {
  return {
    session,
    attempts,
    mean: '10.00',
    clips: 0,
    clipBytes: 0,
    cloudClips: 0,
    current,
    unreadable: [],
  };
}

function entry(
  session: SessionRecord,
  pending = false,
): CloudEntry<ReturnType<typeof cloudSession>> {
  return { id: session.id, document: cloudSession(session, OWNER), pending };
}

describe('withCurrent', () => {
  const laptop = realSession(SESSION_A, 1_790_000_000_000);
  const phone = realSession(SESSION_B, 1_790_000_100_000, 'ThinkPhone');

  it("gives the current session's row its attempts as the timer has them now", () => {
    const attempts = [attemptWithClips(1, 10_000), testAttempt(2, 14_000)];
    const other = item(phone, 0);
    const rows = withCurrent([other, item(laptop, 1, true)], laptop, attempts);
    expect(rows.map((row) => [row.session.id, row.current, row.attempts])).toEqual([
      [SESSION_B, false, 0],
      [SESSION_A, true, 2],
    ]);
    expect(rows[1]).toMatchObject({ mean: '12.00', clips: 2, clipBytes: 5_300_000 });
    // The others stay as the store listed them.
    expect(rows[0]).toBe(other);
  });

  it('adds a session begun since the store was read, in its place, and moves the current mark', () => {
    const rows = withCurrent([item(laptop, 1, true)], phone, []);
    expect(rows.map((row) => [row.session.id, row.current, row.attempts])).toEqual([
      [SESSION_B, true, 0],
      [SESSION_A, false, 1],
    ]);
    expect(rows[0].mean).toBe('–');
  });

  it('keeps the rows as the store said without a current session', () => {
    const items = [item(phone, 2), item(laptop, 1, true)];
    expect(withCurrent(items, null, []).map((row) => row.current)).toEqual([false, false]);
  });
});

describe('mergeSessions', () => {
  const laptop = realSession(SESSION_A, 1_790_000_000_000);
  const phone = realSession(SESSION_B, 1_790_000_100_000, 'ThinkPhone');
  const later = realSession(SESSION_C, 1_790_000_200_000);

  it('merges by id, newest first: this device, cloud and both', () => {
    const rows = mergeSessions(
      [item(later, 3), item(laptop, 1)],
      [entry(phone), entry(laptop, true)],
      new Set(),
    );
    expect(rows.map((row) => [row.id, row.place])).toEqual([
      [SESSION_C, 'device'],
      [SESSION_B, 'cloud'],
      [SESSION_A, 'both'],
    ]);
    // The cloud's session is the record its document copies, without the owner.
    expect(rows[1].session).toEqual(phone);
    expect(rows[1].local).toBeNull();
    // This device's record and listing, with the document beside them.
    expect(rows[2].local?.attempts).toBe(1);
    expect(rows[2].cloud?.pending).toBe(true);
  });

  it('takes a session this page load wrote to the index as in both, though the listing came first', () => {
    const rows = mergeSessions([item(later, 3)], [], new Set([SESSION_C]));
    expect(rows.map((row) => row.place)).toEqual(['both']);
    expect(rows[0].cloud).toBeNull();
  });

  it('lists the host labels seen, each once', () => {
    const rows = mergeSessions(
      [item(later, 3), item(laptop, 1)],
      [entry(phone), entry(laptop)],
      new Set(),
    );
    expect(hostLabels(rows)).toEqual(['Linux laptop', 'ThinkPhone']);
  });
});
