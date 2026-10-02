import { readEmulators } from './account-backend';

describe('readEmulators', () => {
  // What the end-to-end suite's cloud project sets (apps/web/e2e/helpers/emulators.ts).
  const emulators = {
    projectId: 'demo-cubetrace',
    auth: '127.0.0.1:9099',
    firestore: '127.0.0.1:8080',
    functions: '127.0.0.1:5001',
    googleIdToken: '{"sub":"e2e-ada","email":"ada@example.com","email_verified":true}',
  };

  it('reads the emulators of the end-to-end suite', () => {
    expect(readEmulators(emulators)).toEqual(emulators);
    expect(readEmulators({ ...emulators, extra: true })).toEqual(emulators);
  });

  it('is null without them, so that the app reaches Firebase as it always does', () => {
    for (const value of [undefined, null, 'demo-cubetrace', 42, () => emulators]) {
      expect(readEmulators(value)).toBeNull();
    }
    for (const field of Object.keys(emulators)) {
      expect(readEmulators({ ...emulators, [field]: undefined }), field).toBeNull();
      expect(readEmulators({ ...emulators, [field]: '' }), field).toBeNull();
      expect(readEmulators({ ...emulators, [field]: 9099 }), field).toBeNull();
    }
  });
});
