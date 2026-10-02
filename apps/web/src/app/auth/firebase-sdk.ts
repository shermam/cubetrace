// The account's backend on the Firebase SDK (docs/ARCHITECTURE.md, "Account"): Authentication with
// the Google provider, Firestore for users/{uid} (with the clip viewer's choices in it, T3.10), the
// session index (T3.1), the account's cubes (T3.4) and its diagnostics events (T3.9), and the
// upload's two callable functions (T3.3), through the modular API. This is the only
// file that imports Firebase, and only ACCOUNT_LOADER's dynamic import loads it, so the SDK is a
// lazy chunk of its own, firebase-sdk-<hash>.js, which the service worker caches only once it has
// been used (ngsw-config.json): a device that never signs in never downloads it. In development builds
// the end-to-end suite's cloud project can point it at the Firebase emulators (FirebaseEmulators).
import {
  attemptDocumentId,
  type CloudAttempt,
  type CloudAttemptFields,
  type CloudSession,
} from '@cubetrace/core';
import type { ConfirmRequest, ConfirmResult, SignRequest, SignedFile } from '@cubetrace/upload';
import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  browserPopupRedirectResolver,
  connectAuthEmulator,
  indexedDBLocalPersistence,
  initializeAuth,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  initializeFirestore,
  limit,
  orderBy,
  persistentLocalCache,
  persistentMultipleTabManager,
  query,
  setDoc,
  waitForPendingWrites,
  where,
  writeBatch,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type QuerySnapshot,
} from 'firebase/firestore';
import {
  connectFunctionsEmulator,
  getFunctions,
  httpsCallable,
  type Functions,
} from 'firebase/functions';

import { FIREBASE_CONFIG } from '../../environments/firebase';
import type {
  AccountBackend,
  BackendUser,
  CloudDocument,
  CloudListing,
  FirebaseEmulators,
} from './account-backend';

/** The most writes one batch may hold (Firestore's limit). */
const BATCH_WRITES = 500;

/** Where the functions run (functions/README.md). */
const FUNCTIONS_REGION = 'us-central1';

/**
 * Starts Firebase: call once per page (`AuthService` keeps the backend). With `emulators` (the
 * end-to-end suite's, in development builds only: account-backend.ts), against the emulators' offline
 * project rather than Google's servers.
 */
