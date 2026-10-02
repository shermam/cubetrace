import { recordJson } from '@cubetrace/storage';
import { describe, expect, it } from 'vitest';

import { CloudError } from './api';
import { RETRY_MAX_MS } from './backoff';
import { datasetAttempt } from './files';
import { QUOTA_PAUSE_MIN_MS, SESSION_QUIET_MS, URL_LIFETIME_MS } from './queue';
import { parseQueueState } from './state';
import { FakeUploadHttp } from './testing';
import {
  A,
  attempt,
  B,
  clip,
  DEMO,
  device,
  fileText,
  flush,
  FRAMES_BYTES,
  GYRO,
  GYRO_BYTES,
  KEEP,
  queueOf,
  record,
  session,
  type Device,
  UID,
} from './test-device';

/** The bucket's key of `path` of attempt `index` of session `s`. */
function key(s: string, path: string, index = 1): string {
  return path === 'session.json'
    ? `users/${UID}/sessions/${s}/session.json`
    : `users/${UID}/sessions/${s}/attempts/${String(index).padStart(4, '0')}/${path}`;
}

/** The PUTs made, by key and status (null while held). */
function puts(d: Device): string[] {
  return d.http.puts.map(
    (put) => `${put.key.split('/').slice(-2).join('/')} ${String(put.status)}`,
  );
}

/** The PUTs of the file named `name`, by key and status. */
function putsOf(d: Device, name: string): string[] {
  return puts(d).filter((put) => put.split(' ')[0].endsWith(`/${name}`));
}

/** The names of the files PUT, sorted. */
function putNames(d: Device): string[] {
  return d.http.puts.map((put) => put.key.split('/').at(-1) ?? '').sort();
}

/** uploads.json as the device has it now, for the account. */
function stateOf(d: Device): ReturnType<typeof parseQueueState>['accounts'][string] | undefined {
  return parseQueueState(d.root.files().get('uploads.json')?.text ?? null).accounts[UID];
}

/** Session A with one attempt and its solve clip of `bytes`. */
async function oneAttempt(d: Device, bytes = 2000): Promise<void> {
  await record(d, session(A, 1_790_000_000_000), [attempt(A, 1, [clip('solve', bytes)])]);
}

