import { SHARPNESS_INTERVAL_MS, SharpnessSchedule } from './sharpness-schedule';

/** The times (ms) of the frames that `schedule` measures, of frames every `intervalMs`. */
function measured(
  schedule: SharpnessSchedule,
  intervalMs: number,
  count: number,
  held: (timeMs: number) => boolean = () => false,
  fromMs = 0,
): number[] {
  const times: number[] = [];
  for (let k = 1; k <= count; k++) {
    const timeMs = fromMs + k * intervalMs;
    if (schedule.due(timeMs, held(timeMs))) {
      times.push(timeMs);
    }
  }
  return times;
}

describe('SharpnessSchedule', () => {
  it('measures at most twice a second, at 30 fps and at 60 fps', () => {
    expect(SHARPNESS_INTERVAL_MS).toBe(500);
    // 30 fps for 3 s: frames every 33.3 ms, the first measured, then the first 500 ms after.
    const at30 = measured(new SharpnessSchedule(), 100 / 3, 90);
    expect(at30).toHaveLength(6);
    // 60 fps for 3 s: no more.
    const at60 = measured(new SharpnessSchedule(), 50 / 3, 180);
    expect(at60).toHaveLength(6);
    for (const times of [at30, at60]) {
      for (let k = 1; k < times.length; k++) {
        expect(times[k] - times[k - 1]).toBeGreaterThanOrEqual(500 - 1e-9);
        expect(times[k] - times[k - 1]).toBeLessThan(534);
      }
    }
  });

  it('measures nothing while it is held (a solve), and again as soon as it is not', () => {
    const schedule = new SharpnessSchedule();
    // 25 fps for 10 s, a solve from 2 s to 7 s.
    const times = measured(schedule, 40, 250, (ms) => ms >= 2000 && ms < 7000);
    expect(times.filter((ms) => ms >= 2000 && ms < 7000)).toEqual([]);
    expect(times.filter((ms) => ms < 2000)).toEqual([40, 560, 1080, 1600]);
    // The first frame after the solve.
    expect(times.filter((ms) => ms >= 7000)).toEqual([7000, 7520, 8040, 8560, 9080, 9600]);
  });

  it('starts again when the clock goes back (a new stream in the same preview)', () => {
    const schedule = new SharpnessSchedule();
    expect(measured(schedule, 40, 25)).toEqual([40, 560]);
    // The new stream's clock starts again near 0.
    expect(measured(schedule, 40, 25, () => false, 0)).toEqual([40, 560]);
  });
});
