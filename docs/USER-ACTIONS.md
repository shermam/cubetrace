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
  - [ ] Upgrade to the Blaze plan and set a budget alert (say US$ 20/month) in the linked
    Google Cloud billing account.
  - [ ] Authentication → Sign-in method → enable **Google**.
  - [ ] Firestore Database → Create database → production mode, region `southamerica-east1`
    (São Paulo) or `us-central1` (the bucket's region, decided below); the rules come from
    the repo.
  - [ ] Project settings → Your apps → Add app → Web (nickname `cubetrace`, no Firebase
    Hosting yet): the config object it shows (apiKey, authDomain, projectId, …) is not a
    secret; paste it where `apps/web/src/environments/environment.prod.ts` will say when
    phase 3 lands.
  - [ ] Phase 3 also needs the Firebase CLI logged in once on your machine (`firebase login`)
    to deploy the Cloud Function that mints signed URLs; the coordinator will say when.
- [ ] Decide the bucket: Cloudflare R2 (recommended in the design: free egress) or Google
  Cloud Storage. Both are supported by configuration; the decision sets which secret the
  Cloud Function gets. For R2: create the bucket and an API token with object write; for
  GCS: the bucket in `us-central1` with a lifecycle rule to Coldline after 60 days.
- [ ] Run `python ferramentas/banda.py` (private repo) at home and at the office and record
  the upstream in `docs/DEVICES.md`; it sets the upload queue's expectations.

## Later

- [ ] Phase 2 rig: tripod + phone clamp, a lamp with a diffuser for the desk; the sofa
  pedestal and lights.
- [ ] Before any community upload: the consent flow and the ethics committee decisions
  described in the private design (§12).
