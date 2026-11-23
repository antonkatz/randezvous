import { describe, expect, it } from 'vitest';
import {
  acceptCircleInvite,
  availableInvitees,
  createCircleInvite,
  isCircleInviteMessage,
  loadCircleMembership,
  mergeCircleInviteAcceptance,
  sendCircleInvite,
  type CircleInviteBundle,
} from './invitations';
import { deriveMemberView } from './membership';
import { MemoryCircleStore } from './store';
import {
  MemoryFriends,
  createTestIdentities,
  makeAttendance,
  makeBanVote,
  makeCircleCreated,
  makeInvite,
  makeJoin,
  makePlan,
  type TestIdentity,
} from './testing';
import type { PeerChannel, StoredCircleRecord } from './types';

const circleId = 'circle-invite';
const createdAt = 1_000;

async function baseMembership(
  creator: TestIdentity,
  members: TestIdentity[],
): Promise<StoredCircleRecord[]> {
  const records: StoredCircleRecord[] = [
    await makeCircleCreated(creator, {
      circleId,
      name: 'Invitation circle',
      timezone: 'UTC',
      createdAt,
    }),
  ];
  let at = 2_000;
  for (const member of members) {
    records.push(
      await makeInvite(creator, {
        circleId,
        invitee: member.selfKey,
        at,
      }),
    );
    at += 10;
    records.push(await makeJoin(member, { circleId, at }));
    at += 10;
  }
  return records;
}

function view(
  records: StoredCircleRecord[],
  identity: TestIdentity,
  friends: MemoryFriends,
) {
  return deriveMemberView(records, identity.selfKey, friends, {}, { circleId });
}

