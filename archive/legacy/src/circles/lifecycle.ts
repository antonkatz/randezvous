import { signRecord } from './canonical';
import type {
  CircleId,
  Identity,
  PublicKeyId,
  StoredCircleRecord,
} from './types';

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Random, unguessable circle id. The host may also supply its own id. */
export function newCircleId(): CircleId {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `c_${crypto.randomUUID()}`;
  }
  return `c_${randomHex(16)}`;
}

export interface CreateCircleInput {
  identity: Identity;
  name: string;
  timezone: string;
  createdAt: number;
  /** Optional stable id; otherwise a random id is generated. */
  circleId?: CircleId;
}

export interface CreatedCircle {
  circleId: CircleId;
  record: StoredCircleRecord;
}

/** Sign the founding CircleCreated record. The caller is the creator. */
export async function createCircle(input: CreateCircleInput): Promise<CreatedCircle> {
  const circleId = input.circleId ?? newCircleId();
  const record = await signRecord(input.identity, {
    type: 'CircleCreated',
    circleId,
    name: input.name,
    timezone: input.timezone,
    creator: input.identity.selfKey,
    createdAt: input.createdAt,
  });
  return { circleId, record };
}

/** Sign a local Leave record. The member can rejoin only through a new valid Join. */
export async function leaveCircle(
  identity: Identity,
  circleId: CircleId,
  at: number,
): Promise<StoredCircleRecord> {
  return signRecord(identity, {
    type: 'Leave',
    circleId,
    member: identity.selfKey,
    at,
  });
}

export interface CastBanVoteInput {
  identity: Identity;
  circleId: CircleId;
  target: PublicKeyId;
  vote: 'ban' | 'unban';
  at: number;
}

/** Sign a local opinion. It is never sent to the target and never relayed. */
export async function castBanVote(input: CastBanVoteInput): Promise<StoredCircleRecord> {
  if (input.target === input.identity.selfKey) {
    throw new Error('You cannot vote to ban yourself');
  }
  return signRecord(input.identity, {
    type: 'BanVote',
    circleId: input.circleId,
    voter: input.identity.selfKey,
    target: input.target,
    vote: input.vote,
    at: input.at,
  });
}
