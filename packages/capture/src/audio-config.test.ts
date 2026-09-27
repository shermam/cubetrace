import { describe, expect, it } from 'vitest';

import {
  aacAudioSpecificConfig,
  audioDecoderConfigFor,
  isAudioDecoderConfigComplete,
} from './audio-config';

// The decoder config a clip gets when the audio encoder describes its output poorly or not at all
// (T2.9, issue #33): the AudioSpecificConfig of AAC-LC, bit by bit, and the completion of a config.

function hex(bytes: AllowSharedBufferSource | undefined): string {
  if (bytes === undefined) {
    return 'none';
  }
  const view = ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
  return Array.from(view, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

describe('aacAudioSpecificConfig', () => {
  it('writes the object type, the frequency index and the channels, as encoders do', () => {
    // 00010 0011 0001 000: AAC-LC, 48 kHz (index 3), mono.
    expect(hex(aacAudioSpecificConfig(48_000, 1))).toBe('11 88');
    // 00010 0100 0010 000: 44.1 kHz (index 4), stereo.
    expect(hex(aacAudioSpecificConfig(44_100, 2))).toBe('12 10');
    expect(hex(aacAudioSpecificConfig(48_000, 2))).toBe('11 90');
    expect(hex(aacAudioSpecificConfig(16_000, 1))).toBe('14 08');
    // 8 channels are configuration 7 (7.1).
    expect(hex(aacAudioSpecificConfig(48_000, 8))).toBe('11 b8');
  });

  it('spells out a rate the table lacks in 24 bits', () => {
    // 00010 1111 then 50,000 (0x00c350) in 24 bits, 0001, 000.
    expect(hex(aacAudioSpecificConfig(50_000, 1))).toBe('17 80 61 a8 08');
  });

  it('refuses what AAC-LC cannot describe by itself', () => {
    expect(() => aacAudioSpecificConfig(0, 1)).toThrow(RangeError);
    expect(() => aacAudioSpecificConfig(48_000.5, 1)).toThrow(RangeError);
    expect(() => aacAudioSpecificConfig(48_000, 0)).toThrow(RangeError);
    expect(() => aacAudioSpecificConfig(48_000, 7)).toThrow('cannot describe 7 channels');
    expect(() => aacAudioSpecificConfig(48_000, 9)).toThrow(RangeError);
  });
});

describe('audioDecoderConfigFor', () => {
  const AAC: AudioEncoderConfig = {
    codec: 'mp4a.40.2',
    sampleRate: 48_000,
    numberOfChannels: 1,
    bitrate: 128_000,
  };
  const OPUS: AudioEncoderConfig = { ...AAC, codec: 'opus' };

  it("makes the whole config from the encoder's when the encoder gave none", () => {
    const aac = audioDecoderConfigFor(AAC);
    expect({ ...aac, description: hex(aac.description) }).toEqual({
      codec: 'mp4a.40.2',
      sampleRate: 48_000,
      numberOfChannels: 1,
      description: '11 88',
    });
    expect(audioDecoderConfigFor(OPUS)).toEqual({
      codec: 'opus',
      sampleRate: 48_000,
      numberOfChannels: 1,
    });
  });

  it('says whether what the encoder gave will do as it is', () => {
    expect(isAudioDecoderConfigComplete(undefined)).toBe(false);
    expect(
      isAudioDecoderConfigComplete({ codec: 'opus', sampleRate: 48_000, numberOfChannels: 2 }),
    ).toBe(true);
    const aac = { codec: 'mp4a.40.2', sampleRate: 48_000, numberOfChannels: 1 };
    expect(isAudioDecoderConfigComplete(aac)).toBe(false);
    expect(
      isAudioDecoderConfigComplete({ ...aac, description: new Uint8Array([0x11, 0x88]) }),
    ).toBe(true);
    expect(isAudioDecoderConfigComplete({ ...aac, codec: 'opus', sampleRate: 0 })).toBe(false);
  });

  it('keeps what the encoder gave, and completes what it left out', () => {
    const description = new Uint8Array([0x12, 0x10]).buffer;
    expect(
      audioDecoderConfigFor(AAC, {
        codec: 'mp4a.40.2',
        sampleRate: 44_100,
        numberOfChannels: 2,
        description,
      }),
    ).toEqual({ codec: 'mp4a.40.2', sampleRate: 44_100, numberOfChannels: 2, description });
    // No description, and no sample rate: both from the encoder's config.
    const partial = audioDecoderConfigFor(AAC, {
      codec: 'mp4a.40.2',
      sampleRate: 0,
      numberOfChannels: 1,
    });
    expect(partial.sampleRate).toBe(48_000);
    expect(hex(partial.description)).toBe('11 88');
  });
});
