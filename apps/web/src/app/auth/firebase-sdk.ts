// The account's backend on the Firebase SDK (docs/ARCHITECTURE.md, "Account"): Authentication with
// the Google provider, and Firestore for users/{uid}, through the modular API. This is the only file
// that imports Firebase, and only ACCOUNT_LOADER's dynamic import loads it, so the SDK is a lazy chunk
// of its own, firebase-sdk-<hash>.js, which the service worker caches only once it has been used
// (ngsw-config.json): a device that never signs in never downloads it.
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
  doc,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  setDoc,
} from 'firebase/firestore';

import { FIREBASE_CONFIG } from '../../environments/firebase';
import type { AccountBackend, BackendUser } from './account-backend';

/** Starts Firebase: call once per page (`AuthService` keeps the backend). */
export function connectFirebase(): AccountBackend {
  const app = initializeApp(FIREBASE_CONFIG);
  // The account is kept in IndexedDB across reloads. No popup and redirect resolver here: the calls
  // that open Google's page pass it, so that a remembered sign-in starts without Google's iframe.
  const auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  });
  // Writes go into a cache in IndexedDB first: offline they wait there, across reloads, for the
  // network (the session index of T3.1 relies on it too).
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
