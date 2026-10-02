import type { VideoClip } from '@cubetrace/core';

import { formatBytes } from './format-bytes';

/**
 * What clips are, as their badges and lists say (T2.4, T3.3): `count` clips, of which `inCloud` are
 * no longer on this device (deleted once uploaded: `video[].local` false), the others taking
 * `bytesHere`. "2 clips, 5.3 MB"; "2 clips in the cloud" when none is here any more; "4 clips,
 * 5.3 MB, 2 in the cloud" in between.
 */
export function clipsSummary(count: number, bytesHere: number, inCloud: number): string {
  const clips = `${String(count)} ${count === 1 ? 'clip' : 'clips'}`;
  if (inCloud >= count) {
    return `${clips} in the cloud`;
  }
  const here = `${clips}, ${formatBytes(bytesHere)}`;
  return inCloud === 0 ? here : `${here}, ${String(inCloud)} in the cloud`;
}

/** {@link clipsSummary} of `clips`; null without one. */
export function clipsText(clips: readonly Pick<VideoClip, 'bytes' | 'local'>[]): string | null {
  if (clips.length === 0) {
    return null;
  }
  const here = clips.filter((clip) => clip.local !== false);
  return clipsSummary(
    clips.length,
    here.reduce((sum, clip) => sum + clip.bytes, 0),
    clips.length - here.length,
  );
}
