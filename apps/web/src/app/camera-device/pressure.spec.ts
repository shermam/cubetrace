import { settle } from '../device/fake-browser';
import {
  PRESSURE_SAMPLE_INTERVAL_MS,
  pressureSources,
  watchPressure,
  type PressureReading,
} from './pressure';
import { fakePressure } from './pressure-testing';

// The phone's pressure for its `state` messages (docs/PLAN.md T5.1, the Compute Pressure API): the
// observer behind a fake, absent, with `cpu` only, with `thermals`, refusing.

describe('watchPressure', () => {
  function watch(Observer: unknown): {
    readings: (PressureReading | null)[];
    stop: () => void;
  } {
    const readings: (PressureReading | null)[] = [];
    const stop = watchPressure(Observer, (reading) => {
      readings.push(reading);
    });
    return { readings, stop };
  }

  it('says null once where the browser has no PressureObserver', () => {
    const { readings } = watch(undefined);
    expect(readings).toEqual([null]);
  });

  it('observes the CPU where the browser lists it alone, every 2 s, and gives each change of its state', async () => {
    const fake = fakePressure({ sources: ['cpu'] });
    const { readings, stop } = watch(fake.Observer);
    await settle();
    expect(fake.observed).toEqual([
      { source: 'cpu', sampleInterval: PRESSURE_SAMPLE_INTERVAL_MS, refused: false },
    ]);
    expect(readings).toEqual([]);
    fake.emit('nominal', 'cpu');
    fake.emit('nominal', 'cpu');
    fake.emit('fair', 'cpu');
    // A record of another source is not this observer's.
    fake.emit('critical', 'thermals');
    expect(readings).toEqual([
      { state: 'nominal', source: 'cpu' },
      { state: 'fair', source: 'cpu' },
    ]);
    stop();
    expect(fake.disconnected()).toBe(1);
    fake.emit('serious', 'cpu');
    expect(readings).toHaveLength(2);
  });

  it('prefers the thermals where the browser lists them', async () => {
    const fake = fakePressure({ sources: ['cpu', 'thermals'] });
    const { readings } = watch(fake.Observer);
    await settle();
    expect(fake.observed.map((call) => call.source)).toEqual(['thermals']);
    fake.emit('serious', 'thermals');
    expect(readings).toEqual([{ state: 'serious', source: 'thermals' }]);
  });

  it('falls back on the CPU when the thermals are refused, and on the CPU alone without a list', async () => {
    const refusing = fakePressure({ sources: ['thermals', 'cpu'], refuse: ['thermals'] });
    const first = watch(refusing.Observer);
    await settle();
    expect(refusing.observed.map((call) => [call.source, call.refused])).toEqual([
      ['thermals', true],
      ['cpu', false],
    ]);
    refusing.emit('critical', 'cpu');
    expect(first.readings).toEqual([{ state: 'critical', source: 'cpu' }]);

    const unlisted = fakePressure({ sources: null });
    const second = watch(unlisted.Observer);
    await settle();
    expect(unlisted.observed.map((call) => call.source)).toEqual(['cpu']);
    unlisted.emit('fair', 'cpu');
    expect(second.readings).toEqual([{ state: 'fair', source: 'cpu' }]);
  });

  it('says null once when the browser refuses every source, or lists none this reads', async () => {
    const refusing = fakePressure({ sources: ['cpu'], refuse: ['cpu'] });
    const first = watch(refusing.Observer);
    await settle();
    expect(first.readings).toEqual([null]);

    const other = fakePressure({ sources: ['gpu'] });
    const second = watch(other.Observer);
    await settle();
    expect(other.observed).toEqual([]);
    expect(second.readings).toEqual([null]);
  });

  it('ignores a record of a state it does not know, and says nothing once stopped before the answer', async () => {
    const fake = fakePressure({ sources: ['cpu'] });
    const { readings, stop } = watch(fake.Observer);
    await settle();
    fake.emit('melting', 'cpu');
    expect(readings).toEqual([]);

    const refusing = fakePressure({ sources: ['cpu'], refuse: ['cpu'] });
    const late = watch(refusing.Observer);
    late.stop();
    await settle();
    expect(late.readings).toEqual([]);
    stop();
  });

  it('orders the sources: the thermals first, then the CPU, the CPU alone without a list', () => {
    expect(pressureSources(['cpu', 'thermals'])).toEqual(['thermals', 'cpu']);
    expect(pressureSources(['cpu'])).toEqual(['cpu']);
    expect(pressureSources(['thermals'])).toEqual(['thermals']);
    expect(pressureSources(['gpu'])).toEqual([]);
    expect(pressureSources(undefined)).toEqual(['cpu']);
  });
});
