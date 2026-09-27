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
    // The capture pipeline on its own (docs/PLAN.md, T2.2): a tool reached by its address, not in
    // the navigation.
    path: 'capture-lab',
    title: 'Capture lab · cubetrace',
    loadComponent: () => import('./capture-lab/capture-lab-page').then((m) => m.CaptureLabPage),
  },
  { path: '**', redirectTo: '' },
];
