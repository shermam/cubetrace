import type { JsonObject, JsonValue, Probed } from './probe-types';

/**
 * Helpers that let the probe read browser APIs it cannot trust to exist: every value is read as
 * `unknown` and checked, and every exception or rejection becomes an `{ error }` value.
 */

/** Longest a single browser call may take by default. */
export const STEP_TIMEOUT_MS = 5000;

/** Runs one step; an exception or rejection becomes `{ error }`. */
export async function guard<T>(step: () => Promise<Probed<T>>): Promise<Probed<T>> {
  try {
    return await step();
  } catch (error: unknown) {
    return { error: describeError(error) };
  }
}

export function guardSync<T>(step: () => Probed<T>): Probed<T> {
  try {
    return step();
  } catch (error: unknown) {
    return { error: describeError(error) };
  }
}

/** Reads one value; a value of another type counts as missing, a throwing getter as an error. */
export function read<T>(
  get: () => unknown,
  is: (value: unknown) => value is T,
  name: string,
): Probed<T> {
  return guardSync(() => {
    const value = get();
    return is(value) ? value : { missing: name };
  });
}

/** Settles like `promise`, or rejects after `ms`; a value that arrives late goes to `onLate`. */
export async function withTimeout<T>(
  promise: T | Promise<T>,
  what: string,
  ms = STEP_TIMEOUT_MS,
  onLate?: (value: T) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let late = false;
  const pending = Promise.resolve(promise);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      late = true;
      reject(new Error(`${what} did not answer within ${String(ms)} ms`));
    }, ms);
  });
  if (onLate) {
    void pending.then(
      (value) => {
        if (late) {
          onLate(value);
        }
      },
      () => undefined,
    );
  }
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** "Name: message" of an exception or a rejection, plus the constraint of an OverconstrainedError. */
export function describeError(error: unknown): string {
  try {
    const parts = [member(error, 'name'), member(error, 'message')].filter(
      (part): part is string => isString(part) && part !== '',
    );
    const constraint = member(error, 'constraint');
    const text = parts.length > 0 ? parts.join(': ') : isString(error) ? error : 'unknown error';
    return isString(constraint) && constraint !== '' ? `${text} (constraint: ${constraint})` : text;
  } catch {
    return 'unknown error';
  }
}

/** `target[key]` for any object or function, `undefined` for anything else. */
export function member(target: unknown, key: string): unknown {
  return isObject(target) ? (target as Record<string, unknown>)[key] : undefined;
}

/** Calls `target[key](...args)` when it is a function; `undefined` when there is no such method. */
export function invoke(
  target: unknown,
  key: string,
  args: readonly unknown[] = [],
): { readonly result: unknown } | undefined {
  const method = member(target, key);
  if (typeof method !== 'function') {
    return undefined;
  }
  const result: unknown = Reflect.apply(method, target, args);
  return { result };
}

/** A JSON copy of a browser dictionary. */
export function toJson(value: unknown): JsonValue {
  // JSON.stringify gives undefined (typed as string) for undefined and functions.
  const text = JSON.stringify(value) as string | undefined;
  return text === undefined ? null : (JSON.parse(text) as JsonValue);
}

export function toJsonObject(value: unknown): JsonObject {
  const json = toJson(value);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new TypeError('expected an object');
  }
  return json as JsonObject;
}

export function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}
