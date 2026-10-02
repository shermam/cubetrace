// A fake of cubing.js's player model as far as the clip viewer's 3D cube uses it (T3.10, `CubePlayerModel`):
// the orbit of the player's camera, for the unit tests of clip-cube.ts and clip-viewer.ts. Nothing in
// the app imports this file, so it is not in the bundle.
import type { CubePlayerModel, Orbit, OrbitCoordinates } from './clip-cube';

/**
 * The player's model as far as the orbit goes, as cubing.js's behaves: a request merges into the
 * orbit, the latitude clamped to ±90 and the longitude brought into [−180, 180), and the fresh
 * listeners hear each change in a later task, and the orbit as it is when they are added (cubing.js
 * calls a fresh listener once at first). `drag` is the user moving the camera: the orbit changes
 * without a request.
 */
export class FakeOrbitModel implements CubePlayerModel {
  orbit: OrbitCoordinates = { latitude: 0, longitude: 0, distance: 5 };
  /** The requests made, in order. */
  readonly requests: Partial<OrbitCoordinates>[] = [];
  readonly listeners = new Set<(coordinates: OrbitCoordinates) => void>();

  readonly twistySceneModel = {
    orbitCoordinatesRequest: {
      set: (request: Partial<OrbitCoordinates>): void => {
        this.requests.push(request);
        const latitude = Math.min(90, Math.max(-90, request.latitude ?? this.orbit.latitude));
        const longitude = request.longitude ?? this.orbit.longitude;
        this.move({
          latitude,
          longitude: ((((longitude + 180) % 360) + 360) % 360) - 180,
          distance: request.distance ?? this.orbit.distance,
        });
      },
    },
    orbitCoordinates: {
      get: (): Promise<OrbitCoordinates> => Promise.resolve(this.orbit),
      addFreshListener: (listener: (coordinates: OrbitCoordinates) => void): void => {
        this.listeners.add(listener);
        const orbit = this.orbit;
        queueMicrotask(() => {
          if (this.listeners.has(listener)) {
            listener(orbit);
          }
        });
      },
      removeFreshListener: (listener: (coordinates: OrbitCoordinates) => void): void => {
        this.listeners.delete(listener);
      },
    },
  };

  /** The user drags the cube: the camera goes to `orbit`, and the listeners hear it. */
  drag(orbit: Orbit): void {
    this.move({ ...orbit, distance: this.orbit.distance });
  }

  private move(next: OrbitCoordinates): void {
    const same =
      next.latitude === this.orbit.latitude &&
      next.longitude === this.orbit.longitude &&
      next.distance === this.orbit.distance;
    this.orbit = next;
    if (same) {
      return;
    }
    for (const listener of this.listeners) {
      queueMicrotask(() => {
        if (this.listeners.has(listener)) {
          listener(next);
        }
      });
    }
  }
}
