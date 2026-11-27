import { signText, verifyText } from './crypto';
import type { PossessionState, StoredPossession } from './types';

const POSSESSION_DOMAIN = 'rendezvous/possession/v1';

export type PossessionKind = 'possess/claim' | 'possess/release' | 'possess/check';

export interface PossessionMessage {
  v: 1;
  kind: PossessionKind;
  photoId: string;
  from: string;
  to: string;
  appointmentId: string | null;
  at: number;
  sig: string;
}

type UnsignedPossession = Omit<PossessionMessage, 'sig'>;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Deterministic JSON for signing. Keys are sorted; arrays keep their order. */
export function possessionTranscript(value: UnsignedPossession): string {
  const keys = Object.keys(value).sort() as Array<keyof UnsignedPossession>;
  const parts = keys.map((key) => {
    const entry = value[key];
    return `${JSON.stringify(key)}:${JSON.stringify(entry)}`;
  });
  return `{${parts.join(',')}}`;
}

export async function createPossessionMessage(input: {
  privateKey: CryptoKey;
  kind: PossessionKind;
  photoId: string;
  from: string;
  to: string;
  appointmentId?: string | null;
  at?: number;
}): Promise<PossessionMessage> {
  const unsigned: UnsignedPossession = {
    v: 1,
    kind: input.kind,
    photoId: input.photoId,
    from: input.from,
    to: input.to,
    appointmentId: input.appointmentId ?? null,
    at: input.at ?? Date.now(),
  };
  const sig = await signText(
    input.privateKey,
    POSSESSION_DOMAIN,
    possessionTranscript(unsigned),
  );
  return { ...unsigned, sig };
}

export function isPossessionMessage(value: unknown): value is PossessionMessage {
  if (!isObject(value)) return false;
  return (
    value.v === 1 &&
    (value.kind === 'possess/claim' ||
      value.kind === 'possess/release' ||
      value.kind === 'possess/check') &&
    typeof value.photoId === 'string' &&
    value.photoId.length > 0 &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    (value.appointmentId === null || typeof value.appointmentId === 'string') &&
    typeof value.at === 'number' &&
    Number.isFinite(value.at) &&
    typeof value.sig === 'string'
  );
}

export async function verifyPossessionMessage(
  publicKey: string,
  message: PossessionMessage,
): Promise<boolean> {
  if (!isPossessionMessage(message)) return false;
  const { sig, ...unsigned } = message;
  return verifyText(
    publicKey,
    POSSESSION_DOMAIN,
    possessionTranscript(unsigned),
    sig,
  );
}

export function possessionKey(photoId: string, holder: string): string {
  return `${photoId}\u0000${holder}`;
}

/**
 * A later signed statement supersedes an earlier one. Equal timestamps fall
 * back to the signature so every browser converges on the same record.
 */
export function newerPossession(
  current: StoredPossession | undefined,
  next: StoredPossession,
): boolean {
  if (!current) return true;
  if (next.at !== current.at) return next.at > current.at;
  if (next.state !== current.state) return next.state === 'released';
  return next.key < current.key;
}

export function possessionState(message: PossessionMessage): PossessionState | null {
  if (message.kind === 'possess/claim') return 'held';
  if (message.kind === 'possess/release') return 'released';
  return null;
}
