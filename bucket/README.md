# The dataset's bucket

Where the uploads go (`docs/ARCHITECTURE.md`, "Uploads"): objects
`users/{uid}/sessions/{sessionId}/attempts/{index}/<file>` and
`users/{uid}/sessions/{sessionId}/session.json`, put by the browser through URLs that `signUpload`
signs (`functions/README.md`), never public. The provider is a configuration (`BUCKET_PROVIDER` in
`functions/.env`): Google Cloud Storage during the free trial, Cloudflare R2 later
(`docs/USER-ACTIONS.md`, phase 3). Nothing here is created by a workflow: the coordinator does it
once, by hand.

## CORS

The app uploads from `https://shermam.github.io` (Pages) and `http://localhost:4200` (`npm start`).
A signed `PUT` carries `Content-Type`, and on GCS `x-goog-content-length-range`, both bound by the
signature; the browser asks the bucket in a preflight whether it may send them, and the bucket
answers from its CORS policy. `GET` is there for reads through signed URLs later.

- `cors.json`: Google Cloud Storage's policy, in the format of `gcloud storage buckets update
  --cors-file` and of the JSON API's `cors` field. Its `responseHeader` is what the preflight
  checks the request's headers against.
- `cors.r2.json`: R2's, in the format of the Cloudflare dashboard (bucket → Settings → CORS policy).
  `Content-Length`, which the URL also binds, is set by the browser and needs no rule.

Another origin (Firebase Hosting, a second test port) goes into both files and is applied again.

## Google Cloud Storage (now)

**The bucket.** With a key whose account has Storage Admin, or in the Google Cloud console:

```sh
gcloud storage buckets create gs://cubetrace-data --project=cubetrace-cacd9 \
  --location=us-central1 --default-storage-class=STANDARD \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://cubetrace-data --cors-file=bucket/cors.json
gcloud storage buckets describe gs://cubetrace-data --format="default(cors_config)"
```

With `gsutil`: `gsutil mb -p cubetrace-cacd9 -l us-central1 -b on --pap enforced gs://cubetrace-data`,
then `gsutil cors set bucket/cors.json gs://cubetrace-data` and `gsutil cors get gs://cubetrace-data`.
Without either, the JSON API with the key's access token:
`POST https://storage.googleapis.com/storage/v1/b?project=cubetrace-cacd9` with
`{"name": "cubetrace-data", "location": "US-CENTRAL1", "storageClass": "STANDARD",
"iamConfiguration": {"uniformBucketLevelAccess": {"enabled": true}, "publicAccessPrevention":
"enforced"}, "cors": <the content of cors.json>}`; a later change of CORS is
`PATCH https://storage.googleapis.com/storage/v1/b/cubetrace-data` with `{"cors": <cors.json>}`.

**The functions' identity.** Second-generation functions run as the project's default compute
service account unless told otherwise: `60596954832-compute@developer.gserviceaccount.com`
(60596954832 is the project's number, the web config's `messagingSenderId`; the Cloud Run service of
either function names its account under Security). It signs the URLs with its own key through the
IAM Credentials API (`signBlob`), and a signed `PUT` then acts with its permissions on the bucket:

```sh
SA=60596954832-compute@developer.gserviceaccount.com
gcloud services enable iamcredentials.googleapis.com --project=cubetrace-cacd9
gcloud storage buckets add-iam-policy-binding gs://cubetrace-data \
  --member="serviceAccount:$SA" --role=roles/storage.objectAdmin
gcloud iam service-accounts add-iam-policy-binding "$SA" --project=cubetrace-cacd9 \
  --member="serviceAccount:$SA" --role=roles/iam.serviceAccountTokenCreator
```

Storage Object Admin rather than Object Creator: putting a file over an object that is there (a
`session.json` that changed, an upload retried after it went through) needs the right to delete as
well as to create, and `confirmUpload` reads the objects' sizes. Service Account Token Creator on
itself is what lets it sign. It also writes Firestore (the quota, the attempt's `upload`): the
default compute account is an Editor of a project without an organization; otherwise give it Cloud
Datastore User. Without Token Creator, or with the API off, `signUpload` fails with `internal` and the
function's log says `signBlob` was denied; nothing is recorded or counted.

**A check**, once the functions are deployed: a URL from `signUpload` accepts
`curl -X PUT -H 'Content-Type: application/json' -H 'x-goog-content-length-range: 2,2' --data-binary
'{}' '<url>'` for a two-byte `attempt.json`, and refuses a body of any other size, another
`Content-Type`, or the request after `expiresAt`.

## Cloudflare R2 (later)

1. Cloudflare dashboard → R2 → Create bucket `cubetrace`, location hint Eastern North America (or
   `npx wrangler r2 bucket create cubetrace --location enam`).
2. The bucket → Settings → CORS policy → paste `cors.r2.json`. Through the S3 API instead:
   `aws s3api put-bucket-cors --bucket cubetrace --endpoint-url
   https://<account id>.r2.cloudflarestorage.com --cors-configuration
   "{\"CORSRules\": $(cat bucket/cors.r2.json)}"`.
3. R2 → Manage API tokens → Create API token: Object Read & Write, this bucket only. Its Access Key ID
   and Secret Access Key are the two secrets.
4. The coordinator stores them in Secret Manager: `npm run firebase -- functions:secrets:set
   R2_ACCESS_KEY_ID --project cubetrace-cacd9`, the same for `R2_SECRET_ACCESS_KEY` (each prompts for
   its value, or reads `--data-file`). Never in the repo, a PR or a workflow's log.
5. A pull request sets, in `functions/.env`, `BUCKET_PROVIDER=r2`, `BUCKET_NAME=cubetrace` and
   `R2_ACCOUNT_ID=<account id>` (not a secret: it is in every URL); its deploy binds the two secrets
   to both functions, and refuses to go on while either is missing from Secret Manager.
6. The objects already in GCS: copied with `rclone` while the trial still pays the egress
   (`docs/USER-ACTIONS.md`).

The R2 signer is tested against the SigV4 scheme (`functions/src/object-store.test.ts`), not yet
against R2 itself: the first upload there is part of the switch.
