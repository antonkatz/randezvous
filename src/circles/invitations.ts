import { compareStrings, signRecord, verifyStoredRecord } from './canonical';
import { deriveMemberView, memberValidAt, resolveCircleMetadata } from './membership';
import { mergeRecords, type MergeResult } from './merge';
import type {
  CircleId,
  CircleStore,
  Friends,
  Identity,
  MemberOverride,
  MemberView,
  PeerChannel,
  PublicKeyId,
  StoredCircleRecord,
} from './types';
import { isCircleScopedRecord } from './types';

const MEMBERSHIP_TYPES = new Set([
  'CircleCreated',
  'Invite',
  'Join',
  'Leave',
  'LinkInvite',
]);

const EMPTY_FRIENDS: Friends = {
  directFriends() {
    return new Set();
  },
};

export interface CircleInviteBundle {
  kind: 'circle-invite';
  circleId: CircleId;
  inviter: PublicKeyId;
  invitee: PublicKeyId;
  at: number;
  /** Membership history plus the new Invite, sorted by content id. */
  records: StoredCircleRecord[];
  /** The newly signed Invite, also present in records. */
  invite: StoredCircleRecord;
}

export interface CircleInviteAcceptance {
  kind: 'circle-invite-acceptance';
  circleId: CircleId;
  inviter: PublicKeyId;
  invitee: PublicKeyId;
  /** The signed Join, also present in records. */
  join: StoredCircleRecord;
  /** Complete membership history, the Invite and the Join. */
  records: StoredCircleRecord[];
}

export interface CreateCircleInviteInput {
  identity: Identity;
  records: readonly StoredCircleRecord[];
  circleId: CircleId;
  invitee: PublicKeyId;
  /** Authoring time; supplied by the caller for deterministic tests. */
  at: number;
  /**
   * Strongly recommended: when present, only a direct human can be invited.
   * Without it the caller is responsible for secure out-of-band delivery.
   */
  friends?: Friends;
  overrides?: Readonly<Record<PublicKeyId, MemberOverride>>;
}

