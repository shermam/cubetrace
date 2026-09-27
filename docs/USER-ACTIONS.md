# Things only the repository owner can do

Kept here so nothing is forgotten and nothing blocks the implementation. The coordinator
adds items; the owner ticks them when done (date and any detail that others need).

## Needed for phase 1

- [ ] **Enable GitHub Pages** for this repo: Settings → Pages → Build and deployment →
  Source: **GitHub Actions**. The `pages.yml` workflow then publishes `main` to
  `https://shermam.github.io/cubetrace/` after every merge. This is the development host
  for testing on the real phones and laptops (HTTPS is required for Web Bluetooth and the
  camera). Firebase Hosting replaces it in phase 3.
- [ ] **Manual round 1 (v0.1.0)**, now that the timer is on Pages (T1.6b): open
  https://shermam.github.io/cubetrace/ on one laptop and on the ThinkPhone and go through the
  T1.5, T1.6 and T1.7 sections of `docs/MANUAL-TESTS.md` with the GAN 12 ui FreePlay and the
  356 i3 (at least ten attempts on each cube), filling in the "Round 1" table at the top of that
  file: date, device, Chrome version and the model strings the cubes report. Then put each
  device's session export (Sessions → Export) in a GitHub issue, attached as a file (ten attempts
  make about 160 kB, too long to paste into an issue), and open an issue for every failure. The
  coordinator tags `v0.1.0` after the round.
- [ ] **Run the device probe** (`/probe` route, after T1.8 lands) on both phones (rear and
  front cameras) and on each laptop, and paste the JSON reports into `docs/DEVICES.md`.
  This decides the phase 2 camera settings.
- [ ] `chrome://flags` on each device: keep `#enable-web-bluetooth-new-permissions-backend`
  (or whatever flag the app's connect screen names) enabled so the cube's MAC address can
  be read automatically; otherwise enter the MAC once per cube in Settings.

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
- [x] 2026-09-27 — **Bucket decided: Cloudflare R2.** To do when the coordinator asks (phase 3):
  in the Cloudflare dashboard, R2 → Create bucket `cubetrace` (location hint: Eastern North
  America, so it sits near `nam5`); R2 → Manage API tokens → Create API token with
  **Object Read & Write** on that bucket only; keep the Access Key ID, the Secret Access Key
  and the account id (the S3 endpoint is `https://<account-id>.r2.cloudflarestorage.com`).
  They go into GitHub Actions secrets (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
  `R2_ACCOUNT_ID`), from which the deploy workflow stores them as Firebase secrets; they are
  never committed. The bucket's CORS rule (PUT and GET from `https://shermam.github.io` and,
  later, the Firebase Hosting domain) comes from the repo as a file you paste in the
  bucket's Settings → CORS policy.
- [x] 2026-09-27 — Bucket provider decided: R2 (see above). GCS stays supported by
  configuration for anyone else deploying the app.
- [ ] Run `python ferramentas/banda.py` (private repo) at home and at the office and record
  the upstream in `docs/DEVICES.md`; it sets the upload queue's expectations.

## Later

- [ ] Phase 2 rig: tripod + phone clamp, a lamp with a diffuser for the desk; the sofa
  pedestal and lights.
- [ ] Before any community upload: the consent flow and the ethics committee decisions
  described in the private design (§12).
