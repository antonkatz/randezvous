import {
  base64UrlToBytes,
  bytesToBase64Url,
  derivePeerId,
  isPeerId,
  isRawPublicKey,
  normalizeName,
  randomBytes,
  randomToken,
  signDomain,
  signText,
  utf8,
  verifyDomain,
  verifyText,
} from './crypto';
import type {
  InvitePayload,
  InviteRendezvous,
  JoinRequest,
  PublicIdentityClaim,
} from './protocol';
import type { PublicIdentity, StoredIdentity } from './types';

const INVITE_VERSION = 'v1';
const INVITE_VERSION_COMPACT = 'v2';
const INVITE_DOMAIN = 'rendezvous/invite/v1';
const INVITE_DOMAIN_COMPACT = 'rendezvous/invite/v2';
const JOIN_DOMAIN = 'rendezvous/join/v1';
const JOIN_PROOF_TRANSCRIPT_VERSION = 'rendezvous/join-proof/v1';
const COMPACT_VERSION = 2;
const COMPACT_FLAG_RENDEZVOUS = 1;
const COMPACT_FLAG_AUDIO_DISABLED = 2;
const COMPACT_FLAG_CIRCLE = 4;
const COMPACT_NONCE_BYTES = 8;
const P256_FIELD_PRIME = 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n;
const P256_CURVE_B =
  0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function invitePayloadBytes(payload: InvitePayload): Uint8Array {
  return utf8(JSON.stringify(payload));
}

function readU48(bytes: Uint8Array, offset: number): number {
  let value = 0n;
  for (let index = 0; index < 6; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index] ?? 0);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Invalid invitation');
  return number;
}

function writeU48(bytes: Uint8Array, offset: number, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 2 ** 48) {
    throw new Error('Invalid invitation');
  }
  let current = BigInt(value);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[offset + index] = Number(current & 0xffn);
    current >>= 8n;
  }
}

