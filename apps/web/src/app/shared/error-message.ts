/**
 * The message of an error, for sentences shown to the user: its `message` when it has one (an
 * `Error`, or a `DOMException`, which is not an `Error` everywhere), otherwise the value as text.
 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message: unknown = error.message;
    if (typeof message === 'string' && message !== '') {
      return message;
    }
  }
  return String(error);
}
