// Public API of @cubetrace/core. Plain TypeScript: no Angular, no browser-only globals at import time.
export { CORE_VERSION, coreVersion } from './version';
export type { Face, Move } from './notation';
export {
  NotationError,
  formatMove,
  formatMoves,
  inverse,
  inverseSequence,
  parseMove,
  parseMoves,
  quarterTurns,
} from './notation';
