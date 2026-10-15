import type { BrowserGlobals } from '../device/browser-globals';
import { E2E_REMOTE, e2eCapture, e2eRemote } from './e2e-remote';

// The end-to-end suite's settings, read in a development build (the unit tests run in one).

describe('e2eRemote', () => {
  it('reads what the suite set, each field checked, and nothing else', () => {
    const globals = {
      [E2E_REMOTE]: { clockOffsetMs: 5000, ignoreCuts: true, motionCostLimitMs: 40, other: 1 },
    } as unknown as BrowserGlobals;
    expect(e2eRemote(globals)).toEqual({
      clockOffsetMs: 5000,
      closeAfterBytes: undefined,
      ignoreCuts: true,
      clipWaitMs: undefined,
      finishWaitMs: undefined,
      motionCostLimitMs: 40,
      stagingFolder: undefined,
    });
    expect(e2eRemote({})).toEqual({});
  });

  it('reads a staging folder of letters, digits and hyphens only (T5.6)', () => {
    const folder = (stagingFolder: unknown): string | undefined =>
      e2eRemote({ [E2E_REMOTE]: { stagingFolder } } as unknown as BrowserGlobals).stagingFolder;
    expect(folder('camera-clips-moto')).toBe('camera-clips-moto');
    expect(folder('../sessions')).toBeUndefined();
    expect(folder('')).toBeUndefined();
    expect(folder(2)).toBeUndefined();
  });

  it("gives the capture's config the motion meter's cost limit only when the suite set one (T5.3)", () => {
    expect(
      e2eCapture({ [E2E_REMOTE]: { motionCostLimitMs: 40 } } as unknown as BrowserGlobals),
    ).toEqual({ motionCostLimitMs: 40 });
    expect(
      e2eCapture({ [E2E_REMOTE]: { motionCostLimitMs: 'many' } } as unknown as BrowserGlobals),
    ).toEqual({});
    expect(e2eCapture({})).toEqual({});
  });
});
