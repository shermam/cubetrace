import { Routes } from '@angular/router';

// Every page is lazy-loaded so the initial bundle stays small once cubing.js arrives.
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Timer · cubetrace',
    loadComponent: () => import('./timer/timer-page').then((m) => m.TimerPage),
  },
  {
    path: 'sessions',
    title: 'Sessions · cubetrace',
    loadComponent: () => import('./sessions/sessions-page').then((m) => m.SessionsPage),
  },
  {
    path: 'sessions/:id',
    title: 'Session · cubetrace',
    loadComponent: () => import('./sessions/session-page').then((m) => m.SessionPage),
  },
  {
    // The cloud index's attempts by day and device (docs/PLAN.md, T3.1), linked from the Sessions
    // page signed in.
    path: 'qa',
    title: 'QA · cubetrace',
    loadComponent: () => import('./qa/qa-page').then((m) => m.QaPage),
  },
  {
    path: 'settings',
    title: 'Settings · cubetrace',
    loadComponent: () => import('./settings/settings-page').then((m) => m.SettingsPage),
  },
  {
    path: 'probe',
    title: 'Device probe · cubetrace',
    loadComponent: () => import('./probe/probe-page').then((m) => m.ProbePage),
  },
  {
    // The phone as a camera of another device's session (docs/PLAN.md, T4.1): reached from the QR
    // code the host shows (`?session=<id>&token=<t>`), or by typing the code there; not in the
    // navigation. Its chunk carries the connection's code (@cubetrace/rtc), which the Timer page's
    // own Cameras section loads only when a camera is added.
    path: 'camera',
    title: 'Camera · cubetrace',
    loadComponent: () =>
      import('./camera-device/camera-device-page').then((m) => m.CameraDevicePage),
  },
  {
    // The capture pipeline on its own (docs/PLAN.md, T2.2): a tool reached by its address, not in
    // the navigation.
    path: 'capture-lab',
    title: 'Capture lab · cubetrace',
    loadComponent: () => import('./capture-lab/capture-lab-page').then((m) => m.CaptureLabPage),
  },
  { path: '**', redirectTo: '' },
];
