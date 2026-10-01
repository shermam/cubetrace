// The Firebase project of cubetrace, cubetrace-cacd9 (docs/USER-ACTIONS.md, phase 3): the web app's
// config as the Firebase console gives it. It is public by design, not a secret: it names the project
// to the SDK, and what anyone may read or write there is decided by the Firestore rules
// (firebase/firestore.rules) and Authentication's authorized domains. Only the account's lazy chunk
// imports it (app/auth/firebase-sdk.ts).
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAi-h7xqdO2cz2wswT4BoWu1o3WdUJLme0',
  authDomain: 'cubetrace-cacd9.firebaseapp.com',
  projectId: 'cubetrace-cacd9',
  storageBucket: 'cubetrace-cacd9.firebasestorage.app',
  messagingSenderId: '60596954832',
  appId: '1:60596954832:web:aa09888a4575a99b6d20d5',
  measurementId: 'G-Q73EMTB159',
} as const;