describe('circle invitations', () => {
  it('creates a signed bundle, accepts it and admits the new member', async () => {
    const { identities } = await createTestIdentities(3);
    const [ana, baz, dana] = identities;
    if (!ana || !baz || !dana) throw new Error('identities missing');
    const records = await baseMembership(ana, [baz]);
    const anaFriends = new MemoryFriends([baz.selfKey, dana.selfKey]);
    const danaFriends = new MemoryFriends([ana.selfKey]);

    const bundle = await createCircleInvite({
      identity: ana,
      records,
      circleId,
      invitee: dana.selfKey,
      at: 3_000,
      friends: anaFriends,
    });
    expect(bundle.kind).toBe('circle-invite');
    expect(bundle.inviter).toBe(ana.selfKey);
    expect(bundle.invitee).toBe(dana.selfKey);
    expect(bundle.invite.record.type).toBe('Invite');
    expect(bundle.records.some((entry) => entry.id === bundle.invite.id)).toBe(true);
    expect(bundle.records.every((entry) => entry.record.type === 'CircleCreated' || entry.record.type === 'Invite' || entry.record.type === 'Join' || entry.record.type === 'Leave')).toBe(true);

    const acceptance = await acceptCircleInvite({
      identity: dana,
      bundle,
      at: 4_000,
      friends: danaFriends,
    });
    expect(acceptance.kind).toBe('circle-invite-acceptance');
    expect(acceptance.join.record.type).toBe('Join');

    const merged = await mergeCircleInviteAcceptance(ana, bundle.records, acceptance);
    expect(merged.rejected).toEqual([]);
    expect(merged.added.map((entry) => entry.id)).toContain(acceptance.join.id);

    const anaView = view(merged.records, ana, anaFriends);
    const danaView = view(acceptance.records, dana, danaFriends);
    expect(anaView.members).toEqual([ana.selfKey, baz.selfKey, dana.selfKey].sort());
    expect(danaView.members).toEqual([ana.selfKey, baz.selfKey, dana.selfKey].sort());
    expect(anaView.unconnectedToYou).toEqual([]);
    expect(danaView.unconnectedToYou).toContain(baz.selfKey);
    expect(anaView.shouldAcceptConnection(circleId, dana.selfKey)).toBe(true);
  });

  it('excludes BanVotes and rendezvous records from the bundle', async () => {
    const { identities } = await createTestIdentities(3);
    const [ana, baz, dana] = identities;
    if (!ana || !baz || !dana) throw new Error('identities missing');
    const membership = await baseMembership(ana, [baz]);
    const vote = await makeBanVote(ana, {
      circleId,
      target: baz.selfKey,
      vote: 'ban',
      at: 5_000,
    });
    const plan = await makePlan(ana, {
      circleId,
      rendezvousId: 'r-secret',
      scheduledAt: 100_000,
      invitees: [baz.selfKey],
      createdAt: 50_000,
    });
    const attendance = await makeAttendance(ana, {
      rendezvousId: 'r-secret',
      scheduledAt: 100_000,
      joinedAt: 100_000,
      swappedWith: [baz.selfKey],
    });
    const bundle = await createCircleInvite({
      identity: ana,
      records: [...membership, vote, plan, attendance],
      circleId,
      invitee: dana.selfKey,
      at: 6_000,
      friends: new MemoryFriends([baz.selfKey, dana.selfKey]),
    });
    for (const entry of bundle.records) {
      expect(['CircleCreated', 'Invite', 'Join', 'Leave']).toContain(entry.record.type);
    }
    expect(bundle.records.some((entry) => entry.id === vote.id)).toBe(false);
    expect(bundle.records.some((entry) => entry.id === plan.id)).toBe(false);
    expect(bundle.records.some((entry) => entry.id === attendance.id)).toBe(false);
  });


  it('lists direct humans who are not yet members', async () => {
    const { identities } = await createTestIdentities(3);
    const [ana, baz, dana] = identities;
    if (!ana || !baz || !dana) throw new Error('identities missing');
    const records = await baseMembership(ana, [baz]);
    const friends = new MemoryFriends([baz.selfKey, dana.selfKey]);
    expect(availableInvitees(view(records, ana, friends), friends)).toEqual([
      dana.selfKey,
    ]);
  });
  it('refuses invitations to non-friends, existing members and yourself', async () => {
    const { identities } = await createTestIdentities(3);
    const [ana, baz, dana] = identities;
    if (!ana || !baz || !dana) throw new Error('identities missing');
    const records = await baseMembership(ana, [baz]);
    await expect(
      createCircleInvite({
        identity: ana,
        records,
        circleId,
        invitee: dana.selfKey,
        at: 3_000,
        friends: new MemoryFriends([baz.selfKey]),
      }),
    ).rejects.toThrow(/direct humans/u);
    await expect(
      createCircleInvite({
        identity: ana,
        records,
        circleId,
        invitee: baz.selfKey,
        at: 3_000,
        friends: new MemoryFriends([baz.selfKey, dana.selfKey]),
      }),
    ).rejects.toThrow(/already a member/u);
    await expect(
      createCircleInvite({
        identity: ana,
        records,
        circleId,
        invitee: ana.selfKey,
        at: 3_000,
      }),
    ).rejects.toThrow(/yourself/u);
  });

  it('refuses acceptance by someone other than the named invitee', async () => {
    const { identities } = await createTestIdentities(4);
    const [ana, baz, dana, eve] = identities;
    if (!ana || !baz || !dana || !eve) throw new Error('identities missing');
    const records = await baseMembership(ana, [baz]);
    const bundle = await createCircleInvite({
      identity: ana,
      records,
      circleId,
      invitee: dana.selfKey,
      at: 3_000,
      friends: new MemoryFriends([baz.selfKey, dana.selfKey]),
    });
    await expect(
      acceptCircleInvite({ identity: eve, bundle, at: 4_000 }),
    ).rejects.toThrow(/another human/u);
  });

  it('rejects tampered invitations and joins that predate them', async () => {
    const { identities } = await createTestIdentities(3);
    const [ana, baz, dana] = identities;
    if (!ana || !baz || !dana) throw new Error('identities missing');
    const records = await baseMembership(ana, [baz]);
    const bundle = await createCircleInvite({
      identity: ana,
      records,
      circleId,
      invitee: dana.selfKey,
      at: 3_000,
      friends: new MemoryFriends([baz.selfKey, dana.selfKey]),
    });

    const tampered: CircleInviteBundle = {
      ...bundle,
      invite: {
        ...bundle.invite,
        record: {
          ...bundle.invite.record,
          sig: 'AAAA',
        },
      },
    };
    await expect(
      acceptCircleInvite({ identity: dana, bundle: tampered, at: 4_000 }),
    ).rejects.toThrow(/signature|invalid/iu);

    await expect(
      acceptCircleInvite({ identity: dana, bundle, at: 2_999 }),
    ).rejects.toThrow(/predate/u);
  });

  it('rejects an invitation signed by a non-member', async () => {
    const { identities } = await createTestIdentities(4);
    const [ana, baz, cy, dana] = identities;
    if (!ana || !baz || !cy || !dana) throw new Error('identities missing');
    const records = await baseMembership(ana, [baz]);
    const { signRecord } = await import('./canonical');
    const invite = await signRecord(cy, {
      type: 'Invite',
      circleId,
      invitee: dana.selfKey,
      inviter: cy.selfKey,
      at: 3_000,
    });
    const bundle: CircleInviteBundle = {
      kind: 'circle-invite',
      circleId,
      inviter: cy.selfKey,
      invitee: dana.selfKey,
      at: 3_000,
      invite,
      records: [...records, invite].sort((a, b) => (a.id < b.id ? -1 : 1)),
    };
    await expect(
      acceptCircleInvite({ identity: dana, bundle, at: 4_000 }),
    ).rejects.toThrow(/not a current member/u);
  });

  it('sends an invitation over a peer channel and loads membership', async () => {
    const { identities } = await createTestIdentities(3);
    const [ana, baz, dana] = identities;
    if (!ana || !baz || !dana) throw new Error('identities missing');
    const records = await baseMembership(ana, [baz]);
    const bundle = await createCircleInvite({
      identity: ana,
      records,
      circleId,
      invitee: dana.selfKey,
      at: 3_000,
      friends: new MemoryFriends([baz.selfKey, dana.selfKey]),
    });
    const sent: unknown[] = [];
    const channel: PeerChannel = {
      peerKey: dana.selfKey,
      send(message) {
        sent.push(message);
      },
      onMessage() {
        return () => {};
      },
    };
    await sendCircleInvite(channel, bundle);
    expect(sent).toHaveLength(1);
    expect(isCircleInviteMessage(sent[0])).toBe(true);
    if (isCircleInviteMessage(sent[0])) {
      expect(sent[0].type).toBe('circle-invite/offer');
    }

    const store = new MemoryCircleStore();
    await store.append(circleId, [...records, bundle.invite]);
    expect((await loadCircleMembership(store, circleId)).length).toBe(4);
    expect((await loadCircleMembership(store, 'other')).length).toBe(0);
  });
});
