import {
  SLEEP_HINT_AFTER_MS,
  describeDisconnect,
  formatIdle,
  idleDisconnectReason,
} from './disconnect-reason';

describe('the words for the end of a connection', () => {
  it('idleDisconnectReason names the minutes', () => {
    expect(idleDisconnectReason(5)).toBe(
      "Disconnected after 5 minutes without a turn, to save the cube's battery.",
    );
    expect(idleDisconnectReason(1)).toBe(
      "Disconnected after 1 minute without a turn, to save the cube's battery.",
    );
  });

  it.each([
    [0, 'less than 1 s'],
    [999, 'less than 1 s'],
    [1000, '1 s'],
    [59_999, '59 s'],
    [60_000, '1 min'],
    [372_000, '6 min 12 s'],
    [3_599_999, '59 min 59 s'],
    [3_600_000, '1 h'],
    [3_900_000, '1 h 5 min'],
    [-5, 'less than 1 s'],
  ])('formatIdle(%i) is "%s"', (ms, text) => {
    expect(formatIdle(ms)).toBe(text);
  });

  it("describeDisconnect: the connection's reason first, then the idle time and the hidden tab", () => {
    expect(
      describeDisconnect({
        reason: 'The Bluetooth connection was closed.',
        idleMs: 372_000,
        hidden: true,
      }),
    ).toBe(
      'The Bluetooth connection was closed. It happened after 6 min 12 s without a turn, while ' +
        'this tab was in the background. GAN cubes go to sleep after a few minutes without turns.',
    );
    expect(describeDisconnect({ reason: 'Out of range.', idleMs: 4200, hidden: false })).toBe(
      'Out of range. It happened after 4 s without a turn.',
    );
  });

  it('describeDisconnect: the sleep hint only past two minutes; a reason gets its full stop', () => {
    expect(describeDisconnect({ reason: 'Lost', idleMs: SLEEP_HINT_AFTER_MS, hidden: false })).toBe(
      'Lost. It happened after 2 min without a turn.',
    );
    expect(
      describeDisconnect({ reason: '  ', idleMs: SLEEP_HINT_AFTER_MS + 1000, hidden: false }),
    ).toBe(
      'The cube disconnected. It happened after 2 min 1 s without a turn. GAN cubes go to sleep ' +
        'after a few minutes without turns.',
    );
  });
});
