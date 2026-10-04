# Things only the repository owner can do

Kept here so nothing is forgotten and nothing blocks the implementation. The coordinator
adds items; the owner ticks them when done (date and any detail that others need).

## Needed for phase 1

- [ ] **Enable GitHub Pages** for this repo: Settings → Pages → Build and deployment →
  Source: **GitHub Actions**. The `pages.yml` workflow then publishes `main` to
  `https://shermam.github.io/cubetrace/` after every merge. This is the development host
  for testing on the real phones and laptops (HTTPS is required for Web Bluetooth and the
  camera). Firebase Hosting replaces it in phase 3.
- [x] 2026-09-27 — Manual round 1 done on the MacBook Pro 2021 and the ThinkPhone with the GAN 12 ui (issues #19, #20; results in `docs/MANUAL-TESTS.md` and `docs/DEVICES.md`); the GAN 356 i3 is still to be tested when charged. **Manual round 1 (v0.1.0)**, now that the timer is on Pages (T1.6b): open
  https://shermam.github.io/cubetrace/ on one laptop and on the ThinkPhone and go through the
  T1.5, T1.6 and T1.7 sections of `docs/MANUAL-TESTS.md` with the GAN 12 ui FreePlay and the
  356 i3 (at least ten attempts on each cube), filling in the "Round 1" table at the top of that
  file: date, device, Chrome version and the model strings the cubes report. Then put each
  device's session export (Sessions → Export) in a GitHub issue, attached as a file (ten attempts
  make about 160 kB, too long to paste into an issue), and open an issue for every failure. The
  coordinator tags `v0.1.0` after the round.
