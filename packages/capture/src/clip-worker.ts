// The clip worker (docs/PLAN.md, T2.4): it saves the clips that the capture worker cuts. The capture
// worker moves each cut, with its request, through the channel the window set up between them; this
// worker muxes it into an MP4 (mux.ts, mediabunny), writes it with its frames.json into the attempt's
// folder of the origin private file system (clip-writer.ts) and answers the window. Muxing and
// writing a long clip take a tenth of a second or more, which in the capture worker held up the
// camera's frames (docs/TOOLCHAIN.md, "Two workers"); here they hold up nothing but the next clip.
// It also removes, on the window's request, a clip saved for an attempt that is gone. Angular's
// builder emits it as a chunk of its own, with mediabunny; `startCapture` (pipeline.ts) starts it.
// Plain TypeScript: no Angular. The file system and the way to the window come in through
// `ClipWorkerEnvironment`, so the logic also runs in Node's tests; the last lines wire it to the
// worker's global scope.
import type { OpfsDirectoryHandle } from '@cubetrace/storage';

import { SESSIONS_FOLDER } from './clip-files';
import { deleteClipIf, writeClip } from './clip-writer';
import { muxClip } from './mux';
import {
  describeError,
  isClipJob,
  isWindowToClipWorker,
  post,
  type ClipJob,
  type DeleteClipRequest,
  type MessageTarget,
  type WorkerToWindow,
} from './protocol';

/** What the clip worker takes from its global scope; the tests give it fakes. */
export interface ClipWorkerEnvironment {
  /** Sends an answer to the window. */
  post(message: WorkerToWindow): void;
  /** The origin private file system's root (`navigator.storage.getDirectory()`). */
  opfsRoot(): Promise<OpfsDirectoryHandle>;
}

/**
 * Saves clips and removes them, one at a time, in the order they come: a clip's job from the
 * capture worker (muxed, written, answered with its `video[]` entry) or a removal from the window.
 * Every job is answered, with the reason when it fails.
 */
export class ClipWorker {
  readonly #env: ClipWorkerEnvironment;
  /** The end of the last job queued. */
  #queue: Promise<void> = Promise.resolve();

  constructor(env: ClipWorkerEnvironment) {
    this.#env = env;
  }

  /** Queues a job after the ones before it; resolves once it is answered. Never rejects. */
  handle(message: ClipJob | DeleteClipRequest): Promise<void> {
    const job =
      message.type === 'clip-job' ? () => this.#save(message) : () => this.#delete(message);
    // Only an answer that cannot be sent at all rejects: the window's timeout then speaks for it,
    // and the jobs after this one run all the same.
    const run = this.#queue.then(job).catch(() => undefined);
    this.#queue = run;
    return run;
  }

  /** Resolves once the jobs queued so far are answered. */
  idle(): Promise<void> {
    return this.#queue;
  }

  async #save(job: ClipJob): Promise<void> {
    const { id, sessionId, index, camera, segment, fpsNominal, app, staging } = job.request;
    try {
      const { mp4, frames, info } = await muxClip(job.cut, { camera, segment, audio: job.audio });
      const root = await stagingRoot(await this.#env.opfsRoot(), staging, sessionId);
      const clip = await writeClip(root, sessionId, index, camera, segment, mp4, frames, {
        codec: info.codec,
        audio: info.audio,
        width: info.width,
        height: info.height,
        fpsNominal,
        truncatedStart: info.truncatedStart,
        ...(app === undefined ? {} : { app }),
      });
      this.#answer({
        type: 'mux-and-write-done',
        id,
        clip,
        report: {
          lateMs: info.lateMs,
          bufferSeconds: job.bufferSeconds,
          audioMissing: info.audioMissing,
          audioRebasedMs: info.audioRebasedMs,
          audioConfigMade: info.audio !== null && job.audio.configMade,
        },
      });
    } catch (error: unknown) {
      this.#answer({ type: 'mux-and-write-failed', id, message: describeError(error) });
    }
  }

  async #delete(request: DeleteClipRequest): Promise<void> {
    const { id, sessionId, index, camera, segment, firstFrameHostMs } = request;
    try {
      const root = await this.#env.opfsRoot();
      const deleted = await deleteClipIf(root, sessionId, index, camera, segment, firstFrameHostMs);
      this.#answer({ type: 'delete-clip-done', id, deleted });
    } catch (error: unknown) {
      this.#answer({ type: 'delete-clip-failed', id, message: describeError(error) });
    }
  }

  /** Sends an answer; a failure to send it becomes a failed answer. */
  #answer(answer: WorkerToWindow & { readonly id: number }): void {
    try {
      this.#env.post(answer);
    } catch (error: unknown) {
      this.#env.post({
        type: answer.type.startsWith('delete-clip') ? 'delete-clip-failed' : 'mux-and-write-failed',
        id: answer.id,
        message: `The answer could not be sent: ${describeError(error)}`,
      });
    }
  }
}

/**
 * Where a clip's `sessions/<sessionId>/…` goes: the file system's root, or a staging folder at the
 * root with the session's folder made in it (T4.2, `SaveClipParams.staging`), so that `writeClip`,
 * which wants the session's folder there, writes a camera device's clips as the host's.
 */
async function stagingRoot(
  root: OpfsDirectoryHandle,
  staging: string | undefined,
  sessionId: string,
): Promise<OpfsDirectoryHandle> {
  if (staging === undefined) {
    return root;
  }
  const folder = await root.getDirectoryHandle(staging, { create: true });
  const sessions = await folder.getDirectoryHandle(SESSIONS_FOLDER, { create: true });
  await sessions.getDirectoryHandle(sessionId, { create: true });
  return folder;
}

/** The worker's global scope, as far as this file uses it. */
interface WorkerScope extends MessageTarget {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
}

// Only in a dedicated worker: the package's index never imports this file into the window, and
// Node's tests import `ClipWorker` without a DedicatedWorkerGlobalScope.
if (typeof (globalThis as Record<string, unknown>)['DedicatedWorkerGlobalScope'] === 'function') {
  const scope = globalThis as unknown as WorkerScope;
  const worker = new ClipWorker({
    post: (message) => {
      post(scope, message);
    },
    opfsRoot: () => {
      // Read as optional: TypeScript's DOM types say every navigator has one.
      const storage = (globalThis.navigator as Partial<Navigator> | undefined)?.storage;
      return typeof storage?.getDirectory === 'function'
        ? storage.getDirectory()
        : Promise.reject(new Error('This browser has no origin private file system in workers.'));
    },
  });
  scope.addEventListener('message', (event) => {
    const data = event.data;
    if (!isWindowToClipWorker(data)) {
      return;
    }
    if (data.type === 'delete-clip') {
      void worker.handle(data);
      return;
    }
    // The capture worker's cuts come through the channel.
    data.port.addEventListener('message', (job: MessageEvent<unknown>) => {
      if (isClipJob(job.data)) {
        void worker.handle(job.data);
      }
    });
    data.port.start();
  });
}
