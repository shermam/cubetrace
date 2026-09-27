// The JSON Schemas (draft 2020-12) of the records (docs/DATA-MODEL.md §6, §7 and §9): session.json
// and attempt.json in schema version 2, which the app writes, and in version 1, which it still
// reads, and the frames files of the video clips. They live as JSON files in packages/core/schema/,
// imported here as JSON modules (TypeScript resolves them with the base tsconfig's
// `moduleResolution: bundler`; the bundlers inline them). The app itself reads records with
// records.ts, which checks the same rules without a validator.
import attemptSchemaV1 from '../schema/attempt.v1.schema.json';
import attemptSchema from '../schema/attempt.schema.json';
import framesSchema from '../schema/frames.schema.json';
import sessionSchemaV1 from '../schema/session.v1.schema.json';
import sessionSchema from '../schema/session.schema.json';

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
