// users/{uid}/cubes/{name} in Firestore (docs/DATA-MODEL.md §10, docs/PLAN.md T3.4, issue #21),
// schema version 1: Settings' list of the cubes' MAC addresses, one document per cube, by the
// Bluetooth name the cube reports, so that a MAC address typed once on one device of an account is
// known on the others. It is the account's, never the dataset's: no file of §5 holds a MAC address,
// so neither an export nor the uploads (T3.3) carry one.

/**
 * A MAC address as Settings keeps it (`normalizeMac` of `@cubetrace/gan`) and the documents hold it:
 * six hex bytes in upper case with colons between them, such as `AB:12:CD:34:EF:56`.
 */
export const MAC_ADDRESS = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/u;

/**
 * A cube's name that can be the id of its document, as Firestore's ids must be: not empty, without
 * `/`, neither `.` nor `..`, and not `__…__` (reserved). The byte limit of an id (1,500 bytes) is
 * {@link isCubeDocumentName}'s.
 */
export const CUBE_NAME = /^(?!\.\.?$)(?!__.*__$)[^/]+$/u;

/** The most bytes of a document's id (Firestore's limit), its name's UTF-8. */
const MAX_ID_BYTES = 1_500;

/** users/{uid}/cubes/{name}, schema version 1 (docs/DATA-MODEL.md §10). */
export interface CloudCube {
  schema: 1;
  /**
   * The cube's Bluetooth name as Settings has it (as Chrome's device list shows it, such as
   * `GAN12ui_AB12`; the cube's own when the connect dialog stored it): the document's id. Settings
   * matches names ignoring case.
   */
  name: string;
  /** Its MAC address, normalized ({@link MAC_ADDRESS}). */
  mac: string;
  /**
   * When the entry last changed, in ms, on the host clock of the device that changed it: of two
   * copies of an entry, the one changed last wins a merge.
   */
  updatedMs: number;
  /** The host label of the device that wrote the document (Settings → This device). */
  device: string;
}

/** What a device writes for an entry of its list. */
export interface CloudCubeInput {
  name: string;
  mac: string;
  updatedMs: number;
  /** The writer's host label. */
  device: string;
}

/** users/{uid}/cubes/{name} of an entry of Settings' list, as `device` writes it. */
export function cloudCube(input: CloudCubeInput): CloudCube {
  return {
    schema: 1,
    name: input.name,
    mac: input.mac,
    updatedMs: input.updatedMs,
    device: input.device,
  };
}

/**
 * Whether `name` can be the id of a cube's document ({@link CUBE_NAME}, and at most 1,500 bytes): a
 * cube whose name cannot stays on its device.
 */
export function isCubeDocumentName(name: string): boolean {
  return CUBE_NAME.test(name) && new TextEncoder().encode(name).byteLength <= MAX_ID_BYTES;
}
