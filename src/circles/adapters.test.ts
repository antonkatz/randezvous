import { describe, expect, it } from 'vitest';
import {
  bytesToBase64Url,
  generateIdentityMaterial,
  normalizeName,
  sha256,
  utf8,
} from '../lib/crypto';
import type { StoredIdentity } from '../lib/types';
import {
  CIRCLE_RECORD_SIGNATURE_DOMAIN,
  CircleKeyDirectory,
  addHumanKey,
  createBrowserCircleIdentity,
  friendsFromHumans,
  isUsablePublicKey,
} from './adapters';

async function storedIdentity(name: string): Promise<StoredIdentity> {
  const material = await generateIdentityMaterial();
  return {
    key: 'self',
    id: material.peerId,
    name: normalizeName(name),
    publicKey: material.publicKey,
    privateKey: material.privateKey,
    createdAt: 1,
  };
}

describe('browser adapters', () => {
  it('adapts the existing P-256 identity to the circle Identity interface', async () => {
    const ana = await storedIdentity('Ana');
    const baz = await storedIdentity('Baz');
    const directory = new CircleKeyDirectory();
    addHumanKey(directory, baz);
    const identity = createBrowserCircleIdentity(ana, directory);
    const bytes = utf8('canonical circle bytes');

    expect(identity.selfKey).toBe(ana.id);
    const signature = await identity.sign(bytes);
    expect(await identity.verify(ana.id, bytes, signature)).toBe(true);
    expect(await identity.verify(baz.id, bytes, signature)).toBe(false);
    expect(await identity.verify('unknown', bytes, signature)).toBe(false);
    expect(await identity.verify(ana.id, utf8('other bytes'), signature)).toBe(false);
    expect(await identity.hash(bytes)).toBe(
      bytesToBase64Url(await sha256(bytes)),
    );
    expect(CIRCLE_RECORD_SIGNATURE_DOMAIN).toContain('circle-record');
  });

  it('builds the direct-friends set from the app humans', () => {
    const friends = friendsFromHumans([{ id: 'h_one' }, { id: 'h_two' }]);
    expect(friends.directFriends()).toEqual(new Set(['h_one', 'h_two']));
  });

  it('validates raw public keys', async () => {
    const identity = await storedIdentity('Ana');
    expect(isUsablePublicKey(identity.publicKey)).toBe(true);
    expect(isUsablePublicKey('not-a-key')).toBe(false);
    expect(isUsablePublicKey('')).toBe(false);
  });
});