- [x] 2026-09-27 — Device probe run on the MacBook Pro 2021 (FaceTime) and the ThinkPhone (front and rear cameras): `docs/DEVICES.md`. Still to run, when convenient: the Moto g60 (both cameras) and the MacBook Pro 2016.
- [ ] `chrome://flags` on each device: keep `#enable-web-bluetooth-new-permissions-backend`
  (or whatever flag the app's connect screen names) enabled so the cube's MAC address can
  be read automatically; otherwise enter the MAC once per cube in Settings.

## Needed for phase 2

- [ ] **Manual round 2 (v0.2.0)** — released on 2026-09-27 at night, once the fixes from the
  first real recordings were on Pages (T2.8 sync check, T2.9 clips and audio, T2.10 video quality;
  issues #32–#34): open https://shermam.github.io/cubetrace/ on the MacBook Pro 2021 and on the
  ThinkPhone and go through the "Round 2 (v0.2.0)" block at the top of `docs/MANUAL-TESTS.md`
  (T2.1, T2.4, T2.5, T2.7, T2.10, then T2.3) with the GAN 12 ui FreePlay (and the 356 i3), on the
  MacBook's camera and on both of the phone's: fill in its table, attach to one issue each device's
  session export, one attempt's downloaded clips per device, the console lines and the screenshots
  it lists, write its numbers into `docs/DEVICES.md` (or into that issue), and open an issue for
  every failure. Three things to look at in particular: the sync check wants a framing rectangle
  around the cube (it asks for one; if it still fails, attach its "Download check data" JSON and the
  console's `cubetrace: sync check …` line); the recording panel's codec line now names the audio
  state (say what it shows, and whether a downloaded clip has sound: the viewer starts muted); and a
  clip that begins late is saved and marked, no longer lost. The coordinator then asks for the
  `v0.2.0` release (from the GitHub UI: the session cannot push tags).

## Needed for phase 3 (Firebase)

- [x] 2026-09-27 — Firebase project created: `cubetrace-cacd9`
  (https://console.firebase.google.com/project/cubetrace-cacd9/overview). Still to do there
  before phase 3 starts, in this order (each is a few clicks in the console):
  - [x] Blaze plan with a budget alert (2026-09-27).
  - [x] Authentication → Google sign-in enabled (2026-09-27).
  - [x] Firestore created in production mode, location **`nam5`** (US multi-region;
    2026-09-27). Fine for the index: it cannot be moved later, its per-operation prices are
    about twice a single region's, and the volume (a few hundred documents a day) makes that
    cents. Cloud Functions will run in `us-central1`, inside `nam5`.
  - [x] Web app registered (2026-09-27); its config object (public by design) goes into the
    repo when phase 3 lands.
  - [x] 2026-10-01 — **Paste the web config** into the repo: done by the coordinator, from the
    Firebase Management API, as `apps/web/src/environments/firebase.ts` (T3.0).
  - [x] 2026-09-27 — `shermam.github.io` added to Authentication → Settings → Authorized domains.
  - [ ] **No CLI login needed: one service account, two keys** (decided 2026-09-27). In the
    Google Cloud console of `cubetrace-cacd9`: IAM → Service accounts → create `deploy` with
    the roles Firebase Admin, Service Account User, Secret Manager Admin, Cloud Run Admin,
    Cloud Build Editor and Artifact Registry Administrator (Editor also works, but is
    broader). Then two JSON keys, revocable one by one:
    - key 1 → the Claude Code cloud environment's variables as `FIREBASE_SA_KEY_JSON`: the
      coordinator session (never a subagent) runs `firebase deploy`, `functions:secrets:set`
      and rules deploys with it during phases 3+;
    - key 2 → the repository secret `FIREBASE_SERVICE_ACCOUNT` (Settings → Secrets and
      variables → Actions): the deploy workflow that phase 3 adds, so merges to `main`
      deploy without anyone's machine.
    Delete the downloaded files afterwards. Neither key is ever committed, printed in a PR or
    handed to an agent; `CLAUDE.md` will say so. Browser only, no Codespace, no local CLI.
  - [x] 2026-10-01 — The Firestore rules of T3.0 are deployed, by the coordinator through the
    Firebase Rules API with the environment's key (the Admin SDK account's: `firebase deploy` is
    refused without **Service Usage Consumer**, so give that account the role, or put the `deploy`
    account's key in the environment, before T3.2's functions).
  - [ ] **Add the repository secret `FIREBASE_SERVICE_ACCOUNT`** (T3.0), for
    `.github/workflows/firebase.yml`, which deploys the Firestore rules on every merge to `main`
    that changes them (`firebase/**`, `firebase.json`, `.firebaserc`) and, without the secret, fails
    in its first step saying so (the coordinator deploys from its session meanwhile). The key:
    Firebase console → Project settings → Service accounts → **Generate new private key** downloads
    a JSON key of the Admin SDK's service account
    (`firebase-adminsdk-…@cubetrace-cacd9.iam.gserviceaccount.com`). `firebase deploy` first checks
    that the Firestore API is enabled, which that account's own role does not allow: in the Google
    Cloud console → IAM, give it **Service Usage Consumer**, and **Firebase Rules Admin** if a deploy
    then still says `PERMISSION_DENIED` about `firebaserules`. The `deploy` account of the item above
    (key 2) needs neither, since Firebase Admin covers both, and it will also deploy T3.2's
    functions: its key is the better one here. Then GitHub → Settings → Secrets and variables →
    Actions → New repository secret, named `FIREBASE_SERVICE_ACCOUNT`, the whole JSON file as its
    value; delete the downloaded file; Actions → Firebase → Run workflow deploys the rules once, to
    check.
- [x] 2026-09-27 — **Bucket decided: Google Cloud Storage first, Cloudflare R2 later.** The
  Firebase project's billing account is a Google Cloud free trial (R$ 1,761.10 of credit, until
  2026-12-27) and the credit applies to Cloud Storage's storage *and* internet egress as well as to
  Firestore and Cloud Functions, so the solo phase (one solver, phases 2–3) runs on GCS at no
  cost: at the design's cadence one camera is roughly 100–130 GB a month, i.e. a few dollars of
  storage and about US$ 0.12 per GiB when the dataset is downloaded to the training machine,
  all inside the credit. The function serves both providers by configuration; `BUCKET_PROVIDER`
  starts as `gcs`. **Before 2026-12-27**, decide: stay on GCS (paid: ~US$ 0.02/GB-month plus
  egress) or copy the bucket to R2 while the credit still pays the egress (`rclone`), for the
  community version. To do when phase 3 asks: in the Google Cloud console of `cubetrace-cacd9`,
  create the bucket `cubetrace-data` in `us-central1`, Standard class, uniform bucket-level access,
  public access prevented; the CORS policy comes from the repo (`bucket/cors.json`) and is applied
  with `gcloud storage buckets update --cors-file` by the coordinator; the function's service
  account needs Storage Object Admin on that bucket and the Service Account Token Creator role on
  itself to sign URLs.
  - Note on the card: Google charges the card only after the trial account is *activated* to a
    full account (Billing → the "Activate" banner); until then usage beyond the credit is refused
    and, when the trial ends, the project drops to the Spark plan and the paid pieces (Functions,
    the bucket) stop. Either way the R$ 100 budget alert only warns; the blocked virtual card is
    the actual stop, and a failed payment suspends the billing account rather than charging.
  - The R2 steps, for later: a Cloudflare account, R2 → Create bucket `cubetrace` (location hint
    Eastern North America), an API token with Object Read & Write on that bucket, and the three
    values (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`) as GitHub Actions
    secrets, never committed; the bucket's CORS rule is pasted from the repo.
- [x] 2026-09-27 — Bucket provider decided: GCS during the free trial, R2 as the later option (see above); both stay supported by configuration.
- [ ] **The bucket and the functions of T3.2**, by the coordinator with the environment's key, in this
  order (`bucket/README.md` and `functions/README.md` have the commands):
  1. The key's roles. The Admin SDK account (the environment's key since T3.0) needs, in Google
     Cloud IAM, **Service Usage Consumer**, **Cloud Functions Developer**, **Service Account User**
     and **Storage Admin**; or put the `deploy` account's key (key 1 of the item above) in the
     environment instead, whose roles cover all of it. If the first deploy stops while making the
     callable functions public (`setIamPolicy` on their Cloud Run services), the Admin SDK account also
     needs **Cloud Run Admin**, which the `deploy` account has; with R2, later, **Secret Manager
     Admin** too.
  2. The bucket `cubetrace-data` (`us-central1`, Standard, uniform bucket-level access, public access
     prevented) and its CORS policy from `bucket/cors.json`.
  3. The functions' service account, the project's default compute one
     (`60596954832-compute@developer.gserviceaccount.com`): **Storage Object Admin** on the bucket and
     **Service Account Token Creator** on itself (it signs the URLs), and the **IAM Service Account
     Credentials API** enabled in the project.
  4. The first deploy of the functions: `npm ci`, then `npm run firebase -- deploy --only functions
     --project cubetrace-cacd9 --non-interactive --force` (the `--force` sets, once, the cleanup policy
     of the functions' container images, without which a deploy without prompts fails after
     deploying), and the check of `docs/MANUAL-TESTS.md`, "T3.2". From then on
     `.github/workflows/firebase.yml` deploys them with the rules on each merge that changes them, once
     the `FIREBASE_SERVICE_ACCOUNT` secret is there (its account needs the roles of step 1).
- [ ] Run `python ferramentas/banda.py` (private repo) at home and at the office and record
  the upstream in `docs/DEVICES.md`; it sets the upload queue's expectations.
- [ ] **Manual round 3 (v0.3.0)**, once the coordinator has made sure that `main`'s rules, indexes
  and functions are deployed and the bucket is set up, and run the T3.2 check (the items above):
  open https://shermam.github.io/cubetrace/ on the MacBook Pro 2021 (Chrome) and in the installed
  app on the ThinkPhone, sign in on both with the same Google account, and go through the "Round 3
  (v0.3.0)" block at the top of `docs/MANUAL-TESTS.md` (T3.0, T3.4, T3.1, T3.3, then T2.14) with the
  GAN 12 ui FreePlay: two attempts on each device with the camera on, one merged Sessions list on
  both, the queue's panel, the files in the bucket (`gcloud storage ls -r
  gs://cubetrace-data/users/` in Cloud Shell, or `rclone ls` from the training machine), the QA
  view's counts, Keep local copies off on the phone ("in the cloud"), the cube's MAC address synced,
  the two cameras of T2.14, and whether the installed app comes back signed in from Google's page.
  Fill in its table, attach to one issue the exports, the bucket's listing, the console lines and
  the screenshots it lists, write its numbers into `docs/DEVICES.md` ("Manual round 3"), and open an
  issue for every failure.
- [x] 2026-10-02 — **The `v0.3.0` release** created by the owner (round 3's sign-in question settled by T3.6, issue #50). (Was:) after round 3, from the GitHub UI (the coordinator's session cannot
  push tags): Releases → Draft a new release → Choose a tag: type `v0.3.0` and choose "Create new
  tag on publish", target `main` (after T3.6 merges: the installed app's sign-in, issue #50), title
  `0.3.0`, the notes from the 0.3.0 section of `docs/CHANGELOG.md` → Publish release. The `v0.2.0`
  release, if still missing (round 2's item), is made the same way, on the commit the coordinator
  names.

## Needed for phase 4

- [ ] **The `v0.4.0` release**, once T4.4's pull request is merged, from the GitHub UI (the
  coordinator's session cannot push tags): Releases → Draft a new release → Choose a tag: type
  `v0.4.0` and choose "Create new tag on publish", Target: 16ad587 (the merge commit of PR #66) (the
  coordinator writes it here once merged; under Target → Recent commits, or `main` while nothing has
  been merged after it), title `cubetrace 0.4.0`, as 0.3.0's, the notes from the 0.4.0 section of
  `docs/CHANGELOG.md` → Publish release.
- [ ] **The "After T4" round (the desk rig, 0.4.0)**, the owner's next action: on
  https://shermam.github.io/cubetrace/ once its footer reads `cubetrace 0.4.0 · <commit>`, set the
  rig up as `README.md`, "The desk rig", says (the MacBook with its FaceTime camera and the GAN 12
  ui, the ThinkPhone on its stand, paired as `phone-rear`, and the lamp; a second phone if one is at
  hand, with a name of its own in Settings → This device), signed in on both devices with Settings →
  Account → Diagnostics on (the default), and go through "After T4" in `docs/MANUAL-TESTS.md` in its
  order. Write down only what its items ask beside the events (the phone's temperature by hand, the
  tile, the phone's moves against its picture, how long things took), and open an issue for anything
  that fails. The coordinator then reads the round from the events (`npm run round-report`), fills
  `docs/DEVICES.md`'s Remote cameras rows and the live preview's cost from them, and closes issue #61
  if a pairing stayed converged for twenty minutes.

## Later

- [ ] Phase 2 rig: tripod + phone clamp, a lamp with a diffuser for the desk; the sofa
  pedestal and lights.
- [ ] Before any community upload: the consent flow and the ethics committee decisions
  described in the private design (§12).
