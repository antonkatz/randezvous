import { describe, expect, it } from 'vitest';
import {
  castBanVote,
  createCircle,
  leaveCircle,
  newCircleId,
} from './lifecycle';
import { deriveMemberView } from './membership';
import { verifyStoredRecord } from './canonical';
import { MemoryFriends, createTestIdentities } from './testing';

describe('circle lifecycle', () => {
  it('creates a signed founding record with a random or supplied id', async () => {
    const { identities } = await createTestIdentities(1);
    const ana = identities[0];
    if (!ana) throw new Error('identity missing');
    const created = await createCircle({
      identity: ana,
      name: 'Sunday table',
      timezone: 'Europe/Berlin',
      createdAt: 1_000,
    });
    expect(created.circleId).toMatch(/^c_/u);
    expect(created.record.record.type).toBe('CircleCreated');
    expect(await verifyStoredRecord(ana, created.record)).toEqual({ ok: true });

    const view = deriveMemberView(
      [created.record],
      ana.selfKey,
      new MemoryFriends(),
      {},
      { circleId: created.circleId },
    );
    expect(view.members).toEqual([ana.selfKey]);
    expect(view.creator).toBe(ana.selfKey);

    const explicit = await createCircle({
      identity: ana,
      name: 'Explicit',
      timezone: 'UTC',
      createdAt: 2_000,
      circleId: 'c_explicit',
    });
    expect(explicit.circleId).toBe('c_explicit');
    expect(newCircleId()).not.toBe(newCircleId());
  });

  it('signs leave and ban-vote records but refuses a self-ban', async () => {
    const { identities } = await createTestIdentities(2);
    const [ana, baz] = identities;
    if (!ana || !baz) throw new Error('identities missing');
    const leave = await leaveCircle(ana, 'c1', 5_000);
    expect(leave.record.type).toBe('Leave');
    expect(await verifyStoredRecord(ana, leave)).toEqual({ ok: true });

    const vote = await castBanVote({
      identity: ana,
      circleId: 'c1',
      target: baz.selfKey,
      vote: 'ban',
      at: 5_100,
    });
    expect(vote.record.type).toBe('BanVote');
    expect(await verifyStoredRecord(ana, vote)).toEqual({ ok: true });
    await expect(
      castBanVote({
        identity: ana,
        circleId: 'c1',
        target: ana.selfKey,
        vote: 'ban',
        at: 5_200,
      }),
    ).rejects.toThrow(/yourself/u);
  });

  it('rejects an invalid IANA timezone before producing a record', async () => {
    const { identities } = await createTestIdentities(1);
    const ana = identities[0];
    if (!ana) throw new Error('identity missing');
    await expect(
      createCircle({
        identity: ana,
        name: 'Bad timezone',
        timezone: 'Not/AZone',
        createdAt: 1,
      }),
    ).rejects.toThrow(/timezone/u);
  });
});
