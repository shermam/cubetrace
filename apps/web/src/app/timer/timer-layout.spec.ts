import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import { FakeMediaQuery } from '../device/fake-browser';
import {
  TWO_COLUMNS_QUERY,
  remotePicturesLayout,
  timerLayout,
  windowMatches,
  type TimerLayout,
} from './timer-layout';

describe('timerLayout', () => {
  it("keeps T2.7's columns on a wide window, whatever the camera and the setting", () => {
    for (const cameraOn of [false, true]) {
      for (const overPicture of [false, true]) {
        expect(timerLayout(true, cameraOn, overPicture)).toBe('columns');
      }
    }
  });

  it('on a phone: the scramble over the picture with the camera on, pinned alone with it off', () => {
    expect(timerLayout(false, true, true)).toBe('overlay');
    expect(timerLayout(false, false, true)).toBe('pinned');
  });

  it("on a phone with Scramble over the picture off: T2.7's column, camera on or off", () => {
    expect(timerLayout(false, true, false)).toBe('stacked');
    expect(timerLayout(false, false, false)).toBe('stacked');
  });

  it('asks for the width of the two columns of styles/_layout.scss', () => {
    expect(TWO_COLUMNS_QUERY).toBe('(min-width: 60rem)');
  });
});

describe('remotePicturesLayout', () => {
  /** The layout of the phones' pictures for a host (`phone` or not), a window and the choice. */
  function pictures(
    phone: boolean,
    wide: boolean,
    chosen: 'equal' | 'tiles' | null,
    cameraOn = true,
    overPicture = true,
  ): string {
    return remotePicturesLayout(chosen, timerLayout(wide, cameraOn, overPicture), phone);
  }

  it("gives a laptop the same size as its own picture by default, beside the time (T2.7's columns)", () => {
    expect(pictures(false, true, null)).toBe('equal');
    expect(pictures(false, true, null, false)).toBe('equal');
    // Chosen: as chosen.
    expect(pictures(false, true, 'tiles')).toBe('tiles');
    expect(pictures(false, true, 'equal')).toBe('equal');
  });

  it('gives a phone small tiles by default, and what it chose where its layout allows', () => {
    expect(pictures(true, false, null)).toBe('tiles');
    expect(pictures(true, false, null, false)).toBe('tiles');
    // T2.7's column on a phone (Scramble over the picture off), or a camera off: as chosen.
    expect(pictures(true, false, 'equal', true, false)).toBe('equal');
    expect(pictures(true, false, 'equal', false)).toBe('equal');
    // A tablet wide enough for the columns: its default is still a phone's.
    expect(pictures(true, true, null)).toBe('tiles');
  });

  it("keeps tiles in a phone's overlay (T2.13), whatever was chosen, also in a narrow laptop window", () => {
    const layouts: TimerLayout[] = ['columns', 'stacked', 'pinned', 'overlay'];
    for (const chosen of ['equal', 'tiles', null] as const) {
      for (const phone of [false, true]) {
        expect(remotePicturesLayout(chosen, 'overlay', phone)).toBe('tiles');
      }
    }
    // The laptop's window narrowed under the two columns, the camera on: the overlay.
    expect(pictures(false, false, 'equal')).toBe('tiles');
    // Narrowed with the camera off (pinned), or with Scramble over the picture off: its choice.
    expect(pictures(false, false, null, false)).toBe('equal');
    expect(pictures(false, false, null, true, false)).toBe('equal');
    expect(layouts.map((layout) => remotePicturesLayout('equal', layout, false))).toEqual([
      'equal',
      'equal',
      'equal',
      'tiles',
    ]);
  });
});

describe('windowMatches', () => {
  @Component({ selector: 'app-wide-probe', template: '' })
  class WideProbe {
    readonly wide = windowMatches(TWO_COLUMNS_QUERY);
  }

  function render(globals: BrowserGlobals) {
    TestBed.configureTestingModule({
      providers: [{ provide: BROWSER_GLOBALS, useValue: globals }],
    });
    return TestBed.createComponent(WideProbe);
  }

  it('follows the media query from its first answer, until the component goes', () => {
    const query = new FakeMediaQuery(true);
    const asked: string[] = [];
    const fixture = render({
      matchMedia: (media) => {
        asked.push(media);
        return query;
      },
    });
    const wide = fixture.componentInstance.wide;

    expect(asked).toEqual(['(min-width: 60rem)']);
    expect(wide()).toBe(true);
    // A phone turned upright, then back.
    query.set(false);
    expect(wide()).toBe(false);
    query.set(true);
    expect(wide()).toBe(true);

    // Gone: it no longer listens.
    fixture.destroy();
    query.set(false);
    expect(wide()).toBe(true);
  });

  it('is false where the browser has no matchMedia, as on the phone the styles start from', () => {
    expect(render({}).componentInstance.wide()).toBe(false);
  });
});
