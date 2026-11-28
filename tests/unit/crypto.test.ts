import { describe, expect, it } from 'vitest';
import { base64UrlToBytes, canonicalJson } from '../../src/rdz/bytes';
import {
  createEnvelope,
  createIdentity,
  envelopeId,
  isNotFromFuture,
  isValidGoing,
  isValidPing,
  isValidSignal,
  MAX_CLOCK_SKEW_MS,
  MAX_SCHEDULE_HORIZON_MS,
  verifyEnvelope,
} from '../../src/rdz/crypto';
import { randomRendezvousId } from '../../src/rdz/ids';
import type { Envelope, GoingPayload } from '../../src/rdz/types';

describe('identity and signed envelopes', () => {
  it('derives a stable human id from the public key', async () => {
    const identity = await createIdentity();
    expect(base64UrlToBytes(identity.humanId)).toHaveLength(11);
    expect(identity.publicKey.length).toBeGreaterThan(40);
    const envelope = await createEnvelope(identity, { kind: 'PING' });
    expect(envelope.author).toBe(identity.humanId);
    expect(envelope.publicKey).toBe(identity.publicKey);
  });

  it('verifies a valid envelope', async () => {
    const identity = await createIdentity();
    const envelope = await createEnvelope(identity, { kind: 'PING' });
    const verified = await verifyEnvelope(envelope);
    expect(verified).not.toBeNull();
    expect(verified?.author).toBe(identity.humanId);
  });

  it('rejects a tampered payload', async () => {
    const identity = await createIdentity();
    const envelope = await createEnvelope(identity, { kind: 'PING' });
    const tampered = {
      ...envelope,
      payload: { kind: 'GOING', rendezvousId: 'abc', scheduledAt: Date.now() },
    };
    expect(await verifyEnvelope(tampered)).toBeNull();
  });

  it('rejects a changed author', async () => {
    const identity = await createIdentity();
    const envelope = await createEnvelope(identity, { kind: 'PING' });
    expect(await verifyEnvelope({ ...envelope, author: 'not-the-author' })).toBeNull();
  });

  it('is idempotent by envelope id', async () => {
    const identity = await createIdentity();
    const envelope = await createEnvelope(identity, { kind: 'PING' });
    expect(await envelopeId(envelope)).toBe(await envelopeId(envelope));
  });

  it('rejects a GOING whose rendezvous id is not an 88-bit identifier', async () => {
    const identity = await createIdentity();
    const envelope = await createEnvelope(identity, {
      kind: 'GOING',
      rendezvousId: 'not-a-valid-id',
      scheduledAt: Date.now() + 60_000,
    });
    // Even freshly signed, a malformed ID must never cross the boundary: one
    // such envelope used to brick every render that decoded its channel.
    expect(await verifyEnvelope(envelope)).toBeNull();
    expect(isValidGoing(envelope)).toBe(false);
  });

  it('rejects a SIGNAL whose target, channel, or transfer id is malformed', async () => {
    const identity = await createIdentity();
    const build = (overrides: Record<string, unknown>) =>
      createEnvelope(identity, {
        kind: 'SIGNAL',
        target: identity.humanId,
        channelId: randomRendezvousId(),
        signal: 'image-offer',
        transferId: 'transfer-1',
        ...overrides,
      } as Parameters<typeof createEnvelope>[1]);
    expect(await verifyEnvelope(await build({}))).not.toBeNull();
    expect(await verifyEnvelope(await build({ target: 'not-a-valid-id' }))).toBeNull();
    expect(await verifyEnvelope(await build({ channelId: 'not-a-valid-id' }))).toBeNull();
    expect(await verifyEnvelope(await build({ transferId: 'bad id!' }))).toBeNull();
    expect(await verifyEnvelope(await build({ transferId: '' }))).toBeNull();
    // Mesh mechanics signals legitimately carry no channel.
    expect(await verifyEnvelope(await build({ channelId: '', signal: 'mesh-ice' }))).not.toBeNull();
  });

  it('does not let an injected __proto__ key bypass the signature', async () => {
    const identity = await createIdentity();
    const envelope = await createEnvelope(identity, { kind: 'PING' });
    const wire = JSON.parse(JSON.stringify(envelope));
    wire.payload = JSON.parse('{"kind":"PING","__proto__":{"injected":"unsigned"}}');
    // Canonicalisation must include the key, so the signature no longer matches.
    expect(await verifyEnvelope(wire)).toBeNull();
  });
});