function bigintFromBytes(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bytes32(value: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let current = value;
  for (let index = 31; index >= 0; index -= 1) {
    bytes[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  if (current !== 0n) throw new Error('Invalid invitation');
  return bytes;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let current = base % modulus;
  let power = exponent;
  while (power > 0n) {
    if ((power & 1n) === 1n) result = (result * current) % modulus;
    current = (current * current) % modulus;
    power >>= 1n;
  }
  return result;
}

function compressPublicKey(raw: Uint8Array): Uint8Array {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('Invalid invitation');
  const compressed = new Uint8Array(33);
  compressed[0] = (raw[64] ?? 0) % 2 === 0 ? 2 : 3;
  compressed.set(raw.subarray(1, 33), 1);
  return compressed;
}

function decompressPublicKey(compressed: Uint8Array): Uint8Array {
  if (
    compressed.length !== 33 ||
    (compressed[0] !== 2 && compressed[0] !== 3)
  ) {
    throw new Error('Invalid invitation');
  }
  const x = bigintFromBytes(compressed.subarray(1));
  if (x >= P256_FIELD_PRIME) throw new Error('Invalid invitation');
  const x3 = (((x * x) % P256_FIELD_PRIME) * x) % P256_FIELD_PRIME;
  const rhs =
    (x3 - (3n * x) % P256_FIELD_PRIME + P256_CURVE_B + P256_FIELD_PRIME) %
    P256_FIELD_PRIME;
  let y = modPow(rhs, (P256_FIELD_PRIME + 1n) / 4n, P256_FIELD_PRIME);
  if (((y * y) % P256_FIELD_PRIME) !== rhs) throw new Error('Invalid invitation');
  if ((y & 1n) !== BigInt((compressed[0] ?? 2) & 1)) y = P256_FIELD_PRIME - y;
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(bytes32(x), 1);
  raw.set(bytes32(y), 33);
  return raw;
}

function encodeCompactPayload(
  identity: StoredIdentity,
  rendezvous: InviteRendezvous | undefined,
  circleId: string | undefined,
  issuedAt: number,
): Uint8Array {
  const name = utf8(normalizeName(identity.name));
  if (name.length > 255) throw new Error('Invalid invitation');
  const rendezvousId = rendezvous ? utf8(rendezvous.id) : null;
  if (rendezvousId && (rendezvousId.length === 0 || rendezvousId.length > 255)) {
    throw new Error('Invalid invitation');
  }
  const circleBytes = circleId ? utf8(circleId) : null;
  if (circleBytes && (circleBytes.length === 0 || circleBytes.length > 255)) {
    throw new Error('Invalid invitation');
  }
  const publicKey = compressPublicKey(base64UrlToBytes(identity.publicKey));
  const nonce = randomBytes(COMPACT_NONCE_BYTES);
  const size =
    3 +
    name.length +
    publicKey.length +
    6 +
    nonce.length +
    (rendezvous ? 1 + (rendezvousId?.length ?? 0) + 6 + 6 : 0) +
    (circleBytes ? 1 + circleBytes.length : 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  bytes[offset] = COMPACT_VERSION;
  offset += 1;
  bytes[offset] =
    (rendezvous ? COMPACT_FLAG_RENDEZVOUS : 0) |
    (rendezvous?.liveAudioDisabled ? COMPACT_FLAG_AUDIO_DISABLED : 0) |
    (circleBytes ? COMPACT_FLAG_CIRCLE : 0);
  offset += 1;
  bytes[offset] = name.length;
  offset += 1;
  bytes.set(name, offset);
  offset += name.length;
  bytes.set(publicKey, offset);
  offset += publicKey.length;
  writeU48(bytes, offset, issuedAt);
  offset += 6;
  bytes.set(nonce, offset);
  offset += nonce.length;
  if (rendezvous && rendezvousId) {
    bytes[offset] = rendezvousId.length;
    offset += 1;
    bytes.set(rendezvousId, offset);
    offset += rendezvousId.length;
    writeU48(bytes, offset, rendezvous.scheduledFor);
    offset += 6;
    writeU48(bytes, offset, rendezvous.createdAt);
    offset += 6;
  }
  if (circleBytes) {
    bytes[offset] = circleBytes.length;
    offset += 1;
    bytes.set(circleBytes, offset);
    offset += circleBytes.length;
  }
  return bytes;
}

async function decodeCompactPayload(bytes: Uint8Array): Promise<InvitePayload> {
  let offset = 0;
  const version = bytes[offset];
  offset += 1;
  if (version !== COMPACT_VERSION) throw new Error('Invalid invitation');
  const flags = bytes[offset];
  offset += 1;
  if (flags === undefined || (flags & ~7) !== 0) throw new Error('Invalid invitation');
  const nameLength = bytes[offset];
  offset += 1;
  if (
    nameLength === undefined ||
    offset + nameLength + 33 + 6 + COMPACT_NONCE_BYTES > bytes.length
  ) {
    throw new Error('Invalid invitation');
  }
  const name = normalizeName(new TextDecoder().decode(bytes.subarray(offset, offset + nameLength)));
  offset += nameLength;
  const publicKeyRaw = decompressPublicKey(bytes.slice(offset, offset + 33));
  offset += 33;
  const publicKey = bytesToBase64Url(publicKeyRaw);
  const issuedAt = readU48(bytes, offset);
  offset += 6;
  const nonce = bytesToBase64Url(bytes.slice(offset, offset + COMPACT_NONCE_BYTES));
  offset += COMPACT_NONCE_BYTES;

  let rendezvous: InviteRendezvous | undefined;
  if ((flags & COMPACT_FLAG_RENDEZVOUS) !== 0) {
    const idLength = bytes[offset];
    offset += 1;
    if (idLength === undefined || idLength === 0 || offset + idLength + 12 > bytes.length) {
      throw new Error('Invalid invitation');
    }
    const id = new TextDecoder().decode(bytes.subarray(offset, offset + idLength));
    offset += idLength;
    const scheduledFor = readU48(bytes, offset);
    offset += 6;
    const createdAt = readU48(bytes, offset);
    offset += 6;
    rendezvous = { id, scheduledFor, createdAt };
    if ((flags & COMPACT_FLAG_AUDIO_DISABLED) !== 0) rendezvous.liveAudioDisabled = true;
  } else if ((flags & COMPACT_FLAG_AUDIO_DISABLED) !== 0) {
    throw new Error('Invalid invitation');
  }

  let circleId: string | undefined;
  if ((flags & COMPACT_FLAG_CIRCLE) !== 0) {
    const circleLength = bytes[offset];
    offset += 1;
    if (
      circleLength === undefined ||
      circleLength === 0 ||
      offset + circleLength > bytes.length
    ) {
      throw new Error('Invalid invitation');
    }
    circleId = new TextDecoder().decode(bytes.subarray(offset, offset + circleLength));
    offset += circleLength;
  }
  if (offset !== bytes.length) throw new Error('Invalid invitation');

  return {
    v: 1,
    id: await derivePeerId(publicKeyRaw),
    name,
    publicKey,
    issuedAt,
    nonce,
    ...(rendezvous ? { rendezvous } : {}),
    ...(circleId ? { circleId } : {}),
  };
}


function parseRendezvous(value: unknown): InviteRendezvous | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid invitation');
  }
  const rendezvous = value as Partial<InviteRendezvous>;
  if (
    typeof rendezvous.id !== 'string' ||
    rendezvous.id.length === 0 ||
    rendezvous.id.length > 128 ||
    typeof rendezvous.scheduledFor !== 'number' ||
    !Number.isSafeInteger(rendezvous.scheduledFor) ||
    rendezvous.scheduledFor < 0 ||
    typeof rendezvous.createdAt !== 'number' ||
    !Number.isSafeInteger(rendezvous.createdAt) ||
    rendezvous.createdAt < 0 ||
    (rendezvous.liveAudioDisabled !== undefined &&
      typeof rendezvous.liveAudioDisabled !== 'boolean')
  ) {
    throw new Error('Invalid invitation');
  }
  const parsed: InviteRendezvous = {
    id: rendezvous.id,
    scheduledFor: rendezvous.scheduledFor,
    createdAt: rendezvous.createdAt,
  };
  if (typeof rendezvous.liveAudioDisabled === 'boolean') {
    parsed.liveAudioDisabled = rendezvous.liveAudioDisabled;
  }
  return parsed;
}

function parseCircleId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error('Invalid invitation');
  }
  return value;
}

