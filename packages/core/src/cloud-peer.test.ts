import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, it, vi } from 'vitest';

import type { CloudCandidate, CloudPeer, JsonSchema } from './index';
import {
  ATTEMPT_SCHEMA,
  ATTEMPT_SCHEMA_V1,
  CANDIDATE_COLLECTIONS,
  CANDIDATE_MAX_LENGTH,
  CLOUD_ATTEMPT_SCHEMA,
  CLOUD_CANDIDATE_SCHEMA,
  CLOUD_CUBE_SCHEMA,
  CLOUD_EVENT_SCHEMA,
  CLOUD_PEER_SCHEMA,
  CLOUD_SESSION_SCHEMA,
  FRAMES_SCHEMA,
  GYRO_SCHEMA,
  PEER_STATES,
  RecordError,
  SDP_MAX_LENGTH,
  SESSION_SCHEMA,
  SESSION_SCHEMA_V1,
  TOKEN_HASH,
  USER_SCHEMA,
  cloudCandidate,
  cloudPeer,
  parseCloudCandidate,
  parseCloudPeer,
} from './index';

// The signaling documents of the remote cameras in Firestore (docs/DATA-MODEL.md §10, docs/RTC.md,
// docs/PLAN.md T4.0): what the builders write, the JSON Schemas, and the readers the app reads the
// documents back with, held to the schemas field by field as cloud-cube.test.ts holds the cubes'.

const ajv = new Ajv2020({ allowUnionTypes: true, allErrors: true });
const isPeer = ajv.compile<CloudPeer>(CLOUD_PEER_SCHEMA);
const isCandidate = ajv.compile<CloudCandidate>(CLOUD_CANDIDATE_SCHEMA);

