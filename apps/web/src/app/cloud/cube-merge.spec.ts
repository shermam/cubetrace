import { cloudCube } from '@cubetrace/core';

import type { CubeMac } from '../settings/settings-service';
import { cubeChanges, mergeCubes, type CloudCubeEntry, type KnownCubes } from './cube-merge';

// The merge of Settings' cube list with the account's (docs/PLAN.md T3.4): the union of the two, the
// copy changed last winning on either side, and the deletions on either side carried to the other.

const LAST_MERGE = 1_790_000_000_000;
const EARLIER = LAST_MERGE - 60_000;
const LATER = LAST_MERGE + 60_000;

/** An entry of Settings' list. */
function entry(name: string, updatedMs: number, mac = 'AB:12:CD:34:EF:56'): CubeMac {
  return { name, mac, updatedMs };
}

/** A document of the account's list as another device wrote it, confirmed by the server. */
function document(name: string, updatedMs: number, mac = 'AB:12:CD:34:EF:56'): CloudCubeEntry {
  return { cube: cloudCube({ name, mac, updatedMs, device: 'Android phone' }), pending: false };
}

function known(entries: Record<string, number> = {}): KnownCubes {
  return new Map(Object.entries(entries));
}

/** The merge of `local` and `cloud`, from the server unless said otherwise. */
function merge(
  local: CubeMac[],
  cloud: CloudCubeEntry[],
  before: KnownCubes = known(),
  options: { fromServer?: boolean; unreadable?: string[] } = {},
): { local: CubeMac[]; known: Record<string, number> } {
  const merged = mergeCubes({
    local,
    cloud,
    unreadable: options.unreadable ?? [],
    known: before,
    fromServer: options.fromServer ?? true,
  });
  return { local: merged.local, known: Object.fromEntries(merged.known) };
}