function parsePayload(raw: string): InvitePayload {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid invitation');
  const payload = parsed as Partial<InvitePayload>;
  if (
    payload.v !== 1 ||
    typeof payload.id !== 'string' ||
    !isPeerId(payload.id) ||
    typeof payload.name !== 'string' ||
    typeof payload.publicKey !== 'string' ||
    !isRawPublicKey(payload.publicKey) ||
    typeof payload.issuedAt !== 'number' ||
    !Number.isFinite(payload.issuedAt) ||
    typeof payload.nonce !== 'string' ||
    payload.nonce.length < 8
  ) {
    throw new Error('Invalid invitation');
  }
  const rendezvous = parseRendezvous(payload.rendezvous);
  const circleId = parseCircleId(payload.circleId);
  const parsedPayload: InvitePayload = {
    v: 1,
    id: payload.id,
    name: normalizeName(payload.name),
    publicKey: payload.publicKey,
    issuedAt: payload.issuedAt,
    nonce: payload.nonce,
  };
  if (rendezvous) parsedPayload.rendezvous = rendezvous;
  if (circleId) parsedPayload.circleId = circleId;
  return parsedPayload;
}

export interface InviteTokenOptions {
  rendezvous?: InviteRendezvous;
  circleId?: string;
}

function normalizeInviteOptions(
  value: InviteTokenOptions | InviteRendezvous | undefined,
): InviteTokenOptions {
  if (!value) return {};
  if (
    'id' in value &&
    'scheduledFor' in value &&
    'createdAt' in value
  ) {
    return { rendezvous: value as InviteRendezvous };
  }
  return value as InviteTokenOptions;
}

export async function createInviteToken(
  identity: StoredIdentity,
  optionsOrRendezvous: InviteTokenOptions | InviteRendezvous = {},
): Promise<string> {
  const options = normalizeInviteOptions(optionsOrRendezvous);
  const issuedAt = Date.now();
  const bytes = encodeCompactPayload(identity, options.rendezvous, options.circleId, issuedAt);
  const signature = await signDomain(identity.privateKey, INVITE_DOMAIN_COMPACT, bytes);
  return `${INVITE_VERSION_COMPACT}.${bytesToBase64Url(bytes)}.${signature}`;
}

