// The JSON Schemas (draft 2020-12) of session.json and attempt.json, schema version 1
// (docs/DATA-MODEL.md §6 and §7), for validating records and exports. They live as JSON files in
// packages/core/schema/, imported here as JSON modules (TypeScript resolves them with the base
// tsconfig's `moduleResolution: bundler`; the bundlers inline them).
import attemptSchema from '../schema/attempt.schema.json';
import sessionSchema from '../schema/session.schema.json';

/**
 * A JSON Schema document, read-only. With ajv: `new Ajv2020({ allowUnionTypes: true })` from
 * `ajv/dist/2020`, since the fields that may be null are typed `["number", "null"]` (ajv's default
 * strict mode otherwise warns about union types). ajv's optional `strictRequired` check must stay
 * off: it rejects the `if`/`then` rule that only F2L phases have a `slot`, which is valid JSON Schema.
 */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** The schema of session.json. */
export const SESSION_SCHEMA: JsonSchema = sessionSchema;

/** The schema of attempt.json. */
export const ATTEMPT_SCHEMA: JsonSchema = attemptSchema;
