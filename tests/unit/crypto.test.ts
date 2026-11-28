import { describe, expect, it } from 'vitest';
import { base64UrlToBytes } from '../../src/rdz/bytes';
import {
  createEnvelope,
  createIdentity,
  envelopeId,
  isNotFromFuture,
  isValidGoing,
  isValidPing,
  isValidSignal,
  MAX_CLOCK_SKEW_MS,
  verifyEnvelope,
} from '../../src/rdz/crypto';
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
      rendezvousId: 'channel',
      scheduledAt: now,
    };
    const envelope = base({ type: 'GOING', payload });
    expect(isValidGoing(envelope, now + 2 * 60_000)).toBe(true);
    expect(isValidGoing(envelope, now + 4 * 60_000)).toBe(false);
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