export async function verifyInviteToken(token: string): Promise<InvitePayload> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid invitation');
  const payloadPart = parts[1];
  const signature = parts[2];
  if (!payloadPart || !signature) throw new Error('Invalid invitation');

  if (parts[0] === INVITE_VERSION_COMPACT) {
    let bytes: Uint8Array;
    try {
      bytes = base64UrlToBytes(payloadPart);
    } catch {
      throw new Error('Invalid invitation');
    }
    let payload: InvitePayload;
    try {
      payload = await decodeCompactPayload(bytes);
    } catch {
      throw new Error('Invalid invitation');
    }
    const valid = await verifyDomain(
      payload.publicKey,
      INVITE_DOMAIN_COMPACT,
      bytes,
      signature,
    );
    if (!valid) throw new Error('Invalid invitation signature');
    return payload;
  }

  if (parts[0] !== INVITE_VERSION) throw new Error('Invalid invitation');

  let payload: InvitePayload;
  try {
    payload = parsePayload(new TextDecoder().decode(base64UrlToBytes(payloadPart)));
  } catch {
    throw new Error('Invalid invitation');
  }

  const expectedId = await derivePeerId(base64UrlToBytes(payload.publicKey));
  if (expectedId !== payload.id) throw new Error('Invitation identity mismatch');

  const valid = await verifyDomain(
    payload.publicKey,
    INVITE_DOMAIN,
    invitePayloadBytes(payload),
    signature,
  );
  if (!valid) throw new Error('Invalid invitation signature');

  return payload;
}

export function buildInviteUrl(token: string): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#join=${token}`;
}

export function getInviteTokenFromUrl(): string | null {
  if (!window.location.hash) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.get('join');
}

export function clearInviteFromUrl(): void {
  const clean = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(null, '', clean);
}

function joinProofTranscript(input: {
  joinId: string;
  to: string;
  from: string;
  token: string;
}): string {
  return [
    JOIN_PROOF_TRANSCRIPT_VERSION,
    `join:${input.joinId}`,
    `to:${input.to}`,
    `from:${input.from}`,
    `token:${input.token}`,
  ].join('\n');
}

export async function createJoinRequest(input: {
  identity: StoredIdentity;
  inviterId: string;
  token: string;
}): Promise<JoinRequest> {
  const from: PublicIdentityClaim = {
    id: input.identity.id,
    name: input.identity.name,
    publicKey: input.identity.publicKey,
  };
  const id = `j_${randomToken(12)}`;
  const proof = await signText(
    input.identity.privateKey,
    JOIN_DOMAIN,
    joinProofTranscript({
      joinId: id,
      to: input.inviterId,
      from: from.id,
      token: input.token,
    }),
  );
  return {
    id,
    token: input.token,
    to: input.inviterId,
    from,
    proof,
    createdAt: Date.now(),
  };
}

export async function verifyJoinRequest(
  join: JoinRequest,
  expectedInviter: PublicIdentity,
): Promise<{ invite: InvitePayload; sender: PublicIdentity }> {
  if (!join || typeof join !== 'object') throw new Error('Invalid join request');
  if (join.to !== expectedInviter.id) throw new Error('Invitation target mismatch');
  if (!join.from || join.from.id === expectedInviter.id) throw new Error('Invalid sender');
  if (!isPeerId(join.from.id) || !isRawPublicKey(join.from.publicKey)) {
    throw new Error('Invalid sender identity');
  }

  const invite = await verifyInviteToken(join.token);
  if (invite.id !== expectedInviter.id || invite.publicKey !== expectedInviter.publicKey) {
    throw new Error('Invitation does not belong to this human');
  }

  const senderId = await derivePeerId(base64UrlToBytes(join.from.publicKey));
  if (senderId !== join.from.id) throw new Error('Sender identity mismatch');

  const validProof = await verifyText(
    join.from.publicKey,
    JOIN_DOMAIN,
    joinProofTranscript({
      joinId: join.id,
      to: join.to,
      from: join.from.id,
      token: join.token,
    }),
    join.proof,
  );
  if (!validProof) throw new Error('Invalid join proof');

  return {
    invite,
    sender: {
      id: join.from.id,
      name: normalizeName(join.from.name),
      publicKey: join.from.publicKey,
    },
  };
}
