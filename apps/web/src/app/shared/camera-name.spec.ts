import type { CameraInfo } from '@cubetrace/core';

import { cameraName, cameraNames } from './camera-name';

/** A camera of a session, `remote` when it is a phone's. */
function camera(label: string, remote?: CameraInfo['remote']): CameraInfo {
  return {
    label,
    local: remote === undefined,
    facing: 'environment',
    deviceLabel: 'camera 0, facing back',
    settings: {},
    capabilities: {},
    constraints: {},
    crop: null,
    mode: 'full',
    microphone: null,
    ...(remote === undefined ? {} : { remote }),
  };
}

describe('cameraName', () => {
  it('names a phone by its label and its model, and anything else by its label (T5.6)', () => {
    expect(cameraName('phone-rear-2', 'moto g60')).toBe('phone-rear-2 · moto g60');
    expect(cameraName('phone-rear', 'ThinkPhone by motorola')).toBe(
      'phone-rear · ThinkPhone by motorola',
    );
    expect(cameraName('laptop', undefined)).toBe('laptop');
    expect(cameraName('phone-rear', null)).toBe('phone-rear');
    expect(cameraName('phone-rear', '')).toBe('phone-rear');
  });

  it("names a session's cameras by label, each phone with the model its record keeps", () => {
    const names = cameraNames([
      camera('laptop'),
      camera('phone-rear', {
        label: 'ThinkPhone by motorola',
        platform: 'Android',
        model: 'ThinkPhone by motorola',
      }),
      camera('phone-rear-2', { label: 'moto g60', platform: 'Android', model: 'moto g60' }),
      // A record written before T5.6, or a phone whose browser gives no model.
      camera('phone-rear-3', { label: 'Android phone', platform: 'Android' }),
    ]);
    expect([...names.values()]).toEqual([
      'laptop',
      'phone-rear · ThinkPhone by motorola',
      'phone-rear-2 · moto g60',
      'phone-rear-3',
    ]);
  });
});