describe('UploadQueue', () => {
  it("uploads each attempt's attempt.json, clips and frames files, and session.json with the newest of its session, the oldest session first", async () => {
    const d = device();
    const older = session(B, 1_789_000_000_000);
    const newer = session(A, 1_790_000_000_000);
    const b1 = attempt(B, 1, [clip('scramble', 1000), clip('solve', 3000)]);
    const a1 = attempt(A, 1);
    const a2 = attempt(A, 2, [clip('solve', 2000)]);
    await record(d, newer, [a1, a2]);
    await record(d, older, [b1]);
    const queue = queueOf(d);
    await queue.start();
    await flush();

    expect(d.cloud.calls.filter((call) => call.startsWith('sign'))).toEqual([
      `sign ${B}/1 attempt.json,laptop.scramble.mp4,laptop.scramble.frames.json,laptop.solve.mp4,laptop.solve.frames.json,session.json`,
      `sign ${A}/1 attempt.json`,
      `sign ${A}/2 attempt.json,laptop.solve.mp4,laptop.solve.frames.json,session.json`,
    ]);
    const keys = [...d.bucket.objects.keys()];
    expect(keys).toHaveLength(6 + 1 + 4);
    expect(d.bucket.objects.get(key(B, 'attempt.json'))?.text).toBe(recordJson(datasetAttempt(b1)));
    expect(d.bucket.objects.get(key(B, 'laptop.solve.mp4'))).toMatchObject({
      bytes: 3000,
      contentType: 'video/mp4',
    });
    expect(d.bucket.objects.get(key(B, 'laptop.solve.frames.json'))).toMatchObject({
      bytes: FRAMES_BYTES,
      contentType: 'application/json',
    });
    const stored = await d.store.exportSession(A);
    expect(d.bucket.objects.get(key(A, 'session.json'))?.text).toBe(recordJson(stored.session));
    expect(d.cloud.uploads.get(`${A}/2`)?.state).toBe('done');
    expect(d.cloud.uploads.get(`${B}/1`)?.state).toBe('done');

    const view = queue.view();
    expect(view.counts).toEqual({ waiting: 0, pending: 0, uploading: 0, done: 3, failed: 0 });
    expect(view.active).toEqual([]);
    expect(view.bytesLeft).toBe(0);
    expect(view.recent.map((a) => `${a.sessionId}/${String(a.index)}`)).toEqual([
      `${A}/2`,
      `${A}/1`,
      `${B}/1`,
    ]);

    // uploads.json says so, once written.
    d.env.advance(1000);
    await flush();
    const state = parseQueueState(d.root.files().get('uploads.json')?.text ?? null);
    const account = state.accounts[UID];
    expect(account.sessions[A].attempts['0002'].files['laptop.solve.mp4']).toMatchObject({
      bytes: 2000,
      state: 'done',
      tries: 1,
    });
    expect(account.sessions[A].sessionJson?.bytes).toBe(recordJson(stored.session).length);
    await queue.stop();
  });

  it('sends two files at a time', async () => {
    const d = device();
    await record(d, session(A, 1_790_000_000_000), [
      attempt(A, 1, [clip('scramble', 1000), clip('solve', 2000)]),
      attempt(A, 2, [clip('scramble', 1000), clip('solve', 2000)]),
    ]);
    d.http.hold = true;
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(d.http.held).toBe(2);
    expect(queue.view().counts.uploading).toBe(1);
    const [first] = queue.view().active;
    expect(
      first.files.filter((file) => file.state === 'uploading').map((file) => file.sent),
    ).toEqual([expect.any(Number), expect.any(Number)]);
    for (let k = 0; k < 12 && d.http.held > 0; k++) {
      d.http.hold = true;
      d.http.release();
      d.http.hold = true;
      await flush();
      expect(d.http.inFlight).toBeLessThanOrEqual(2);
    }
    d.http.release();
    await flush();
    expect(d.http.maxInFlight).toBe(2);
    expect(d.bucket.objects.size).toBe(11);
    expect(queue.view().counts.done).toBe(2);
    await queue.stop();
  });

  it('tries a network error and a server error again after 1 s, then 2 s, 4 s, …, up to 5 min, with jitter', async () => {
    const d = device();
    await record(d, session(A, 1_790_000_000_000), [attempt(A, 1)]);
    d.env.jitter = 0.5;
    d.http.responses.push(
      { status: 0, path: 'attempt.json' },
      { status: 503, body: 'Service Unavailable', path: 'attempt.json' },
    );
    const queue = queueOf(d);
    await queue.start();
    await flush();
    // session.json went beside it, in the other slot.
    expect(putsOf(d, 'attempt.json')).toEqual(['0001/attempt.json 0']);
    expect(putsOf(d, 'session.json')).toEqual([`${A}/session.json 200`]);
    const [waiting] = queue.view().active;
    expect(waiting.state).toBe('pending');
    expect(waiting.files[0]).toMatchObject({
      state: 'pending',
      tries: 1,
      error: 'the upload did not reach the bucket (network error)',
      retryAtMs: d.env.now() + 750,
    });
    // The first retry after 1 s, less a quarter at this jitter.
    d.env.advance(749);
    await flush();
    expect(putsOf(d, 'attempt.json')).toHaveLength(1);
    d.env.advance(1);
    await flush();
    expect(putsOf(d, 'attempt.json')).toEqual(['0001/attempt.json 0', '0001/attempt.json 503']);
    expect(queue.view().active[0].files[0]).toMatchObject({
      tries: 2,
      error: 'the bucket answered 503: Service Unavailable',
      retryAtMs: d.env.now() + 1500,
    });
    d.env.advance(1500);
    await flush();
    expect(putsOf(d, 'attempt.json').at(-1)).toBe('0001/attempt.json 200');
    expect(queue.view().counts.done).toBe(1);
    // The same URL was used again: it was still good.
    expect(d.cloud.calls.filter((call) => call.startsWith('sign'))).toHaveLength(1);
    await queue.stop();
  });

  it('waits up to 5 min between tries, however many failed', async () => {
    const d = device();
    await record(d, session(A, 1_790_000_000_000), [attempt(A, 1)]);
    d.env.jitter = 0;
    for (let k = 0; k < 12; k++) {
      d.http.responses.push({ status: 0, path: 'attempt.json' });
    }
    const queue = queueOf(d);
    await queue.start();
    await flush();
    const waits: number[] = [];
    for (let k = 0; k < 11; k++) {
      const retryAt = queue.view().active[0].files[0].retryAtMs ?? 0;
      waits.push(retryAt - d.env.now());
      d.env.advance(retryAt - d.env.now());
      await flush();
    }
    expect(waits).toEqual([
      1000,
      2000,
      4000,
      8000,
      16_000,
      32_000,
      64_000,
      128_000,
      256_000,
      RETRY_MAX_MS,
      RETRY_MAX_MS,
    ]);
    await queue.stop();
  });

  it('tries a 408 and a 429 again, as a 5xx', async () => {
    const d = device();
    await record(d, session(A, 1_790_000_000_000), [attempt(A, 1)]);
    d.env.jitter = 0;
    d.http.responses.push(
      { status: 429, body: 'SlowDown', path: 'attempt.json' },
      { status: 408, path: 'attempt.json' },
    );
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(queue.view().active[0]).toMatchObject({
      state: 'pending',
      error: 'the bucket answered 429: SlowDown',
    });
    d.env.advance(1000);
    await flush();
    d.env.advance(2000);
    await flush();
    expect(putsOf(d, 'attempt.json')).toEqual([
      '0001/attempt.json 429',
      '0001/attempt.json 408',
      '0001/attempt.json 200',
    ]);
    expect(queue.view().counts.done).toBe(1);
    await queue.stop();
  });

  it('does not wake again and again for a file whose time to try again came while the network was down', async () => {
    const d = device();
    await oneAttempt(d);
    d.env.jitter = 0;
    d.http.responses.push({ status: 0, path: 'attempt.json' });
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(queue.view().active[0].files[0]).toMatchObject({ path: 'attempt.json', tries: 1 });
    d.env.setNetwork({ online: false });
    await flush();
    // Its time comes and goes while offline: one wake, which finds the network down, then none
    // (a timer due at once, again and again, would never let this advance end).
    d.env.advance(5000);
    await flush();
    expect(putsOf(d, 'attempt.json')).toEqual(['0001/attempt.json 0']);
    expect(d.env.pendingTimers).toBeLessThanOrEqual(2);
    d.env.setNetwork({ online: true });
    await flush();
    expect(putsOf(d, 'attempt.json')).toEqual(['0001/attempt.json 0', '0001/attempt.json 200']);
    expect(queue.view().counts.done).toBe(1);
    await queue.stop();
  });

  it('does not try a refused upload (4xx) again: the file fails until Retry', async () => {
    const d = device();
    await record(d, session(A, 1_790_000_000_000), [attempt(A, 1)]);
    d.http.responses.push({
      status: 403,
      body: '<Error><Code>AccessDenied</Code></Error>',
      path: 'attempt.json',
    });
    const queue = queueOf(d);
    await queue.start();
    await flush();
    const [failed] = queue.view().active;
    expect(failed.state).toBe('failed');
    expect(failed.error).toBe(
      'the bucket refused the upload: 403: <Error><Code>AccessDenied</Code></Error>',
    );
    expect(queue.view().counts.failed).toBe(1);
    d.env.advance(RETRY_MAX_MS * 3);
    await flush();
    expect(putsOf(d, 'attempt.json')).toEqual(['0001/attempt.json 403']);

    queue.retry(A, 1);
    await flush();
    expect(putsOf(d, 'attempt.json')).toEqual(['0001/attempt.json 403', '0001/attempt.json 200']);
    expect(putsOf(d, 'session.json')).toEqual([`${A}/session.json 200`]);
    expect(queue.view().counts).toMatchObject({ failed: 0, done: 1 });
    await queue.stop();
  });

  it('tries again later a file that signUpload left out of its answer', async () => {
    const d = device();
    await oneAttempt(d);
    d.env.jitter = 0;
    d.cloud.omitOnce = 'laptop.solve.frames.json';
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(
      queue.view().active[0].files.find((f) => f.path === 'laptop.solve.frames.json'),
    ).toMatchObject({
      state: 'pending',
      error: 'signUpload did not sign it',
      retryAtMs: d.env.now() + 1000,
    });
    expect(d.cloud.calls.filter((call) => call.startsWith('sign'))).toHaveLength(1);
    d.env.advance(1000);
    await flush();
    expect(d.cloud.calls.filter((call) => call.startsWith('sign')).at(-1)).toBe(
      `sign ${A}/1 laptop.solve.frames.json`,
    );
    expect(queue.view().counts.done).toBe(1);
    await queue.stop();
  });

  it('does nothing more once stopped: the operations still queued are dropped', async () => {
    const d = device({ lock: true });
    await oneAttempt(d);
    const holder = queueOf(d);
    d.http.hold = true;
    await holder.start();
    await flush();
    // A second tab waits for the lock; the app tells it of an attempt, then it is stopped.
    const waiting = queueOf(d);
    void waiting.start();
    await flush();
    expect(waiting.status).toBe('waiting');
    const calls = d.cloud.calls.length;
    waiting.attemptSaved(attempt(B, 1));
    waiting.rescan();
    await waiting.stop();
    await holder.stop();
    await flush();
    expect(d.cloud.calls.slice(calls)).toEqual([]);
    expect(waiting.status).toBe('stopped');
  });

  it('signs a URL that expired again, once', async () => {
    const d = device();
    await record(d, session(A, 1_790_000_000_000), [attempt(A, 1)]);
    d.http.responses.push({
      status: 400,
      body: '<Error><Code>ExpiredToken</Code><Message>Request has expired</Message></Error>',
      path: 'attempt.json',
    });
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(d.cloud.calls.filter((call) => call.startsWith('sign'))).toEqual([
      `sign ${A}/1 attempt.json,session.json`,
      `sign ${A}/1 attempt.json`,
    ]);
    expect(queue.view().counts.done).toBe(1);

    // A second expiry in a row is the URL's problem, not the clock's: the file fails.
    const e = device();
    await record(e, session(A, 1_790_000_000_000), [attempt(A, 1)]);
    const expired = { status: 403, body: 'Request has expired', path: 'attempt.json' };
    e.http.responses.push(expired, expired);
    const again = queueOf(e);
    await again.start();
    await flush();
    expect(again.view().active[0]).toMatchObject({ state: 'failed' });
    expect(e.cloud.calls.filter((call) => call.startsWith('sign'))).toHaveLength(2);
    await queue.stop();
    await again.stop();
  });

  it('signs again a file whose URL is no longer good when its turn comes', async () => {
    const d = device();
    await record(d, session(A, 1_790_000_000_000), [
      attempt(A, 1, [clip('scramble', 1000), clip('solve', 2000)]),
    ]);
    d.http.hold = true;
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(d.http.held).toBe(2);
    // The network goes: the two PUTs are cut off; it comes back 20 minutes later.
    d.env.setNetwork({ online: false });
    await flush();
    expect(queue.view().pause).toEqual({ reason: 'offline' });
    d.env.advance(URL_LIFETIME_MS + 5 * 60 * 1000);
    d.http.hold = false;
    d.env.setNetwork({ online: true });
    await flush();
    const signs = d.cloud.calls.filter((call) => call.startsWith('sign'));
    expect(signs).toEqual([
      `sign ${A}/1 attempt.json,laptop.scramble.mp4,laptop.scramble.frames.json,laptop.solve.mp4,laptop.solve.frames.json,session.json`,
      `sign ${A}/1 attempt.json,laptop.scramble.mp4,laptop.scramble.frames.json,laptop.solve.mp4,laptop.solve.frames.json,session.json`,
    ]);
    expect(d.http.puts.every((put) => put.status !== 400)).toBe(true);
    expect(queue.view().counts.done).toBe(1);
    await queue.stop();
  });

  it("pauses until the day's quota resets, and says so, across a reload", async () => {
    const d = device();
    await oneAttempt(d);
    const resetsAtMs = d.env.now() + 3_600_000;
    // Four files to sign (attempt.json, the clip, its frames, session.json): 401 do not fit in 400.
    d.cloud.quota = { bytes: 0, files: 397, maxBytes: 2_000_000_000, maxFiles: 400, resetsAtMs };
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(d.http.puts).toEqual([]);
    expect(queue.view().pause).toEqual({ reason: 'quota', untilMs: resetsAtMs });
    expect(queue.view().active[0].state).toBe('pending');
    d.env.advance(1000);
    await flush();
    expect(stateOf(d)?.pausedUntilMs).toBe(resetsAtMs);
    await queue.stop();

    // A reload during the pause signs nothing either.
    const reloaded = queueOf(d);
    const signs = d.cloud.calls.length;
    await reloaded.start();
    await flush();
    expect(reloaded.view().pause).toEqual({ reason: 'quota', untilMs: resetsAtMs });
    expect(d.cloud.calls.slice(signs).filter((call) => call.startsWith('sign'))).toEqual([]);

    // The day resets.
    d.cloud.quota = { bytes: 0, files: 0, maxBytes: 2_000_000_000, maxFiles: 400, resetsAtMs: 0 };
    d.env.advance(3_600_000);
    await flush();
    expect(reloaded.view().pause).toBeNull();
    expect(reloaded.view().counts.done).toBe(1);
    expect(d.bucket.objects.size).toBe(4);
    await reloaded.stop();
    expect(stateOf(d)?.pausedUntilMs).toBeNull();
  });

  it("pauses a minute at least when the quota's reset time has passed by this device's clock", async () => {
    const d = device();
    await oneAttempt(d);
    // A device whose clock runs ahead of the server's: the server's day has not reset yet.
    d.cloud.quota = {
      bytes: 0,
      files: 400,
      maxBytes: 2_000_000_000,
      maxFiles: 400,
      resetsAtMs: d.env.now() - 5000,
    };
    const queue = queueOf(d);
    await queue.start();
    await flush();
    const signs = (): number => d.cloud.calls.filter((call) => call.startsWith('sign')).length;
    expect(signs()).toBe(1);
    expect(queue.view().pause).toEqual({
      reason: 'quota',
      untilMs: d.env.now() + QUOTA_PAUSE_MIN_MS,
    });
    d.env.advance(QUOTA_PAUSE_MIN_MS - 1);
    await flush();
    expect(signs()).toBe(1);
    d.cloud.quota.files = 0;
    d.env.advance(1);
    await flush();
    expect(signs()).toBe(2);
    expect(queue.view().pause).toBeNull();
    expect(queue.view().counts.done).toBe(1);
    await queue.stop();
  });

  it('after a reload, a file that may be in the bucket is confirmed, again after a failed confirmation, and not sent again', async () => {
    const d = device();
    await oneAttempt(d);
    d.http.hold = true;
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(d.http.held).toBe(2);
    d.env.advance(1000);
    await flush();
    expect(stateOf(d)?.sessions[A].attempts['0001'].files['attempt.json'].state).toBe('uploading');
    // The page goes away (its queue with it), after the two PUTs reached the bucket.
    for (const put of d.http.puts) {
      d.bucket.objects.set(put.key, { bytes: put.bytes, contentType: '', text: '' });
    }
    const next = { ...d, http: new FakeUploadHttp(d.bucket, () => d.env.now()) };
    d.env.jitter = 0;
    d.cloud.confirmError = {
      error: new CloudError('unavailable', 'The service is unavailable.'),
      once: true,
      path: 'attempt.json',
    };
    const reloaded = queueOf(next);
    await reloaded.start();
    await flush();
    expect(reloaded.view().active[0].files[0]).toMatchObject({
      path: 'attempt.json',
      state: 'pending',
      error: 'confirmUpload: The service is unavailable.',
    });
    d.env.advance(1000);
    await flush();
    expect(reloaded.view().counts.done).toBe(1);
    // Of the two, only their confirmations: the clip's frames file and session.json are sent.
    expect(putNames(next)).toEqual(['laptop.solve.frames.json', 'session.json']);
    await reloaded.stop();
  });

  it('resumes after a reload from uploads.json: what is done stays done, a file being sent is confirmed first', async () => {
    const d = device();
    await record(d, session(A, 1_790_000_000_000), [
      attempt(A, 1, [clip('scramble', 1000), clip('solve', 2000)]),
    ]);
    const queue = queueOf(d);
    // The first two files go; the next two are being sent when the page goes away.
    d.http.hold = true;
    await queue.start();
    await flush();
    d.http.release();
    d.http.hold = true;
    await flush();
    expect(d.http.held).toBe(2);
    d.env.advance(1000);
    await flush();
    const before = stateOf(d)?.sessions[A].attempts['0001'].files;
    expect(
      Object.fromEntries(Object.entries(before ?? {}).map(([path, f]) => [path, f.state])),
    ).toEqual({
      'attempt.json': 'done',
      'laptop.scramble.mp4': 'done',
      'laptop.scramble.frames.json': 'uploading',
      'laptop.solve.mp4': 'uploading',
      'laptop.solve.frames.json': 'pending',
      'session.json': 'pending',
    });
    // One of the two reached the bucket before the page went; the other did not.
    d.bucket.objects.set(key(A, 'laptop.scramble.frames.json'), {
      bytes: FRAMES_BYTES,
      contentType: 'application/json',
      text: 'f'.repeat(FRAMES_BYTES),
    });

    // The next page load: a new queue on the same device; the old page's queue is gone.
    const next = { ...d, http: new FakeUploadHttp(d.bucket, () => d.env.now()) };
    const reloaded = queueOf(next);
    const calls = d.cloud.calls.length;
    await reloaded.start();
    await flush();
    // The index is asked first (the attempt is not all done in uploads.json): it has nothing
    // confirmed of what remains, so the two files being sent are confirmed first.
    expect(d.cloud.calls.slice(calls)).toEqual([
      `uploads ${A}`,
      `confirm ${A}/1 laptop.scramble.frames.json`,
      `confirm ${A}/1 laptop.solve.mp4`,
      `sign ${A}/1 laptop.solve.mp4,laptop.solve.frames.json,session.json`,
      `confirm ${A}/1 laptop.solve.mp4`,
      expect.stringMatching(/^confirm /),
      expect.stringMatching(/^confirm /),
    ]);
    expect(putNames(next)).toEqual([
      'laptop.solve.frames.json',
      'laptop.solve.mp4',
      'session.json',
    ]);
    expect(reloaded.view().counts.done).toBe(1);
    await reloaded.stop();
  });

  it('after a reload that came before uploads.json was written, sends nothing the index says the bucket has', async () => {
    const d = device();
    await oneAttempt(d);
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(queue.view().counts.done).toBe(1);
    // The page went before its last changes reached uploads.json: there, the frames file and
    // session.json are still pending, and the clip being sent.
    await queue.flush();
    const state = JSON.parse(fileText(d, 'uploads.json') ?? '{}') as {
      accounts: Record<
        string,
        { sessions: Record<string, { sessionJson: unknown; attempts: Record<string, unknown> }> }
      >;
    };
    const session = state.accounts[UID].sessions[A];
    session.sessionJson = null;
    const files = (session.attempts['0001'] as { files: Record<string, { state: string }> }).files;
    files['laptop.solve.frames.json'].state = 'pending';
    files['laptop.solve.mp4'].state = 'uploading';
    files['session.json'].state = 'pending';
    await d.root.plant('uploads.json', JSON.stringify(state));

    const next = { ...d, http: new FakeUploadHttp(d.bucket, () => d.env.now()) };
    const calls = d.cloud.calls.length;
    const reloaded = queueOf(next);
    await reloaded.start();
    await flush();
    expect(d.cloud.calls.slice(calls)).toEqual([`uploads ${A}`]);
    expect(next.http.puts).toEqual([]);
    expect(reloaded.view().counts).toMatchObject({ done: 1, pending: 0, uploading: 0 });
    // Written again, it says so.
    await reloaded.flush();
    expect(stateOf(d)?.sessions[A].sessionJson).not.toBeNull();
    await reloaded.stop();
  });

  it('writes uploads.json at once when asked (the page going away), else soon after a change', async () => {
    const d = device();
    await oneAttempt(d);
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(fileText(d, 'uploads.json')).toBeNull();
    await queue.flush();
    expect(stateOf(d)?.sessions[A].attempts['0001'].files['attempt.json'].state).toBe('done');
    await queue.stop();
  });

  it('takes as done what the index says the bucket has, when uploads.json does not know it', async () => {
    const d = device();
    const a1 = attempt(A, 1, [clip('solve', 2000)]);
    await oneAttempt(d);
    // Uploaded before (another page, uploads.json lost): the index has the files with their sizes.
    d.cloud.uploads.set(`${A}/1`, {
      state: 'done',
      files: {
        'attempt.json': { bytes: recordJson(datasetAttempt(a1)).length, doneMs: 1_789_999_000_000 },
        'laptop.solve.mp4': { bytes: 2000, doneMs: 1_789_999_000_000 },
        'laptop.solve.frames.json': { bytes: FRAMES_BYTES + 1, doneMs: 1_789_999_000_000 },
      },
    });
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(d.cloud.calls[0]).toBe(`uploads ${A}`);
    // The frames file of another size is sent; so is session.json, which the index does not say.
    expect(putNames(d)).toEqual(['laptop.solve.frames.json', 'session.json']);
    expect(queue.view().counts.done).toBe(1);
    await queue.stop();
  });

  it('never uploads a demo session', async () => {
    const d = device();
    await record(d, session(DEMO, 1_790_000_000_000, true), [
      attempt(DEMO, 1, [clip('solve', 2000)]),
    ]);
    const queue = queueOf(d);
    await queue.start();
    queue.attemptSaved(attempt(DEMO, 2));
    await flush();
    expect(d.cloud.calls).toEqual([]);
    expect(d.http.puts).toEqual([]);
    expect(queue.view().counts).toEqual({
      waiting: 0,
      pending: 0,
      uploading: 0,
      done: 0,
      failed: 0,
    });
    await queue.stop();
    expect(stateOf(d)?.sessions).toEqual({});
  });

  it("waits for an attempt's clips: its record is final once the recording has saved them", async () => {
    const d = device();
    await oneAttempt(d);
    d.awaiting.add(`${A}/1`);
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(d.http.puts).toEqual([]);
    expect(queue.view().active[0].state).toBe('waiting');
    expect(queue.view().counts.waiting).toBe(1);
    d.awaiting.delete(`${A}/1`);
    queue.refresh();
    await flush();
    expect(queue.view().counts.done).toBe(1);
    await queue.stop();
  });

  it('follows the records the app saves: a new attempt, a clip added later, an attempt begun again with the same index, a deletion', async () => {
    const d = device();
    const s = session(A, 1_790_000_000_000);
    await record(d, s, [attempt(A, 1)]);
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(queue.view().counts.done).toBe(1);

    // A new attempt, and its session's summary: the session.json changed waits until the session has
    // stayed the same for two minutes.
    const a2 = attempt(A, 2, [clip('solve', 2000)]);
    await record(d, s, [attempt(A, 1), a2]);
    queue.attemptSaved(a2);
    const summed = (await d.store.exportSession(A)).session;
    queue.sessionSaved(summed);
    await flush();
    const signs = (): string[] => d.cloud.calls.filter((call) => call.startsWith('sign'));
    expect(signs().at(-1)).toBe(
      `sign ${A}/2 attempt.json,laptop.solve.mp4,laptop.solve.frames.json`,
    );
    expect(queue.view().counts.done).toBe(2);
    d.env.advance(SESSION_QUIET_MS - 1);
    await flush();
    expect(signs().at(-1)).toBe(
      `sign ${A}/2 attempt.json,laptop.solve.mp4,laptop.solve.frames.json`,
    );
    d.env.advance(1);
    await flush();
    expect(signs().at(-1)).toBe(`sign ${A}/2 session.json`);
    expect(d.bucket.objects.get(key(A, 'session.json'))?.text).toBe(recordJson(summed));
    expect(queue.view().counts.done).toBe(2);

    // A clip added to it after its upload: its attempt.json and the clip's files go.
    const withScramble = { ...a2, video: [clip('scramble', 1500), ...a2.video] };
    await record(d, s, [attempt(A, 1), withScramble]);
    queue.attemptSaved(withScramble);
    await flush();
    expect(d.cloud.calls.filter((call) => call.startsWith('sign')).at(-1)).toBe(
      `sign ${A}/2 attempt.json,laptop.scramble.mp4,laptop.scramble.frames.json`,
    );
    expect(d.bucket.objects.get(key(A, 'attempt.json', 2))?.text).toBe(
      recordJson(datasetAttempt(withScramble)),
    );

    // Delete last, and attempt 2 begun again: another attempt, uploaded afresh.
    await d.store.deleteAttempt(A, 2);
    queue.attemptDeleted(A, 2);
    await flush();
    expect(queue.attemptView(A, 2)).toBeNull();
    const again = attempt(A, 2, [], 1_790_000_900_000);
    await d.store.saveAttempt(again);
    queue.attemptSaved(again);
    await flush();
    expect(d.cloud.calls.filter((call) => call.startsWith('sign')).at(-1)).toBe(
      `sign ${A}/2 attempt.json`,
    );
    expect(d.bucket.objects.get(key(A, 'attempt.json', 2))?.text).toBe(
      recordJson(datasetAttempt(again)),
    );

    // The session deleted from the device: it leaves uploads.json.
    await d.store.deleteSession(A);
    queue.sessionDeleted(A);
    await flush();
    await queue.stop();
    expect(stateOf(d)?.sessions).toEqual({});
  });

  it('waits for the index: an attempt it has not received yet is tried again', async () => {
    const d = device();
    await oneAttempt(d);
    d.cloud.indexAll = false;
    d.env.jitter = 0;
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(queue.view().active[0].error).toMatch(/^not in the cloud index yet: /);
    expect(d.http.puts).toEqual([]);
    expect(d.cloud.waits).toBe(1);
    d.cloud.indexed.add(`${A}/1`);
    d.env.advance(1000);
    await flush();
    expect(queue.view().counts.done).toBe(1);
    await queue.stop();
  });

  it("fails the files of a request the functions refuse, and tries a function's transient failure again", async () => {
    const d = device();
    await oneAttempt(d);
    d.env.jitter = 0;
    d.cloud.signError = {
      error: new CloudError('unavailable', 'The service is unavailable.'),
      once: true,
    };
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(queue.view().active[0]).toMatchObject({
      state: 'pending',
      error: 'signUpload: The service is unavailable.',
    });
    d.cloud.signError = {
      error: new CloudError('permission-denied', "Session 3f1c… is another account's."),
      once: true,
    };
    d.env.advance(1000);
    await flush();
    expect(queue.view().active[0]).toMatchObject({
      state: 'failed',
      error: "signUpload: Session 3f1c… is another account's.",
    });
    queue.retry();
    await flush();
    expect(queue.view().counts.done).toBe(1);

    // A confirmation that fails on the server is asked again, without sending the file again.
    const e = device();
    await oneAttempt(e);
    e.env.jitter = 0;
    e.cloud.confirmError = {
      error: new CloudError('internal', 'confirmUpload failed.'),
      once: true,
      path: 'attempt.json',
    };
    const again = queueOf(e);
    await again.start();
    await flush();
    expect(again.view().active[0]).toMatchObject({
      state: 'pending',
      error: 'confirmUpload: confirmUpload failed.',
    });
    e.env.advance(1000);
    await flush();
    expect(putNames(e)).toEqual([
      'attempt.json',
      'laptop.solve.frames.json',
      'laptop.solve.mp4',
      'session.json',
    ]);
    expect(e.cloud.calls.filter((call) => call === `confirm ${A}/1 attempt.json`)).toHaveLength(2);
    expect(again.view().counts.done).toBe(1);
    await queue.stop();
    await again.stop();
  });

  it('sends session.json again, with the newest attempt, when it changed after its attempts were uploaded', async () => {
    const d = device();
    const s = session(A, 1_790_000_000_000);
    await record(d, s, [attempt(A, 1), attempt(A, 2)]);
    const queue = queueOf(d);
    await queue.start();
    await flush();
    const noted = { ...(await d.store.exportSession(A)).session, notes: 'cloud: a note' };
    await d.store.saveSession(noted);
    queue.sessionSaved(noted);
    await flush();
    d.env.advance(SESSION_QUIET_MS);
    await flush();
    expect(d.cloud.calls.filter((call) => call.startsWith('sign')).at(-1)).toBe(
      `sign ${A}/2 session.json`,
    );
    expect(d.bucket.objects.get(key(A, 'session.json'))?.text).toBe(recordJson(noted));
    // The same session.json again: nothing to send.
    const signs = d.cloud.calls.length;
    queue.sessionSaved(noted);
    await flush();
    expect(d.cloud.calls.length).toBe(signs);
    await queue.stop();
  });

  it('with Wi-Fi only, waits off Wi-Fi, cuts off what was being sent, and goes on Wi-Fi', async () => {
    const d = device();
    await oneAttempt(d, 5000);
    d.env.connection = { online: true, type: 'cellular', effectiveType: '4g' };
    const queue = queueOf(d, { wifiOnly: true, keepLocalCopies: true });
    await queue.start();
    await flush();
    expect(queue.view().pause).toEqual({ reason: 'not-wifi' });
    expect(d.cloud.calls).toEqual([`uploads ${A}`]);
    d.http.hold = true;
    d.env.setNetwork({ online: true, type: 'wifi', effectiveType: '4g' });
    await flush();
    expect(queue.view().pause).toBeNull();
    expect(d.http.held).toBe(2);
    // Off Wi-Fi again in the middle: cut off, and pending, not failed.
    d.env.setNetwork({ online: true, type: 'cellular', effectiveType: '4g' });
    await flush();
    expect(d.http.held).toBe(0);
    expect(queue.view().active[0].files.map((file) => file.state)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(queue.view().active[0].error).toBeNull();
    // "Wi-Fi only" off: mobile data is fine.
    d.http.hold = false;
    queue.setPolicy(KEEP);
    await flush();
    expect(queue.view().counts.done).toBe(1);
    await queue.stop();
  });

  it("uploads an attempt's gyro file as its sixth file, after the clips, and keeps it on the device with the frames files when the clips go (T3.7)", async () => {
    const d = device();
    const a1 = { ...attempt(A, 1, [clip('scramble', 1000), clip('solve', 2000)]), gyro: GYRO };
    await record(d, session(A, 1_790_000_000_000), [a1]);
    const queue = queueOf(d, { wifiOnly: false, keepLocalCopies: false });
    await queue.start();
    await flush();
    expect(d.cloud.calls.filter((call) => call.startsWith('sign'))).toEqual([
      `sign ${A}/1 attempt.json,laptop.scramble.mp4,laptop.scramble.frames.json,laptop.solve.mp4,laptop.solve.frames.json,gyro.json,session.json`,
    ]);
    expect(d.bucket.objects.get(key(A, 'gyro.json'))).toMatchObject({
      bytes: GYRO_BYTES,
      contentType: 'application/json',
    });
    expect(d.cloud.uploads.get(`${A}/1`)?.state).toBe('done');
    expect(Object.keys(d.cloud.uploads.get(`${A}/1`)?.files ?? {}).sort()).toEqual([
      'attempt.json',
      'gyro.json',
      'laptop.scramble.frames.json',
      'laptop.scramble.mp4',
      'laptop.solve.frames.json',
      'laptop.solve.mp4',
      'session.json',
    ]);
    // The uploaded attempt.json names the gyro file, as the device's does.
    expect(d.bucket.objects.get(key(A, 'attempt.json'))?.text).toBe(recordJson(datasetAttempt(a1)));
    // The clips leave the device by policy; the gyro file stays, as the frames files do.
    const folder = `sessions/${A}/attempts/0001`;
    expect(d.removed).toEqual([`${A}/1 laptop.scramble.mp4,laptop.solve.mp4`]);
    expect(fileText(d, `${folder}/laptop.solve.mp4`)).toBeNull();
    expect(fileText(d, `${folder}/gyro.json`)).toBe('g'.repeat(GYRO_BYTES));
    expect(fileText(d, `${folder}/laptop.solve.frames.json`)).toBe('f'.repeat(FRAMES_BYTES));
    expect(queue.view().freed).toEqual({ clips: 2, bytes: 3000 });
    await queue.stop();
  });

  it('without Keep local copies, deletes the clips of an attempt once all its files are uploaded, keeping attempt.json and the frames files', async () => {
    const d = device();
    await record(d, session(A, 1_790_000_000_000), [
      attempt(A, 1, [clip('scramble', 1000), clip('solve', 2000)]),
    ]);
    const queue = queueOf(d, { wifiOnly: false, keepLocalCopies: false });
    await queue.start();
    await flush();
    const folder = `sessions/${A}/attempts/0001`;
    expect(d.removed).toEqual([`${A}/1 laptop.scramble.mp4,laptop.solve.mp4`]);
    expect(fileText(d, `${folder}/laptop.solve.mp4`)).toBeNull();
    expect(fileText(d, `${folder}/laptop.scramble.mp4`)).toBeNull();
    expect(fileText(d, `${folder}/laptop.solve.frames.json`)).toBe('f'.repeat(FRAMES_BYTES));
    const [stored] = (await d.store.exportSession(A)).attempts;
    expect(stored.video.map((c) => c.local)).toEqual([false, false]);
    expect(queue.view().freed).toEqual({ clips: 2, bytes: 3000 });
    d.env.advance(1000);
    await flush();
    expect(stateOf(d)?.sessions[A].attempts['0001'].files['laptop.solve.mp4']).toMatchObject({
      state: 'done',
      local: false,
    });

    // Read again (the next start), the clips gone stay done; nothing is sent again.
    await queue.stop();
    const reloaded = queueOf(d, { wifiOnly: false, keepLocalCopies: false });
    const puts = d.http.puts.length;
    await reloaded.start();
    await flush();
    expect(d.http.puts.length).toBe(puts);
    expect(reloaded.view().counts.done).toBe(1);
    await reloaded.stop();
  });

  it('turning Keep local copies off deletes the clips of every attempt uploaded', async () => {
    const d = device();
    await record(d, session(A, 1_790_000_000_000), [
      attempt(A, 1, [clip('solve', 1000)]),
      attempt(A, 2, [clip('solve', 2000)]),
    ]);
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(d.removed).toEqual([]);
    queue.setPolicy({ wifiOnly: false, keepLocalCopies: false });
    await flush();
    expect(d.removed).toEqual([`${A}/1 laptop.solve.mp4`, `${A}/2 laptop.solve.mp4`]);
    await queue.stop();
  });

  it('from 70% of the storage quota, deletes the oldest uploaded clips first, down to 60%', async () => {
    const d = device();
    await record(d, session(B, 1_789_000_000_000), [
      attempt(B, 1, [clip('scramble', 30_000), clip('solve', 40_000)]),
    ]);
    await record(d, session(A, 1_790_000_000_000), [
      attempt(A, 1, [clip('scramble', 20_000), clip('solve', 30_000)]),
      attempt(A, 2, [clip('solve', 30_000)]),
    ]);
    // 69%: nothing goes.
    d.env.quota = 1_000_000;
    d.env.usage = 690_000;
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(queue.view().counts.done).toBe(3);
    expect(d.removed).toEqual([]);
    // 70.5%, 105 kB over 60%: B's two clips (70 kB), then A1's scramble (20 kB) and solve (30 kB);
    // A2's stays.
    d.env.usage = 705_000;
    d.env.advance(10 * 60 * 1000);
    await flush();
    expect(d.removed).toEqual([
      `${B}/1 laptop.scramble.mp4,laptop.solve.mp4`,
      `${A}/1 laptop.scramble.mp4,laptop.solve.mp4`,
    ]);
    expect(fileText(d, `sessions/${A}/attempts/0002/laptop.solve.mp4`)).toBe('v'.repeat(30_000));
    expect(fileText(d, `sessions/${B}/attempts/0001/laptop.solve.mp4`)).toBeNull();
    expect(fileText(d, `sessions/${B}/attempts/0001/attempt.json`)).not.toBeNull();
    expect(fileText(d, `sessions/${B}/attempts/0001/laptop.solve.frames.json`)).not.toBeNull();
    expect(queue.view().freed).toEqual({ clips: 4, bytes: 120_000 });
    const [b1] = (await d.store.exportSession(B)).attempts;
    expect(b1.video.map((c) => c.local)).toEqual([false, false]);
    await queue.stop();
  });

  it('stopped, the files being sent are cut off and stay pending in uploads.json', async () => {
    const d = device();
    await oneAttempt(d);
    d.http.hold = true;
    const queue = queueOf(d);
    await queue.start();
    await flush();
    expect(d.http.held).toBe(2);
    await queue.stop();
    expect(queue.status).toBe('stopped');
    const files = stateOf(d)?.sessions[A].attempts['0001'].files ?? {};
    expect(Object.values(files).map((file) => file.state)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('uploads from one tab at a time: another waits for the lock', async () => {
    const d = device({ lock: true });
    await oneAttempt(d);
    const first = queueOf(d);
    d.http.hold = true;
    await first.start();
    await flush();
    const second = queueOf(d);
    void second.start();
    await flush();
    expect(second.status).toBe('waiting');
    expect(second.view().status).toBe('waiting');
    await first.stop();
    d.http.hold = false;
    await flush();
    expect(second.status).toBe('running');
    expect(second.view().counts.done).toBe(1);
    await second.stop();
  });
});
