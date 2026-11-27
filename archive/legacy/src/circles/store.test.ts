import { describe, expect, it } from 'vitest';
import { MemoryCircleStore } from './store';
import {
  createTestIdentities,
  makeCircleCreated,
  makeInvite,
} from './testing';

describe('in-memory circle store', () => {
  it('appends idempotently, loads sorted and lists circles', async () => {
    const { identities } = await createTestIdentities(2);
    const [ana, baz] = identities;
    if (!ana || !baz) throw new Error('identities missing');
    const circle = await makeCircleCreated(ana, {
      circleId: 'c1',
      name: 'C',
      timezone: 'UTC',
      createdAt: 1,
    });
    const invite = await makeInvite(ana, {
      circleId: 'c1',
      invitee: baz.selfKey,
      at: 2,
    });
    const other = await makeCircleCreated(ana, {
      circleId: 'c2',
      name: 'Other',
      timezone: 'Africa/Cairo',
      createdAt: 3,
    });

    const store = new MemoryCircleStore();
    expect(await store.load('c1')).toEqual([]);
    await store.append('c1', [invite, circle, invite]);
    await store.append('c2', [other]);
    await store.append('c2', []);

    const loaded = await store.load('c1');
    expect(loaded.map((entry) => entry.id)).toEqual(
      [circle.id, invite.id].sort(),
    );
    expect(loaded).toHaveLength(2);
    expect((await store.listCircles()).sort()).toEqual(['c1', 'c2']);
    expect(store.snapshot('c1')).toHaveLength(2);
    expect(await store.load('missing')).toEqual([]);
  });
});
