import {
  base64UrlToBytes,
  bytesToBase64Url,
  derivePeerId,
  isPeerId,
  isRawPublicKey,
  normalizeName,
  randomToken,
  signDomain,
  signText,
  utf8,
  verifyDomain,
  verifyText,
} from './crypto';
import type { InvitePayload, JoinRequest, PublicIdentityClaim } from './protocol';
import type { PublicIdentity, StoredIdentity } from './types';

const INVITE_VERSION = 'v1';
const INVITE_DOMAIN = 'randevouz/invite/v1';
const JOIN_DOMAIN = 'randevouz/join/v1';
const JOIN_PROOF_TRANSCRIPT_VERSION = 'randevouz/join-proof/v1';

function invitePayloadBytes(payload: InvitePayload): Uint8Array {
  return utf8(JSON.stringify(payload));
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
  return {
    v: 1,
    id: payload.id,
    name: normalizeName(payload.name),
    publicKey: payload.publicKey,
    issuedAt: payload.issuedAt,
    nonce: payload.nonce,
  };
}

export async function createInviteToken(identity: StoredIdentity): Promise<string> {
  const payload: InvitePayload = {
    v: 1,
    id: identity.id,
    name: identity.name,
    publicKey: identity.publicKey,
    issuedAt: Date.now(),
    nonce: randomToken(12),
  };
  const bytes = invitePayloadBytes(payload);
  const signature = await signDomain(identity.privateKey, INVITE_DOMAIN, bytes);
  return `${INVITE_VERSION}.${bytesToBase64Url(bytes)}.${signature}`;
}

export async function verifyInviteToken(token: string): Promise<InvitePayload> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== INVITE_VERSION) {
    throw new Error('Invalid invitation');
  }
  const payloadPart = parts[1];
  const signature = parts[2];
  if (!payloadPart || !signature) throw new Error('Invalid invitation');

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
