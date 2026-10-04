import type { CloudAttempt } from '@cubetrace/core';

import { attemptDocument, attemptWithClips, clipOf, realSession } from '../cloud/cloud-testing';
import type { CloudEntry } from '../cloud/session-index';
import { SESSION_A, SESSION_B, testAttempt } from '../session/session-testing';
import { localDay, qaSummary } from './qa-summary';

const OWNER = 'ada-uid';
const DAY_MS = 86_400_000;

/** An attempt document whose scramble was shown at `shownMs`. */
function at(shownMs: number, document: CloudAttempt, pending = false): CloudEntry<CloudAttempt> {
  return {
    id: String(document.index).padStart(4, '0'),
    document: { ...document, events: { ...document.events, scrambleShown: shownMs } },
    pending,
  };
}

describe('qaSummary', () => {
  const laptop = realSession(SESSION_A, 1_790_000_000_000);
  const phone = realSession(SESSION_B, 1_790_000_100_000, 'ThinkPhone');
  /** Day 0 and day 1, as days of their own (the test's days are numbers of days). */
  const dayOf = (ms: number): string => `day ${String(Math.floor(ms / DAY_MS))}`;

  it('counts the attempts by day and device: clips, bytes recorded, uploaded and pending', () => {
    const summary = qaSummary(
      [
        // Day 0, the laptop: two attempts with their clips, the second's files uploaded.
        at(1_000, attemptDocument(attemptWithClips(1), laptop, OWNER)),
        at(2_000, attemptDocument(attemptWithClips(2), laptop, OWNER, 1_790_000_500_000)),
        // Day 0, the phone: one without a clip, waiting to be sent.
        at(
          3_000,
          attemptDocument(testAttempt(1, 9_000, { session: SESSION_B }), phone, OWNER),
          true,
        ),
        // Day 1, the laptop.
        at(DAY_MS + 1, attemptDocument(attemptWithClips(3), laptop, OWNER)),
      ],
      dayOf,
    );

    // attemptWithClips: 1.2 MB and 4.1 MB of clips; attemptDocument: attempt.json of 5 kB and frames
    // files of 2 kB each.
    expect(summary.rows).toEqual([
      {
        day: 'day 1',
        device: 'Linux laptop',
        attempts: 1,
        clips: 2,
        recordedBytes: 5_300_000,
        uploadedBytes: 0,
        pendingBytes: 5_309_000,
        unsent: 0,
        gyro: 0,
        gyroRateHz: null,
      },
      {
        day: 'day 0',
        device: 'Linux laptop',
        attempts: 2,
        clips: 4,
        recordedBytes: 10_600_000,
        uploadedBytes: 5_309_000,
        pendingBytes: 5_309_000,
        unsent: 0,
        gyro: 0,
        gyroRateHz: null,
      },
      {
        day: 'day 0',
        device: 'ThinkPhone',
        attempts: 1,
        clips: 0,
        recordedBytes: 0,
        uploadedBytes: 0,
        pendingBytes: 5_000,
        unsent: 1,
        gyro: 0,
        gyroRateHz: null,
      },
    ]);
    expect(summary.total).toEqual({
      attempts: 4,
      clips: 6,
      recordedBytes: 15_900_000,
      uploadedBytes: 5_309_000,
      pendingBytes: 10_623_000,
      unsent: 1,
      gyro: 0,
      gyroRateHz: null,
    });
  });

  it('counts the attempts with a gyro file and the median rate of those files (T3.7)', () => {
    const withRate = (index: number, rateHz: number): CloudAttempt => ({
      ...attemptDocument(attemptWithClips(index), laptop, OWNER),
      gyro: {
        file: 'gyro.json',
        samples: 1000,
        fromHostMs: 1_790_000_000_000,
        toHostMs: 1_790_000_020_000,
        rateHz,
        truncatedStart: false,
      },
    });
    const summary = qaSummary(
      [
        at(1_000, withRate(1, 49.8)),
        at(2_000, withRate(2, 50.4)),
        at(3_000, attemptDocument(attemptWithClips(3), laptop, OWNER)),
        at(DAY_MS + 1, withRate(4, 97.9)),
      ],
      dayOf,
    );
    expect(summary.rows.map((row) => [row.day, row.gyro, row.gyroRateHz])).toEqual([
      ['day 1', 1, 97.9],
      ['day 0', 2, 50.1],
    ]);
    expect(summary.total).toMatchObject({ attempts: 4, gyro: 3, gyroRateHz: 50.4 });
  });

  it("counts as pending the clips that the attempt's upload does not name yet", () => {
    // Created before its clips were attached: its upload names attempt.json alone.
    const document = {
      ...attemptDocument(attemptWithClips(1), laptop, OWNER),
      upload: {
        state: 'pending' as const,
        files: { 'attempt.json': { bytes: 5_000, doneMs: null } },
      },
    };
    const summary = qaSummary([at(1_000, document)], dayOf);
    expect(summary.total).toMatchObject({
      recordedBytes: 5_300_000,
      uploadedBytes: 0,
      pendingBytes: 5_305_000,
    });
    // Signed by the uploads, a clip counts at the size signed, uploaded once confirmed.
    const signed = {
      ...document,
      upload: {
        state: 'uploading' as const,
        files: {
          'attempt.json': { bytes: 5_000, doneMs: 1_790_000_500_000 },
          'laptop.solve.mp4': { bytes: 4_100_000, doneMs: null },
        },
      },
    };
    expect(qaSummary([at(1_000, signed)], dayOf).total).toMatchObject({
      uploadedBytes: 5_000,
      pendingBytes: 5_300_000,
    });
  });

  it('counts the clips by camera label: the host’s own and each phone’s (T4.2)', () => {
    const phoneClip = (segment: 'scramble' | 'solve', bytes: number) => ({
      ...clipOf(segment, bytes),
      camera: 'phone-rear',
      file: `phone-rear.${segment}.mp4`,
      framesFile: `phone-rear.${segment}.frames.json`,
    });
    // Attempt 1 with the phone's two clips beside the laptop's; attempt 2 without the phone's
    // scramble clip; attempt 3 from the laptop alone.
    const one = { ...attemptWithClips(1) };
    one.video = [...one.video, phoneClip('scramble', 700_000), phoneClip('solve', 2_000_000)];
    const two = { ...attemptWithClips(2) };
    two.video = [...two.video, phoneClip('solve', 1_800_000)];
    const summary = qaSummary(
      [
        at(1_000, attemptDocument(one, laptop, OWNER)),
        at(2_000, attemptDocument(two, laptop, OWNER)),
        at(3_000, attemptDocument(attemptWithClips(3), laptop, OWNER)),
      ],
      dayOf,
    );
    expect(summary.cameras).toEqual([
      { label: 'laptop', attempts: 3, clips: 6, recordedBytes: 15_900_000 },
      { label: 'phone-rear', attempts: 2, clips: 3, recordedBytes: 4_500_000 },
    ]);
    expect(summary.total).toMatchObject({ attempts: 3, clips: 9, recordedBytes: 20_400_000 });
  });

  it('says nothing without an attempt', () => {
    expect(qaSummary([])).toEqual({
      cameras: [],
      rows: [],
      total: {
        attempts: 0,
        clips: 0,
        recordedBytes: 0,
        uploadedBytes: 0,
        pendingBytes: 0,
        unsent: 0,
        gyro: 0,
        gyroRateHz: null,
      },
    });
  });

  it("writes a host time's day in this time zone", () => {
    const noon = new Date(2026, 9, 1, 12, 0, 0).getTime();
    expect(localDay(noon)).toBe('2026-10-01');
    expect(localDay(new Date(2026, 0, 9, 23, 59).getTime())).toBe('2026-01-09');
  });
});
