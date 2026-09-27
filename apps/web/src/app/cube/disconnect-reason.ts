// The words for the end of a cube connection (T1.14): the reason of the app's own idle
// disconnection, and, for a disconnection the app did not ask for, what the app knows about it,
// appended to the connection's own reason. CubeService.disconnectReason holds the result; the
// status pill's tooltip, the Timer page and the connect dialog show it.

/** The reason of a disconnection on request: the Disconnect button, or Cancel while connecting. */
export const DISCONNECTED_ON_REQUEST = 'Disconnected on request.';

/**
 * Past this long without a turn, a disconnection is most likely the cube going to sleep, and the
 * reason says so.
 */
export const SLEEP_HINT_AFTER_MS = 2 * 60_000;

/** The reason of the idle disconnection after `minutes` without a turn. */
export function idleDisconnectReason(minutes: number): string {
  const unit = minutes === 1 ? 'minute' : 'minutes';
  return `Disconnected after ${String(minutes)} ${unit} without a turn, to save the cube's battery.`;
}

/** What the app knows when a connection ends without its asking. */
export interface DisconnectFacts {
  /** The connection's own reason (the driver's), such as "The Bluetooth connection was closed." */
  readonly reason: string;
  /** Host ms since the cube's last turn, or since the connection if it was not turned. */
  readonly idleMs: number;
  /** The tab was hidden at that moment. */
  readonly hidden: boolean;
}

/**
 * The reason shown for a disconnection the app did not ask for: the connection's own first, then
 * how long the cube had gone without a turn and whether the tab was in the background, and, past
 * {@link SLEEP_HINT_AFTER_MS}, that GAN cubes go to sleep. Such as "The Bluetooth connection was
 * closed. It happened after 6 min 12 s without a turn, while this tab was in the background. GAN
 * cubes go to sleep after a few minutes without turns."
 */
export function describeDisconnect(facts: DisconnectFacts): string {
  const reason = facts.reason.trim();
  const first =
    reason === '' ? 'The cube disconnected.' : /[.!?]$/.test(reason) ? reason : `${reason}.`;
  const background = facts.hidden ? ', while this tab was in the background' : '';
  const hint =
    facts.idleMs > SLEEP_HINT_AFTER_MS
      ? ' GAN cubes go to sleep after a few minutes without turns.'
      : '';
  return `${first} It happened after ${formatIdle(facts.idleMs)} without a turn${background}.${hint}`;
}

/** A duration for the reasons: "less than 1 s", "42 s", "6 min 12 s", "6 min", "1 h 5 min". */
export function formatIdle(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 1) {
    return 'less than 1 s';
  }
  if (seconds < 60) {
    return `${String(seconds)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(rest)} s`;
  }
  const rest = minutes % 60;
  const hours = String(Math.floor(minutes / 60));
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest)} min`;
}
