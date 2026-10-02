import type { Page } from '@playwright/test';

// The end-to-end suite's cloud project (npm run e2e:cloud): the app's own Firebase SDK against the Auth,
// Firestore and Functions emulators that `firebase emulators:exec` runs around Playwright (their ports
// in firebase.json), under the offline project demo-cubetrace, and the functions' bucket the sink on
// this machine (bucket-sink.mts). The page takes the emulators from `window.cubetraceE2eEmulators`
// (src/app/auth/account-backend.ts, development builds only); the tests read what the app wrote through
// the emulators' REST APIs, past the rules, and what reached the bucket through the sink.

/** The emulators' project; `emulators:exec` says it in GCLOUD_PROJECT. */
export const PROJECT = process.env['GCLOUD_PROJECT'] ?? 'demo-cubetrace';
const AUTH = process.env['FIREBASE_AUTH_EMULATOR_HOST'] ?? '127.0.0.1:9099';
const FIRESTORE = process.env['FIRESTORE_EMULATOR_HOST'] ?? '127.0.0.1:8080';
/** firebase.json's port: `emulators:exec` names no variable for the Functions emulator. */
const FUNCTIONS = '127.0.0.1:5001';
/** The bucket sink, as the Playwright config starts it and functions/.env.demo-cubetrace names it. */
export const SINK_PORT = 4600;
const SINK = `http://127.0.0.1:${String(SINK_PORT)}`;

/** The emulators' REST APIs take this token as the project's owner, past the rules. */
const OWNER = { Authorization: 'Bearer owner' };

/** A Google account, as the Auth emulator's Google provider signs it in. */
export interface GoogleAccount {
  /** Google's id of the account: the same `sub` signs in the same account, on any page. */
  readonly sub: string;
  readonly email: string;
  readonly name: string;
}

/**
 * Points the app of `page` at the emulators for every page load (call it before `page.goto`): Sign in
 * then signs in `account`, through the Auth emulator's Google provider, without Google's page.
 */
export async function useEmulators(page: Page, account: GoogleAccount): Promise<void> {
  const googleIdToken = JSON.stringify({
    sub: account.sub,
    email: account.email,
    email_verified: true,
    name: account.name,
  });
  await page.addInitScript(
    (emulators) => {
      Reflect.set(window, 'cubetraceE2eEmulators', emulators);
    },
    { projectId: PROJECT, auth: AUTH, firestore: FIRESTORE, functions: FUNCTIONS, googleIdToken },
  );
}

/** The Auth emulator's record of the account of `email`: its uid and when it was created (ms). */
export async function authAccount(
  email: string,
): Promise<{ readonly uid: string; readonly createdMs: number } | null> {
  const response = await fetch(
    `http://${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`,
    {
      method: 'POST',
      headers: { ...OWNER, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: [email] }),
    },
  );
  if (!response.ok) {
    throw new Error(`The Auth emulator answered ${String(response.status)}.`);
  }
  const { users } = (await response.json()) as {
    users?: { localId: string; createdAt: string }[];
  };
  const user = users?.[0];
  return user === undefined ? null : { uid: user.localId, createdMs: Number(user.createdAt) };
}

/** A value as the Firestore REST API writes it. */
interface FirestoreValue {
  readonly nullValue?: null;
  readonly booleanValue?: boolean;
  readonly integerValue?: string;
  readonly doubleValue?: number | string;
  readonly stringValue?: string;
  readonly timestampValue?: string;
  readonly mapValue?: { readonly fields?: Readonly<Record<string, FirestoreValue>> };
  readonly arrayValue?: { readonly values?: readonly FirestoreValue[] };
}

interface FirestoreDocument {
  readonly name: string;
  readonly fields?: Readonly<Record<string, FirestoreValue>>;
}

/** A document's fields as plain JSON, as the app wrote them. */
export type Fields = Record<string, unknown>;

function fieldsOf(fields: Readonly<Record<string, FirestoreValue>> = {}): Fields {
  return Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, valueOf(value)]));
}

function valueOf(value: FirestoreValue): unknown {
  if (value.mapValue !== undefined) {
    return fieldsOf(value.mapValue.fields);
  }
  if (value.arrayValue !== undefined) {
    return (value.arrayValue.values ?? []).map(valueOf);
  }
  if (value.integerValue !== undefined) {
    return Number(value.integerValue);
  }
  if (value.doubleValue !== undefined) {
    return Number(value.doubleValue);
  }
  if (value.stringValue !== undefined) {
    return value.stringValue;
  }
  if (value.booleanValue !== undefined) {
    return value.booleanValue;
  }
  if (value.timestampValue !== undefined) {
    return value.timestampValue;
  }
  if ('nullValue' in value) {
    return null;
  }
  throw new Error(`A Firestore value this reader does not know: ${JSON.stringify(value)}.`);
}

function documentsUrl(path: string): string {
  return `http://${FIRESTORE}/v1/projects/${PROJECT}/databases/(default)/documents/${path}`;
}

/** The document at `path` (`users/<uid>`) in the Firestore emulator; null when there is none. */
export async function firestoreDocument(path: string): Promise<Fields | null> {
  const response = await fetch(documentsUrl(path), { headers: OWNER });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`The Firestore emulator answered ${String(response.status)} for ${path}.`);
  }
  return fieldsOf(((await response.json()) as FirestoreDocument).fields);
}

/** The documents of the collection at `path` (`sessions/<id>/attempts`), by id. */
export async function firestoreCollection(path: string): Promise<Record<string, Fields>> {
  const response = await fetch(`${documentsUrl(path)}?pageSize=300`, { headers: OWNER });
  if (!response.ok) {
    throw new Error(`The Firestore emulator answered ${String(response.status)} for ${path}.`);
  }
  const { documents = [] } = (await response.json()) as { documents?: FirestoreDocument[] };
  return Object.fromEntries(
    documents.map((document) => [document.name.split('/').pop() ?? '', fieldsOf(document.fields)]),
  );
}

/** An object of the bucket sink. */
export interface SinkObject {
  readonly key: string;
  readonly bytes: number;
  readonly contentType: string;
}

/** The sink's objects whose keys start with `prefix`, by key. */
export async function sinkObjects(prefix: string): Promise<SinkObject[]> {
  const response = await fetch(`${SINK}/?prefix=${encodeURIComponent(prefix)}`);
  return (await response.json()) as SinkObject[];
}

/** The bytes of the sink's object at `key`, as text; null when there is none. */
export async function sinkText(key: string): Promise<string | null> {
  const response = await fetch(`${SINK}/${key}`);
  return response.status === 404 ? null : response.text();
}
