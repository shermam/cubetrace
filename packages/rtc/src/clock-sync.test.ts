import { RemoteClockFit } from '@cubetrace/core';
import { describe, expect, it } from 'vitest';

import {
  ClockPinger,
  FakeTimers,
  MemoryTransport,
  MessageLink,
  PING_INTERVAL_MS,
  answerPings,
} from './index';

/** A seeded pseudo-random generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the clock sync over a link', () => {
  it('pings every 2 s, the phone answers with its clock, and the fit converges on the offset', () => {
    const timers = new FakeTimers();
    // The phone's clock is 1,234.5 ms ahead of the host's; the network takes 8 ms each way, with
    // up to 4 ms more at random on each leg.
    const offset = 1234.5;
    const [hostEnd, phoneEnd] = MemoryTransport.pair({
      delayMs: 8,
      jitterMs: 4,
      timers,
      random: random(9),
    });
    const host = new MessageLink(hostEnd);
    const phone = new MessageLink(phoneEnd);
    const stop = answerPings(phone, () => timers.now() + offset);
    const fit = new RemoteClockFit();
    const pinger = new ClockPinger(host, fit, { timers });
    const samples: number[] = [];
    pinger.onSample((f) => samples.push(f.offsetMs));
    pinger.start();
    // A minute of pings, and the time for the last answer to come back.
    timers.advance(60_100);
    expect(pinger.pings).toBe(31);
    expect(pinger.pongs).toBe(31);
    expect(samples).toHaveLength(31);
    expect(fit.samples).toBe(31);
    expect(Math.abs(fit.offsetMs - offset)).toBeLessThan(2);
    expect(fit.rttMs).toBeGreaterThanOrEqual(16);
    expect(fit.rttMs).toBeLessThan(20);
    expect(fit.converged).toBe(true);
    expect(PING_INTERVAL_MS).toBe(2000);
    pinger.stop();
    stop();
    timers.advance(10_000);
    expect(pinger.pings).toBe(31);
    expect(pinger.fit).toBe(fit);
    // Stopped, the phone no longer answers either.
    host.send({ type: 'ping', t1: timers.now() });
    timers.advance(100);
    expect(pinger.pongs).toBe(31);
  });

  it('ignores an answer to a ping it did not send, and a ping lost on the way', () => {
    const timers = new FakeTimers();
    const [hostEnd, phoneEnd] = MemoryTransport.pair({ timers });
    const host = new MessageLink(hostEnd);
    const phone = new MessageLink(phoneEnd);
    const pinger = new ClockPinger(host, new RemoteClockFit(), { timers, intervalMs: 1000 });
    pinger.start();
    phone.send({ type: 'pong', t1: 12345, t2: 1, t3: 2 });
    timers.advance(1);
    expect(pinger.pongs).toBe(0);
    // Pings dropped on the way: no answer, and no sample.
    hostEnd.transform = () => null;
    timers.advance(3000);
    expect(pinger.pings).toBe(4);
    expect(pinger.pongs).toBe(0);
    hostEnd.transform = null;
    answerPings(phone, () => timers.now() + 5);
    timers.advance(2000);
    expect(pinger.pongs).toBe(2);
    expect(pinger.fit.offsetMs).toBe(5);
    // Starting twice changes nothing; stopping twice neither.
    pinger.start();
    pinger.stop();
    pinger.stop();
    timers.advance(5000);
    expect(pinger.pings).toBe(6);
  });

  it('drops an answer whose clocks ran backwards instead of throwing', () => {
    const timers = new FakeTimers();
    const [hostEnd, phoneEnd] = MemoryTransport.pair({ timers });
    const host = new MessageLink(hostEnd);
    const phone = new MessageLink(phoneEnd);
    const pinger = new ClockPinger(host, new RemoteClockFit(), { timers });
    phone.on('ping', (ping) => {
      phone.send({ type: 'pong', t1: ping.t1, t2: 100, t3: 50 });
    });
    pinger.start();
    timers.advance(1);
    expect(pinger.pings).toBe(1);
    expect(pinger.pongs).toBe(0);
    expect(pinger.fit.samples).toBe(0);
  });
});
