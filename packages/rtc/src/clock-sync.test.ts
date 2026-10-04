import { RemoteClockFit } from '@cubetrace/core';
import { describe, expect, it } from 'vitest';

import {
  ClockPinger,
  FAST_PINGS_MS,
  FAST_PING_INTERVAL_MS,
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

/** The gaps between the pings the phone's end received, in ms, rounded. */
function gaps(times: readonly number[]): number[] {
  return times.slice(1).map((t, k) => Math.round(t - times[k]));
}

describe('the clock sync over a link', () => {
  it('pings every 500 ms until the fit converges, then every 2 s; the phone answers with its clock, and the fit converges on the offset', () => {
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
    const received: number[] = [];
    phone.on('ping', (ping) => received.push(ping.t1));
    const fit = new RemoteClockFit();
    const pinger = new ClockPinger(host, fit, { timers });
    const samples: number[] = [];
    let convergedMs: number | null = null;
    pinger.onSample((f) => {
      samples.push(f.offsetMs);
      if (f.converged) {
        convergedMs ??= timers.now() - received[0];
      }
    });
    expect(pinger.intervalMs).toBe(FAST_PING_INTERVAL_MS);
    pinger.start();
    // A minute of pings, and the time for the last answer to come back.
    timers.advance(60_100);
    // Ten samples over ten seconds: the answer to the ping of 10 s converged the fit; the ping
    // sent before that answer came, at 10.5 s, was the last fast one, and the next came 2 s later.
    expect(convergedMs).toBeGreaterThan(10_000);
    expect(convergedMs).toBeLessThan(10_100);
    expect(gaps(received)).toEqual([
      ...Array<number>(21).fill(500),
      ...Array<number>(24).fill(2000),
    ]);
    expect(pinger.intervalMs).toBe(PING_INTERVAL_MS);
    expect(pinger.pings).toBe(46);
    expect(pinger.pongs).toBe(46);
    expect(samples).toHaveLength(46);
    // The window holds the last two minutes: all of them.
    expect(fit.samples).toBe(46);
    expect(Math.abs(fit.offsetMs - offset)).toBeLessThan(2);
    expect(fit.rttMs).toBeGreaterThanOrEqual(16);
    expect(fit.rttMs).toBeLessThan(20);
    expect(fit.converged).toBe(true);
    expect([FAST_PING_INTERVAL_MS, FAST_PINGS_MS, PING_INTERVAL_MS]).toEqual([500, 60_000, 2000]);
    pinger.stop();
    stop();
    timers.advance(10_000);
    expect(pinger.pings).toBe(46);
    expect(pinger.fit).toBe(fit);
    // Stopped, the phone no longer answers either.
    host.send({ type: 'ping', t1: timers.now() });
    timers.advance(100);
    expect(pinger.pongs).toBe(46);
  });

  it('pings fast for a minute at most when the fit does not converge, and at the steady rate from the first answer of a fit converged already', () => {
    const timers = new FakeTimers();
    const [hostEnd, phoneEnd] = MemoryTransport.pair({ delayMs: 8, timers });
    const host = new MessageLink(hostEnd);
    const phone = new MessageLink(phoneEnd);
    const received: number[] = [];
    phone.on('ping', (ping) => received.push(ping.t1));
    // A phone that never answers (asleep): the fit never converges; a minute of 500 ms, then 2 s.
    const pinger = new ClockPinger(host, new RemoteClockFit(), { timers });
    pinger.start();
    timers.advance(70_100);
    expect(gaps(received)).toEqual([
      ...Array<number>(120).fill(500),
      ...Array<number>(5).fill(2000),
    ]);
    expect(pinger.pongs).toBe(0);
    pinger.stop();

    // The fit kept across a reconnection, converged still (the phone's clock 7 ms behind, 8 ms each
    // way): the first answer settles the pinger, whose next ping, scheduled before it came, is the
    // last at 500 ms.
    const fit = new RemoteClockFit();
    for (let k = 0; k < 20; k++) {
      const t1 = timers.now() - 40_000 + 2000 * k;
      fit.addSample(t1, t1 + 1, t1 + 1, t1 + 16);
    }
    expect(fit.converged).toBe(true);
    received.length = 0;
    answerPings(phone, () => timers.now() - 7);
    const again = new ClockPinger(host, fit, { timers });
    again.start();
    timers.advance(10_000);
    expect(gaps(received)).toEqual([500, 2000, 2000, 2000, 2000]);
    expect(fit.converged).toBe(true);
    again.stop();

    // fastMs 0: the steady interval from the start.
    received.length = 0;
    const steady = new ClockPinger(host, new RemoteClockFit(), { timers, fastMs: 0 });
    expect(steady.intervalMs).toBe(PING_INTERVAL_MS);
    steady.start();
    timers.advance(6100);
    expect(gaps(received)).toEqual([2000, 2000, 2000]);
    steady.stop();
  });

  it('ignores an answer to a ping it did not send, and a ping lost on the way', () => {
    const timers = new FakeTimers();
    const [hostEnd, phoneEnd] = MemoryTransport.pair({ timers });
    const host = new MessageLink(hostEnd);
    const phone = new MessageLink(phoneEnd);
    const pinger = new ClockPinger(host, new RemoteClockFit(), {
      timers,
      intervalMs: 1000,
      fastMs: 0,
    });
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
