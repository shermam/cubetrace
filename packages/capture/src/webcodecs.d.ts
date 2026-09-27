// What TypeScript's DOM library lacks for the capture pipeline (typescript 6.0.3, checked on
// 2026-09-27). lib.dom.d.ts declares VideoEncoder, AudioEncoder, VideoFrame, AudioData, the encoded
// chunks and their configs; it declares MediaStreamTrackProcessor only for workers
// (lib.webworker.d.ts, and without the `track` of its init), while Chrome has it on the window only
// (docs/DEVICES.md). So it is declared here as types, not as a global: the window reads it from
// `globalThis` once it has checked that it exists, and nothing can clash with another declaration.

/** Chrome's `new MediaStreamTrackProcessor({ track })`, on the window. */
export interface MediaStreamTrackProcessorInit {
  readonly track: MediaStreamTrack;
  /** How many frames (or audio buffers) wait for a slow reader before the oldest is dropped. */
  readonly maxBufferSize?: number;
}

/** A track's frames (`VideoFrame`) or audio (`AudioData`) as a stream that can move to a worker. */
export interface MediaStreamTrackProcessor<T> {
  readonly readable: ReadableStream<T>;
}

export type MediaStreamTrackProcessorConstructor = new <T extends VideoFrame | AudioData>(
  init: MediaStreamTrackProcessorInit,
) => MediaStreamTrackProcessor<T>;
