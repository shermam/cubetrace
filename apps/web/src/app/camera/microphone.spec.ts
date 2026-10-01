import type { MicrophoneInfo } from '@cubetrace/core';

import {
  DEFAULT_MICROPHONE,
  microphoneConstraints,
  microphoneInfo,
  microphoneText,
  processingKept,
  processingNotice,
  type MicrophoneSettings,
} from './microphone';

/** A track of the microphone called `label` that reports `settings`. */
function track(settings: MicrophoneSettings, label = 'MacBook Pro Microphone (Built-in)') {
  return { label, getSettings: () => settings };
}

/** What Chromium 141's fake microphone reports raw (docs/TOOLCHAIN.md, "Microphone"). */
const CHROMIUM_RAW: MicrophoneSettings = {
  autoGainControl: false,
  channelCount: 2,
  deviceId: 'default',
  echoCancellation: false,
  groupId: '343711854dc0ffcff5c916b57138d46bbaf98f105812ab76e0d90102f2dcf210',
  noiseSuppression: false,
  sampleRate: 44_100,
  sampleSize: 16,
  voiceIsolation: false,
};

/** What it reports with the browser's defaults, `{audio: true}`. */
const CHROMIUM_DEFAULT: MicrophoneSettings = {
  ...CHROMIUM_RAW,
  autoGainControl: true,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  sampleRate: 48_000,
};

const RAW: MicrophoneInfo = {
  label: 'Fake Default Audio Input',
  processing: 'raw',
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  voiceIsolation: false,
  sampleRate: 44_100,
  channelCount: 2,
};

describe('microphoneConstraints', () => {
  it('asks for every voice processing off, one channel at 48 kHz as ideals, when raw', () => {
    expect(microphoneConstraints('raw')).toEqual({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        voiceIsolation: false,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48_000 },
      },
    });
    // Nothing a device could fail: no `exact`, no device.
    expect(JSON.stringify(microphoneConstraints('raw'))).not.toMatch(/exact|min|max|deviceId/);
  });

  it("asks for the browser's defaults for voice, as before T2.12", () => {
    expect(microphoneConstraints('voice')).toEqual({ audio: true });
    expect(DEFAULT_MICROPHONE).toEqual({ audio: true });
  });
});

describe('microphoneInfo', () => {
  it('keeps what was asked, the label and what the browser applied, not the device', () => {
    const info = microphoneInfo(track(CHROMIUM_RAW, 'Fake Default Audio Input'), 'raw');
    expect(info).toEqual(RAW);
    // In the order of the schema's fields, as session.json is written.
    expect(Object.keys(info)).toEqual(Object.keys(RAW));
    expect(info).not.toHaveProperty('deviceId');
    expect(info).not.toHaveProperty('groupId');

    expect(microphoneInfo(track(CHROMIUM_DEFAULT, 'Fake Default Audio Input'), 'voice')).toEqual({
      ...RAW,
      processing: 'voice',
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      sampleRate: 48_000,
      channelCount: 1,
    });
  });

  it('says null for what the browser does not report, or reports as something else', () => {
    expect(microphoneInfo(track({}), 'raw')).toEqual({
      label: 'MacBook Pro Microphone (Built-in)',
      processing: 'raw',
      echoCancellation: null,
      noiseSuppression: null,
      autoGainControl: null,
      voiceIsolation: null,
      sampleRate: null,
      channelCount: null,
    });
    const odd = { sampleRate: 0, channelCount: 1.5, noiseSuppression: 'yes' } as unknown;
    expect(microphoneInfo(track(odd as MicrophoneSettings), 'raw')).toMatchObject({
      noiseSuppression: null,
      sampleRate: null,
      channelCount: null,
    });
    expect(
      microphoneInfo(track({ sampleRate: Number.NaN, channelCount: -1 }), 'raw'),
    ).toMatchObject({ sampleRate: null, channelCount: null });
  });

  it("counts Chrome's echo cancellation modes as on", () => {
    for (const mode of ['all', 'remote-only']) {
      expect(microphoneInfo(track({ echoCancellation: mode }), 'raw').echoCancellation).toBe(true);
    }
    expect(microphoneInfo(track({ echoCancellation: 'loud' }), 'raw').echoCancellation).toBeNull();
  });
});

describe('the microphone in words', () => {
  it('says mic raw, or mic voice, as asked', () => {
    expect(microphoneText(RAW)).toBe('mic raw');
    expect(processingNotice(RAW)).toBeNull();
    // Raw asked, nothing reported: nothing is known to be on.
    const unreported: MicrophoneInfo = {
      ...RAW,
      echoCancellation: null,
      noiseSuppression: null,
      autoGainControl: null,
      voiceIsolation: null,
    };
    expect(microphoneText(unreported)).toBe('mic raw');
    expect(processingKept(unreported)).toEqual([]);
    // Voice asked: the processing on is what was asked for.
    const voice: MicrophoneInfo = {
      ...RAW,
      processing: 'voice',
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    expect(microphoneText(voice)).toBe('mic voice');
    expect(processingKept(voice)).toEqual([]);
    expect(processingNotice(voice)).toBeNull();
  });

  it('says when the browser kept some processing on although raw was asked for, and which', () => {
    const one: MicrophoneInfo = { ...RAW, noiseSuppression: true };
    expect(processingKept(one)).toEqual(['noise suppression']);
    expect(microphoneText(one)).toBe('mic: the browser kept processing on');
    expect(processingNotice(one)).toBe(
      "The microphone is not raw: the browser kept its noise suppression on although Raw was asked for, so the sound may lack the cube's clicks.",
    );

    const two: MicrophoneInfo = { ...RAW, echoCancellation: true, voiceIsolation: true };
    expect(processingNotice(two)).toBe(
      "The microphone is not raw: the browser kept its echo cancellation and voice isolation on although Raw was asked for, so the sound may lack the cube's clicks.",
    );

    const all: MicrophoneInfo = {
      ...RAW,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceIsolation: true,
    };
    expect(processingKept(all)).toEqual([
      'echo cancellation',
      'noise suppression',
      'automatic gain control',
      'voice isolation',
    ]);
    expect(processingNotice(all)).toContain(
      'kept its echo cancellation, noise suppression, automatic gain control and voice isolation on',
    );
  });
});
