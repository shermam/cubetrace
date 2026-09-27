import { DEMO_FILE } from '../cube/cube-testing';
import { parseDemoSolves } from '../cube/demo';
import { setup } from './session-harness';

// The timer with the demo cube's mis-scramble (`?misscramble=`, src/app/cube/demo.ts): what the
// end-to-end suite checks in the browser (e2e/misscramble.spec.ts), on a fake clock.
describe('SessionService with a demo mis-scramble', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the undo guidance, then records the attempt as corrected', async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.service.whenReady();
    s.service.prepare();
    await vi.advanceTimersByTimeAsync(0);
    const [demo] = parseDemoSolves(DEMO_FILE);

    // Demo solve 0 is R U; after R, the demo cube turns F by mistake.
    s.cube.connectDemo(demo, 10, 1);
    await vi.advanceTimersByTimeAsync(10);
    expect(s.service.attempt()).toMatchObject({
      state: 'scrambling',
      progress: { matched: 1, diverged: true },
      undo: { moves: ["F'"], done: 0 },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.service.attempts()).toHaveLength(1);
    expect(s.service.attempts()[0].result).toMatchObject({
      status: 'solved',
      replayOk: true,
      scrambleCorrected: true,
      scrambleExtraMoves: 2,
    });
  });
});
