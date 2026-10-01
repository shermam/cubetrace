// The Cloud Functions of the Firebase project cubetrace-cacd9 (functions/README.md): signUpload and
// confirmUpload, callable, in us-central1, for signed-in accounts only. Their logic is in uploads.ts;
// this file plugs it into Firebase: the Admin SDK, the bucket of the configuration (params.ts) and the
// structured logger.
import { Storage } from '@google-cloud/storage';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onCall, type CallableOptions } from 'firebase-functions/https';
import * as logger from 'firebase-functions/logger';
import { setGlobalOptions } from 'firebase-functions/options';

import {
  gcsObjectStore,
  r2Client,
  r2ObjectStore,
  unconfiguredObjectStore,
  type ObjectStore,
} from './object-store.js';
import {
  BUCKET_NAME,
  BUCKET_PROVIDER,
  MAX_FILE_BYTES,
  QUOTA_BYTES_PER_DAY,
  QUOTA_FILES_PER_DAY,
  R2_ACCOUNT_ID,
  R2_KEYS,
} from './params.js';
import * as uploads from './uploads.js';

// Next to Firestore (nam5); at most ten instances, a ceiling on what a runaway client can cost.
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const options: CallableOptions = {
  // App Check is not set up yet; the functions require a signed-in account instead.
  enforceAppCheck: false,
  secrets: R2_KEYS === null ? [] : [R2_KEYS.accessKeyId, R2_KEYS.secretAccessKey],
};

export const signUpload = onCall(options, (request) => uploads.signUpload(deps(), request));

export const confirmUpload = onCall(options, (request) => uploads.confirmUpload(deps(), request));

let cached: uploads.UploadDeps | undefined;

/** The functions' dependencies, made on an instance's first call, from the configuration. */
function deps(): uploads.UploadDeps {
  cached ??= {
    db: getFirestore(getApps()[0] ?? initializeApp()),
    store: objectStore(),
    limits: {
      bytesPerDay: QUOTA_BYTES_PER_DAY.value(),
      filesPerDay: QUOTA_FILES_PER_DAY.value(),
      maxFileBytes: MAX_FILE_BYTES.value(),
    },
    now: () => Date.now(),
    log: logger,
  };
  return cached;
}

/** The bucket of the configuration; one that says what is missing when the configuration is not whole. */
function objectStore(): ObjectStore {
  const provider = BUCKET_PROVIDER.value();
  const bucket = BUCKET_NAME.value();
  if (provider === 'gcs') {
    return gcsObjectStore(new Storage().bucket(bucket));
  }
  if (provider !== 'r2') {
    return unconfiguredObjectStore(provider, bucket, 'BUCKET_PROVIDER is neither gcs nor r2');
  }
  const credentials = {
    accountId: R2_ACCOUNT_ID.value(),
    accessKeyId: R2_KEYS?.accessKeyId.value() ?? '',
    secretAccessKey: R2_KEYS?.secretAccessKey.value() ?? '',
  };
  if (credentials.accountId === '') {
    return unconfiguredObjectStore(provider, bucket, 'R2_ACCOUNT_ID is empty');
  }
  if (credentials.accessKeyId === '' || credentials.secretAccessKey === '') {
    return unconfiguredObjectStore(
      provider,
      bucket,
      'the R2 secrets are not bound: deploy with BUCKET_PROVIDER=r2 in functions/.env',
    );
  }
  return r2ObjectStore(r2Client(credentials), bucket);
}