describe('mergeCubes', () => {
  it("takes the union of the two lists: this device's new cubes stay, the account's new ones come", () => {
    const merged = merge(
      [entry('GAN12ui_AB12', LATER)],
      [document('GAN356i3_CD34', EARLIER, '11:22:33:44:55:66')],
    );
    expect(merged.local).toEqual([
      entry('GAN12ui_AB12', LATER),
      entry('GAN356i3_CD34', EARLIER, '11:22:33:44:55:66'),
    ]);
    // What the server holds: the account's cube; this device's is for cubeChanges to write.
    expect(merged.known).toEqual({ GAN356i3_CD34: EARLIER });
    expect(cubeChanges(merged.local, known(merged.known), new Set())).toEqual({
      writes: [entry('GAN12ui_AB12', LATER)],
      deletes: [],
      unsyncable: [],
    });
  });

  it('keeps the copy changed last, both ways, matching names ignoring case', () => {
    const merged = merge(
      [
        entry('GAN12ui_AB12', EARLIER, '00:00:00:00:00:01'),
        entry('GAN356i3_CD34', LATER, '00:00:00:00:00:02'),
      ],
      [
        document('gan12ui_ab12', LATER, '11:11:11:11:11:11'),
        document('GAN356i3_CD34', EARLIER, '22:22:22:22:22:22'),
      ],
      known({ gan12ui_ab12: EARLIER, GAN356i3_CD34: EARLIER }),
    );
    // The account's newer copy replaces this device's, its name with it; this device's newer copy
    // stays, to be written.
    expect(merged.local).toEqual([
      entry('gan12ui_ab12', LATER, '11:11:11:11:11:11'),
      entry('GAN356i3_CD34', LATER, '00:00:00:00:00:02'),
    ]);
    expect(cubeChanges(merged.local, known(merged.known), new Set())).toEqual({
      writes: [entry('GAN356i3_CD34', LATER, '00:00:00:00:00:02')],
      deletes: [],
      unsyncable: [],
    });
  });

  it("settles two copies of the same time that differ on the account's, so that every device ends the same", () => {
    const merged = merge(
      [entry('GAN12ui_AB12', LAST_MERGE, '00:00:00:00:00:01')],
      [document('GAN12ui_AB12', LAST_MERGE, '11:11:11:11:11:11')],
    );
    expect(merged.local).toEqual([entry('GAN12ui_AB12', LAST_MERGE, '11:11:11:11:11:11')]);
    expect(cubeChanges(merged.local, known(merged.known), new Set()).writes).toEqual([]);
  });

  it('removes here a cube deleted in the account since this device saw that copy on the server', () => {
    const merged = merge(
      [entry('GAN12ui_AB12', EARLIER), entry('GAN356i3_CD34', EARLIER)],
      [document('GAN356i3_CD34', EARLIER)],
      known({ GAN12ui_AB12: EARLIER, GAN356i3_CD34: EARLIER }),
    );
    expect(merged.local).toEqual([entry('GAN356i3_CD34', EARLIER)]);
    expect(merged.known).toEqual({ GAN356i3_CD34: EARLIER });
    expect(cubeChanges(merged.local, known(merged.known), new Set())).toEqual({
      writes: [],
      deletes: [],
      unsyncable: [],
    });
  });

  it('deletes in the account a cube removed here since this device saw that copy on the server', () => {
    const merged = merge([], [document('GAN12ui_AB12', EARLIER)], known({ GAN12ui_AB12: EARLIER }));
    expect(merged.local).toEqual([]);
    expect(cubeChanges(merged.local, known(merged.known), new Set())).toEqual({
      writes: [],
      deletes: ['GAN12ui_AB12'],
      unsyncable: [],
    });
  });

  it('lets a change on one side win over a deletion on the other', () => {
    // Changed here after the last merge, deleted in the account: written again.
    const here = merge([entry('GAN12ui_AB12', LATER)], [], known({ GAN12ui_AB12: EARLIER }));
    expect(here.local).toEqual([entry('GAN12ui_AB12', LATER)]);
    expect(cubeChanges(here.local, known(here.known), new Set()).writes).toEqual(here.local);
    // Changed in the account after the last merge, removed here: back here.
    const there = merge([], [document('GAN12ui_AB12', LATER)], known({ GAN12ui_AB12: EARLIER }));
    expect(there.local).toEqual([entry('GAN12ui_AB12', LATER)]);
    expect(cubeChanges(there.local, known(there.known), new Set())).toEqual({
      writes: [],
      deletes: [],
      unsyncable: [],
    });
  });

  it("read from this device's cache, never takes a missing document for a deletion", () => {
    // The cache holds nothing (the server out of reach since the page loaded): the cube stays and
    // is not written again, and what was known stays known.
    const merged = merge([entry('GAN12ui_AB12', EARLIER)], [], known({ GAN12ui_AB12: EARLIER }), {
      fromServer: false,
    });
    expect(merged.local).toEqual([entry('GAN12ui_AB12', EARLIER)]);
    expect(merged.known).toEqual({ GAN12ui_AB12: EARLIER });
    expect(cubeChanges(merged.local, known(merged.known), new Set())).toEqual({
      writes: [],
      deletes: [],
      unsyncable: [],
    });
    // What the cache holds still merges: a cube of another device comes.
    const other = merge([], [document('GAN356i3_CD34', EARLIER)], known(), { fromServer: false });
    expect(other.local).toEqual([entry('GAN356i3_CD34', EARLIER)]);
  });

  it("keeps what was known of a document holding this device's unconfirmed write, so that the write goes again", () => {
    const pending: CloudCubeEntry = { ...document('GAN12ui_AB12', LATER), pending: true };
    const merged = merge(
      [entry('GAN12ui_AB12', LATER)],
      [pending],
      known({ GAN12ui_AB12: EARLIER }),
    );
    expect(merged.local).toEqual([entry('GAN12ui_AB12', LATER)]);
    expect(merged.known).toEqual({ GAN12ui_AB12: EARLIER });
    expect(cubeChanges(merged.local, known(merged.known), new Set()).writes).toEqual(merged.local);
  });

  it('counts documents whose names differ in case only as one cube: the newer, the other deleted', () => {
    const merged = merge(
      [],
      [document('GAN12ui_AB12', EARLIER), document('gan12ui_ab12', LATER, '11:22:33:44:55:66')],
    );
    expect(merged.local).toEqual([entry('gan12ui_ab12', LATER, '11:22:33:44:55:66')]);
    expect(cubeChanges(merged.local, known(merged.known), new Set())).toEqual({
      writes: [],
      deletes: ['GAN12ui_AB12'],
      unsyncable: [],
    });
  });

  it('leaves a cube whose document could not be read as it is, on both sides', () => {
    const merged = merge(
      [entry('GAN12ui_AB12', LATER)],
      [document('GAN356i3_CD34', EARLIER)],
      known({ GAN12ui_AB12: EARLIER }),
      { unreadable: ['GAN12ui_AB12'] },
    );
    expect(merged.local).toEqual([entry('GAN12ui_AB12', LATER), entry('GAN356i3_CD34', EARLIER)]);
    expect(cubeChanges(merged.local, known(merged.known), new Set(['gan12ui_ab12']))).toEqual({
      writes: [],
      deletes: [],
      unsyncable: [],
    });
  });

  it('sends the entries a device stored before T3.4, dated when it first read them, as new ones', () => {
    // The ThinkPhone typed the MAC address in round 1; the MacBook has another cube of its own.
    const migrated = entry('GAN12ui_AB12', LATER);
    const merged = merge([migrated], [document('GAN356i3_CD34', EARLIER)]);
    expect(cubeChanges(merged.local, known(merged.known), new Set()).writes).toEqual([migrated]);
  });
});

describe('cubeChanges', () => {
  it('writes the entries the server lacks in their version and deletes the documents no entry names', () => {
    const local = [
      entry('GAN12ui_AB12', LAST_MERGE),
      entry('GAN356i3_CD34', LATER),
      entry('GAN 11 M Pro', EARLIER),
    ];
    expect(
      cubeChanges(
        local,
        known({ GAN12ui_AB12: LAST_MERGE, GAN356i3_CD34: EARLIER, GANicV2_EF56: EARLIER }),
        new Set(),
      ),
    ).toEqual({
      writes: [entry('GAN356i3_CD34', LATER), entry('GAN 11 M Pro', EARLIER)],
      deletes: ['GANicV2_EF56'],
      unsyncable: [],
    });
  });

  it('renames a document when its entry is renamed, even in case only', () => {
    expect(
      cubeChanges([entry('gan12ui_ab12', LATER)], known({ GAN12ui_AB12: EARLIER }), new Set()),
    ).toEqual({
      writes: [entry('gan12ui_ab12', LATER)],
      deletes: ['GAN12ui_AB12'],
      unsyncable: [],
    });
  });

  it('keeps on this device an entry whose name cannot name a document, and skips the names asked', () => {
    const slash = entry('GAN/12', LATER);
    expect(
      cubeChanges(
        [slash, entry('..', LATER), entry('Skipped', LATER)],
        known({ skipped: EARLIER }),
        new Set(['skipped']),
      ),
    ).toEqual({ writes: [], deletes: [], unsyncable: [slash, entry('..', LATER)] });
  });
});
