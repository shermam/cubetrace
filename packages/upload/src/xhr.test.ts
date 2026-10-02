import { describe, expect, it } from 'vitest';

import type { PutRequest } from './ports';
import { xhrHttp, type XhrLike } from './xhr';

/** An XMLHttpRequest that records what it was asked and settles as the test says. */
class FakeXhr implements XhrLike {
  method = '';
  url = '';
  readonly headers: Record<string, string> = {};
  body: Blob | null = null;
  aborted = false;
  status = 0;
  responseText = '';
  readonly upload: XhrLike['upload'] = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: Blob): void {
    this.body = body;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
}

function request(signal: AbortSignal, progress: number[]): PutRequest {
  return {
    url: 'https://bucket.test/users/u/sessions/s/attempts/0001/laptop.solve.mp4?X-Goog-Signature=1',
    headers: { 'Content-Type': 'video/mp4', 'x-goog-content-length-range': '4,4' },
    body: new Blob(['abcd']),
    progress: (sent) => progress.push(sent),
    signal,
  };
}

describe('xhrHttp', () => {
  it('PUTs the Blob with the headers signed, tells the progress, and answers with the status', async () => {
    const xhr = new FakeXhr();
    const progress: number[] = [];
    const put = xhrHttp(() => xhr).put(request(new AbortController().signal, progress));
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toMatch(/^https:\/\/bucket\.test\//);
    expect(xhr.headers).toEqual({
      'Content-Type': 'video/mp4',
      'x-goog-content-length-range': '4,4',
    });
    expect(xhr.body?.size).toBe(4);
    xhr.upload.onprogress?.({ loaded: 2 });
    xhr.upload.onprogress?.({ loaded: 4 });
    xhr.status = 200;
    xhr.onload?.();
    await expect(put).resolves.toEqual({ status: 200, body: '' });
    expect(progress).toEqual([2, 4]);
  });

  it('answers a refusal with its status and text, and a network error with 0', async () => {
    const refused = new FakeXhr();
    const put = xhrHttp(() => refused).put(request(new AbortController().signal, []));
    refused.status = 403;
    refused.responseText = '<Error><Code>AccessDenied</Code></Error>';
    refused.onload?.();
    await expect(put).resolves.toEqual({
      status: 403,
      body: '<Error><Code>AccessDenied</Code></Error>',
    });
    for (const fail of ['onerror', 'ontimeout'] as const) {
      const xhr = new FakeXhr();
      const failed = xhrHttp(() => xhr).put(request(new AbortController().signal, []));
      xhr[fail]?.();
      await expect(failed).resolves.toEqual({ status: 0, body: '' });
    }
  });

  it('is cut off by its signal, before or during the upload', async () => {
    const controller = new AbortController();
    const xhr = new FakeXhr();
    const put = xhrHttp(() => xhr).put(request(controller.signal, []));
    controller.abort();
    await expect(put).rejects.toMatchObject({ name: 'AbortError' });
    expect(xhr.aborted).toBe(true);
    let made = false;
    const late = xhrHttp(() => {
      made = true;
      return new FakeXhr();
    }).put(request(controller.signal, []));
    await expect(late).rejects.toMatchObject({ name: 'AbortError' });
    expect(made).toBe(false);
  });
});
