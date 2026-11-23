/**
 * Test and example fakes. Nothing in this file is imported by the runtime
 * modules; it exists so the injected interfaces have honest, Web-Crypto-backed
 * implementations in tests and local experiments.
 */
import {
  base64UrlToBytes,
  bytesToBase64Url,
  generateIdentityMaterial,
  sha256,
  signDomain,
  verifyDomain,
} from '../lib/crypto';
import { signRecord } from './canonical';
import type {
  AttendanceRecord,
  BanVoteRecord,
  CircleCreatedRecord,
  CircleRecord,
  Friends,
  Identity,
  InviteRecord,
  JoinRecord,
  LeaveRecord,
  PlanRecord,
  PublicKeyId,
  StoredCircleRecord,
} from './types';

const TEST_SIGNATURE_DOMAIN = 'randevouz/circles/test/v1';

export interface TestKeyRegistry {
  register(publicKey: string): string;
  resolve(publicKeyId: PublicKeyId): string | null;
  entries(): Map<PublicKeyId, string>;
}

export interface TestIdentity extends Identity {
  publicKey: string;
  label?: string;
}

/**
 * Create a real P-256 identity. Every identity in the same registry can verify
 * every other identity's signatures, which mirrors pinned direct friends and
 * known circle members in the host app.
 */
export async function createTestIdentity(
  registry: TestKeyRegistry = createTestRegistry(),
  label?: string,
): Promise<TestIdentity> {
  const material = await generateIdentityMaterial();
  return createIdentityFromMaterial(material, registry, label);
}

export function createTestRegistry(): TestKeyRegistry {
  const keys = new Map<PublicKeyId, string>();
  return {
    register(publicKey) {
      const bytes = base64UrlToBytes(publicKey);
      const id = deriveTestId(bytes);
      keys.set(id, publicKey);
      return id;
    },
    resolve(publicKeyId) {
      return keys.get(publicKeyId) ?? null;
    },
    entries() {
      return new Map(keys);
    },
  };
}

function deriveTestId(rawPublicKey: Uint8Array): string {
  // The real app derives h_ + a truncated hash. A deterministic test id keeps
  // failure messages readable while retaining the same collision properties.
  return `h_${bytesToBase64Url(rawPublicKey).slice(0, 22)}`;
}

async function createIdentityFromMaterial(
  material: Awaited<ReturnType<typeof generateIdentityMaterial>>,
  registry: TestKeyRegistry,
  label?: string,
): Promise<TestIdentity> {
  const selfKey = registry.register(material.publicKey);
  return {
    selfKey,
    publicKey: material.publicKey,
    ...(label !== undefined ? { label } : {}),
    async sign(bytes) {
      return signDomain(material.privateKey, TEST_SIGNATURE_DOMAIN, bytes);
    },
    async verify(publicKeyId, bytes, signature) {
      const publicKey = registry.resolve(publicKeyId);
      if (!publicKey) return false;
      return verifyDomain(publicKey, TEST_SIGNATURE_DOMAIN, bytes, signature);
    },
    async hash(bytes) {
      return bytesToBase64Url(await sha256(bytes));
    },
  };
}

export async function createTestIdentities(
  count: number,
): Promise<{ identities: TestIdentity[]; registry: TestKeyRegistry }> {
  const registry = createTestRegistry();
  const identities: TestIdentity[] = [];
  for (let index = 0; index < count; index += 1) {
    identities.push(await createTestIdentity(registry));
  }
  return { identities, registry };
}

export class MemoryFriends implements Friends {
  private readonly friends: Set<PublicKeyId>;

  constructor(initial: Iterable<PublicKeyId> = []) {
    this.friends = new Set(initial);
  }

  add(...keys: PublicKeyId[]): this {
    for (const key of keys) this.friends.add(key);
    return this;
  }

  delete(key: PublicKeyId): this {
    this.friends.delete(key);
    return this;
  }

  directFriends(): Set<PublicKeyId> {
    return new Set(this.friends);
  }
}

export async function makeCircleCreated(
  identity: Identity,
  input: Omit<CircleCreatedRecord, 'type' | 'creator' | 'sig'> & {
    creator?: PublicKeyId;
  },
): Promise<StoredCircleRecord> {
  return signRecord(identity, {
    type: 'CircleCreated',
    circleId: input.circleId,
    name: input.name,
    timezone: input.timezone,
    creator: input.creator ?? identity.selfKey,
    createdAt: input.createdAt,
  });
}

export async function makeInvite(
  inviter: Identity,
  input: Omit<InviteRecord, 'type' | 'inviter' | 'sig'>,
): Promise<StoredCircleRecord> {
  return signRecord(inviter, {
    type: 'Invite',
    circleId: input.circleId,
    invitee: input.invitee,
    inviter: inviter.selfKey,
    at: input.at,
  });
}

export async function makeJoin(
  member: Identity,
  input: Omit<JoinRecord, 'type' | 'member' | 'sig'>,
): Promise<StoredCircleRecord> {
  return signRecord(member, {
    type: 'Join',
    circleId: input.circleId,
    member: member.selfKey,
    at: input.at,
  });
}

export async function makeLeave(
  member: Identity,
  input: Omit<LeaveRecord, 'type' | 'member' | 'sig'>,
): Promise<StoredCircleRecord> {
  return signRecord(member, {
    type: 'Leave',
    circleId: input.circleId,
    member: member.selfKey,
    at: input.at,
  });
}

export async function makeBanVote(
  voter: Identity,
  input: Omit<BanVoteRecord, 'type' | 'voter' | 'sig'>,
): Promise<StoredCircleRecord> {
  return signRecord(voter, {
    type: 'BanVote',
    circleId: input.circleId,
    voter: voter.selfKey,
    target: input.target,
    vote: input.vote,
    at: input.at,
  });
}

export async function makePlan(
  organizer: Identity,
  input: Omit<PlanRecord, 'type' | 'organizer' | 'sig' | 'invitees'> & {
    invitees?: PublicKeyId[];
  },
): Promise<StoredCircleRecord> {
  return signRecord(organizer, {
    type: 'Plan',
    rendezvousId: input.rendezvousId,
    scheduledAt: input.scheduledAt,
    organizer: organizer.selfKey,
    invitees: [...new Set(input.invitees ?? [])].sort(),
  });
}

export async function makeAttendance(
  attendee: Identity,
  input: Omit<AttendanceRecord, 'type' | 'attendee' | 'sig' | 'swappedWith'> & {
    swappedWith?: PublicKeyId[];
    promptId?: string | null;
  },
): Promise<StoredCircleRecord> {
  return signRecord(attendee, {
    type: 'Attendance',
    rendezvousId: input.rendezvousId,
    scheduledAt: input.scheduledAt,
    attendee: attendee.selfKey,
    joinedAt: input.joinedAt,
    swappedWith: [...new Set(input.swappedWith ?? [])].sort(),
    promptId: input.promptId ?? null,
  });
}

/** Convenience for tests that only need the signed record bodies. */
export function recordsOf(entries: readonly StoredCircleRecord[]): CircleRecord[] {
  return entries.map((entry) => entry.record);
}
