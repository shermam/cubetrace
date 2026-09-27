import { ATTEMPT_SCHEMA, type VideoClip } from '@cubetrace/core';
import { FakeDirectoryHandle } from '@cubetrace/storage';
import { Ajv2020 } from 'ajv/dist/2020';
import { ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { afterEach, describe, expect, it } from 'vitest';

import { CaptureWorker, type FrameLike } from './capture-worker';
import { ClipWorker } from './clip-worker';
import { cut, type Cut } from './cut';
import {
  resolveCaptureConfig,
  transferList,
  type AudioReport,
  type ClipJob,
  type ClipReport,
  type DeleteClipRequest,
  type MuxAndWriteRequest,
  type WorkerToWindow,
} from './protocol';
import { RingBuffer } from './ring-buffer';
import { readMediaSample } from './test-media';

// The clip worker (docs/PLAN.md, T2.4) with the recorded sample (fixtures/media/) and the in-memory
// file system of @cubetrace/storage: a job's cut muxed and written into the attempt's folder, the
// answers, the order of the jobs, the guarded removal, and the whole way from the capture worker
// through a channel.

const SESSION = '3f1c2b7e-8a4d-4f2e-9b1a-0c5d6e7f8a9b';
const FOLDER = `sessions/${SESSION}/attempts/0003`;

const ports: MessagePort[] = [];

afterEach(() => {
  for (const port of ports.splice(0)) {
    port.close();
  }
});

/** A file system with the session's folder, and a clip worker writing into it. */
async function clipWorker() {
  const root = new FakeDirectoryHandle('', { syncAccessHandle: true });
  await root.plant(`sessions/${SESSION}/session.json`, '{}');
  const posted: WorkerToWindow[] = [];
  const worker = new ClipWorker({
    post: (message) => {
      transferList(message);
      posted.push(message);
    },
    opfsRoot: () => Promise.resolve(root),
  });
  return { worker, posted, root };
}

/** The request of a clip of the sample, for attempt 3 of the session. */
function request(id: number, changes: Partial<MuxAndWriteRequest> = {}): MuxAndWriteRequest {
  const sample = readMediaSample();
  return {
    type: 'mux-and-write',
    id,
    startHostMs: sample.startHostMs,
    endHostMs: sample.endHostMs,
    sessionId: SESSION,
    index: 3,
    camera: 'laptop',
    segment: 'solve',
    fpsNominal: 30,
    ...changes,
  };
}

/** The capture's audio while it encodes the fake microphone. */
const ENCODING: AudioReport = {
  state: 'encoding',
  data: 400,
  chunks: 200,
  error: null,
  configMade: false,
};

function job(
  id: number,
  changes: Partial<MuxAndWriteRequest> = {},
  source?: Cut,
  audio: AudioReport = ENCODING,
): ClipJob {
  return {
    type: 'clip-job',
    request: request(id, changes),
    cut: source ?? readMediaSample(),
    bufferSeconds: 90,
    audio,
  };
}

function clipOf(message: WorkerToWindow | undefined): VideoClip {
  if (message?.type !== 'mux-and-write-done') {
    throw new Error(`expected a clip, got ${JSON.stringify(message)}`);
  }
  return message.clip;
}

function reportOf(message: WorkerToWindow | undefined): ClipReport {
  if (message?.type !== 'mux-and-write-done') {
    throw new Error(`expected a clip, got ${JSON.stringify(message)}`);
  }
  return message.report;
}

function deletion(id: number, firstFrameHostMs: number): DeleteClipRequest {
  return {
    type: 'delete-clip',
    id,
    sessionId: SESSION,
    index: 3,
    camera: 'laptop',
    segment: 'solve',
    firstFrameHostMs,
  };
}

describe('ClipWorker', () => {
  it("muxes and writes a job's cut into the attempt's folder, and answers with its video[] entry", async () => {
    const { worker, posted, root } = await clipWorker();
    const sample = readMediaSample();

    await worker.handle(job(1, {}, sample));

    const clip = clipOf(posted.at(-1));
    expect(posted.at(-1)).toMatchObject({ id: 1 });
    const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
    ajv.addSchema(ATTEMPT_SCHEMA);
    const validate = ajv.getSchema(`${String(ATTEMPT_SCHEMA['$id'])}#/$defs/clip`);
    expect(validate?.(clip), JSON.stringify(validate?.errors)).toBe(true);
    expect(clip).toMatchObject({
      camera: 'laptop',
      segment: 'solve',
      file: 'laptop.solve.mp4',
      codec: 'vp09.00.40.08',
      audio: 'opus',
      width: 1920,
      height: 1080,
      fpsNominal: 30,
      frames: sample.video.chunks.length,
      firstFrameHostMs: sample.frames.t0HostMs,
      framesFile: 'laptop.solve.frames.json',
      crop: null,
      syncResidualMs: null,
      truncatedStart: false,
    });
    expect(reportOf(posted.at(-1))).toEqual({
      lateMs: 0,
      bufferSeconds: 90,
      audioMissing: null,
      audioRebasedMs: 0,
      audioConfigMade: false,
    });
    const mp4 = root.files().get(`${FOLDER}/laptop.solve.mp4`)?.bytes;
    expect(mp4?.length).toBe(clip.bytes);
    const input = new Input({
      source: new BufferSource(mp4 ?? new Uint8Array(0)),
      formats: ALL_FORMATS,
    });
    const videoTrack = await input.getPrimaryVideoTrack();
    expect((await videoTrack?.computePacketStats())?.packetCount).toBe(clip.frames);
    expect(
      JSON.parse(root.files().get(`${FOLDER}/laptop.solve.frames.json`)?.text ?? ''),
    ).toMatchObject({ camera: 'laptop', segment: 'solve', dtMs: sample.frames.dtMs });
  });

  it('saves a clip whose start was older than the buffer, from its first keyframe, and reports how late it begins', async () => {
    const { worker, posted, root } = await clipWorker();
    const sample = readMediaSample();
    // Asked from 434.1 s before its first frame, as attempt 6 of the i3's scramble was (issue #34).
    const truncated: Cut = {
      ...sample,
      startHostMs: sample.frames.t0HostMs - 434_100,
      truncatedStart: true,
    };

    await worker.handle(job(2, { segment: 'scramble' }, truncated));

    const clip = clipOf(posted.at(-1));
    expect(clip).toMatchObject({
      segment: 'scramble',
      truncatedStart: true,
      frames: sample.video.chunks.length,
      firstFrameHostMs: sample.frames.t0HostMs,
    });
    expect(reportOf(posted.at(-1))).toEqual({
      lateMs: 434_100,
      bufferSeconds: 90,
      audioMissing: null,
      audioRebasedMs: 0,
      audioConfigMade: false,
    });
    expect(root.files().get(`${FOLDER}/laptop.scramble.mp4`)?.bytes.length).toBe(clip.bytes);
  });

  it('reports why a clip has no sound while the capture records audio', async () => {
    const { worker, posted } = await clipWorker();
    const silent: Cut = { ...readMediaSample(), audio: null };

    await worker.handle(
      job(5, {}, silent, { state: 'waiting', data: 0, chunks: 0, error: null, configMade: false }),
    );

    expect(clipOf(posted.at(-1)).audio).toBeNull();
    expect(reportOf(posted.at(-1)).audioMissing).toBe(
      'no audio data: the microphone sent nothing (muted, or held by another app)',
    );
  });

  it('reports that the capture made the audio decoder config of a clip with sound', async () => {
    const { worker, posted } = await clipWorker();

    await worker.handle(job(6, {}, undefined, { ...ENCODING, configMade: true }));
    await worker.handle(
      job(7, {}, { ...readMediaSample(), audio: null }, { ...ENCODING, configMade: true }),
    );

    expect(posted.map((message) => reportOf(message).audioConfigMade)).toEqual([true, false]);
  });

  it('says why when there is no clip: no session folder, a bad label', async () => {
    const { worker, posted } = await clipWorker();

    await worker.handle(job(3, { sessionId: 'gone' }));
    await worker.handle(job(4, { camera: 'Laptop' }));

    expect(posted).toEqual([
      {
        type: 'mux-and-write-failed',
        id: 3,
        message: 'Error: No session gone: its folder is missing.',
      },
      {
        type: 'mux-and-write-failed',
        id: 4,
        message: expect.stringMatching(/^RangeError: "Laptop" is not a camera label/) as unknown,
      },
    ]);
  });

  it('does one job at a time, in the order they came', async () => {
    const { worker, posted, root } = await clipWorker();

    void worker.handle(job(1, { segment: 'scramble' }));
    void worker.handle(job(2));
    void worker.handle(deletion(3, readMediaSample().frames.t0HostMs));
    await worker.idle();

    expect(posted.map((message) => [message.type, 'id' in message ? message.id : null])).toEqual([
      ['mux-and-write-done', 1],
      ['mux-and-write-done', 2],
      ['delete-clip-done', 3],
    ]);
    expect([...root.files().keys()].filter((path) => path.endsWith('.mp4'))).toEqual([
      `${FOLDER}/laptop.scramble.mp4`,
    ]);
  });

  it('removes a clip only while it is the one asked for: a newer clip of the same name stays', async () => {
    const { worker, posted, root } = await clipWorker();
    await worker.handle(job(1));
    const saved = clipOf(posted.at(-1));

    await worker.handle(deletion(2, saved.firstFrameHostMs - 1000));
    expect(root.files().get(`${FOLDER}/laptop.solve.mp4`)).toBeDefined();
    await worker.handle(deletion(3, saved.firstFrameHostMs));
    await worker.handle(deletion(4, saved.firstFrameHostMs));
    await worker.handle({ ...deletion(5, 0), camera: 'Laptop' });

    expect(posted.slice(1)).toEqual([
      { type: 'delete-clip-done', id: 2, deleted: false },
      { type: 'delete-clip-done', id: 3, deleted: true },
      { type: 'delete-clip-done', id: 4, deleted: false },
      {
        type: 'delete-clip-failed',
        id: 5,
        message: expect.stringMatching(/^RangeError: "Laptop" is not a camera label/) as unknown,
      },
    ]);
    expect([...root.files().keys()]).toEqual([`sessions/${SESSION}/session.json`]);
  });

  it('answers that the answer could not be sent, when it cannot be', async () => {
    const posted: WorkerToWindow[] = [];
    let refuse = true;
    const worker = new ClipWorker({
      post: (message) => {
        if (refuse) {
          refuse = false;
          throw new DOMException('could not be cloned', 'DataCloneError');
        }
        posted.push(message);
      },
      opfsRoot: () => Promise.reject(new Error('no file system')),
    });

    await worker.handle(deletion(6, 0));

    expect(posted).toEqual([
      {
        type: 'delete-clip-failed',
        id: 6,
        message: 'The answer could not be sent: DataCloneError: could not be cloned',
      },
    ]);
  });
});

describe('the capture worker and the clip worker, through a channel', () => {
  it("saves a clip cut by the capture worker, whose own bytes stay whole, and answers the window's request", async () => {
    const { worker: clips, posted, root } = await clipWorker();
    const channel = new MessageChannel();
    ports.push(channel.port1, channel.port2);
    channel.port2.addEventListener('message', (event: MessageEvent<ClipJob>) => {
      void clips.handle(event.data);
    });
    channel.port2.start();
    const toWindow: WorkerToWindow[] = [];
    const capture = new CaptureWorker({
      VideoEncoder: undefined,
      AudioEncoder: undefined,
      now: () => 0,
      post: (message) => toWindow.push(message),
      every: () => () => undefined,
    });
    void capture.start(
      new ReadableStream<FrameLike>(),
      null,
      resolveCaptureConfig(),
      30,
      channel.port1,
    );
    const sample = readMediaSample();
    fill(capture.buffer, sample);

    capture.muxAndWrite(request(9));
    await expect.poll(() => posted.length).toBe(1);
    await clips.idle();

    expect(toWindow).toEqual([]);
    const clip = clipOf(posted[0]);
    expect(clip.frames).toBe(sample.video.chunks.length);
    expect(root.files().get(`${FOLDER}/laptop.solve.mp4`)?.bytes.length).toBe(clip.bytes);
    expect(capture.buffer.video.every((chunk) => chunk.data.byteLength === chunk.byteLength)).toBe(
      true,
    );
    // The buffer's bytes cut again give the same clip.
    const again = cut(capture.buffer, sample.startHostMs, sample.endHostMs);
    expect(again.video.chunks).toHaveLength(clip.frames);
  });
});

/** Pushes the sample's chunks into `buffer`, as the encoders would have. */
function fill(buffer: RingBuffer, sample: Cut): void {
  const { chunks: video, decoderConfig: videoConfig, ...videoTrack } = sample.video;
  buffer.setVideoTrack(videoTrack);
  if (videoConfig !== null) {
    buffer.setVideoDecoderConfig(videoConfig);
  }
  const audio = sample.audio;
  if (audio !== null) {
    const { codec, sampleRate, numberOfChannels, decoderConfig } = audio;
    buffer.setAudioTrack({ codec, sampleRate, numberOfChannels });
    if (decoderConfig !== null) {
      buffer.setAudioDecoderConfig(decoderConfig);
    }
  }
  for (const chunk of [...video, ...(audio?.chunks ?? [])].sort(
    (p, q) => p.timestampUs - q.timestampUs,
  )) {
    buffer.push(chunk);
  }
}
