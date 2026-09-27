/// <reference types="node" />
// Node's types for this file only: it reads the recorded media sample (fixtures/media/) with
// node:fs. For the tests of the muxer, the clip writer and the worker; not part of the package's
// API.
import { readFileSync } from 'node:fs';

import type { Cut } from './cut';
import type { EncodedChunkRecord } from './ring-buffer';

/** fixtures/media/fake-camera-vp9-1s.json as it is stored: a cut whose ArrayBuffers are base64. */
interface StoredChunk extends Omit<EncodedChunkRecord, 'data'> {
  readonly data: string;
}

interface StoredTrack<Config> {
  readonly decoderConfig: (Omit<Config, 'description'> & { description?: string }) | null;
  readonly chunks: readonly StoredChunk[];
}

interface StoredSample {
  readonly about: string;
  readonly recorded: { readonly date: string; readonly userAgent: string; readonly flags: string };
  readonly cut: Omit<Cut, 'video' | 'audio'> & {
    readonly video: Omit<Cut['video'], 'decoderConfig' | 'chunks'> &
      StoredTrack<VideoDecoderConfig>;
    readonly audio:
      | (Omit<NonNullable<Cut['audio']>, 'decoderConfig' | 'chunks'> &
          StoredTrack<AudioDecoderConfig>)
      | null;
  };
}

/** The recorded sample: about one second of Chrome's fake camera and microphone, VP9 and Opus. */
export const MEDIA_SAMPLE = 'fake-camera-vp9-1s.json';

/**
 * The cut stored in `fixtures/media/<name>`, with its bytes decoded: every call gives a new cut
 * with buffers of its own, which a test may change or transfer.
 */
export function readMediaSample(name = MEDIA_SAMPLE): Cut {
  const text = readFileSync(new URL(`../../../fixtures/media/${name}`, import.meta.url), 'utf8');
  const stored = (JSON.parse(text) as StoredSample).cut;
  const video = stored.video;
  const audio = stored.audio;
  return {
    ...stored,
    video: { ...video, decoderConfig: config(video.decoderConfig), chunks: chunks(video.chunks) },
    audio:
      audio === null
        ? null
        : { ...audio, decoderConfig: config(audio.decoderConfig), chunks: chunks(audio.chunks) },
  };
}

/** Base64 to the bytes in an ArrayBuffer of their own (Node's Buffers share a pool). */
function bytes(base64: string): ArrayBuffer {
  return new Uint8Array(Buffer.from(base64, 'base64')).buffer;
}

function chunks(stored: readonly StoredChunk[]): EncodedChunkRecord[] {
  return stored.map((chunk) => ({ ...chunk, data: bytes(chunk.data) }));
}

function config<Config extends VideoDecoderConfig | AudioDecoderConfig>(
  stored: (Omit<Config, 'description'> & { description?: string }) | null,
): Config | null {
  if (stored === null) {
    return null;
  }
  const { description, ...rest } = stored;
  return (
    description === undefined ? rest : { ...rest, description: bytes(description) }
  ) as Config;
}
