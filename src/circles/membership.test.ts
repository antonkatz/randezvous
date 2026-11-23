import { describe, expect, it } from 'vitest';
import { deriveMemberView, resolveCircleMetadata, shouldAcceptConnection } from './membership';
import {
  MemoryFriends,
  createTestIdentities,
  makeBanVote,
  makeCircleCreated,
  makeInvite,
  makeJoin,
  makeLeave,
  type TestIdentity,
} from './testing';
import type { MemberOverride, StoredCircleRecord } from './types';

const circleId = 'circle-1';

async function createCircle(creator: TestIdentity): Promise<StoredCircleRecord> {
  return makeCircleCreated(creator, {
    circleId,
    name: 'Sunday table',
    timezone: 'Europe/Berlin',
    createdAt: 1_000,
  });
}

async function addMembers(
  inviter: TestIdentity,
  members: TestIdentity[],
  startAt = 2_000,
): Promise<StoredCircleRecord[]> {
  const records: StoredCircleRecord[] = [];
  let at = startAt;
  for (const member of members) {
    records.push(
      await makeInvite(inviter, {
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
  self: TestIdentity,
  friends: MemoryFriends,
  overrides: Record<string, MemberOverride> = {},
) {
  return deriveMemberView(records, self.selfKey, friends, overrides, { circleId });
}

describe('membership chain', () => {
  it('admits a valid invite chain and exposes unconnected members', async () => {
    const { identities } = await createTestIdentities(3);
    const [ana, baz, cy] = identities;
    if (!ana || !baz || !cy) throw new Error('identities missing');

    const records = [await createCircle(ana), ...(await addMembers(ana, [baz]))];
    const bazInvite = await makeInvite(baz, {
      circleId,
      invitee: cy.selfKey,
      at: 3_000,
    });
    const cyJoin = await makeJoin(cy, { circleId, at: 3_010 });
    records.push(bazInvite, cyJoin);

    const friends = new MemoryFriends([baz.selfKey]);
    const result = view(records, ana, friends);
    expect(result.members).toEqual([ana.selfKey, baz.selfKey, cy.selfKey].sort());
    expect(result.unconnectedToYou).toEqual([cy.selfKey]);
    expect(result.creator).toBe(ana.selfKey);
    expect(result.shouldAcceptConnection(circleId, cy.selfKey)).toBe(true);
    expect(result.shouldAcceptConnection(circleId, 'stranger')).toBe(false);
    expect(shouldAcceptConnection(result, circleId, baz.selfKey)).toBe(true);
    expect(shouldAcceptConnection(result, 'other-circle', baz.selfKey)).toBe(false);
  });

  it('rejects joins without an invite or through a non-member', async () => {
    const { identities } = await createTestIdentities(3);
    const [ana, baz, cy] = identities;
    if (!ana || !baz || !cy) throw new Error('identities missing');
    const records = [
      await createCircle(ana),
      await makeJoin(baz, { circleId, at: 2_000 }),
      await makeInvite(cy, { circleId, invitee: baz.selfKey, at: 2_100 }),
      await makeJoin(baz, { circleId, at: 2_200 }),
    ];
    const result = view(records, ana, new MemoryFriends());
    expect(result.members).toEqual([ana.selfKey]);
  });

  it('requires the invite to precede the join and the inviter to still be valid', async () => {
    const { identities } = await createTestIdentities(3);
    const [ana, baz, cy] = identities;
    if (!ana || !baz || !cy) throw new Error('identities missing');
    const invite = await makeInvite(ana, {
      circleId,
      invitee: baz.selfKey,
      at: 2_500,
    });
    const earlyJoin = await makeJoin(baz, { circleId, at: 2_000 });
    expect(view([await createCircle(ana), invite, earlyJoin], ana, new MemoryFriends()).members).toEqual([
      ana.selfKey,
    ]);

    const bazInvite = await makeInvite(ana, {
      circleId,
      invitee: baz.selfKey,
      at: 2_000,
    });
    const bazJoin = await makeJoin(baz, { circleId, at: 2_100 });
    const leave = await makeLeave(baz, { circleId, at: 2_200 });
    const cyInvite = await makeInvite(baz, {
      circleId,
      invitee: cy.selfKey,
      at: 2_300,
    });
    const cyJoin = await makeJoin(cy, { circleId, at: 2_400 });
    const afterLeave = view(
      [await createCircle(ana), bazInvite, bazJoin, leave, cyInvite, cyJoin],
      ana,
      new MemoryFriends(),
    );
    expect(afterLeave.members).toEqual([ana.selfKey]);
  });

  it('removes a member on a later Leave', async () => {
    const { identities } = await createTestIdentities(2);
    const [ana, baz] = identities;
    if (!ana || !baz) throw new Error('identities missing');
    const records = [
      await createCircle(ana),
      ...(await addMembers(ana, [baz])),
      await makeLeave(baz, { circleId, at: 3_000 }),
    ];
    const result = view(records, ana, new MemoryFriends([baz.selfKey]));
    expect(result.members).toEqual([ana.selfKey]);
    expect(result.unconnectedToYou).toEqual([]);
  });

  it('picks a canonical circle creation', async () => {
    const { identities } = await createTestIdentities(1);
    const ana = identities[0];
    if (!ana) throw new Error('identity missing');
    const later = await makeCircleCreated(ana, {
      circleId,
      name: 'Later',
      timezone: 'UTC',
      createdAt: 2_000,
    });
    const earlier = await makeCircleCreated(ana, {
      circleId,
      name: 'Earlier',
      timezone: 'Africa/Cairo',
      createdAt: 1_000,
    });
    expect(resolveCircleMetadata([later, earlier], circleId)?.name).toBe('Earlier');
  });
});

describe('ban votes', () => {
  it('applies only overrides when there are fewer than two eligible friends', async () => {
    const { identities } = await createTestIdentities(4);
    const [ana, baz, target, cy] = identities;
    if (!ana || !baz || !target || !cy) throw new Error('identities missing');
    const base = [
      await createCircle(ana),
      ...(await addMembers(ana, [baz, target, cy])),
    ];
    const vote = await makeBanVote(baz, {
      circleId,
      target: target.selfKey,
      vote: 'ban',
      at: 4_000,
    });

    expect(view([...base, vote], ana, new MemoryFriends()).banned).toEqual([]);
    expect(
      view([...base, vote], ana, new MemoryFriends([baz.selfKey])).banned,
    ).toEqual([]);
    expect(
      view([...base, vote], ana, new MemoryFriends([baz.selfKey]), {
        [target.selfKey]: 'ban',
      }).banned,
    ).toEqual([target.selfKey]);
    expect(
      view([...base, vote], ana, new MemoryFriends([baz.selfKey]), {
        [target.selfKey]: 'keep',
      }).banned,
    ).toEqual([]);
  });

  it('uses max(2, floor(f/2)+1) for f = 2 and f = 3', async () => {
    const { identities } = await createTestIdentities(6);
    const [ana, baz, cy, target, e, f] = identities;
    if (!ana || !baz || !cy || !target || !e || !f) throw new Error('identities missing');
    const base = [
      await createCircle(ana),
      ...(await addMembers(ana, [baz, cy, target, e, f])),
    ];
    const twoBanVotes = [
      await makeBanVote(baz, { circleId, target: target.selfKey, vote: 'ban', at: 4_000 }),
      await makeBanVote(cy, { circleId, target: target.selfKey, vote: 'ban', at: 4_010 }),
    ];
    const f2 = new MemoryFriends([baz.selfKey, cy.selfKey]);
    expect(view([...base, ...twoBanVotes], ana, f2).banned).toEqual([target.selfKey]);

    const f3 = new MemoryFriends([baz.selfKey, cy.selfKey, target.selfKey]);
    expect(view([...base, ...twoBanVotes], ana, f3).banned).toEqual([target.selfKey]);
  });

  it('requires three of four eligible friends', async () => {
    const { identities } = await createTestIdentities(7);
    const [ana, a, b, c, d, target, outsider] = identities;
    if (!ana || !a || !b || !c || !d || !target || !outsider) {
      throw new Error('identities missing');
    }
    const base = [
      await createCircle(ana),
      ...(await addMembers(ana, [a, b, c, d, target, outsider])),
    ];
    const friends = new MemoryFriends([a.selfKey, b.selfKey, c.selfKey, d.selfKey]);
    const votes = [
      await makeBanVote(a, { circleId, target: target.selfKey, vote: 'ban', at: 4_000 }),
      await makeBanVote(b, { circleId, target: target.selfKey, vote: 'ban', at: 4_010 }),
    ];
    expect(view([...base, ...votes], ana, friends).banned).toEqual([]);
    votes.push(
      await makeBanVote(c, { circleId, target: target.selfKey, vote: 'ban', at: 4_020 }),
    );
    expect(view([...base, ...votes], ana, friends).banned).toEqual([target.selfKey]);
  });

  it('lets a local keep override beat the threshold', async () => {
    const { identities } = await createTestIdentities(6);
    const [ana, baz, cy, target, e, f] = identities;
    if (!ana || !baz || !cy || !target || !e || !f) throw new Error('identities missing');
    const base = [
      await createCircle(ana),
      ...(await addMembers(ana, [baz, cy, target, e, f])),
    ];
    const votes = [
      await makeBanVote(baz, { circleId, target: target.selfKey, vote: 'ban', at: 4_000 }),
      await makeBanVote(cy, { circleId, target: target.selfKey, vote: 'ban', at: 4_010 }),
    ];
    const result = view(
      [...base, ...votes],
      ana,
      new MemoryFriends([baz.selfKey, cy.selfKey]),
      { [target.selfKey]: 'keep' },
    );
    expect(result.banned).toEqual([]);
  });

  it('excludes override-banned voters from both f and the vote count', async () => {
    const { identities } = await createTestIdentities(6);
    const [ana, baz, cy, d, target, e] = identities;
    if (!ana || !baz || !cy || !d || !target || !e) throw new Error('identities missing');
    const base = [
      await createCircle(ana),
      ...(await addMembers(ana, [baz, cy, d, target, e])),
    ];
    const votes = [
      await makeBanVote(baz, { circleId, target: target.selfKey, vote: 'ban', at: 4_000 }),
      await makeBanVote(d, { circleId, target: target.selfKey, vote: 'ban', at: 4_010 }),
    ];
    // With d override-banned, f = 2 and only baz's vote remains, so target is kept.
    const result = view(
      [...base, ...votes],
      ana,
      new MemoryFriends([baz.selfKey, cy.selfKey, d.selfKey]),
      { [d.selfKey]: 'ban' },
    );
    expect(result.banned).toEqual([d.selfKey]);
  });

  it('lets a later unban replace an earlier ban vote', async () => {
    const { identities } = await createTestIdentities(4);
    const [ana, baz, cy, target] = identities;
    if (!ana || !baz || !cy || !target) throw new Error('identities missing');
    const base = [
      await createCircle(ana),
      ...(await addMembers(ana, [baz, cy, target])),
    ];
    const friends = new MemoryFriends([baz.selfKey, cy.selfKey]);
    const votes = [
      await makeBanVote(baz, { circleId, target: target.selfKey, vote: 'ban', at: 4_000 }),
      await makeBanVote(cy, { circleId, target: target.selfKey, vote: 'ban', at: 4_010 }),
    ];
    expect(view([...base, ...votes], ana, friends).banned).toEqual([target.selfKey]);

    votes.push(
      await makeBanVote(baz, {
        circleId,
        target: target.selfKey,
        vote: 'unban',
        at: 4_020,
      }),
    );
    expect(view([...base, ...votes], ana, friends).banned).toEqual([]);
  });

  it('denies connections to banned members', async () => {
    const { identities } = await createTestIdentities(2);
    const [ana, baz] = identities;
    if (!ana || !baz) throw new Error('identities missing');
    const records = [await createCircle(ana), ...(await addMembers(ana, [baz]))];
    const banned = view(records, ana, new MemoryFriends([baz.selfKey]), {
      [baz.selfKey]: 'ban',
    });
    expect(banned.members).toEqual([ana.selfKey]);
    expect(banned.banned).toEqual([baz.selfKey]);
    expect(banned.shouldAcceptConnection(circleId, baz.selfKey)).toBe(false);
  });
});
