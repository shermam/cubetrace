// The event stream behind both cube sources (CubeConnection.events$): a hot RxJS Subject, plus the
// replay, to every new subscriber, of the events that describe the cube rather than a moment.
import { Subject, concat, defer, from, type Observable } from 'rxjs';

import type {
  CubeBatteryEvent,
  CubeDisconnectedEvent,
  CubeEvent,
  CubeHardwareEvent,
} from './types';

export class CubeEventHub {
  private readonly subject = new Subject<CubeEvent>();
  private hardware: CubeHardwareEvent | undefined;
  private battery: CubeBatteryEvent | undefined;
  private end: CubeDisconnectedEvent | undefined;

  /** The latest `hardware`, `battery` and `disconnected` events, then the live ones. */
  readonly events$: Observable<CubeEvent> = defer(() => concat(from(this.replay()), this.subject));

  /** True once `disconnected` has been emitted. */
  get closed(): boolean {
    return this.end !== undefined;
  }

  /** Sends `event` to the subscribers; `disconnected` completes the stream; later events are dropped. */
  emit(event: CubeEvent): void {
    if (this.end !== undefined) {
      return;
    }
    if (event.type === 'hardware') {
      this.hardware = event;
    } else if (event.type === 'battery') {
      this.battery = event;
    } else if (event.type === 'disconnected') {
      this.end = event;
    }
    this.subject.next(event);
    if (this.end !== undefined) {
      this.subject.complete();
    }
  }

  private replay(): CubeEvent[] {
    const events: CubeEvent[] = [];
    for (const event of [this.hardware, this.battery, this.end]) {
      if (event !== undefined) {
        events.push(event);
      }
    }
    return events;
  }
}
