// The frames file of a remote camera's clip, as the host keeps it (docs/DATA-MODEL.md §9, docs/RTC.md,
// docs/PLAN.md T4.2 and T4.3). The phone's capture writes a clip's frames file as the host's does, on
// its own clock: its `t0HostMs` is the phone's time of the first frame. The host keeps that time as
// `t0RemoteMs`, puts the first frame on the host clock through the clock sync of the data channel (the
// estimate's line evaluated at the clip's own time: since T4.3 the line the host took when it cut the
// clip, `RemoteClockLine`), and records the sync it used in `remote`, its offset the one applied at the
// first frame, so that the dataset stays on the host clock and says how each remote clip was placed on
// it. Pure: the caller gives the estimate.
import type { FramesJson } from './attempt';
import type { RemoteClockParams } from './remote-clock';

/**
 * What the conversion needs of the clock sync: `RemoteClockFit` gives it, and so does the app's clock
 * estimate, a frozen `RemoteClockLine` with the fit's record (T4.3).
 */
export interface RemoteClockSnapshot {
  /** The host time of a time on the phone's clock, by the estimate: its line's value there. */
  toHostMs(remoteMs: number): number;
  /** The fit's record (`clock.cameras[label].remote` of session.json). */
  readonly params: RemoteClockParams;
  readonly converged: boolean;
}

/** The label pattern of docs/DATA-MODEL.md §5, which names the clip's files. */
const LABEL = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

/**
 * The frames file `phone` of a remote camera's clip, as the phone's capture wrote it (its times on
 * the phone's clock), as the host keeps it: `camera` the label the session gives the phone's camera,
 * the phone's first frame time kept as `t0RemoteMs`, `t0HostMs` that time on the host clock through
 * `sync` (its line's value at the clip's own time), rounded to 0.01 ms as the capture rounds it, and
 * `remote` the sync's record with whether it had converged and `takenMs`, the host time it was taken
 * at: its `offsetMs` the offset applied at the first frame (T4.3: `t0RemoteMs − t0HostMs`, to 0.01
 * ms), its `driftPpm` the line's slope, so that the record alone converts the clip again. The frame
 * intervals, the keyframes and the arrival fit stay the phone's: intervals are the same on both clocks
 * to the drift (50 ppm is a millisecond over 20 s). Throws a RangeError for a file that is already a
 * remote clip's (its times converted once) and for a label that cannot name a clip.
 */
export function remoteFrames(
  phone: FramesJson,
  camera: string,
  sync: RemoteClockSnapshot,
  takenMs: number,
): FramesJson {
  if (phone.t0RemoteMs !== undefined || phone.remote !== undefined) {
    throw new RangeError("The frames file is a remote clip's already: its times were converted.");
  }
  if (!LABEL.test(camera)) {
    throw new RangeError(`"${camera}" is not a camera label.`);
  }
  const t0RemoteMs = phone.t0HostMs;
  const t0HostMs = hundredths(sync.toHostMs(t0RemoteMs));
  return {
    schema: phone.schema,
    camera,
    segment: phone.segment,
    ...(phone.app === undefined ? {} : { app: { ...phone.app } }),
    t0HostMs,
    t0RemoteMs,
    dtMs: [...phone.dtMs],
    keyframes: [...phone.keyframes],
    arrival: { ...phone.arrival },
    remote: {
      ...sync.params,
      offsetMs: hundredths(t0RemoteMs - t0HostMs),
      converged: sync.converged,
      takenMs,
    },
  };
}

/** `ms` to a hundredth, never -0. */
function hundredths(ms: number): number {
  return Math.round(ms * 100) / 100 + 0;
}
