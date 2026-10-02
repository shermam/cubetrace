// The JSON Schemas (draft 2020-12) of the records (docs/DATA-MODEL.md §6, §7, §9, §10 and §11):
// session.json and attempt.json in schema version 2, which the app writes, and in version 1, which it
// still reads, the frames files of the video clips, the gyro files (T3.7), users/{uid}, the account's
// record in Firestore, the documents of the session index there (T3.1), the account's cubes (T3.4)
// and its diagnostics events (T3.9). They live as JSON
// files in packages/core/schema/, imported here as JSON modules (TypeScript resolves them with the
// base tsconfig's `moduleResolution: bundler`; the bundlers inline them). The app itself reads
// records with records.ts, which checks the same rules without a validator.
import attemptSchemaV1 from '../schema/attempt.v1.schema.json';
import attemptSchema from '../schema/attempt.schema.json';
import cloudAttemptSchema from '../schema/cloud-attempt.schema.json';
import cloudCubeSchema from '../schema/cloud-cube.schema.json';
import cloudEventSchema from '../schema/cloud-event.schema.json';
import cloudSessionSchema from '../schema/cloud-session.schema.json';
import framesSchema from '../schema/frames.schema.json';
import gyroSchema from '../schema/gyro.schema.json';
import sessionSchemaV1 from '../schema/session.v1.schema.json';
import sessionSchema from '../schema/session.schema.json';
import userSchema from '../schema/user.schema.json';

/**
 * A JSON Schema document, read-only. With ajv: `new Ajv2020({ allowUnionTypes: true })` from
 * `ajv/dist/2020`, since the fields that may be null are typed `["number", "null"]` (ajv's default
 * strict mode otherwise warns about union types). ajv's optional `strictRequired` check must stay
 * off: it rejects the `if`/`then` rule that only F2L phases have a `slot`, which is valid JSON Schema.
 * Each schema has its own `$id`, so that all of them can be compiled by one ajv instance.
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** The schema of session.json, version 2: what the app writes. */
export const SESSION_SCHEMA: JsonSchema = sessionSchema;

/** The schema of attempt.json, version 2: what the app writes. */
export const ATTEMPT_SCHEMA: JsonSchema = attemptSchema;

/** The schema of session.json, version 1 (cubetrace 0.1): read, never written. */
export const SESSION_SCHEMA_V1: JsonSchema = sessionSchemaV1;

/** The schema of attempt.json, version 1 (cubetrace 0.1): read, never written. */
export const ATTEMPT_SCHEMA_V1: JsonSchema = attemptSchemaV1;

/** The schema of `<camera>.<segment>.frames.json`, the frame times of a clip (version 2). */
export const FRAMES_SCHEMA: JsonSchema = framesSchema;

/** The schema of `gyro.json`, the gyroscope samples of an attempt (its own version 1, §11, T3.7). */
export const GYRO_SCHEMA: JsonSchema = gyroSchema;

/** The schema of users/{uid} in Firestore, the account's record (schema version 1, §10). */
export const USER_SCHEMA: JsonSchema = userSchema;

/**
 * The schema of `sessions/{id}` in Firestore, a session's document in the session index (schema
 * version 2, §10): session.json with its owner.
 */
export const CLOUD_SESSION_SCHEMA: JsonSchema = cloudSessionSchema;

/**
 * The schema of `sessions/{id}/attempts/{index}` in Firestore, an attempt's document in the session
 * index (schema version 2, §10): attempt.json without its moves, with its owner, device and upload.
 */
export const CLOUD_ATTEMPT_SCHEMA: JsonSchema = cloudAttemptSchema;

/**
 * The schema of `users/{uid}/cubes/{name}` in Firestore, a cube of the account's list of MAC
 * addresses (schema version 1, §10, T3.4).
 */
export const CLOUD_CUBE_SCHEMA: JsonSchema = cloudCubeSchema;

/**
 * The schema of `users/{uid}/events/{eventId}` in Firestore, a diagnostics event of an account
 * (schema version 1, §10, T3.9; the catalogue of kinds is docs/DIAGNOSTICS.md).
 */
export const CLOUD_EVENT_SCHEMA: JsonSchema = cloudEventSchema;
