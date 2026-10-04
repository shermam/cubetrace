import type { Hello, MessageLink } from '@cubetrace/rtc';

/**
 * The other side's `hello` over `link` (docs/RTC.md §8): resolves with it, or rejects as soon as the
 * connection closes or fails first (T4.2b), so that a side the other gave up on (its own wait for a
 * hello over) moves on at once rather than at the end of its own wait. `from` names the other side
 * in the error: `the connection closed before the host's hello`. The caller bounds the wait.
 */
export function helloOrClose(link: MessageLink, from: 'host' | 'phone'): Promise<Hello> {
  return new Promise<Hello>((resolve, reject) => {
    const closed = (state: string): Error =>
      new Error(`the connection ${state} before the ${from}'s hello`);
    if (!link.open) {
      reject(closed(link.state));
      return;
    }
    const off = link.transport.onStateChange((state) => {
      if (state === 'closed' || state === 'failed') {
        off();
        reject(closed(state));
      }
    });
    void link.next('hello').then((hello) => {
      off();
      resolve(hello);
    });
  });
}
