import { describe, expect, it } from 'vitest';

import { FakeTimers, MemoryTransport, MessageLink, ProtocolError, type WireFrame } from './index';

/** A seeded pseudo-random generator (mulberry32), so that losses are reproducible. */
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

describe('MemoryTransport', () => {
  it('delivers frames to the other end, in order, after the delay', () => {
    const timers = new FakeTimers();
    const [a, b] = MemoryTransport.pair({ delayMs: 200, timers });
    const received: [WireFrame, number][] = [];
    b.onFrame((frame) => received.push([frame, timers.now()]));
    const t0 = timers.now();
    a.send('one');
    a.send(new Uint8Array([2]));
    a.send('three');
    expect(received).toEqual([]);
    timers.advance(199);
    expect(received).toEqual([]);
    timers.advance(1);
    expect(received.map(([frame]) => frame)).toEqual(['one', new Uint8Array([2]), 'three']);
    expect(received.map(([, at]) => at - t0)).toEqual([200, 200, 200]);
    expect(a.stats).toEqual({ frames: 3, bytes: 3 + 1 + 5, retransmitted: 0, maxBuffered: 9 });
    expect(a.state).toBe('open');
    expect(b.state).toBe('open');
  });

  it('drains its queue at the bandwidth, counts the bytes queued, and says when they fall under the threshold', () => {
    const timers = new FakeTimers();
    // 1 MB/s: a 10 KB frame takes 10 ms to leave the queue.
    const [a, b] = MemoryTransport.pair({ bytesPerSecond: 1_000_000, timers });
    const lows: number[] = [];
    a.bufferedAmountLowThreshold = 15_000;
    a.onBufferedAmountLow(() => lows.push(a.bufferedAmount));
    const arrivals: number[] = [];
    b.onFrame(() => arrivals.push(timers.now()));
    const t0 = timers.now();
    for (let k = 0; k < 5; k++) {
      a.send(new Uint8Array(10_000));
    }
    expect(a.bufferedAmount).toBe(50_000);
    timers.advance(10);
    expect(a.bufferedAmount).toBe(40_000);
    expect(lows).toEqual([]);
    timers.advance(30);
    expect(a.bufferedAmount).toBe(10_000);
    // From 20,000 to 10,000: under the threshold, once.
    expect(lows).toEqual([10_000]);
    timers.advance(10);
    expect(a.bufferedAmount).toBe(0);
    expect(lows).toEqual([10_000]);
    expect(arrivals.map((at) => at - t0)).toEqual([10, 20, 30, 40, 50]);
    expect(a.stats.maxBuffered).toBe(50_000);
    // Under the threshold already: a send that stays under it fires no event.
    a.send(new Uint8Array(100));
    timers.advance(1);
    expect(lows).toEqual([10_000]);
  });

  it('holds a lost frame, and every frame behind it, until its retransmission', () => {
    const timers = new FakeTimers();
    const next = random(3);
    // Every other frame "lost": the random values of this seed, read as the transport reads them.
    const [a, b] = MemoryTransport.pair({
      delayMs: 100,
      loss: 0.5,
      retransmitMs: 1000,
      timers,
      random: next,
    });
    const arrivals: [string, number][] = [];
    b.onFrame((frame) => arrivals.push([frame as string, timers.now()]));
    const t0 = timers.now();
    for (let k = 0; k < 6; k++) {
      a.send(String(k));
    }
    timers.advance(5000);
    expect(arrivals.map(([frame]) => frame)).toEqual(['0', '1', '2', '3', '4', '5']);
    const times = arrivals.map(([, at]) => at - t0);
    // In order, never earlier than the frame before, and each at least the delay.
    for (let k = 1; k < times.length; k++) {
      expect(times[k]).toBeGreaterThanOrEqual(times[k - 1]);
    }
    expect(Math.min(...times)).toBeGreaterThanOrEqual(100);
    expect(a.stats.retransmitted).toBeGreaterThan(0);
    expect(Math.max(...times)).toBeGreaterThanOrEqual(1100);
    // Without losses, every frame takes the delay.
    const [c, d] = MemoryTransport.pair({ delayMs: 100, loss: 0, timers });
    const plain: number[] = [];
    d.onFrame(() => plain.push(timers.now()));
    const t1 = timers.now();
    c.send('x');
    timers.advance(100);
    expect(plain.map((at) => at - t1)).toEqual([100]);
  });

  it('closes both ends at once, drops what was on its way, and refuses to send afterwards', () => {
    const timers = new FakeTimers();
    const [a, b] = MemoryTransport.pair({ delayMs: 100, timers });
    const states: string[] = [];
    a.onStateChange((state, reason) => states.push(`a ${state}: ${reason ?? ''}`));
    b.onStateChange((state, reason) => states.push(`b ${state}: ${reason ?? ''}`));
    const received: WireFrame[] = [];
    b.onFrame((frame) => received.push(frame));
    a.send('lost');
    timers.advance(50);
    b.close('the phone left');
    expect(a.state).toBe('closed');
    expect(b.state).toBe('closed');
    expect(states).toEqual([
      'b closed: the phone left',
      'a closed: the other end closed: the phone left',
    ]);
    timers.advance(1000);
    expect(received).toEqual([]);
    expect(a.bufferedAmount).toBe(0);
    expect(() => {
      a.send('more');
    }).toThrow('The transport is closed.');
    // A second close changes nothing.
    a.close();
    expect(states).toHaveLength(2);
  });

  it('refuses a frame larger than the channel takes, and says the size', () => {
    const [a] = MemoryTransport.pair({ maxMessageSize: 16_384 });
    expect(a.maxMessageSize).toBe(16_384);
    expect(() => {
      a.send(new Uint8Array(16_385));
    }).toThrow('A frame of 16385 bytes: the channel takes at most 16384.');
    expect(() => {
      a.send(new Uint8Array(16_384));
    }).not.toThrow();
    const [c] = MemoryTransport.pair();
    expect(c.maxMessageSize).toBeNull();
  });

  it('lets a test corrupt or drop frames on their way', () => {
    const timers = new FakeTimers();
    const [a, b] = MemoryTransport.pair({ timers });
    const received: WireFrame[] = [];
    b.onFrame((frame) => received.push(frame));
    a.transform = (frame) =>
      frame === 'drop' ? null : typeof frame === 'string' ? frame.toUpperCase() : frame;
    a.send('keep');
    a.send('drop');
    a.send('also');
    timers.advance(1);
    expect(received).toEqual(['KEEP', 'ALSO']);
  });

  it('runs on the real timers by default', async () => {
    const [a, b] = MemoryTransport.pair({ delayMs: 5 });
    const frame = new Promise<WireFrame>((resolve) => {
      b.onFrame(resolve);
    });
    a.send('real');
    expect(await frame).toBe('real');
  });
});

