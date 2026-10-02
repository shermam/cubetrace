import { FakeCube } from '@cubetrace/gan';

import { asGanCube, bluetoothNavigator } from '../cube/cube-testing';
import { settle } from '../device/fake-browser';
import { setup, turn } from './session-harness';

// The cubes' MAC addresses are the account's, never the dataset's (docs/PLAN.md T3.4, issue #21;
// docs/DATA-MODEL.md §10): a session recorded with a cube whose address was typed and kept in
// Settings holds none in its records, session.json and attempt.json, which are what an export
// (Sessions → Export) is made of, and what the uploads (T3.3) send with the clips.

/** A MAC address in any usual form: six hex bytes with colons or dashes between them. */
const MAC_LIKE = /\b[0-9a-f]{2}([:-])[0-9a-f]{2}(?:\1[0-9a-f]{2}){4}\b/i;

describe("a session's records", () => {
  it('hold no MAC address, though the cube connected with one typed and kept in Settings', async () => {
    // Chrome without the flag that reads the address: the connect dialog asks for it.
    const s = setup({ navigator: bluetoothNavigator(false) });
    s.settings.saveCubeMac('GAN356i3_CD34', '11-22-33-44-55-66');
    await s.service.whenReady();
    s.service.prepare();
    await settle();

    const fake = new FakeCube({ now: () => s.perf.hostMs });
    const connecting = s.cube.connect();
    const answer = s.connector.last.macProvider({ name: 'GAN12ui_AB12', id: 'device-1' }, true);
    expect(s.cube.answerMac('ab:12:cd:34:ef:56', true)).toBeNull();
    expect(await answer).toBe('AB:12:CD:34:EF:56');
    s.connector.last.resolve(asGanCube(fake));
    await connecting;
    expect(s.settings.macFor('GAN12ui_AB12')).toBe('AB:12:CD:34:EF:56');

    // One solve: the scramble R U F, then its inverse.
    turn(s, fake, 'R U F');
    turn(s, fake, "F' U' R'", 400);
    await s.service.whenSaved();
    const session = s.service.session();
    expect(session?.summary.solved).toBe(1);

    const exported = await s.service.exportSession(session?.id ?? '');
    expect(exported.attempts).toHaveLength(1);
    const text = JSON.stringify(exported);
    expect(text).not.toMatch(MAC_LIKE);
    for (const mac of ['AB:12:CD:34:EF:56', '11:22:33:44:55:66']) {
      expect(text.toUpperCase()).not.toContain(mac);
      expect(text.toUpperCase()).not.toContain(mac.replaceAll(':', ''));
    }
    // The pattern has teeth: the list Settings keeps would match it.
    expect(JSON.stringify(s.settings.cubeMacs())).toMatch(MAC_LIKE);
  });
});
