import { describe, expect, it } from 'vitest';
import {
  bytesToBase64Url,
  derivePeerId,
  deriveVerificationWords,
  hashToken,
  normalizeName,
  base64UrlToBytes,
  randomToken,
  signDomain,
  utf8,
} from '../src/lib/crypto';
import {
  createInviteToken,
  createJoinRequest,
  verifyInviteToken,
  verifyJoinRequest,
} from '../src/lib/invite';
import { generateIdentityMaterial } from '../src/lib/crypto';
import type { StoredIdentity } from '../src/lib/types';

async function makeIdentity(name: string): Promise<StoredIdentity> {
  const material = await generateIdentityMaterial();
  return {
    key: 'self',
    id: material.peerId,
    name: normalizeName(name),
    publicKey: material.publicKey,
    privateKey: material.privateKey,
    createdAt: Date.now(),
  };
}

describe('identity and verification codes', () => {
  it('derives a stable eight-word code independent of key order', async () => {
    const ana = await makeIdentity('Ana');
    const baz = await makeIdentity('Baz');
    const first = await deriveVerificationWords(ana.publicKey, baz.publicKey);
    const second = await deriveVerificationWords(baz.publicKey, ana.publicKey);
    const third = await deriveVerificationWords(ana.publicKey, baz.publicKey);

    expect(first).toHaveLength(8);
    expect(first.every((word) => word.length > 0)).toBe(true);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('changes the words when either key changes', async () => {
    const ana = await makeIdentity('Ana');
    const baz = await makeIdentity('Baz');
    const cy = await makeIdentity('Cy');
    const first = await deriveVerificationWords(ana.publicKey, baz.publicKey);
    const second = await deriveVerificationWords(ana.publicKey, cy.publicKey);
    expect(second).not.toEqual(first);
  });

  it('derives a peer id from raw public bytes', async () => {
    const identity = await makeIdentity('Ana');
    const derived = await derivePeerId(base64UrlToBytes(identity.publicKey));
    expect(derived).toBe(identity.id);
  });

  it('hashes invitation tokens consistently', async () => {
    const hash = await hashToken('v1.payload.signature');
    expect(hash).toBe(await hashToken('v1.payload.signature'));
    expect(hash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });
});

describe('signed invitations and joins', () => {
  it('verifies a signed invitation and rejects tampering', async () => {
    const ana = await makeIdentity('Ana');
    const token = await createInviteToken(ana);
    const invite = await verifyInviteToken(token);

    expect(invite.id).toBe(ana.id);
    expect(invite.publicKey).toBe(ana.publicKey);
    expect(invite.name).toBe('Ana');

    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]?.slice(0, -1)}A.${parts[2]}`;
    await expect(verifyInviteToken(tampered)).rejects.toThrow();
  });

  it('carries the live-audio flag in a signed rendezvous invitation', async () => {
    const ana = await makeIdentity('Ana');
    const token = await createInviteToken(ana, {
      id: 'rv_liveaudio1',
      scheduledFor: Date.now() + 60_000,
      createdAt: Date.now(),
      liveAudioDisabled: true,
    });
    const invite = await verifyInviteToken(token);
    expect(invite.rendezvous?.liveAudioDisabled).toBe(true);
  });

  it('uses a compact self-contained token and round-trips the appointment', async () => {
    const ana = await makeIdentity('Ana');
    const scheduledFor = Date.now() + 60_000;
    const createdAt = Date.now();
    const plain = await createInviteToken(ana);
    const token = await createInviteToken(ana, {
      id: 'rv_compact123456789',
      scheduledFor,
      createdAt,
    });
    const invite = await verifyInviteToken(token);

    expect(token.startsWith('v2.')).toBe(true);
    expect(plain.length).toBeLessThan(token.length);
    expect(token.length).toBeLessThan(260);
    expect(invite.id).toBe(ana.id);
    expect(invite.name).toBe('Ana');
    expect(invite.publicKey).toBe(ana.publicKey);
    expect(invite.nonce.length).toBeGreaterThanOrEqual(8);
    expect(invite.rendezvous).toEqual({
      id: 'rv_compact123456789',
      scheduledFor,
      createdAt,
    });
  });

  it('round-trips a self-contained circle rendezvous link', async () => {
    const ana = await makeIdentity('Ana');
    const scheduledFor = Date.now() + 60_000;
    const token = await createInviteToken(ana, {
      rendezvous: {
        id: 'rv_circle123456789',
        scheduledFor,
        createdAt: Date.now(),
      },
      circle: {
        id: 'c_moon_garden',
        linkId: 'lr_link123',
        records: [
          {
            id: 'lr_link123',
            record: {
              type: 'LinkInvite',
              circleId: 'c_moon_garden',
              inviter: ana.id,
              planId: 'pl_offer123',
              at: Date.now(),
              expiresAt: scheduledFor + 5 * 60_000,
              sig: 'not-checked-by-the-token',
            },
          },
        ],
        plan: {
          id: 'pl_offer123',
          record: {
            type: 'Plan',
            circleId: 'c_moon_garden',
            scheduledAt: scheduledFor,
          },
        },
        keys: { [ana.id]: ana.publicKey },
      },
    });
    const invite = await verifyInviteToken(token);

    expect(token.startsWith('v3.')).toBe(true);
    expect(invite.rendezvous?.id).toBe('rv_circle123456789');
    expect(invite.circle?.id).toBe('c_moon_garden');
    expect(invite.circle?.linkId).toBe('lr_link123');
    expect(invite.circle?.records).toHaveLength(1);
    expect(invite.circle?.keys[ana.id]).toBe(ana.publicKey);
    expect(invite.circleId).toBe('c_moon_garden');
  });

  it('still verifies legacy v1 invitation links', async () => {
    const ana = await makeIdentity('Ana');
    const payload = {
      v: 1,
      id: ana.id,
      name: ana.name,
      publicKey: ana.publicKey,
      issuedAt: Date.now(),
      nonce: randomToken(12),
      rendezvous: {
        id: 'rv_legacy123456789',
        scheduledFor: Date.now() + 60_000,
        createdAt: Date.now(),
      },
    };
    const bytes = utf8(JSON.stringify(payload));
    const signature = await signDomain(ana.privateKey, 'rendezvous/invite/v1', bytes);
    const token = `v1.${bytesToBase64Url(bytes)}.${signature}`;
    const invite = await verifyInviteToken(token);
    expect(invite.id).toBe(ana.id);
    expect(invite.publicKey).toBe(ana.publicKey);
    expect(invite.rendezvous?.id).toBe('rv_legacy123456789');
  });

  it('creates and verifies a join request against the pinned inviter', async () => {
    const ana = await makeIdentity('Ana');
    const baz = await makeIdentity('Baz');
    const token = await createInviteToken(ana);
    const join = await createJoinRequest({
      identity: baz,
      inviterId: ana.id,
      token,
    });

    const verified = await verifyJoinRequest(join, {
      id: ana.id,
      name: ana.name,
      publicKey: ana.publicKey,
    });

    expect(verified.invite.id).toBe(ana.id);
    expect(verified.sender.id).toBe(baz.id);
    expect(verified.sender.publicKey).toBe(baz.publicKey);
  });

  it('rejects a join request for another inviter', async () => {
    const ana = await makeIdentity('Ana');
    const baz = await makeIdentity('Baz');
    const cy = await makeIdentity('Cy');
    const token = await createInviteToken(ana);
    const join = await createJoinRequest({
      identity: baz,
      inviterId: ana.id,
      token,
    });

    await expect(
      verifyJoinRequest(join, {
        id: cy.id,
        name: cy.name,
        publicKey: cy.publicKey,
      }),
    ).rejects.toThrow();
  });
});