const HASH = '7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069';
const OFFER = { type: 'offer' as const, sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\n' };
const ANSWER = { type: 'answer' as const, sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\n' };

/** The phone's document as it joins: its offer, waiting for the answer. */
function offered(): CloudPeer {
  return cloudPeer({
    owner: 'ada-uid',
    createdMs: 1_790_000_000_123.5,
    tokenHash: HASH,
    offer: OFFER,
  });
}

/** The same once the host answered. */
function answered(): CloudPeer {
  return { ...offered(), answer: ANSWER, state: 'answered' };
}

/** A copy of `document` with the value at `path` replaced, or removed when `value` is undefined. */
function changed(document: unknown, path: readonly string[], value: unknown): unknown {
  const copy: unknown = structuredClone(document);
  let node = copy as Record<string, unknown>;
  for (const key of path.slice(0, -1)) {
    node = node[key] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (value === undefined) {
    Reflect.deleteProperty(node, last);
  } else {
    node[last] = value;
  }
  return copy;
}

describe('cloudPeer and cloudCandidate', () => {
  it("write the phone's peer document as docs/DATA-MODEL.md §10 describes it, in the schema's order", () => {
    expect(offered()).toEqual({
      schema: 1,
      owner: 'ada-uid',
      role: 'camera',
      createdMs: 1_790_000_000_123.5,
      tokenHash: HASH,
      offer: OFFER,
      answer: null,
      state: 'offered',
    });
    expect(Object.keys(offered())).toEqual(CLOUD_PEER_SCHEMA['required']);
    // A copy of the offer, not the caller's object.
    expect(offered().offer).not.toBe(OFFER);
    expect(PEER_STATES).toEqual(['offered', 'answered', 'closed']);
    expect(CANDIDATE_COLLECTIONS).toEqual({
      caller: 'callerCandidates',
      callee: 'calleeCandidates',
    });
  });

  it("write a candidate from the browser's RTCIceCandidateInit, with null for what it leaves out", () => {
    const init = {
      candidate: 'candidate:1 1 udp 2122260223 192.168.0.7 54321 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    expect(cloudCandidate(init, 1_790_000_000_200)).toEqual({
      ...init,
      createdMs: 1_790_000_000_200,
    });
    expect(Object.keys(cloudCandidate(init, 1))).toEqual(CLOUD_CANDIDATE_SCHEMA['required']);
    // The end-of-candidates mark has an empty candidate and no mid.
    expect(cloudCandidate({}, 5)).toEqual({
      candidate: '',
      sdpMid: null,
      sdpMLineIndex: null,
      createdMs: 5,
    });
    expect(
      cloudCandidate({ candidate: 'x', sdpMid: null, sdpMLineIndex: null }, 5).sdpMid,
    ).toBeNull();
  });
});

describe('the JSON Schemas of the signaling documents', () => {
  const others: JsonSchema[] = [
    ATTEMPT_SCHEMA,
    ATTEMPT_SCHEMA_V1,
    CLOUD_ATTEMPT_SCHEMA,
    CLOUD_CUBE_SCHEMA,
    CLOUD_EVENT_SCHEMA,
    CLOUD_SESSION_SCHEMA,
    FRAMES_SCHEMA,
    GYRO_SCHEMA,
    SESSION_SCHEMA,
    SESSION_SCHEMA_V1,
    USER_SCHEMA,
  ];

  it.each([
    ['sessions/{id}/peers/{peerId}', CLOUD_PEER_SCHEMA, /\/cloud-peer\.schema\.json$/],
    [
      'sessions/{id}/peers/{peerId}/callerCandidates/{id} and calleeCandidates/{id}',
      CLOUD_CANDIDATE_SCHEMA,
      /\/cloud-candidate\.schema\.json$/,
    ],
  ] as [string, JsonSchema, RegExp][])(
    'the schema of %s is draft 2020-12, compiles in ajv without a warning and has an $id of its own',
    (title, schema, id) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        new Ajv2020({ allowUnionTypes: true }).compile(schema);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
      expect(schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema['title']).toBe(title);
      expect(schema['$id']).toMatch(id);
      expect(others.map((other) => other['$id'])).not.toContain(schema['$id']);
    },
  );

  it('accept a peer offered, answered and closed, with or without its descriptions', () => {
    for (const valid of [
      offered(),
      answered(),
      { ...answered(), state: 'closed' },
      { ...offered(), offer: null },
      { ...answered(), offer: null },
      { ...offered(), offer: { type: 'offer', sdp: '' } },
      { ...offered(), offer: { type: 'offer', sdp: 'a'.repeat(SDP_MAX_LENGTH) } },
    ]) {
      expect(isPeer(valid), JSON.stringify(isPeer.errors)).toBe(true);
    }
    expect(SDP_MAX_LENGTH).toBe(20_000);
  });

  it.each([
    ['schema version 2', ['schema'], 2],
    ['no schema', ['schema'], undefined],
    ['no owner', ['owner'], undefined],
    ['an empty owner', ['owner'], ''],
    ['a role of host', ['role'], 'host'],
    ['no creation time', ['createdMs'], undefined],
    ['a creation time that is text', ['createdMs'], 'now'],
    ['no token hash', ['tokenHash'], undefined],
    ['a token hash in upper case', ['tokenHash'], HASH.toUpperCase()],
    ['a token hash of 63 digits', ['tokenHash'], HASH.slice(1)],
    ['the token itself as its hash', ['tokenHash'], 'A1B2C3D4'],
    ['no offer field', ['offer'], undefined],
    ['an offer that is text', ['offer'], OFFER.sdp],
    ['an offer of type answer', ['offer', 'type'], 'answer'],
    ['an offer without its SDP', ['offer', 'sdp'], undefined],
    ['an SDP that is a number', ['offer', 'sdp'], 1],
    ['an SDP of 20,001 characters', ['offer', 'sdp'], 'a'.repeat(SDP_MAX_LENGTH + 1)],
    ['an unknown field in a description', ['offer', 'ice'], 'lite'],
    ['no answer field', ['answer'], undefined],
    ['a state of paired', ['state'], 'paired'],
    ['no state', ['state'], undefined],
    ['an unknown field', ['device'], 'Android phone'],
  ] as [string, string[], unknown][])(
    'refuse a peer with %s, in the schema and in the reader',
    (_, path, value) => {
      const document = changed(offered(), path, value);
      expect(isPeer(document)).toBe(false);
      expect(() => parseCloudPeer(document)).toThrow(RecordError);
    },
  );

  it('refuse an answer of type offer', () => {
    const document = changed(answered(), ['answer', 'type'], 'offer');
    expect(isPeer(document)).toBe(false);
    expect(() => parseCloudPeer(document)).toThrow(
      'sessions/{id}/peers/{peerId} (schema 1): answer.type must be "answer", got "offer".',
    );
  });

  it('accept a candidate as the browser gives it, and the end-of-candidates mark', () => {
    const now = 1_790_000_000_200;
    for (const valid of [
      cloudCandidate(
        {
          candidate: 'candidate:1 1 udp 1 192.168.0.7 54321 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
        now,
      ),
      cloudCandidate({}, now),
      cloudCandidate(
        { candidate: 'c'.repeat(CANDIDATE_MAX_LENGTH), sdpMid: null, sdpMLineIndex: 3 },
        now,
      ),
    ]) {
      expect(isCandidate(valid), JSON.stringify(isCandidate.errors)).toBe(true);
      expect(parseCloudCandidate(structuredClone(valid))).toEqual(valid);
    }
    expect(CANDIDATE_MAX_LENGTH).toBe(1000);
  });

  it.each([
    ['no candidate', ['candidate'], undefined],
    ['a candidate that is a number', ['candidate'], 1],
    ['a candidate of 1,001 characters', ['candidate'], 'c'.repeat(CANDIDATE_MAX_LENGTH + 1)],
    ['a mid that is a number', ['sdpMid'], 0],
    ['a mid of 101 characters', ['sdpMid'], 'm'.repeat(101)],
    ['no line index field', ['sdpMLineIndex'], undefined],
    ['a negative line index', ['sdpMLineIndex'], -1],
    ['a fractional line index', ['sdpMLineIndex'], 0.5],
    ['no creation time', ['createdMs'], undefined],
    ['an unknown field', ['usernameFragment'], 'abc'],
  ] as [string, string[], unknown][])(
    'refuse a candidate with %s, in the schema and in the reader',
    (_, path, value) => {
      const document = changed(
        cloudCandidate({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 }, 1),
        path,
        value,
      );
      expect(isCandidate(document)).toBe(false);
      expect(() => parseCloudCandidate(document)).toThrow(RecordError);
    },
  );

  it('name the field that is wrong, and the document', () => {
    expect(() => parseCloudCandidate('x')).toThrow(
      'sessions/{id}/peers/{peerId}/candidates/{id} must be an object, got "x".',
    );
    expect(() =>
      parseCloudCandidate({ candidate: 'c', sdpMid: null, sdpMLineIndex: -1, createdMs: 1 }),
    ).toThrow(
      'sessions/{id}/peers/{peerId}/candidates/{id}: sdpMLineIndex must be an integer ≥ 0 or null, got -1.',
    );
    expect(() => parseCloudPeer({ ...offered(), schema: 2 })).toThrow(
      'sessions/{id}/peers/{peerId}: schema must be 1, got 2.',
    );
    expect(() => parseCloudPeer(null)).toThrow(
      'sessions/{id}/peers/{peerId} must be an object, got null.',
    );
  });
});

describe('parseCloudPeer', () => {
  it('returns what the phone and the host write as it is, as a new object', () => {
    for (const document of [offered(), answered()]) {
      const input = structuredClone(document);
      const read = parseCloudPeer(input);
      expect(read).toEqual(document);
      expect(Object.keys(read)).toEqual(Object.keys(document));
      expect(read.offer).not.toBe(input.offer);
    }
  });

  it('holds a token hash to 64 lowercase hex digits', () => {
    expect(TOKEN_HASH.test(HASH)).toBe(true);
    for (const text of [HASH.toUpperCase(), HASH.slice(1), `${HASH}0`, 'g'.repeat(64), '']) {
      expect(TOKEN_HASH.test(text), text).toBe(false);
    }
  });
});