export interface AcceptCircleInviteInput {
  identity: Identity;
  bundle: CircleInviteBundle;
  /** Acceptance time; must not precede the Invite. */
  at: number;
  friends?: Friends;
  overrides?: Readonly<Record<PublicKeyId, MemberOverride>>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMembershipEntry(entry: unknown): entry is StoredCircleRecord {
  if (!isObject(entry) || !isObject(entry.record)) return false;
  const type = entry.record.type;
  return typeof type === 'string' && MEMBERSHIP_TYPES.has(type);
}

function membershipOnly(
  records: readonly StoredCircleRecord[],
  circleId: CircleId,
): StoredCircleRecord[] {
  return records.filter(
    (entry) =>
      isMembershipEntry(entry) &&
      isCircleScopedRecord(entry.record) &&
      entry.record.circleId === circleId,
  );
}

function sorted(records: readonly StoredCircleRecord[]): StoredCircleRecord[] {
  return [...records].sort((a, b) => compareStrings(a.id, b.id));
}

function firstRejection(result: MergeResult): Error {
  const rejection = result.rejected[0];
  return new Error(
    rejection
      ? `Invalid circle invitation: ${rejection.error}`
      : 'Invalid circle invitation',
  );
}

/**
 * Create a signed Invite plus the membership history needed to prove that the
 * inviter is a current, valid member. The bundle contains no BanVotes and no
 * rendezvous/media records. Deliver it over an authenticated direct-human
 * channel (or a secure out-of-band link owned by the host app).
 */
export async function createCircleInvite(
  input: CreateCircleInviteInput,
): Promise<CircleInviteBundle> {
  if (input.invitee === input.identity.selfKey) {
    throw new Error('You cannot invite yourself to a circle');
  }
  if (input.friends && !input.friends.directFriends().has(input.invitee)) {
    throw new Error('Circle invitations can only be sent to direct humans');
  }

  const scoped = input.records.filter((entry) => {
    const record = entry?.record;
    if (!isObject(record)) return false;
    if (record.type === 'BanVote') return record.circleId === input.circleId;
    return (
      MEMBERSHIP_TYPES.has(record.type) &&
      isCircleScopedRecord(record) &&
      record.circleId === input.circleId
    );
  });
  const verified = await mergeRecords(input.identity, [], scoped, {
    circleId: input.circleId,
  });
  if (verified.rejected.length > 0) throw firstRejection(verified);
  if (verified.records.length === 0) throw new Error('Circle records are missing');

  const circle = resolveCircleMetadata(verified.records, input.circleId);
  if (!circle) throw new Error('Circle creation record is missing');
  if (input.at < circle.createdAt) {
    throw new Error('Invitation cannot predate the circle');
  }

  const view = deriveMemberView(
    verified.records,
    input.identity.selfKey,
    input.friends ?? EMPTY_FRIENDS,
    input.overrides ?? {},
    { circleId: input.circleId },
  );
  if (!view.members.includes(input.identity.selfKey)) {
    throw new Error('Only a current member can invite someone');
  }
  if (view.banned.includes(input.invitee)) {
    throw new Error('That human is banned in your view of this circle');
  }
  if (view.members.includes(input.invitee)) {
    throw new Error('That human is already a member of this circle');
  }

  const invite = await signRecord(input.identity, {
    type: 'Invite',
    circleId: input.circleId,
    invitee: input.invitee,
    inviter: input.identity.selfKey,
    at: input.at,
  });

  // The bundle carries membership proof only. BanVotes remain local and must
  // never be relayed, but they still shape the inviter's ban checks above.
  const history = verified.records.filter(
    (entry) => isMembershipEntry(entry),
  );

  return {
    kind: 'circle-invite',
    circleId: input.circleId,
    inviter: input.identity.selfKey,
    invitee: input.invitee,
    at: input.at,
    records: sorted([...history, invite]),
    invite,
  };
}

export interface CreateCircleLinkInviteInput {
  identity: Identity;
  records: readonly StoredCircleRecord[];
  circleId: CircleId;
  /** Bound circle offer, or null for a membership-only link. */
  planId: string | null;
  at: number;
  expiresAt: number;
  friends?: Friends;
  overrides?: Readonly<Record<PublicKeyId, MemberOverride>>;
}

export interface CreatedCircleLinkInvite {
  /** The signed LinkInvite. It is also present in `records`. */
  link: StoredCircleRecord;
  /** Membership proof plus the new LinkInvite, sorted by content id. */
  records: StoredCircleRecord[];
}

/**
 * Sign a bearer membership grant for a circle rendezvous link. The link is
 * out-of-band and intentionally not addressed to one key; anyone holding it may
 * join until `expiresAt`. The caller embeds the returned records in the link.
 */
export async function createCircleLinkInvite(
  input: CreateCircleLinkInviteInput,
): Promise<CreatedCircleLinkInvite> {
  if (!Number.isFinite(input.at) || !Number.isSafeInteger(input.at) || input.at < 0) {
    throw new Error('Invitation time must be a UTC timestamp');
  }
  if (
    !Number.isFinite(input.expiresAt) ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= input.at
  ) {
    throw new Error('Invitation expiry must follow its creation');
  }
  if (input.planId !== null && input.planId.length === 0) {
    throw new Error('planId must not be empty');
  }

  const scoped = input.records.filter(
    (entry) =>
      isMembershipEntry(entry) &&
      isCircleScopedRecord(entry.record) &&
      entry.record.circleId === input.circleId,
  );
  const verified = await mergeRecords(input.identity, [], scoped, {
    circleId: input.circleId,
  });
  if (verified.rejected.length > 0) throw firstRejection(verified);
  if (verified.records.length === 0) throw new Error('Circle records are missing');

  const view = deriveMemberView(
    verified.records,
    input.identity.selfKey,
    input.friends ?? EMPTY_FRIENDS,
    input.overrides ?? {},
    { circleId: input.circleId },
  );
  if (!view.members.includes(input.identity.selfKey)) {
    throw new Error('Only a current member can create a circle link');
  }

  const link = await signRecord(input.identity, {
    type: 'LinkInvite',
    circleId: input.circleId,
    inviter: input.identity.selfKey,
    planId: input.planId,
    at: input.at,
    expiresAt: input.expiresAt,
  });

  return {
    link,
    records: sorted([...verified.records, link]),
  };
}

export interface AcceptCircleLinkInviteInput {
  identity: Identity;
  /** Membership proof and LinkInvite carried by the link. */
  records: readonly StoredCircleRecord[];
  circleId: CircleId;
  linkId: string;
  at: number;
  friends?: Friends;
  overrides?: Readonly<Record<PublicKeyId, MemberOverride>>;
}

export interface CircleLinkInviteAcceptance {
  /** Verified records plus the local Join, when one was needed. */
  records: StoredCircleRecord[];
  join: StoredCircleRecord | null;
}

/**
 * Verify a circle link locally and sign the opener's Join. No inviter
 * connection is required. Reopening a link from an existing member is
 * idempotent and creates no duplicate Join.
 */
export async function acceptCircleLinkInvite(
  input: AcceptCircleLinkInviteInput,
): Promise<CircleLinkInviteAcceptance> {
  if (!Number.isFinite(input.at) || !Number.isSafeInteger(input.at) || input.at < 0) {
    throw new Error('Join time must be a UTC timestamp');
  }
  const verified = await mergeRecords(input.identity, [], input.records, {
    circleId: input.circleId,
  });
  if (verified.rejected.length > 0) throw firstRejection(verified);

  const linkEntry = verified.records.find(
    (entry) => entry.id === input.linkId && entry.record.type === 'LinkInvite',
  );
  if (!linkEntry || linkEntry.record.type !== 'LinkInvite') {
    throw new Error('This link has no valid circle invitation');
  }
  const link = linkEntry.record;
  if (link.circleId !== input.circleId) {
    throw new Error('The circle link belongs to another circle');
  }
  if (input.at < link.at) throw new Error('Join cannot predate the link');
  if (input.at > link.expiresAt) {
    throw new Error('This circle invitation link has expired');
  }
  if (!memberValidAt(verified.records, input.circleId, link.inviter, input.at)) {
    throw new Error('The inviter is not a current member of this circle');
  }

  const view = deriveMemberView(
    verified.records,
    input.identity.selfKey,
    input.friends ?? EMPTY_FRIENDS,
    input.overrides ?? {},
    { circleId: input.circleId },
  );
  if (view.members.includes(input.identity.selfKey)) {
    return { records: verified.records, join: null };
  }
  if (view.banned.includes(input.identity.selfKey)) {
    throw new Error('You are banned in this circle');
  }

  const join = await signRecord(input.identity, {
    type: 'Join',
    circleId: input.circleId,
    member: input.identity.selfKey,
    at: input.at,
  });
  return {
    records: sorted([...verified.records, join]),
    join,
  };
}

/**
 * Verify an addressed invitation, prove the inviter's chain position, and sign
 * the Join. The returned records are ready to append locally and send back to
 * the inviter.
 */
export async function acceptCircleInvite(
  input: AcceptCircleInviteInput,
): Promise<CircleInviteAcceptance> {
  const bundle = input.bundle;
  if (!isObject(bundle) || bundle.kind !== 'circle-invite') {
    throw new Error('Invalid circle invitation bundle');
  }
  if (
    typeof bundle.circleId !== 'string' ||
    typeof bundle.inviter !== 'string' ||
    typeof bundle.invitee !== 'string' ||
    typeof bundle.at !== 'number' ||
    !Array.isArray(bundle.records) ||
    !isObject(bundle.invite)
  ) {
    throw new Error('Invalid circle invitation bundle');
  }
  if (bundle.invitee !== input.identity.selfKey) {
    throw new Error('This circle invitation is for another human');
  }

  const inviteEntry = bundle.invite as StoredCircleRecord;
  if (inviteEntry.record.type !== 'Invite') {
    throw new Error('Circle invitation does not contain an Invite record');
  }
  if (
    inviteEntry.record.circleId !== bundle.circleId ||
    inviteEntry.record.inviter !== bundle.inviter ||
    inviteEntry.record.invitee !== bundle.invitee ||
    inviteEntry.record.at !== bundle.at
  ) {
    throw new Error('Circle invitation record does not match the bundle');
  }

  const records = bundle.records as unknown[];
  if (!records.every(isMembershipEntry)) {
    throw new Error('Circle invitation contains non-membership records');
  }
  const membership = records as StoredCircleRecord[];
  if (
    !membership.every(
      (entry) =>
        isCircleScopedRecord(entry.record) &&
        entry.record.circleId === bundle.circleId,
    )
  ) {
    throw new Error('Circle invitation contains records from another circle');
  }
  if (!membership.some((entry) => entry.id === inviteEntry.id)) {
    throw new Error('Circle invitation does not include its Invite record');
  }

  const inviteCheck = await verifyStoredRecord(input.identity, inviteEntry);
  if (!inviteCheck.ok) {
    throw new Error(inviteCheck.error ?? 'Invalid Invite signature');
  }

  const verified = await mergeRecords(input.identity, [], membership, {
    circleId: bundle.circleId,
  });
  if (verified.rejected.length > 0) throw firstRejection(verified);

  const circle = resolveCircleMetadata(verified.records, bundle.circleId);
  if (!circle) throw new Error('Circle creation record is missing');
  if (input.at < bundle.at) throw new Error('Join cannot predate the Invite');
  if (input.at < circle.createdAt) {
    throw new Error('Join cannot predate the circle');
  }

  const view = deriveMemberView(
    verified.records,
    input.identity.selfKey,
    input.friends ?? EMPTY_FRIENDS,
    input.overrides ?? {},
    { circleId: bundle.circleId },
  );
  if (view.members.includes(input.identity.selfKey)) {
    throw new Error('You are already a member of this circle');
  }
  if (!view.members.includes(bundle.inviter)) {
    throw new Error('The inviter is not a current member of this circle');
  }
  if (view.banned.includes(bundle.inviter)) {
    throw new Error('The inviter is banned in your view of this circle');
  }
  if (!memberValidAt(verified.records, bundle.circleId, bundle.inviter, bundle.at)) {
    throw new Error('The inviter was not a valid member when the invitation was issued');
  }

  const join = await signRecord(input.identity, {
    type: 'Join',
    circleId: bundle.circleId,
    member: input.identity.selfKey,
    at: input.at,
  });

  return {
    kind: 'circle-invite-acceptance',
    circleId: bundle.circleId,
    inviter: bundle.inviter,
    invitee: input.identity.selfKey,
    join,
    records: sorted([...verified.records, join]),
  };
}

/**
 * The inviter merges the returning acceptance. The Join passes the same chain
 * rules as any other membership record; invalid acceptances are rejected.
 */
export async function mergeCircleInviteAcceptance(
  identity: Identity,
  existing: readonly StoredCircleRecord[],
  acceptance: CircleInviteAcceptance,
  options: { circleId?: CircleId } = {},
): Promise<MergeResult> {
  if (!isObject(acceptance) || acceptance.kind !== 'circle-invite-acceptance') {
    throw new Error('Invalid circle invitation acceptance');
  }
  if (
    typeof acceptance.circleId !== 'string' ||
    !Array.isArray(acceptance.records) ||
    !acceptance.records.every(isMembershipEntry) ||
    !isObject(acceptance.join) ||
    acceptance.join.record.type !== 'Join'
  ) {
    throw new Error('Invalid circle invitation acceptance');
  }
  const circleId = options.circleId ?? acceptance.circleId;
  if (circleId !== acceptance.circleId) {
    throw new Error('Acceptance belongs to another circle');
  }
  if (
    acceptance.join.record.type !== 'Join' ||
    acceptance.join.record.circleId !== circleId
  ) {
    throw new Error('Acceptance does not contain a Join for this circle');
  }
  if (!acceptance.records.some((entry) => entry.id === acceptance.join.id)) {
    throw new Error('Acceptance does not include its Join record');
  }
  return mergeRecords(identity, existing, acceptance.records, { circleId });
}

/**
 * Message namespace for carrying invitations over the host app's already
 * authenticated PeerChannel. Keep this separate from circle-sync messages so a
 * non-member can receive an invitation before the circle becomes shared.
 */
export type CircleInviteMessage =
  | { type: 'circle-invite/offer'; bundle: CircleInviteBundle }
  | { type: 'circle-invite/accept'; acceptance: CircleInviteAcceptance };

export function isCircleInviteMessage(value: unknown): value is CircleInviteMessage {
  if (!isObject(value)) return false;
  if (value.type === 'circle-invite/offer') {
    const bundle = value.bundle;
    return (
      isObject(bundle) &&
      typeof bundle.inviter === 'string' &&
      typeof bundle.invitee === 'string' &&
      Array.isArray(bundle.records) &&
      isObject(bundle.invite)
    );
  }
  if (value.type === 'circle-invite/accept') {
    const acceptance = value.acceptance;
    return (
      isObject(acceptance) &&
      typeof acceptance.circleId === 'string' &&
      Array.isArray(acceptance.records) &&
      isObject(acceptance.join)
    );
  }
  return false;
}

export async function sendCircleInvite(
  channel: PeerChannel,
  bundle: CircleInviteBundle,
): Promise<void> {
  await Promise.resolve(
    channel.send({ type: 'circle-invite/offer', bundle } satisfies CircleInviteMessage),
  );
}

export async function sendCircleInviteAcceptance(
  channel: PeerChannel,
  acceptance: CircleInviteAcceptance,
): Promise<void> {
  await Promise.resolve(
    channel.send({
      type: 'circle-invite/accept',
      acceptance,
    } satisfies CircleInviteMessage),
  );
}

/**
 * Direct humans who are not yet in this circle. The host can turn these into
 * rows in <circle-stats-page>.inviteCandidates.
 */
export function availableInvitees(
  view: MemberView,
  friends: Friends,
): PublicKeyId[] {
  const members = new Set(view.members);
  const banned = new Set(view.banned);
  return [...friends.directFriends()]
    .filter(
      (peerKey) =>
        peerKey !== view.selfKey && !members.has(peerKey) && !banned.has(peerKey),
    )
    .sort(compareStrings);
}

/** Read the current membership records for a circle from a store. */
export async function loadCircleMembership(
  store: CircleStore,
  circleId: CircleId,
): Promise<StoredCircleRecord[]> {
  return membershipOnly(await store.load(circleId), circleId);
}
