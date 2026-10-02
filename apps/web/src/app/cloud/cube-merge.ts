// The merge of Settings' cube list with the account's in Firestore (docs/PLAN.md T3.4, issue #21),
// as pure functions: CubeSyncService runs mergeCubes at each sign-in and each start signed in, then
// cubeChanges after the merge and after every change of the list.
import { isCubeDocumentName, type CloudCube } from '@cubetrace/core';

import type { CubeMac } from '../settings/settings-service';

/** A cube of the account's list as read, and whether it holds this device's unconfirmed writes. */
export interface CloudCubeEntry {
  readonly cube: CloudCube;
  /**
   * Firestore's `hasPendingWrites`: this device wrote it, and the server has not confirmed it yet.
   */
  readonly pending: boolean;
}

/**
 * What this device knows the server holds of the account's list: each document's name with its
 * `updatedMs`, as the last merge read them from the server and the writes confirmed since left
 * them. Two copies of an entry with the same `updatedMs` are the same copy, so an entry missing on
 * one side in a version this device saw on the server was deleted on that side, rather than added
 * on the other.
 */
export type KnownCubes = ReadonlyMap<string, number>;

/** What a merge starts from. */
export interface CubeMergeInput {
  /** Settings' list on this device. */
  readonly local: readonly CubeMac[];
  /** The account's documents that could be read. */
  readonly cloud: readonly CloudCubeEntry[];
  /** The names of the documents that could not be read (another version): they are left alone. */
  readonly unreadable: readonly string[];
  readonly known: KnownCubes;
  /**
   * The documents came from the server. False: from this device's cache, the server out of reach,
   * which may miss documents; a deletion is then never inferred from a document missing there.
   */
  readonly fromServer: boolean;
}

/** What a merge leaves: Settings' list, and what this device knows the server holds. */
export interface CubeMerge {
  readonly local: CubeMac[];
  readonly known: Map<string, number>;
}

/**
 * What makes the account's list match Settings' list, relative to what the server is known to hold.
 */
export interface CubeChanges {
  /** The entries to write: not on the server, or in another version there. */
  readonly writes: CubeMac[];
  /** The documents to delete: no entry of Settings' list has their name any more. */
  readonly deletes: string[];
  /** The entries whose names cannot name a document: they stay on this device. */
  readonly unsyncable: CubeMac[];
}

/** A cube's name as Settings matches it: ignoring case. */
export function cubeKey(name: string): string {
  return name.toLowerCase();
}

/**
 * The union of Settings' list and the account's, by name ignoring case (docs/DATA-MODEL.md §10):
 * - on both sides, the copy changed last wins: the account's newer copy replaces this device's
 *   (equal times with different contents: the account's, so that every device ends the same), and
 *   this device's newer copy stays, for {@link cubeChanges} to write;
 * - only here: deleted in the account since this device saw that copy on the server (when the
 *   documents come from the server), or else new here, kept;
 * - only in the account: removed here since this device saw that copy on the server (the document
 *   then goes, through {@link cubeChanges}), or else new there, added;
 * - two documents whose names differ in case only count as one, the newer, and the other goes;
 * - a name whose document could not be read is left as it is on both sides.
 */
export function mergeCubes(input: CubeMergeInput): CubeMerge {
  const skipped = new Set(input.unreadable.map(cubeKey));
  const cloud = new Map<string, CloudCube>();
  for (const { cube } of input.cloud) {
    const key = cubeKey(cube.name);
    const other = cloud.get(key);
    if (
      other === undefined ||
      cube.updatedMs > other.updatedMs ||
      (cube.updatedMs === other.updatedMs && cube.name < other.name)
    ) {
      cloud.set(key, cube);
    }
  }
  const versions = new Map<string, Set<number>>();
  for (const [name, updatedMs] of input.known) {
    const key = cubeKey(name);
    versions.set(key, (versions.get(key) ?? new Set<number>()).add(updatedMs));
  }
  const knew = (key: string, updatedMs: number): boolean =>
    versions.get(key)?.has(updatedMs) === true;

  const local = new Map(input.local.map((entry) => [cubeKey(entry.name), entry]));
  const merged: CubeMac[] = [];
  for (const key of new Set([...local.keys(), ...cloud.keys()])) {
    const mine = local.get(key);
    const theirs = cloud.get(key);
    if (skipped.has(key)) {
      if (mine !== undefined) {
        merged.push(mine);
      }
    } else if (mine !== undefined && theirs !== undefined) {
      const theirsWins =
        theirs.updatedMs > mine.updatedMs ||
        (theirs.updatedMs === mine.updatedMs &&
          (theirs.name !== mine.name || theirs.mac !== mine.mac));
      merged.push(theirsWins ? entryOf(theirs) : mine);
    } else if (mine !== undefined) {
      if (!(input.fromServer && knew(key, mine.updatedMs))) {
        merged.push(mine);
      }
    } else if (theirs !== undefined && !knew(key, theirs.updatedMs)) {
      merged.push(entryOf(theirs));
    }
  }

  // From the server: what it holds now, except for this device's writes that it has not confirmed
  // yet, whose documents keep what was known of them. From the cache, which may miss documents:
  // what was known, updated with the documents there that the server had confirmed.
  const known = new Map<string, number>(input.fromServer ? [] : input.known);
  for (const { cube, pending } of input.cloud) {
    const before = input.known.get(cube.name);
    if (!pending) {
      known.set(cube.name, cube.updatedMs);
    } else if (before !== undefined) {
      known.set(cube.name, before);
    }
  }
  return { local: sortByName(merged), known };
}

/**
 * The writes and deletions that make the account's list match `local`, given what the server is
 * known to hold (with the writes on their way): every entry not there in its version, every
 * document whose name no entry has (an entry renamed, if only in case, writes its new document and
 * deletes the old one). Names whose key is in `skip` are left alone.
 */
export function cubeChanges(
  local: readonly CubeMac[],
  known: KnownCubes,
  skip: ReadonlySet<string>,
): CubeChanges {
  const names = new Set(local.map((entry) => entry.name));
  const kept = local.filter((entry) => !skip.has(cubeKey(entry.name)));
  return {
    writes: kept.filter(
      (entry) => isCubeDocumentName(entry.name) && known.get(entry.name) !== entry.updatedMs,
    ),
    deletes: [...known.keys()].filter((name) => !names.has(name) && !skip.has(cubeKey(name))),
    unsyncable: kept.filter((entry) => !isCubeDocumentName(entry.name)),
  };
}

function entryOf(cube: CloudCube): CubeMac {
  return { name: cube.name, mac: cube.mac, updatedMs: cube.updatedMs };
}

function sortByName(entries: readonly CubeMac[]): CubeMac[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}
