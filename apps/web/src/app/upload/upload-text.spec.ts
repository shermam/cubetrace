import {
  attemptStateText,
  cloudUploadBadge,
  countsText,
  indicatorOf,
  pauseText,
  percent,
  statusText,
  uploadBadge,
  uploadTime,
} from './upload-text';
import { attemptView, queueView } from './upload-testing';

const UNTIL = 1_790_035_200_000;

describe('the words of the uploads', () => {
  it('say where the uploads are, and what is left', () => {
    expect(statusText('signed-out', null)).toBe('Sign in to upload your sessions.');
    expect(statusText('off', null)).toBe(
      'Uploads are off (Settings → Uploads): the sessions stay on this device.',
    );
    expect(statusText('unavailable', null)).toBe(
      'This browser keeps no sessions in its file system: there is nothing to upload.',
    );
    expect(statusText('error', null)).toBe('The uploads could not start.');
    expect(statusText('loading', null)).toBe('Reading this device’s sessions…');
    expect(statusText('waiting', null)).toBe(
      'Another tab of cubetrace uploads: one tab at a time.',
    );
    expect(statusText('running', queueView())).toBe(
      'Up to date: every attempt of this device is uploaded.',
    );
    const busy = queueView({
      counts: { waiting: 1, pending: 2, uploading: 1, done: 5, failed: 0 },
      bytesLeft: 12_400_000,
    });
    expect(statusText('running', busy)).toBe('Uploading: 4 attempts to upload, 12.4 MB.');
    expect(statusText('running', { ...busy, pause: { reason: 'quota', untilMs: UNTIL } })).toBe(
      `Paused until ${uploadTime(UNTIL)}: the day's upload quota is used up. 4 attempts to upload, 12.4 MB.`,
    );
    expect(statusText('running', { ...busy, pause: { reason: 'not-wifi' } })).toBe(
      'Waiting for Wi-Fi (Settings → Uploads → Wi-Fi only). 4 attempts to upload, 12.4 MB.',
    );
    expect(
      statusText(
        'running',
        queueView({ counts: { waiting: 0, pending: 0, uploading: 0, done: 3, failed: 1 } }),
      ),
    ).toBe('1 attempt could not be uploaded: Retry once the cause is fixed.');
  });

  it('count the attempts by state, the done ones always', () => {
    expect(countsText(queueView())).toBe('0 done');
    expect(
      countsText(
        queueView({ counts: { waiting: 1, pending: 2, uploading: 1, done: 12, failed: 1 } }),
      ),
    ).toBe('2 pending · 1 uploading · 1 waiting for clips · 12 done · 1 failed');
  });

  it("say an attempt's state, in the panel and on its badge", () => {
    expect(attemptStateText(attemptView(1, { state: 'waiting' }))).toBe('waiting for its clips');
    expect(attemptStateText(attemptView(1))).toBe('pending');
    expect(attemptStateText(attemptView(1, { error: 'the network' }))).toBe('will try again');
    expect(
      attemptStateText(attemptView(1, { state: 'uploading', bytes: 2_000, sent: 1_499 })),
    ).toBe('uploading 74%');
    expect(attemptStateText(attemptView(1, { state: 'done' }))).toBe('uploaded');
    expect(attemptStateText(attemptView(1, { state: 'failed' }))).toBe('failed');
    expect(percent({ sent: 5, bytes: 0 })).toBe(0);
    expect(percent({ sent: 7, bytes: 5 })).toBe(100);

    expect(uploadBadge(attemptView(1, { state: 'waiting' }))).toEqual({
      state: 'waiting',
      text: 'to upload',
    });
    expect(uploadBadge(attemptView(1, { state: 'uploading', bytes: 4, sent: 1 }))).toEqual({
      state: 'uploading',
      text: 'uploading 25%',
    });
    expect(uploadBadge(attemptView(1, { state: 'done' }))).toEqual({
      state: 'done',
      text: 'uploaded',
    });
    expect(uploadBadge(attemptView(1, { state: 'failed' }))).toEqual({
      state: 'failed',
      text: 'upload failed',
    });
    expect(
      ['pending', 'uploading', 'done', 'failed'].map((s) => cloudUploadBadge(s as never).text),
    ).toEqual(['to upload', 'uploading', 'uploaded', 'upload failed']);
  });

  it('give the indicator its state, count and title', () => {
    expect(indicatorOf(null)).toBeNull();
    expect(indicatorOf({ left: 3, failed: 0, pause: null, bytesLeft: 5_300_000 })).toEqual({
      state: 'uploading',
      count: 3,
      title: 'Uploading: 3 attempts to upload, 5.3 MB.',
    });
    expect(
      indicatorOf({ left: 1, failed: 0, pause: { reason: 'offline' }, bytesLeft: 1_000 }),
    ).toEqual({
      state: 'paused',
      count: 1,
      title: 'Offline: the uploads go on once the network is back. 1 attempt to upload, 1.0 kB.',
    });
    expect(indicatorOf({ left: 0, failed: 2, pause: null, bytesLeft: 0 })).toEqual({
      state: 'failed',
      count: 2,
      title: '2 attempts could not be uploaded: see Sessions.',
    });
    expect(indicatorOf({ left: 1, failed: 1, pause: null, bytesLeft: 0 })?.state).toBe('failed');
    expect(pauseText(null)).toBeNull();
  });
});
