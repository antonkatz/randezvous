import { asBufferSource, base64UrlToBytes, bytesToBase64Url, canonicalJson, utf8 } from './bytes';
import { humanIdFromPublicKey, isCanonicalId } from './ids';
import type { Envelope, EnvelopePayload, StoredIdentity } from './types';

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' } as const;

export async function createIdentity(): Promise<StoredIdentity> {
  const pair = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const publicKey = bytesToBase64Url(
    new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
  );
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const privateKey = await crypto.subtle.importKey('jwk', privateJwk, ECDSA, false, ['sign']);
  const humanId = await humanIdFromPublicKey(publicKey);
  return { privateKey, publicKey, humanId };
}

export async function sha256Base64Url(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? utf8(value) : value;
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', asBufferSource(bytes))));
}

export async function signText(privateKey: CryptoKey, value: string): Promise<string> {
  const signature = await crypto.subtle.sign(SIGN_ALGORITHM, privateKey, asBufferSource(utf8(value)));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyText(
  publicKeyBase64Url: string,
  signatureBase64Url: string,
  value: string,
): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey(
      'raw',
      asBufferSource(base64UrlToBytes(publicKeyBase64Url)),
      ECDSA,
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      SIGN_ALGORITHM,
      publicKey,
      asBufferSource(base64UrlToBytes(signatureBase64Url)),
      asBufferSource(utf8(value)),
    );
  } catch {
    return false;
  }
}

type EnvelopeBody<T extends EnvelopePayload> = Omit<Envelope<T>, 'signature'>;

export async function createEnvelope<T extends EnvelopePayload>(
  identity: StoredIdentity,
  payload: T,
): Promise<Envelope<T>> {
  const body: EnvelopeBody<T> = {
    v: 1,
    type: payload.kind,
    author: identity.humanId,
    publicKey: identity.publicKey,
    createdAt: Date.now(),
    payload,
  };
  const signature = await signText(identity.privateKey, canonicalJson(body));
  return { ...body, signature };
}

export async function verifyEnvelope(value: unknown): Promise<Envelope | null> {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<Envelope>;
  if (
    candidate.v !== 1 ||
    typeof candidate.type !== 'string' ||
    typeof candidate.author !== 'string' ||
    typeof candidate.publicKey !== 'string' ||
    typeof candidate.createdAt !== 'number' ||
    !Number.isFinite(candidate.createdAt) ||
    typeof candidate.signature !== 'string' ||
    !candidate.payload ||
    typeof candidate.payload !== 'object'
  ) {
    return null;
  }
  const payload = candidate.payload as EnvelopePayload;
  if (payload.kind !== candidate.type) return null;
  if (!['PING', 'GOING', 'SIGNAL'].includes(candidate.type)) return null;
  if (payload.kind === 'GOING') {
    if (
      typeof payload.rendezvousId !== 'string' ||
      !isCanonicalId(payload.rendezvousId) ||
      typeof payload.scheduledAt !== 'number' ||
      !Number.isFinite(payload.scheduledAt)
    ) {
      return null;
    }
  }
  if (payload.kind === 'SIGNAL') {
    if (
      typeof payload.target !== 'string' ||
      !isCanonicalId(payload.target) ||
      typeof payload.channelId !== 'string' ||
      // Mesh mechanics signals carry no channel; every other SIGNAL names a
      // canonical rendezvous ID.
      (payload.channelId !== '' && !isCanonicalId(payload.channelId)) ||
      typeof payload.signal !== 'string' ||
      typeof payload.transferId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(payload.transferId)
    ) {
      return null;
    }
  }
  const derived = await humanIdFromPublicKey(candidate.publicKey);
  if (derived !== candidate.author) return null;
  const body: EnvelopeBody<EnvelopePayload> = {
    v: 1,
    type: candidate.type,
    author: candidate.author,
    publicKey: candidate.publicKey,
    createdAt: candidate.createdAt,
    payload,
  };
  const valid = await verifyText(
    candidate.publicKey,
    candidate.signature,
    canonicalJson(body),
  );
  if (!valid) return null;
  return { ...body, signature: candidate.signature } as Envelope;
}

export async function envelopeId(envelope: Envelope): Promise<string> {
  return sha256Base64Url(canonicalJson(envelope));
}

export const PRESENCE_MS = 5 * 60 * 1000;
export const PING_INTERVAL_MS = 3 * 60 * 1000;
export const ANNOUNCEMENT_GRACE_MS = 3 * 60 * 1000;
export const SIGNAL_TTL_MS = 2 * 60 * 1000;

/**
 * Signed messages dated slightly in the future are still accepted. Two devices
 * in the same rendezvous can drift apart without either clock being wrong on
 * purpose; rejecting a phone's accept or answer because it is a minute ahead
 * strands the call. The allowance is bounded so a bad clock cannot keep a
 * message alive indefinitely.
 */
export const MAX_CLOCK_SKEW_MS = 60 * 1000;

/**
 * A GOING may schedule at most one week past its own creation. Without a
 * horizon, a single signed announcement for the far future stays valid,
 * cached, and replayed forever, growing every peer's cache without bound.
 * The bound is relative to the signed createdAt, not the receiver's clock.
 */
export const MAX_SCHEDULE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

export function isNotFromFuture(envelope: Envelope, now = Date.now()): boolean {
  return envelope.createdAt <= now + MAX_CLOCK_SKEW_MS;
}

export function isValidPing(envelope: Envelope, now = Date.now()): boolean {
  return (
    envelope.type === 'PING' &&
    isNotFromFuture(envelope, now) &&
    now - envelope.createdAt <= PRESENCE_MS
  );
}

export function isValidGoing(envelope: Envelope, now = Date.now()): boolean {
  if (envelope.type !== 'GOING' || !isNotFromFuture(envelope, now)) return false;
  const payload = envelope.payload;
  if (payload.kind !== 'GOING') return false;
  if (!isCanonicalId(payload.rendezvousId)) return false;
  if (payload.scheduledAt > envelope.createdAt + MAX_SCHEDULE_HORIZON_MS) return false;
  return now <= payload.scheduledAt + ANNOUNCEMENT_GRACE_MS;
}

export function isValidSignal(envelope: Envelope, now = Date.now()): boolean {
  return (
    envelope.type === 'SIGNAL' &&
    isNotFromFuture(envelope, now) &&
    now - envelope.createdAt <= SIGNAL_TTL_MS
  );
}
