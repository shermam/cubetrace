# Things only the repository owner can do

Kept here so nothing is forgotten and nothing blocks the implementation. The coordinator
adds items; the owner ticks them when done (date and any detail that others need).

## Needed for phase 1

- [ ] **Enable GitHub Pages** for this repo: Settings → Pages → Build and deployment →
  Source: **GitHub Actions**. The `pages.yml` workflow then publishes `main` to
  `https://shermam.github.io/cubetrace/` after every merge. This is the development host
  for testing on the real phones and laptops (HTTPS is required for Web Bluetooth and the
  camera). Firebase Hosting replaces it in phase 3.
- [ ] **Test on the real cube** after T1.6 lands (the coordinator will ask): connect the
  GAN 12 ui FreePlay and the 356 i3 on one laptop and on the ThinkPhone, do ten attempts,
  and paste the session export (Sessions → Export) into the PR or an issue. The checklist
  is `docs/MANUAL-TESTS.md`.
- [ ] **Run the device probe** (`/probe` route, after T1.8 lands) on both phones (rear and
  front cameras) and on each laptop, and paste the JSON reports into `docs/DEVICES.md`.
  This decides the phase 2 camera settings.
- [ ] `chrome://flags` on each device: keep `#enable-web-bluetooth-new-permissions-backend`
  (or whatever flag the app's connect screen names) enabled so the cube's MAC address can
  be read automatically; otherwise enter the MAC once per cube in Settings.

## Needed for phase 3 (Firebase)

- [ ] Create the Firebase project (Blaze plan; a budget alert at, say, US$ 20/month) and
  paste the web app config into `apps/web/src/environments/environment.prod.ts` as
  documented there. Enable Google sign-in in Authentication and create the Firestore
  database (production mode; rules come from the repo).
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
