import { controlValuesOf, controlsOf } from '@cubetrace/capture';
import {
  FakeTimers,
  MemoryTransport,
  MessageLink,
  type ControlsReport,
  type Message,
} from '@cubetrace/rtc';

import { FAKE_PHONE_FRONT, FAKE_PHONE_REAR } from '../device/fake-browser';
import { controlGroups } from './camera-controls';
import {
  CONTROLS_WAIT_MS,
  NO_ANSWER_TEXT,
  RemoteControlsSource,
  SET_CONTROLS_TIMEOUT_MS,
  driftReset,
  type RemoteControlsOutcome,
} from './remote-controls-source';

/** The ThinkPhone's rear camera's controls, as its `controls` message carries them (T5.2). */
const REPORT: ControlsReport = {
  type: 'controls',
  controls: controlsOf(FAKE_PHONE_REAR.capabilities, FAKE_PHONE_REAR.settings),
  values: controlValuesOf(FAKE_PHONE_REAR.settings),
  applied: { exposureMode: 'continuous', focusMode: 'continuous', whiteBalanceMode: 'continuous' },
  drift: [],
  remoteMs: 1_790_000_000_000,
};

describe('RemoteControlsSource', () => {
  let timers: FakeTimers;
  let host: MessageLink;
  let phone: MessageLink;
  let received: Message[];
  let outcomes: RemoteControlsOutcome[];
  let reports: ControlsReport[];
  let source: RemoteControlsSource;
  let detach: () => void;

  /** The frames on their way arrive (the pair's delay is 1 ms). */
  function deliver(): void {
    timers.advance(5);
  }

  /** The phone answers with its controls, `changes` made to them. */
  function answer(changes: Partial<ControlsReport> = {}): void {
    phone.send({ ...REPORT, ...changes });
    deliver();
  }

  beforeEach(() => {
    timers = new FakeTimers();
    const [a, b] = MemoryTransport.pair({ delayMs: 1, timers });
    host = new MessageLink(a);
    phone = new MessageLink(b);
    received = [];
    phone.onMessage((message) => {
      received.push(message);
    });
    outcomes = [];
    reports = [];
    source = new RemoteControlsSource({
      timers,
      onOutcome: (outcome) => {
        outcomes.push(outcome);
      },
      onReport: (report) => {
        reports.push(report);
      },
    });
    detach = source.attach(host, true);
  });

  it("shows the panel's groups from the phone's controls message", () => {
    expect(source.state()).toBe('waiting');
    expect(source.controls()).toBeNull();
    expect(source.values()).toEqual({});
    answer();
    expect(source.state()).toBe('ready');
    expect(controlGroups(source.controls(), source.values()).map((group) => group.title)).toEqual([
      'Exposure',
      'Focus',
      'White balance',
      'Zoom',
    ]);
    expect(source.values().focusMode).toBe('continuous');
    expect(source.applied()).toEqual(REPORT.applied);
    expect(source.drift()).toEqual([]);
    expect(reports).toHaveLength(1);
    // No change was asked for: nothing to report on.
    expect(outcomes).toEqual([]);
  });

  it("sends a change, in flight until the phone's controls answer it", async () => {
    answer();
    const done = source.set('focusDistance', 0.35);
    expect(source.busy()).toBe(true);
    deliver();
    expect(received).toEqual([{ type: 'set-controls', values: { focusDistance: 0.35 } }]);
    timers.advance(40);
    answer({ values: { ...REPORT.values, focusMode: 'manual', focusDistance: 0.35 } });
    await done;
    expect(source.busy()).toBe(false);
    expect(source.error()).toBeNull();
    expect(source.values()).toMatchObject({ focusMode: 'manual', focusDistance: 0.35 });
    expect(outcomes).toEqual([{ set: ['focusDistance'], outcome: 'ok', message: null, ms: 46 }]);
  });

  it('says what the phone refused, and lets the next change go', async () => {
    answer();
    const done = source.set('zoom', 3);
    deliver();
    phone.send({ type: 'controls-failed', message: 'The camera refused the change (no zoom).' });
    deliver();
    await done;
    expect(source.busy()).toBe(false);
    expect(source.error()).toBe('The camera refused the change (no zoom).');
    expect(outcomes.map((o) => [o.outcome, o.message])).toEqual([
      ['failed', 'The camera refused the change (no zoom).'],
    ]);
    // The phone's controls as they stand come after its refusal: no outcome of their own.
    answer();
    expect(outcomes).toHaveLength(1);
    expect(source.error()).toBe('The camera refused the change (no zoom).');
    // The next change clears it.
    void source.set('torch', true);
    expect(source.error()).toBeNull();
  });

  it('gives a change up after 3 s without an answer: the phone did not answer', async () => {
    answer();
    const done = source.set('exposureMode', 'manual');
    // One change at a time: another waits for the first's answer.
    void source.set('focusMode', 'manual');
    deliver();
    expect(received).toHaveLength(1);
    timers.advance(SET_CONTROLS_TIMEOUT_MS);
    await done;
    expect(source.busy()).toBe(false);
    expect(source.error()).toBe(NO_ANSWER_TEXT);
    expect(outcomes).toEqual([
      { set: ['exposureMode'], outcome: 'no-answer', message: NO_ANSWER_TEXT, ms: 3000 },
    ]);
  });

  it('sends Reset to auto, and resets what the camera changed by itself to the automatic modes', async () => {
    answer();
    const reset = source.reset();
    deliver();
    answer();
    await reset;
    expect(received).toEqual([{ type: 'set-controls', reset: true }]);
    expect(outcomes.at(-1)).toMatchObject({ set: ['reset'], outcome: 'ok' });

    answer({
      drift: [
        { name: 'zoom', expected: 2.5, actual: 1 },
        { name: 'focusDistance', expected: 0.35, actual: 1.2 },
      ],
    });
    expect(source.drift()).toHaveLength(2);
    expect(reports.at(-1)?.drift).toHaveLength(2);
    const back = source.resetDrift();
    deliver();
    answer();
    await back;
    expect(received.at(-1)).toEqual({
      type: 'set-controls',
      values: { focusMode: 'continuous', zoom: 2.5 },
    });
    expect(outcomes.at(-1)).toMatchObject({ set: ['focusMode', 'zoom'], outcome: 'ok' });
    // Nothing drifted: nothing sent.
    await source.resetDrift();
    expect(received).toHaveLength(2);
  });

  it("says a phone's build has no remote controls when none come within 5 s, and a phone without a camera", () => {
    timers.advance(CONTROLS_WAIT_MS - 1);
    expect(source.state()).toBe('waiting');
    timers.advance(1);
    expect(source.state()).toBe('unsupported');
    // They come after all (a busy phone): ready.
    answer();
    expect(source.state()).toBe('ready');
    // Its camera off (a hello without one): no controls; on again, they are awaited.
    source.cameraChanged(false);
    expect(source.state()).toBe('no-camera');
    expect(source.controls()).toBeNull();
    source.cameraChanged(true);
    expect(source.state()).toBe('waiting');
    answer();
    expect(source.state()).toBe('ready');
  });

  it('ends a change in flight when the connection does, and says when the phone is not connected', async () => {
    answer();
    const done = source.set('torch', true);
    detach();
    await done;
    expect(source.busy()).toBe(false);
    expect(outcomes).toEqual([
      {
        set: ['torch'],
        outcome: 'no-answer',
        message: "The phone's connection ended before it answered.",
        ms: 0,
      },
    ]);
    // Its last controls stay to be seen; a change says it cannot go.
    expect(source.state()).toBe('ready');
    await source.set('torch', false);
    expect(source.error()).toBe('The phone is not connected.');
    expect(outcomes).toHaveLength(1);
    // Nothing more arrives from the old connection's link.
    phone.send({ ...REPORT, values: {} });
    deliver();
    expect(source.values()).toEqual(REPORT.values);
  });
});

describe('driftReset', () => {
  it('sets the automatic mode of each drifted group, and the zoom and the torch back as applied', () => {
    const rear = controlsOf(FAKE_PHONE_REAR.capabilities, FAKE_PHONE_REAR.settings);
    expect(
      driftReset(
        [
          { name: 'torch', expected: true, actual: false },
          { name: 'focusMode', expected: 'continuous', actual: 'manual' },
          { name: 'exposureTime', expected: 20, actual: 33 },
        ],
        rear,
      ),
    ).toEqual({ exposureMode: 'continuous', focusMode: 'continuous', torch: true });
    // The front camera lists only manual focus; its setting's continuous is its automatic mode.
    const front = controlsOf(FAKE_PHONE_FRONT.capabilities, FAKE_PHONE_FRONT.settings);
    expect(driftReset([{ name: 'focusDistance', expected: 0.3, actual: 0.5 }], front)).toEqual({
      focusMode: 'continuous',
    });
    expect(
      driftReset([{ name: 'focusMode', expected: 'continuous', actual: 'manual' }], null),
    ).toEqual({});
  });
});