describe('MessageLink', () => {
  it('decodes the frames into messages, by type and all, and sends messages encoded', () => {
    const timers = new FakeTimers();
    const [a, b] = MemoryTransport.pair({ timers });
    const host = new MessageLink(a);
    const phone = new MessageLink(b);
    const pings: number[] = [];
    const all: string[] = [];
    phone.on('ping', (ping) => pings.push(ping.t1));
    phone.onMessage((message) => all.push(message.type));
    host.send({ type: 'ping', t1: 7 });
    host.send({ type: 'leave', reason: 'done' });
    expect(host.open).toBe(true);
    timers.advance(1);
    expect(pings).toEqual([7]);
    expect(all).toEqual(['ping', 'leave']);
    expect(phone.state).toBe('open');
  });

  it('reports a frame that is not a message, and goes on', () => {
    const timers = new FakeTimers();
    const [a, b] = MemoryTransport.pair({ timers });
    const link = new MessageLink(b);
    const errors: [ProtocolError, WireFrame][] = [];
    const messages: string[] = [];
    link.onError((error, frame) => errors.push([error, frame]));
    link.onMessage((message) => messages.push(message.type));
    a.send('garbage');
    a.send(new Uint8Array([7]));
    a.send(JSON.stringify({ type: 'leave', reason: 'ok' }));
    timers.advance(1);
    expect(errors.map(([error]) => error)).toEqual([
      expect.any(ProtocolError),
      expect.any(ProtocolError),
    ]);
    expect(errors.map(([, frame]) => frame)).toEqual(['garbage', new Uint8Array([7])]);
    expect(messages).toEqual(['leave']);
  });

  it('resolves the next message of a type that is accepted, and tells when sending is not possible', async () => {
    const timers = new FakeTimers();
    const [a, b] = MemoryTransport.pair({ timers });
    const host = new MessageLink(a);
    const phone = new MessageLink(b);
    const ack = host.next('file-ack', (m) => m.id === 2);
    phone.send({ type: 'file-ack', id: 1, offset: 0, done: false });
    phone.send({ type: 'file-ack', id: 2, offset: 10, done: false });
    timers.advance(1);
    expect(await ack).toEqual({ type: 'file-ack', id: 2, offset: 10, done: false });
    host.close('bye');
    expect(host.open).toBe(false);
    expect(host.trySend({ type: 'ping', t1: 1 })).toBe(false);
    expect(() => {
      host.send({ type: 'ping', t1: 1 });
    }).toThrow('The transport is closed.');
    // Detached, the link hears nothing more.
    const [c, d] = MemoryTransport.pair({ timers });
    const link = new MessageLink(d);
    const heard: string[] = [];
    link.onMessage((m) => heard.push(m.type));
    link.detach();
    c.send(JSON.stringify({ type: 'ping', t1: 1 }));
    timers.advance(1);
    expect(heard).toEqual([]);
    expect(d.state).toBe('open');
  });
});
