// The driver's loader: one import shared by the app's preload and the connection (T1.14).
import { describe, expect, it, vi } from 'vitest';

import { createGanDriverLoader, loadGanDriver, type ConnectGanDriver } from './driver';

/** The driver's connectGanCube, as the tests' module exports it. */
const connect: ConnectGanDriver = () => Promise.reject(new Error('No Bluetooth in the tests.'));

/** Settles before `promise` if `promise` is still pending (a settled promise listed first wins). */
const PENDING = Symbol('pending');

describe('createGanDriverLoader', () => {
  it('imports the driver once: a click while the preload is under way waits for the same import', async () => {
    let finish: (module: unknown) => void = () => undefined;
    const importModule = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          finish = resolve;
        }),
    );
    const load = createGanDriverLoader(importModule);

    const preload = load(); // The app, as soon as it knows the browser has Web Bluetooth.
    const click = load(); // connectGanCube, from a click before the download has finished.
    expect(click).toBe(preload);
    await expect(Promise.race([click, Promise.resolve(PENDING)])).resolves.toBe(PENDING);
    finish({ connectGanCube: connect });

    await expect(click).resolves.toBe(connect);
    expect(importModule).toHaveBeenCalledOnce();
  });

  it('a click after the preload has finished does not wait on the import', async () => {
    const importModule = vi.fn(() => Promise.resolve<unknown>({ connectGanCube: connect }));
    const load = createGanDriverLoader(importModule);
    await load(); // The preload.

    // Already settled: it wins a race against a promise that is settled too, but listed after it.
    await expect(Promise.race([load(), Promise.resolve(PENDING)])).resolves.toBe(connect);
    expect(importModule).toHaveBeenCalledOnce();
  });

  it('keeps no failed import: the next call imports again', async () => {
    const importModule = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockResolvedValueOnce({ connectGanCube: connect });
    const load = createGanDriverLoader(importModule);

    await expect(load()).rejects.toThrow('Failed to fetch dynamically imported module');
    await expect(load()).resolves.toBe(connect);
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it('refuses a module without connectGanCube', async () => {
    const load = createGanDriverLoader(() => Promise.resolve({ connectGanCube: 'no' }));
    await expect(load()).rejects.toThrow(
      'The GAN driver (gan-web-bluetooth) does not export connectGanCube.',
    );
  });
});

describe('loadGanDriver', () => {
  it('loads the installed driver once: the preload and the connection share one promise', async () => {
    const preload = loadGanDriver();
    await expect(preload).resolves.toBeTypeOf('function');
    expect(loadGanDriver()).toBe(preload);
  });
});