export function connectFirebase(emulators: FirebaseEmulators | null = null): AccountBackend {
  const app = initializeApp(
    emulators === null ? FIREBASE_CONFIG : { ...FIREBASE_CONFIG, projectId: emulators.projectId },
  );
  // The account is kept in IndexedDB across reloads. No popup resolver here: the one call that opens
  // Google's page passes it (browserPopupRedirectResolver, the SDK's resolver for popups too), so
  // that a remembered sign-in starts without Google's iframe.
  const auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  });
  // Writes go into a cache in IndexedDB first: offline they wait there, across reloads, for the
  // network, and so do the session index's (T3.1), whose queries read the cache when offline.
  const firestore = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });
  const google = new GoogleAuthProvider();
  // Google asks which account to use, rather than taking the browser's only one silently.
  google.setCustomParameters({ prompt: 'select_account' });
  // The upload's functions (T3.2), called with the account's token; their errors keep the
  // HttpsError's code (`functions/resource-exhausted`) and details.
  const functions = getFunctions(app, FUNCTIONS_REGION);
  if (emulators !== null) {
    useEmulators(emulators, auth, firestore, functions);
  }
  const sign = httpsCallable<SignRequest, SignedFile[]>(functions, 'signUpload');
  const confirm = httpsCallable<ConfirmRequest, ConfirmResult>(functions, 'confirmUpload');
  return {
    watchUser: (next, error) =>
      onAuthStateChanged(
        auth,
        (user) => {
          next(user === null ? null : backendUser(user));
        },
        error,
      ),
    signInWithPopup: async () => {
      if (emulators !== null) {
        // The end-to-end suite: the Auth emulator's Google provider takes the account's claims as they
        // are, so no window opens.
        await signInWithCredential(auth, GoogleAuthProvider.credential(emulators.googleIdToken));
        return;
      }
      await signInWithPopup(auth, google, browserPopupRedirectResolver);
    },
    signOut: () => signOut(auth),
    saveUser: (uid, record) => setDoc(doc(firestore, 'users', uid), record, { merge: true }),
    getUser: async (uid) => {
      const snapshot = await getDoc(doc(firestore, 'users', uid));
      return snapshot.exists() ? cloudDocument(snapshot) : null;
    },
    // The clip viewer's choices (T3.10): a merge, so that the cameras not named keep theirs.
    saveViewer: (uid, viewer) => setDoc(doc(firestore, 'users', uid), { viewer }, { merge: true }),
    saveSessionIndex: async (session, attempts = []) => {
      // The session first, then its attempts, which the rules accept only under a session of the same
      // owner: one batch, or batches in that order when a session has more than 499 attempts.
      const writes: [DocumentReference, CloudSession | CloudAttempt | CloudAttemptFields][] = [
        [doc(firestore, 'sessions', session.id), session],
        ...attempts.map((attempt): [DocumentReference, CloudAttempt | CloudAttemptFields] => [
          attemptRef(firestore, attempt.session, attempt.index),
          attempt,
        ]),
      ];
      const commits: Promise<void>[] = [];
      for (let start = 0; start < writes.length; start += BATCH_WRITES) {
        const batch = writeBatch(firestore);
        for (const [ref, data] of writes.slice(start, start + BATCH_WRITES)) {
          batch.set(ref, data, { merge: true });
        }
        commits.push(batch.commit());
      }
      await Promise.all(commits);
    },
    saveAttemptIndex: (attempt) =>
      setDoc(attemptRef(firestore, attempt.session, attempt.index), attempt, { merge: true }),
    deleteAttemptIndex: (sessionId, index) => deleteDoc(attemptRef(firestore, sessionId, index)),
    listSessions: async (uid, max) =>
      listing(
        await getDocs(
          query(
            collection(firestore, 'sessions'),
            where('owner', '==', uid),
            orderBy('createdMs', 'desc'),
            limit(max),
          ),
        ),
      ),
    getSession: async (sessionId) => {
      const snapshot = await getDoc(doc(firestore, 'sessions', sessionId));
      return snapshot.exists() ? cloudDocument(snapshot) : null;
    },
    listAttempts: async (uid, sessionId) =>
      listing(
        await getDocs(
          query(
            collection(firestore, 'sessions', sessionId, 'attempts'),
            where('owner', '==', uid),
          ),
        ),
      ),
    waitForIndexWrites: () => waitForPendingWrites(firestore),
    signUpload: async (request) => (await sign(request)).data,
    confirmUpload: async (request) => (await confirm(request)).data,
    // The cubes (T3.4): users/{uid}/cubes/{name}, each written whole.
    listCubes: async (uid) => listing(await getDocs(collection(firestore, 'users', uid, 'cubes'))),
    saveCube: (uid, cube) => setDoc(doc(firestore, 'users', uid, 'cubes', cube.name), cube),
    deleteCube: (uid, name) => deleteDoc(doc(firestore, 'users', uid, 'cubes', name)),
    // The diagnostics events (T3.9): each created whole, in batches of at most 500.
    saveEvents: async (uid, events) => {
      const commits: Promise<void>[] = [];
      for (let start = 0; start < events.length; start += BATCH_WRITES) {
        const batch = writeBatch(firestore);
        for (const { id, event } of events.slice(start, start + BATCH_WRITES)) {
          batch.set(doc(firestore, 'users', uid, 'events', id), event);
        }
        commits.push(batch.commit());
      }
      await Promise.all(commits);
    },
    listEvents: async (uid, max) =>
      listing(
        await getDocs(
          query(collection(firestore, 'users', uid, 'events'), orderBy('tsMs', 'desc'), limit(max)),
        ),
      ),
  };
}

/**
 * Points Authentication, Firestore and the functions at the end-to-end suite's emulators, before
 * anything is asked of them. The Auth emulator's banner, which would cover the bottom of the page, is
 * left out.
 */
function useEmulators(
  emulators: FirebaseEmulators,
  auth: Auth,
  firestore: Firestore,
  functions: Functions,
): void {
  connectAuthEmulator(auth, `http://${emulators.auth}`, { disableWarnings: true });
  const store = hostAndPort(emulators.firestore);
  connectFirestoreEmulator(firestore, store.host, store.port);
  const callable = hostAndPort(emulators.functions);
  connectFunctionsEmulator(functions, callable.host, callable.port);
}

/** `127.0.0.1:8080` as its host and port. */
function hostAndPort(address: string): { host: string; port: number } {
  const url = new URL(`http://${address}`);
  return { host: url.hostname, port: Number(url.port) };
}

/** sessions/{id}/attempts/{index}, its id the index zero-padded as the attempt's folder. */
function attemptRef(firestore: Firestore, sessionId: string, index: number): DocumentReference {
  return doc(firestore, 'sessions', sessionId, 'attempts', attemptDocumentId(index));
}

function cloudDocument(snapshot: DocumentSnapshot): CloudDocument {
  return {
    id: snapshot.id,
    data: snapshot.data(),
    pending: snapshot.metadata.hasPendingWrites,
  };
}

function listing(snapshot: QuerySnapshot): CloudListing {
  return {
    documents: snapshot.docs.map(cloudDocument),
    fromCache: snapshot.metadata.fromCache,
  };
}

function backendUser(user: User): BackendUser {
  // A date as `toUTCString()` writes it, to the second; the same on every device.
  const created = Date.parse(user.metadata.creationTime ?? '');
  return {
    uid: user.uid,
    displayName: user.displayName,
    email: user.email,
    photoURL: user.photoURL,
    createdMs: Number.isFinite(created) ? created : null,
  };
}
