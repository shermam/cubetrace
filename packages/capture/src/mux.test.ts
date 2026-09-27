import { FRAMES_SCHEMA } from '@cubetrace/core';
import { Ajv2020 } from 'ajv/dist/2020';
import {
  ALL_FORMATS,
  BufferSource,
  EncodedPacketSink,
  Input,
  type EncodedPacket,
  type InputTrack,
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import type { Cut } from './cut';
import { muxClip, type MuxedClip } from './mux';
import type { EncodedChunkRecord } from './ring-buffer';
import { readMediaSample } from './test-media';

// The muxer on a real cut: about one second of Chrome's fake camera (VP9, 1080p30) and microphone
// (Opus), recorded through /capture-lab (fixtures/media/README.md), read back with mediabunny's
// demuxer.

const META = { camera: 'laptop', segment: 'solve' } as const;

async function packetsOf(track: InputTrack): Promise<EncodedPacket[]> {
  const packets: EncodedPacket[] = [];
  for await (const packet of new EncodedPacketSink(track).packets()) {
    packets.push(packet);
  }
  return packets;
}

/** The MP4 read back: its top-level boxes, tracks, codecs, packets and duration. */
async function readBack(mp4: ArrayBuffer) {
  const view = new DataView(mp4);
  const boxes: string[] = [];
  for (let at = 0; at + 8 <= mp4.byteLength; at += view.getUint32(at)) {
    boxes.push(String.fromCharCode(...new Uint8Array(mp4, at + 4, 4)));
  }
  const input = new Input({ source: new BufferSource(mp4), formats: ALL_FORMATS });
  const tracks = await input.getTracks();
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  return {
    boxes,
    mimeType: await input.getMimeType(),
    tracks: tracks.length,
    durationS: await input.computeDuration(),
    video:
      video === null
        ? null
        : {
            codec: await video.getCodec(),
            codecString: await video.getCodecParameterString(),
            durationS: await video.computeDuration(),
            width: await video.getCodedWidth(),
            height: await video.getCodedHeight(),
            packets: await packetsOf(video),
          },
    audio:
      audio === null
        ? null
        : {
            codec: await audio.getCodec(),
            codecString: await audio.getCodecParameterString(),
            sampleRate: await audio.getSampleRate(),
            channels: await audio.getNumberOfChannels(),
            packets: await packetsOf(audio),
          },
  };
}

/**
 * Frame k's time from the clip's first frame, ms, as frames.json gives it: dtMs[0] + … + dtMs[k].
 */
function frameTimesMs(dtMs: readonly number[]): number[] {
  let sum = 0;
  return dtMs.map((dt) => (sum += dt));
}

function withVideoChunks(cut: Cut, chunks: EncodedChunkRecord[]): Cut {
  return { ...cut, video: { ...cut.video, chunks } };
}

describe('muxClip on the recorded sample', () => {
  it('makes an MP4 with its metadata first, which mediabunny reads back: two tracks, their codecs, every frame', async () => {
    const cut = readMediaSample();
    const muxed = await muxClip(cut, META);
    const mp4 = await readBack(muxed.mp4);

    expect(mp4.boxes).toEqual(['ftyp', 'moov', 'mdat']);
    expect(mp4.tracks).toBe(2);
    expect(muxed.info).toEqual({
      codec: 'vp09.00.40.08',
      audio: 'opus',
      width: 1920,
      height: 1080,
      frames: cut.video.chunks.length,
      durationMs: expect.any(Number) as unknown,
    });
    expect(mp4.video?.codec).toBe('vp9');
    // The codec string of the vpcC box: the decoder config's, with the colour fields spelled out.
    expect(mp4.video?.codecString?.startsWith(`${muxed.info.codec}.`)).toBe(true);
    expect([mp4.video?.width, mp4.video?.height]).toEqual([1920, 1080]);
    expect(mp4.audio).toMatchObject({ codec: 'opus', codecString: 'opus', sampleRate: 48_000 });
    expect(mp4.mimeType).toBe(`video/mp4; codecs="${String(mp4.video?.codecString)}, opus"`);

    // Every frame, as frames.json counts them, in order, each at its frames.json time from 0.
    const packets = mp4.video?.packets ?? [];
    expect(packets).toHaveLength(muxed.frames.dtMs.length);
    expect(muxed.info.frames).toBe(muxed.frames.dtMs.length);
    const times = frameTimesMs(muxed.frames.dtMs);
    packets.forEach((packet, index) => {
      // 0.05 ms from frames.json's rounding plus 1/57600 s from the MP4's time scale.
      expect(Math.abs(packet.timestamp * 1000 - times[index])).toBeLessThan(0.1);
    });
    expect(packets.flatMap((packet, index) => (packet.type === 'key' ? [index] : []))).toEqual(
      muxed.frames.keyframes,
    );
    // The bytes as the encoder made them: no re-encoding.
    packets.forEach((packet, index) => {
      expect(packet.data).toEqual(new Uint8Array(cut.video.chunks[index].data));
    });

    // The duration: the video's, from the first frame to the end of the last; the file's, within
    // 5% of it (the audio chunk that overlaps the last frame may end a few ms later).
    const lastChunk = cut.video.chunks[cut.video.chunks.length - 1];
    expect(muxed.info.durationMs).toBeCloseTo(
      (lastChunk.timestampUs + lastChunk.durationUs - cut.video.chunks[0].timestampUs) / 1000,
      6,
    );
    expect((mp4.video?.durationS ?? 0) * 1000).toBeCloseTo(muxed.info.durationMs, 0);
    expect(Math.abs(mp4.durationS * 1000 - muxed.info.durationMs)).toBeLessThan(
      0.05 * muxed.info.durationMs,
    );
  });

  it('places the audio by its own timestamps: the chunk that overlaps the first frame starts before 0', async () => {
    const cut = readMediaSample();
    const audio = cut.audio;
    if (audio === null) {
      throw new Error('The sample has audio.');
    }
    const originUs = cut.video.chunks[0].timestampUs;
    const muxed = await muxClip(cut, META);
    const packets = (await readBack(muxed.mp4)).audio?.packets ?? [];

    // The sample's first audio chunk begins before the first frame and ends after it.
    expect(audio.chunks[0].timestampUs).toBeLessThan(originUs);
    expect(audio.chunks[0].timestampUs + audio.chunks[0].durationUs).toBeGreaterThan(originUs);
    expect(packets).toHaveLength(audio.chunks.length);
    packets.forEach((packet, index) => {
      const chunk = audio.chunks[index];
      expect(packet.timestamp).toBeCloseTo((chunk.timestampUs - originUs) / 1e6, 4);
      expect(packet.data).toEqual(new Uint8Array(chunk.data));
    });
  });

  it('leaves out the audio that ends before the first frame', async () => {
    const cut = readMediaSample();
    const audio = cut.audio;
    if (audio === null) {
      throw new Error('The sample has audio.');
    }
    const originUs = cut.video.chunks[0].timestampUs;
    const early: EncodedChunkRecord = {
      ...audio.chunks[0],
      timestampUs: audio.chunks[0].timestampUs - 40_000,
    };
    const muxed = await muxClip(
      { ...cut, audio: { ...audio, chunks: [early, ...audio.chunks] } },
      META,
    );

    expect(early.timestampUs + early.durationUs).toBeLessThanOrEqual(originUs);
    expect((await readBack(muxed.mp4)).audio?.packets).toHaveLength(audio.chunks.length);
  });

  it('gives frames.json the cut frame times, validated against FRAMES_SCHEMA', async () => {
    const cut = readMediaSample();
    const { frames } = await muxClip(cut, { camera: 'phone-front', segment: 'scramble' });
    const validate = new Ajv2020({ allowUnionTypes: true, allErrors: true }).compile(FRAMES_SCHEMA);

    expect(validate(frames), JSON.stringify(validate.errors)).toBe(true);
    expect(frames).toEqual({
      schema: 2,
      camera: 'phone-front',
      segment: 'scramble',
      ...cut.frames,
    });
    expect(Object.keys(frames)).toEqual([
      'schema',
      'camera',
      'segment',
      't0HostMs',
      'dtMs',
      'keyframes',
      'arrival',
    ]);
  });

  it('muxes the video alone when the cut has no audio, or its encoder never described it', async () => {
    const cut = readMediaSample();
    for (const audio of [null, cut.audio === null ? null : { ...cut.audio, decoderConfig: null }]) {
      const muxed = await muxClip({ ...cut, audio }, META);
      const mp4 = await readBack(muxed.mp4);
      expect(mp4.tracks).toBe(1);
      expect(mp4.audio).toBeNull();
      expect(muxed.info.audio).toBeNull();
      expect(mp4.video?.packets).toHaveLength(cut.video.chunks.length);
    }
  });

  it('lets a frame without a duration last until the next one, and the last such frame the median interval', async () => {
    const cut = readMediaSample();
    const chunks = cut.video.chunks.map((chunk) => ({ ...chunk, durationUs: 0 }));
    const intervals = chunks
      .slice(1)
      .map((chunk, index) => chunk.timestampUs - chunks[index].timestampUs)
      .sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    const muxed = await muxClip(withVideoChunks(cut, chunks), META);
    const mp4 = await readBack(muxed.mp4);

    const spanUs = chunks[chunks.length - 1].timestampUs - chunks[0].timestampUs;
    expect(muxed.info.durationMs).toBeCloseTo((spanUs + median) / 1000, 6);
    expect((mp4.video?.durationS ?? 0) * 1000).toBeCloseTo(muxed.info.durationMs, 0);
    expect(mp4.video?.packets.at(-1)?.duration).toBeCloseTo(median / 1e6, 4);
  });

  it('keeps the colour space and the frame size of the decoder config, and takes the size from the cut when it has none', async () => {
    const cut = readMediaSample();
    const config = cut.video.decoderConfig;
    if (config === null) {
      throw new Error('The sample has a decoder config.');
    }
    const sizeless: VideoDecoderConfig = { ...config };
    delete sizeless.codedWidth;
    delete sizeless.codedHeight;
    const muxed: MuxedClip = await muxClip(
      { ...cut, video: { ...cut.video, decoderConfig: sizeless } },
      META,
    );
    const mp4 = await readBack(muxed.mp4);

    expect([mp4.video?.width, mp4.video?.height]).toEqual([1920, 1080]);
    // smpte170m (6) primaries, transfer and matrix, limited range: the sample's colour space.
    expect(mp4.video?.codecString).toBe('vp09.00.40.08.01.06.06.06.00');
  });
});

describe('muxClip with H.264 and AAC', () => {
  // What the real devices encode, which CI's Chromium cannot (docs/TOOLCHAIN.md): the sample's
  // chunks and times, described as H.264 High 4.0 (an avcC with a parameter set of each kind) and
  // AAC-LC at 48 kHz mono (its AudioSpecificConfig). The muxer copies the bytes without reading
  // them, so the file's structure is what is tested here, not its pictures.
  const AVCC = new Uint8Array([
    0x01, 0x64, 0x00, 0x28, 0xff, 0xe1, 0x00, 0x0a, 0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78,
    0x02, 0x27, 0x01, 0x00, 0x04, 0x68, 0xeb, 0xe3, 0xcb,
  ]);
  const AUDIO_SPECIFIC_CONFIG = new Uint8Array([0x11, 0x88]);

  it("writes an avc1 track with the encoder's avcC and an mp4a track, which read back as such", async () => {
    const cut = readMediaSample();
    const audio = cut.audio;
    if (audio === null) {
      throw new Error('The sample has audio.');
    }
    const h264: Cut = {
      ...cut,
      video: {
        ...cut.video,
        codec: 'avc1.640028',
        decoderConfig: {
          codec: 'avc1.640028',
          codedWidth: 1920,
          codedHeight: 1080,
          description: AVCC.slice().buffer,
        },
      },
      audio: {
        ...audio,
        codec: 'mp4a.40.2',
        decoderConfig: {
          codec: 'mp4a.40.2',
          sampleRate: 48_000,
          numberOfChannels: 1,
          description: AUDIO_SPECIFIC_CONFIG.slice().buffer,
        },
      },
    };
    const muxed = await muxClip(h264, META);
    const mp4 = await readBack(muxed.mp4);

    expect(muxed.info).toMatchObject({ codec: 'avc1.640028', audio: 'mp4a.40.2' });
    expect(mp4.boxes).toEqual(['ftyp', 'moov', 'mdat']);
    expect(mp4.video).toMatchObject({ codec: 'avc', codecString: 'avc1.640028' });
    expect(mp4.audio).toMatchObject({
      codec: 'aac',
      codecString: 'mp4a.40.2',
      sampleRate: 48_000,
      channels: 1,
    });
    expect(mp4.mimeType).toBe('video/mp4; codecs="avc1.640028, mp4a.40.2"');
    const input = new Input({ source: new BufferSource(muxed.mp4), formats: ALL_FORMATS });
    const config = await (await input.getPrimaryVideoTrack())?.getDecoderConfig();
    expect(new Uint8Array(config?.description as ArrayBuffer)).toEqual(AVCC);
    expect(mp4.video?.packets).toHaveLength(cut.video.chunks.length);
    expect(mp4.audio?.packets).toHaveLength(audio.chunks.length);
    const times = frameTimesMs(muxed.frames.dtMs);
    mp4.video?.packets.forEach((packet, index) => {
      expect(Math.abs(packet.timestamp * 1000 - times[index])).toBeLessThan(0.1);
    });
  });
});

describe('muxClip refuses', () => {
  it('an empty cut', async () => {
    const cut = readMediaSample();
    await expect(muxClip(withVideoChunks(cut, []), META)).rejects.toThrow(
      'Cannot mux an empty cut: it has no video frames.',
    );
  });

  it('a cut whose start is older than the buffer, saying how late it begins', async () => {
    const cut = readMediaSample();
    const truncated: Cut = {
      ...cut,
      startHostMs: cut.frames.t0HostMs - 1234.5,
      truncatedStart: true,
    };
    await expect(muxClip(truncated, META)).rejects.toThrow(
      'Cannot mux a cut whose start is older than the buffer (truncatedStart): its first frame is ' +
        '1234.5 ms after the start asked for, which the buffer no longer holds.',
    );
  });

  it('a cut that does not begin at a keyframe, or without a decoder config', async () => {
    const cut = readMediaSample();
    await expect(muxClip(withVideoChunks(cut, cut.video.chunks.slice(1)), META)).rejects.toThrow(
      'Cannot mux a cut that does not begin with a keyframe.',
    );
    await expect(
      muxClip({ ...cut, video: { ...cut.video, decoderConfig: null } }, META),
    ).rejects.toThrow("Cannot mux a cut without the video encoder's decoder config.");
  });

  it('a codec the capture does not encode, and names that cannot name a clip', async () => {
    const cut = readMediaSample();
    const config = cut.video.decoderConfig;
    if (config === null) {
      throw new Error('The sample has a decoder config.');
    }
    await expect(
      muxClip(
        { ...cut, video: { ...cut.video, decoderConfig: { ...config, codec: 'vp8' } } },
        META,
      ),
    ).rejects.toThrow('Cannot mux video coded as vp8: the capture encodes H.264 or VP9.');
    await expect(muxClip(cut, { camera: 'Laptop', segment: 'solve' })).rejects.toThrow(
      '"Laptop" is not a camera label',
    );
    await expect(
      muxClip(cut, { camera: 'laptop', segment: 'inspection' as 'solve' }),
    ).rejects.toThrow('"inspection" is not a segment (scramble or solve).');
  });
});
