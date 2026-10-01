/**
 * `navigator.connection`, the Network Information API, where the browser has it (Chrome): its
 * `effectiveType` everywhere, and its `type` (`wifi`, `cellular`, `ethernet`, …) on Android only, so
 * that "Wi-Fi only" (Settings → Uploads, T3.3) can be honoured on a phone and is hidden elsewhere.
 * TypeScript's DOM library does not declare it.
 */
export interface NetworkConnection {
  readonly type?: string;
  readonly effectiveType?: string;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

/** `navigator.connection`, or null where the browser has none. */
export function networkConnection(
  navigator: Partial<Navigator> | undefined,
): NetworkConnection | null {
  const connection: unknown =
    typeof navigator === 'object' ? Reflect.get(navigator, 'connection') : undefined;
  if (
    typeof connection !== 'object' ||
    connection === null ||
    typeof Reflect.get(connection, 'addEventListener') !== 'function'
  ) {
    return null;
  }
  const type: unknown = Reflect.get(connection, 'type');
  const effectiveType: unknown = Reflect.get(connection, 'effectiveType');
  return {
    type: typeof type === 'string' ? type : undefined,
    effectiveType: typeof effectiveType === 'string' ? effectiveType : undefined,
    addEventListener: (event, listener) => {
      (connection as EventTarget).addEventListener(event, listener);
    },
    removeEventListener: (event, listener) => {
      (connection as EventTarget).removeEventListener(event, listener);
    },
  };
}
