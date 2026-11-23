import { describe, expect, it } from 'vitest';
import { deriveMemberView } from './membership';
import { CircleSync, canAcceptRecord, canSendRecord } from './sync';
import { MemoryCircleStore } from './store';
import {
  MemoryFriends,
  MemoryPeerHub,
  createTestIdentities,
  makeAttendance,
  makeBanVote,
  makeCircleCreated,
  makeInvite,
  makeJoin,
  makePlan,
  type TestIdentity,
} from './testing';
import type { MemberView, StoredCircleRecord } from './types';

const circleId = 'circle-sync';
const scheduledAt = 1_700_000_000_000;

interface MembershipWorld {
  identities: TestIdentity[];
  records: StoredCircleRecord[];
}

async function membershipWorld(
  count: number,
  memberCount = count,
): Promise<MembershipWorld> {
  const { identities } = await createTestIdentities(count);
  const creator = identities[0];
  if (!creator) throw new Error('creator missing');
  const records: StoredCircleRecord[] = [
    await makeCircleCreated(creator, {
      circleId,
      name: 'Sync circle',
      timezone: 'UTC',
      createdAt: 1_000,
    }),
  ];
  let at = 2_000;
  for (const member of identities.slice(1, memberCount)) {
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
  return { identities, records };
}

function peerView(
  identity: TestIdentity,
  records: StoredCircleRecord[],
  friends: MemoryFriends,
): MemberView {
  return deriveMemberView(records, identity.selfKey, friends, {}, { circleId });
}

interface PeerFixture {
  identity: TestIdentity;
  friends: MemoryFriends;
  store: MemoryCircleStore;
}

async function syncPair(
  left: PeerFixture,
  right: PeerFixture,
  options: { order?: 'fifo' | 'lifo'; replay?: boolean } = {},
): Promise<MemoryPeerHub> {
  const hub = new MemoryPeerHub();
  const channels = hub.pair(left.identity.selfKey, right.identity.selfKey);
  const leftSync = new CircleSync({
    identity: left.identity,
    friends: left.friends,
    store: left.store,
  });
  const rightSync = new CircleSync({
    identity: right.identity,
    friends: right.friends,
    store: right.store,
  });
  leftSync.addPeer(channels.a);
  rightSync.addPeer(channels.b);
  await leftSync.start();
  await rightSync.start();
  await hub.flush(options.order ?? 'fifo');
  await leftSync.whenIdle();
  await rightSync.whenIdle();
  if (options.replay) {
    await hub.replay('lifo');
    await leftSync.whenIdle();
    await rightSync.whenIdle();
  }
  leftSync.stop();
  rightSync.stop();
  return hub;
}

function ids(records: readonly StoredCircleRecord[]): string[] {
  return records.map((entry) => entry.id).sort();
}

describe('circle sync', () => {
  it('converges with out-of-order and duplicate delivery', async () => {
    const { identities, records } = await membershipWorld(2);
    const [ana, baz] = identities;
    if (!ana || !baz) throw new Error('identities missing');
    const anaStore = new MemoryCircleStore();
    const bazStore = new MemoryCircleStore();
    await anaStore.append(circleId, records);
    await bazStore.append(circleId, records);

    const plan = await makePlan(ana, {
      circleId,
      rendezvousId: 'sync-r1',
      scheduledAt,
      invitees: [baz.selfKey],
      createdAt: scheduledAt - 1_000,
    });
    const anaAttendance = await makeAttendance(ana, {
      rendezvousId: 'sync-r1',
      scheduledAt,
      joinedAt: scheduledAt,
      swappedWith: [baz.selfKey],
    });
    const bazAttendance = await makeAttendance(baz, {
      rendezvousId: 'sync-r1',
      scheduledAt,
      joinedAt: scheduledAt,
      swappedWith: [ana.selfKey],
    });
    await anaStore.append(circleId, [plan, anaAttendance, bazAttendance]);

    const anaPeer: PeerFixture = {
      identity: ana,
      friends: new MemoryFriends([baz.selfKey]),
      store: anaStore,
    };
    const bazPeer: PeerFixture = {
      identity: baz,
      friends: new MemoryFriends([ana.selfKey]),
      store: bazStore,
    };

    await syncPair(anaPeer, bazPeer, { order: 'lifo', replay: true });

    expect(ids(await bazStore.load(circleId))).toEqual(ids(await anaStore.load(circleId)));
    expect(ids(await bazStore.load(circleId))).toContain(plan.id);
    expect(ids(await bazStore.load(circleId))).toContain(anaAttendance.id);
    expect(ids(await bazStore.load(circleId))).toContain(bazAttendance.id);
  });

  it('never sends a BanVote to its target and never relays it', async () => {
    const { identities, records } = await membershipWorld(3);
    const [ana, baz, cy] = identities;
    if (!ana || !baz || !cy) throw new Error('identities missing');
    const anaStore = new MemoryCircleStore();
    const bazStore = new MemoryCircleStore();
    const cyStore = new MemoryCircleStore();
    for (const store of [anaStore, bazStore, cyStore]) {
      await store.append(circleId, records);
    }

    const vote = await makeBanVote(ana, {
      circleId,
      target: baz.selfKey,
      vote: 'ban',
      at: 5_000,
    });
    await anaStore.append(circleId, [vote]);

    const anaPeer: PeerFixture = {
      identity: ana,
      friends: new MemoryFriends([baz.selfKey, cy.selfKey]),
      store: anaStore,
    };
    const bazPeer: PeerFixture = {
      identity: baz,
      friends: new MemoryFriends([ana.selfKey, cy.selfKey]),
      store: bazStore,
    };
    const cyPeer: PeerFixture = {
      identity: cy,
      friends: new MemoryFriends([ana.selfKey, baz.selfKey]),
      store: cyStore,
    };

    await syncPair(anaPeer, bazPeer);
    expect(ids(await bazStore.load(circleId))).not.toContain(vote.id);

    await syncPair(anaPeer, cyPeer);
    expect(ids(await cyStore.load(circleId))).toContain(vote.id);

    await syncPair(cyPeer, bazPeer);
    expect(ids(await bazStore.load(circleId))).not.toContain(vote.id);
    expect(ids(await cyStore.load(circleId))).toContain(vote.id);
  });

  it('gossips Plan/Attendance only to direct friends in a relevant circle', async () => {
    const { identities, records } = await membershipWorld(4, 3);
    const [ana, baz, cy, outsider] = identities;
    if (!ana || !baz || !cy || !outsider) throw new Error('identities missing');
    const anaStore = new MemoryCircleStore();
    const bazStore = new MemoryCircleStore();
    const cyStore = new MemoryCircleStore();
    for (const store of [anaStore, bazStore, cyStore]) {
      await store.append(circleId, records);
    }

    const planWithBaz = await makePlan(ana, {
      circleId,
      rendezvousId: 'gossip-ab',
      scheduledAt,
      invitees: [baz.selfKey],
      createdAt: scheduledAt - 1_000,
    });
    const withBaz = [
      planWithBaz,
      await makeAttendance(ana, {
        rendezvousId: 'gossip-ab',
        scheduledAt,
        joinedAt: scheduledAt,
        swappedWith: [baz.selfKey],
      }),
      await makeAttendance(baz, {
        rendezvousId: 'gossip-ab',
        scheduledAt,
        joinedAt: scheduledAt,
        swappedWith: [ana.selfKey],
      }),
    ];
    const planWithCy = await makePlan(ana, {
      rendezvousId: 'gossip-ac',
      scheduledAt: scheduledAt + 60_000,
      invitees: [cy.selfKey],
      circleId,
      createdAt: scheduledAt - 1_000,
    });
    const withCy = [
      planWithCy,
      await makeAttendance(ana, {
        rendezvousId: 'gossip-ac',
        scheduledAt: scheduledAt + 60_000,
        joinedAt: scheduledAt + 60_000,
        swappedWith: [cy.selfKey],
      }),
      await makeAttendance(cy, {
        rendezvousId: 'gossip-ac',
        scheduledAt: scheduledAt + 60_000,
        joinedAt: scheduledAt + 60_000,
        swappedWith: [ana.selfKey],
      }),
    ];
    const planWithOutsider = await makePlan(ana, {
      rendezvousId: 'gossip-outsider',
      scheduledAt: scheduledAt + 120_000,
      invitees: [outsider.selfKey],
      circleId,
      createdAt: scheduledAt - 1_000,
    });
    const withOutsider = [
      planWithOutsider,
      await makeAttendance(ana, {
        rendezvousId: 'gossip-outsider',
        scheduledAt: scheduledAt + 120_000,
        joinedAt: scheduledAt + 120_000,
        swappedWith: [outsider.selfKey],
      }),
      await makeAttendance(outsider, {
        rendezvousId: 'gossip-outsider',
        scheduledAt: scheduledAt + 120_000,
        joinedAt: scheduledAt + 120_000,
        swappedWith: [ana.selfKey],
      }),
    ];
    await anaStore.append(circleId, [...withBaz, ...withCy, ...withOutsider]);

    const anaPeer: PeerFixture = {
      identity: ana,
      friends: new MemoryFriends([baz.selfKey]),
      store: anaStore,
    };
    const bazPeer: PeerFixture = {
      identity: baz,
      friends: new MemoryFriends([ana.selfKey]),
      store: bazStore,
    };
    const cyPeer: PeerFixture = {
      identity: cy,
      friends: new MemoryFriends([ana.selfKey]),
      store: cyStore,
    };

    // Cy is a circle member but not one of Ana's direct friends.
    await syncPair(anaPeer, cyPeer);
    const cyIds = ids(await cyStore.load(circleId));
    expect(cyIds).not.toContain(planWithBaz.id);
    expect(cyIds).not.toContain(planWithCy.id);
    expect(cyIds).not.toContain(planWithOutsider.id);

    await syncPair(anaPeer, bazPeer);
    const bazIds = ids(await bazStore.load(circleId));
    expect(bazIds).toContain(planWithBaz.id);
    expect(bazIds).toContain(planWithCy.id);
    // A signed plan is circle-scoped metadata: later members and plans naming
    // a non-member still converge on the same canonical history. Attendance
    // with fewer than two current members stays private.
    expect(bazIds).toContain(planWithOutsider.id);
    for (const entry of withOutsider.slice(1)) {
      expect(bazIds).not.toContain(entry.id);
    }
  });

  it('applies the BanVote and gossip policies at the record level', async () => {
    const { identities, records } = await membershipWorld(3);
    const [ana, baz, cy] = identities;
    if (!ana || !baz || !cy) throw new Error('identities missing');
    const friends = new MemoryFriends([baz.selfKey]);
    const view = peerView(ana, records, friends);
    const anaIdentity = ana;

    const voteOnBaz = await makeBanVote(ana, {
      circleId,
      target: baz.selfKey,
      vote: 'ban',
      at: 5_000,
    });
    const base = {
      circleId,
      identity: anaIdentity,
      friends,
      view,
    };
    expect(
      canSendRecord({ ...base, entry: voteOnBaz, peerKey: baz.selfKey }),
    ).toBe(false);
    expect(
      canSendRecord({ ...base, entry: voteOnBaz, peerKey: cy.selfKey }),
    ).toBe(false);

    const voteOnCy = await makeBanVote(ana, {
      circleId,
      target: cy.selfKey,
      vote: 'ban',
      at: 5_010,
    });
    expect(
      canSendRecord({ ...base, entry: voteOnCy, peerKey: baz.selfKey }),
    ).toBe(true);

    const relayed: StoredCircleRecord = voteOnCy;
    expect(
      canAcceptRecord({
        circleId,
        entry: relayed,
        peerKey: baz.selfKey,
        friends,
        view,
        selfKey: cy.selfKey,
      }),
    ).toBe(false);
    expect(
      canAcceptRecord({
        circleId,
        entry: relayed,
        peerKey: cy.selfKey,
        friends,
        view,
        selfKey: cy.selfKey,
      }),
    ).toBe(false);

    const planWithCy = await makePlan(ana, {
      circleId,
      rendezvousId: 'policy-r1',
      scheduledAt,
      invitees: [cy.selfKey],
      createdAt: scheduledAt - 1_000,
    });
    expect(
      canSendRecord({ ...base, entry: planWithCy, peerKey: baz.selfKey }),
    ).toBe(true);
    expect(
      canSendRecord({ ...base, entry: planWithCy, peerKey: cy.selfKey }),
    ).toBe(false);

    const outsider = await createTestIdentities(1);
    const outsiderIdentity = outsider.identities[0];
    if (!outsiderIdentity) throw new Error('outsider missing');
    const planWithOutsider = await makePlan(ana, {
      circleId,
      rendezvousId: 'policy-r2',
      scheduledAt,
      invitees: [outsiderIdentity.selfKey],
      createdAt: scheduledAt - 1_000,
    });
    expect(
      canSendRecord({ ...base, entry: planWithOutsider, peerKey: baz.selfKey }),
    ).toBe(true);
  });
});
