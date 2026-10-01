// The account's backend on the Firebase SDK (docs/ARCHITECTURE.md, "Account"): Authentication with
// the Google provider, and Firestore for users/{uid} and the session index (T3.1), through the modular
// API. This is the only file that imports Firebase, and only ACCOUNT_LOADER's dynamic import loads it,
// so the SDK is a lazy chunk of its own, firebase-sdk-<hash>.js, which the service worker caches only
// once it has been used (ngsw-config.json): a device that never signs in never downloads it.
import {
  attemptDocumentId,
  type CloudAttempt,
  type CloudAttemptFields,
  type CloudSession,
} from '@cubetrace/core';
import { initializeApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  browserPopupRedirectResolver,
  getRedirectResult,
  indexedDBLocalPersistence,
  initializeAuth,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import {
  collection,
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
  where,
  writeBatch,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  type QuerySnapshot,
} from 'firebase/firestore';

import { FIREBASE_CONFIG } from '../../environments/firebase';
import type { AccountBackend, BackendUser, CloudDocument, CloudListing } from './account-backend';

/** The most writes one batch may hold (Firestore's limit). */
const BATCH_WRITES = 500;

/** Starts Firebase: call once per page (`AuthService` keeps the backend). */
export function connectFirebase(): AccountBackend {
  const app = initializeApp(FIREBASE_CONFIG);
  // The account is kept in IndexedDB across reloads. No popup and redirect resolver here: the calls
  // that open Google's page pass it, so that a remembered sign-in starts without Google's iframe.
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
      await signInWithPopup(auth, google, browserPopupRedirectResolver);
    },
    signInWithRedirect: () => signInWithRedirect(auth, google, browserPopupRedirectResolver),
    redirectResult: async () => {
      const result = await getRedirectResult(auth, browserPopupRedirectResolver);
      return result === null ? null : backendUser(result.user);
    },
    signOut: () => signOut(auth),
    saveUser: (uid, record) => setDoc(doc(firestore, 'users', uid), record, { merge: true }),
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
  };
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
