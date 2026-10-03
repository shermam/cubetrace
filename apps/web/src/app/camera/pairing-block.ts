// Why Add camera cannot pair a phone now (docs/PLAN.md T4.1), for the Cameras section and for the
// placeholder that Camera settings show before the section loads: a small module of its own, so that
// the panel's chunk needs nothing of the connection's code.

/** Why Add camera cannot pair now: no account, or no session under way. */
export type PairingBlock = 'signed-out' | 'no-session';

/** The reasons in plain words. */
export const PAIRING_BLOCK_TEXT: Readonly<Record<PairingBlock, string>> = {
  'signed-out': 'Sign in first: the pairing goes through your account.',
  'no-session': 'Connect the cube first: a camera joins the session under way.',
};
