import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { BROWSER_GLOBALS, type BrowserGlobals } from '../device/browser-globals';
import { FakeMediaQuery } from '../device/fake-browser';
import { TWO_COLUMNS_QUERY, timerLayout, windowMatches } from './timer-layout';

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
