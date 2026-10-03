// A typed view of a transport (docs/RTC.md): the frames decoded into the protocol's messages and
// handed to the handlers of their type, and messages encoded and sent. The clock sync, the transfer
// and the app's services each listen for their own messages on one link.
import { ProtocolError, decode, encode, type Message, type WireFrame } from './protocol';
import type { Transport, TransportState } from './transport';

type Handler<T extends Message['type']> = (message: Extract<Message, { type: T }>) => void;

/**
 * The messages over one transport. A frame that is not a message of the protocol is reported to the
 * error handlers and dropped, never thrown into the transport's callback.
 */
export class MessageLink {
  readonly #handlers = new Map<string, Set<(message: Message) => void>>();
  readonly #anyHandlers = new Set<(message: Message) => void>();
  readonly #errorHandlers = new Set<(error: ProtocolError, frame: WireFrame) => void>();
  readonly #unsubscribe: () => void;

  constructor(readonly transport: Transport) {
    this.#unsubscribe = transport.onFrame((frame) => {
      this.#receive(frame);
    });
  }

  /** Whether frames can be sent now. */
  get open(): boolean {
    return this.transport.state === 'open';
  }

  get state(): TransportState {
    return this.transport.state;
  }

  /** Encodes and sends a message. Throws when the transport is not open. */
  send(message: Message): void {
    this.transport.send(encode(message));
  }

  /** Sends a message if the transport is open; false otherwise. */
  trySend(message: Message): boolean {
    if (!this.open) {
      return false;
    }
    this.send(message);
    return true;
  }

  /** Calls `next` with each message of `type` received, until the returned function is called. */
  on<T extends Message['type']>(type: T, next: Handler<T>): () => void {
    let handlers = this.#handlers.get(type);
    if (handlers === undefined) {
      handlers = new Set();
      this.#handlers.set(type, handlers);
    }
    const handler = next as (message: Message) => void;
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  /** Calls `next` with every message received. */
  onMessage(next: (message: Message) => void): () => void {
    this.#anyHandlers.add(next);
    return () => {
      this.#anyHandlers.delete(next);
    };
  }

  /** Calls `next` with each frame that was not a message of the protocol. */
  onError(next: (error: ProtocolError, frame: WireFrame) => void): () => void {
    this.#errorHandlers.add(next);
    return () => {
      this.#errorHandlers.delete(next);
    };
  }

  /** Resolves with the next message of `type` that `accept` takes (every one by default). */
  next<T extends Message['type']>(
    type: T,
    accept: (message: Extract<Message, { type: T }>) => boolean = () => true,
  ): Promise<Extract<Message, { type: T }>> {
    return new Promise((resolve) => {
      const off = this.on(type, (message) => {
        if (accept(message)) {
          off();
          resolve(message);
        }
      });
    });
  }

  /** Stops listening to the transport (the transport itself is left as it is). */
  detach(): void {
    this.#unsubscribe();
    this.#handlers.clear();
    this.#anyHandlers.clear();
  }

  /** Closes the transport. */
  close(reason?: string): void {
    this.transport.close(reason);
  }

  #receive(frame: WireFrame): void {
    let message: Message;
    try {
      message = decode(frame);
    } catch (error: unknown) {
      if (error instanceof ProtocolError) {
        for (const handler of [...this.#errorHandlers]) {
          handler(error, frame);
        }
        return;
      }
      throw error;
    }
    for (const handler of [...(this.#handlers.get(message.type) ?? [])]) {
      handler(message);
    }
    for (const handler of [...this.#anyHandlers]) {
      handler(message);
    }
  }
}
