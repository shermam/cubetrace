import { describe, expect, it } from 'vitest';

import { QUEUE_STATE_SCHEMA, emptyState, parseQueueState, queueStateText } from './state';
import type { QueueStateFile } from './state';

const STATE: QueueStateFile = {
  schema: QUEUE_STATE_SCHEMA,
  accounts: {
    'ada-uid': {
      pausedUntilMs: 1_790_003_600_000,
      sessions: {
        '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f': {
          sessionJson: { hash: '0123456789abcdef', bytes: 718 },
          attempts: {
            '0001': {
              scrambleShown: 1_790_000_060_000,
              files: {
                'attempt.json': {
                  bytes: 3241,
                  hash: 'fedcba9876543210',
                  state: 'done',
                  tries: 1,
                  error: null,
                  doneMs: 1_790_000_100_000,
                },
                'laptop.solve.mp4': {
                  bytes: 2000,
                  state: 'done',
                  tries: 2,
                  error: null,
                  doneMs: 1_790_000_100_500,
                  local: false,
                },
                'laptop.solve.frames.json': {
                  bytes: 120,
                  state: 'failed',
                  tries: 1,
                  error: 'the bucket refused the upload: 403',
                  doneMs: null,
                },
                'session.json': {
                  bytes: 718,
                  hash: '0123456789abcdef',
                  state: 'pending',
                  tries: 0,
                  error: null,
                  doneMs: null,
                },
              },
            },
          },
        },
      },
    },
  },
};

describe('uploads.json', () => {
  it('reads back what it writes, the fields at their defaults left out', () => {
    const text = queueStateText(STATE);
    expect(parseQueueState(text)).toEqual(STATE);
    const pending = (JSON.parse(text) as typeof STATE).accounts['ada-uid'].sessions[
      '3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f'
    ].attempts['0001'].files['session.json'];
    expect(pending).toEqual({ bytes: 718, hash: '0123456789abcdef', state: 'pending' });
  });

  it('reads nothing, or anything not its own, as empty', () => {
    for (const text of [null, '', 'not json', '[]', '{"schema":2,"accounts":{}}', '{"schema":1}']) {
      expect(parseQueueState(text), String(text)).toEqual(emptyState());
    }
  });

  it('leaves out the entries that are not well formed, and keeps the others', () => {
    const json = JSON.parse(queueStateText(STATE)) as {
      accounts: Record<string, { sessions: Record<string, { attempts: Record<string, unknown> }> }>;
    };
    const attempts = json.accounts['ada-uid'].sessions['3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f']
      .attempts as Record<string, { scrambleShown?: number; files: Record<string, unknown> }>;
    attempts['0001'].files['laptop.solve.mp4'] = { bytes: -1, state: 'done' };
    attempts['0001'].files['laptop.solve.frames.json'] = { bytes: 120, state: 'sent' };
    attempts['abc'] = { scrambleShown: 1, files: {} };
    attempts['0002'] = { files: {} };
    json.accounts['bob-uid'] = 'nobody' as never;
    const read = parseQueueState(JSON.stringify(json));
    expect(Object.keys(read.accounts)).toEqual(['ada-uid']);
    const session = read.accounts['ada-uid'].sessions['3f1c9a2e-5b7d-4c1e-9f3a-2b8d6e4c1a7f'];
    expect(Object.keys(session.attempts)).toEqual(['0001']);
    expect(Object.keys(session.attempts['0001'].files)).toEqual(['attempt.json', 'session.json']);
  });
});
