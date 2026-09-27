// The audio decoder config of a clip when the encoder gives none, or an incomplete one (docs/PLAN.md,
// T2.9; issue #33). The muxer needs one to write the audio track (mediabunny wants the codec, an
// integer sample rate and channel count), and an MP4's AAC track needs the AudioSpecificConfig in its
// `esds` to be played; WebCodecs hands the decoder config over with the encoder's first chunk, which
// a platform encoder might not do. Plain TypeScript, tested in Node.

/** AAC-LC, the capture's first choice of audio codec (capture-worker.ts). */
const AAC_LC = 'mp4a.40.2';

/** The sampling frequencies of MPEG-4 audio, by their index (ISO/IEC 14496-3, 1.6.3.4). */
const SAMPLING_FREQUENCIES: readonly number[] = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8000,
  7350,
];

/**
 * The AudioSpecificConfig of AAC-LC (ISO/IEC 14496-3, 1.6.2.1), the `description` of an `mp4a.40.2`
 * decoder config: 5 bits of audioObjectType (2, AAC-LC), 4 of samplingFrequencyIndex (15 and the
 * frequency in 24 bits for a rate the table lacks), 4 of channelConfiguration (the channel count, 1
 * to 6, and 7 for 8 channels), then the GASpecificConfig's 3 bits, all 0 (frames of 1024 samples, no
 * core coder, no extension). 48 kHz mono is `11 88`, 44.1 kHz stereo `12 10`. Throws a RangeError
 * for a rate or a channel count it cannot describe.
 */
export function aacAudioSpecificConfig(sampleRate: number, numberOfChannels: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate >= 2 ** 24) {
    throw new RangeError(`AAC cannot describe a sample rate of ${String(sampleRate)} Hz.`);
  }
  const channels = numberOfChannels === 8 ? 7 : numberOfChannels;
  if (!Number.isInteger(channels) || channels < 1 || channels > 7 || numberOfChannels === 7) {
    throw new RangeError(`AAC-LC cannot describe ${String(numberOfChannels)} channels by itself.`);
  }
  const bits = new BitWriter();
  bits.write(2, 5);
  const index = SAMPLING_FREQUENCIES.indexOf(sampleRate);
  if (index >= 0) {
    bits.write(index, 4);
  } else {
    bits.write(15, 4);
    bits.write(sampleRate, 24);
  }
  bits.write(channels, 4);
  bits.write(0, 3);
  return bits.bytes();
}

/**
 * The decoder config of the output of an audio encoder configured with `config`: what the encoder
 * gave (`given`, from its first chunk), completed from `config` where it lacks the sample rate or
 * the channel count, and, for AAC-LC, the AudioSpecificConfig where it lacks a `description`; all
 * of it from `config` when it gave none. Opus needs no description: the muxer writes its `dOps`
 * from the channel count and the sample rate. Throws a RangeError when an AAC description cannot be
 * made (see {@link aacAudioSpecificConfig}).
 */
export function audioDecoderConfigFor(
  config: AudioEncoderConfig,
  given?: AudioDecoderConfig,
): AudioDecoderConfig {
  const codec = given?.codec ?? config.codec;
  const sampleRate = positiveInteger(given?.sampleRate) ?? config.sampleRate;
  const numberOfChannels = positiveInteger(given?.numberOfChannels) ?? config.numberOfChannels;
  const completed: AudioDecoderConfig = { ...given, codec, sampleRate, numberOfChannels };
  if (codec === AAC_LC && completed.description === undefined) {
    return {
      ...completed,
      description: aacAudioSpecificConfig(sampleRate, numberOfChannels).buffer,
    };
  }
  return completed;
}

/**
 * Whether `given`, an audio encoder's decoder config, has what the muxer needs as it is: a sample rate
 * and a channel count, and for AAC-LC a description. False for none (the encoder gave no config).
 */
export function isAudioDecoderConfigComplete(given: AudioDecoderConfig | undefined): boolean {
  return (
    given !== undefined &&
    positiveInteger(given.sampleRate) !== undefined &&
    positiveInteger(given.numberOfChannels) !== undefined &&
    (given.codec !== AAC_LC || given.description !== undefined)
  );
}

function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Bits written most significant first, into as many bytes as they need (the last one padded). */
class BitWriter {
  readonly #bits: number[] = [];

  write(value: number, width: number): void {
    for (let bit = width - 1; bit >= 0; bit--) {
      this.#bits.push(Math.floor(value / 2 ** bit) % 2);
    }
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.#bits.length / 8));
    this.#bits.forEach((bit, at) => {
      out[at >> 3] |= bit << (7 - (at & 7));
    });
    return out;
  }
}
