import { TestBed } from '@angular/core/testing';

import { ClipsInFlight } from './clips-in-flight';
import { SESSION_A, SESSION_B } from './session-testing';

describe('ClipsInFlight', () => {
  it("counts each attempt's clips to come, and changes its version with each", () => {
    const clips = TestBed.inject(ClipsInFlight);
    const version = clips.version();
    expect(clips.has(SESSION_A, 1)).toBe(false);
    clips.begin(SESSION_A, 1);
    clips.begin(SESSION_A, 1);
    clips.begin(SESSION_B, 1);
    expect(clips.has(SESSION_A, 1)).toBe(true);
    expect(clips.has(SESSION_A, 2)).toBe(false);
    clips.end(SESSION_A, 1);
    expect(clips.has(SESSION_A, 1)).toBe(true);
    clips.end(SESSION_A, 1);
    expect(clips.has(SESSION_A, 1)).toBe(false);
    expect(clips.has(SESSION_B, 1)).toBe(true);
    // An end without its begin changes nothing but the version.
    clips.end(SESSION_A, 3);
    expect(clips.has(SESSION_A, 3)).toBe(false);
    expect(clips.version()).toBe(version + 6);
  });
});