describe('message freshness', () => {
  const base = (overrides: Partial<Envelope> = {}): Envelope =>
    ({
      v: 1,
      type: 'PING',
      author: 'a',
      publicKey: 'b',
      createdAt: Date.now(),
      payload: { kind: 'PING' },
      signature: 'c',
      ...overrides,
    }) as Envelope;

  it('tolerates bounded clock skew but rejects far-future messages', () => {
    const now = Date.now();
    expect(isNotFromFuture(base({ createdAt: now + 1_000 }), now)).toBe(true);
    expect(isNotFromFuture(base({ createdAt: now + MAX_CLOCK_SKEW_MS }), now)).toBe(true);
    expect(isNotFromFuture(base({ createdAt: now + MAX_CLOCK_SKEW_MS + 1 }), now)).toBe(false);
  });

  it('accepts a slightly future SIGNAL so a fast phone can complete a call', () => {
    const now = Date.now();
    const envelope = base({
      createdAt: now + 30_000,
      type: 'SIGNAL',
      payload: {
        kind: 'SIGNAL',
        target: 'target',
        channelId: 'channel',
        signal: 'audio-accept',
        transferId: 'transfer',
      },
    });
    expect(isValidSignal(envelope, now)).toBe(true);
    expect(isValidSignal(base({ ...envelope, createdAt: now + MAX_CLOCK_SKEW_MS + 1 }), now)).toBe(
      false,
    );
  });

  it('expires PING after five minutes', () => {
    const now = Date.now();
    expect(isValidPing(base({ createdAt: now - 4 * 60_000 }), now)).toBe(true);
    expect(isValidPing(base({ createdAt: now - 6 * 60_000 }), now)).toBe(false);
  });

  it('keeps GOING until three minutes after the scheduled time', () => {
    const now = Date.now();
    const payload: GoingPayload = {
      kind: 'GOING',
      rendezvousId: randomRendezvousId(),
      scheduledAt: now,
    };
    const envelope = base({ type: 'GOING', payload });
    expect(isValidGoing(envelope, now + 2 * 60_000)).toBe(true);
    expect(isValidGoing(envelope, now + 4 * 60_000)).toBe(false);
  });

  it('caps a GOING schedule at one week past its creation', () => {
    const now = Date.now();
    const build = (scheduledAt: number): Envelope =>
      base({
        type: 'GOING',
        createdAt: now,
        payload: { kind: 'GOING', rendezvousId: randomRendezvousId(), scheduledAt },
      });
    expect(isValidGoing(build(now), now)).toBe(true);
    expect(isValidGoing(build(now + MAX_SCHEDULE_HORIZON_MS), now)).toBe(true);
    expect(isValidGoing(build(now + MAX_SCHEDULE_HORIZON_MS + 1), now)).toBe(false);
    // The far-future announcement that flooded caches never becomes valid.
    expect(isValidGoing(build(now + 100 * 365 * 24 * 60 * 60 * 1000), now)).toBe(false);
  });

  it('expires SIGNAL after two minutes', () => {
    const now = Date.now();
    const envelope = base({
      createdAt: now,
      type: 'SIGNAL',
      payload: {
        kind: 'SIGNAL',
        target: 'target',
        channelId: 'channel',
        signal: 'offer',
        transferId: 'transfer',
      },
    });
    expect(isValidSignal(envelope, now)).toBe(true);
    expect(isValidSignal(base({ ...envelope, createdAt: now - 3 * 60_000 }), now)).toBe(false);
  });
});
