import { NO_UNDO, nextUndoGuide } from './undo-guide';

describe('nextUndoGuide', () => {
  it('greys out the moves made as the undo list shrinks from the front', () => {
    let guide = nextUndoGuide(NO_UNDO, ["F'", 'U', 'R2']);
    expect(guide).toEqual({ moves: ["F'", 'U', 'R2'], done: 0 });
    guide = nextUndoGuide(guide, ['U', 'R2']);
    expect(guide).toEqual({ moves: ["F'", 'U', 'R2'], done: 1 });
    guide = nextUndoGuide(guide, ['R2']);
    expect(guide).toEqual({ moves: ["F'", 'U', 'R2'], done: 2 });
    expect(nextUndoGuide(guide, [])).toBe(NO_UNDO);
  });

  it('starts over after another wrong move or a half turn made halfway', () => {
    const guide = nextUndoGuide(NO_UNDO, ['U', 'R2']);
    expect(nextUndoGuide(guide, ['B', 'U', 'R2'])).toEqual({ moves: ['B', 'U', 'R2'], done: 0 });
    expect(nextUndoGuide(guide, ['U', 'R'])).toEqual({ moves: ['U', 'R'], done: 0 });
  });
});
