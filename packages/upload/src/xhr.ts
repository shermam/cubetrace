// The PUT through XMLHttpRequest (UploadHttp): fetch() gives no progress of an upload, and an
// XMLHttpRequest sends a Blob (a File of the origin private file system) without reading it into
// memory first. The browser sets Content-Length from the Blob, which an R2 URL binds; the headers
// that the signature asks for (Content-Type, GCS's x-goog-content-length-range) are set as given.
import type { PutRequest, PutResponse, UploadHttp } from './ports';

/** The part of `XMLHttpRequest` the upload uses. */
export interface XhrLike {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
  readonly status: number;
  readonly responseText: string;
  readonly upload: { onprogress: ((event: { readonly loaded: number }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
  onabort: (() => void) | null;
}

/** {@link UploadHttp} over `XMLHttpRequest`s that `create` makes (`() => new XMLHttpRequest()`). */
export function xhrHttp(create: () => XhrLike): UploadHttp {
  return {
    put: (request: PutRequest) =>
      new Promise<PutResponse>((resolve, reject) => {
        const { signal } = request;
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        const xhr = create();
        const onAbort = (): void => {
          xhr.abort();
        };
        const settle = (outcome: () => void): void => {
          signal.removeEventListener('abort', onAbort);
          outcome();
        };
        xhr.open('PUT', request.url);
        for (const [name, value] of Object.entries(request.headers)) {
          xhr.setRequestHeader(name, value);
        }
        xhr.upload.onprogress = (event) => {
          request.progress(event.loaded);
        };
        xhr.onload = () => {
          settle(() => {
            resolve({ status: xhr.status, body: xhr.responseText });
          });
        };
        // A network error, a CORS refusal or a timeout: no response to read.
        xhr.onerror = xhr.ontimeout = () => {
          settle(() => {
            resolve({ status: 0, body: '' });
          });
        };
        xhr.onabort = () => {
          settle(() => {
            reject(abortError());
          });
        };
        signal.addEventListener('abort', onAbort);
        xhr.send(request.body);
      }),
  };
}

function abortError(): DOMException {
  return new DOMException('The upload was cut off.', 'AbortError');
}
