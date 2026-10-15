import type { CameraInfo } from '@cubetrace/core';

/**
 * How the pages name a camera (T5.6): its label in the session and, for a phone whose browser gives
 * its model, the model after it: "phone-rear-2 · moto g60", so that two phones of one name are told
 * apart at a glance; the label alone otherwise ("laptop", a phone without a model).
 */
export function cameraName(label: string, model: string | null | undefined): string {
  return model === null || model === undefined || model === '' ? label : `${label} · ${model}`;
}

/**
 * The names of a session's cameras by label ({@link cameraName}, with each remote camera's model as
 * `cameras[].remote` records it, T5.6).
 */
export function cameraNames(cameras: readonly CameraInfo[]): ReadonlyMap<string, string> {
  return new Map(
    cameras.map((camera) => [camera.label, cameraName(camera.label, camera.remote?.model)]),
  );
}
