import { describe, expect, it } from 'vitest';
import { mergeRecordSets, mergeRecords } from './merge';
import {
  createTestIdentities,
  makeCircleCreated,
  makeInvite,
  makeJoin,
} from './testing';
import type { CircleRecord, StoredCircleRecord } from './types';

function ids(records: readonly StoredCircleRecord[]): string[] {
  return records.map((entry) => entry.id);
}

describe('merge laws', () => {
  it('is commutative, associative and idempotent for valid sets', async () => {
    const { identities } = await createTestIdentities(3);
    const [ana, baz, cy] = identities;
    if (!ana || !baz || !cy) throw new Error('identities missing');

    const a = await makeCircleCreated(ana, {
      circleId: 'c1',
      name: 'Circle',
      timezone: 'Europe/Berlin',
      createdAt: 100,
    });
    const b = await makeInvite(ana, {
      circleId: 'c1',
      invitee: baz.selfKey,
      at: 110,
    });
    const c = await makeJoin(baz, { circleId: 'c1', at: 120 });
    const d = await makeInvite(baz, {
      circleId: 'c1',
      invitee: cy.selfKey,
      at: 130,
    });
    const e = await makeJoin(cy, { circleId: 'c1', at: 140 });

    const setA = [a, b];
    const setB = [c, d];
    const setC = [e, a];

    const ab = await mergeRecords(ana, setA, setB);
    const abC = await mergeRecords(ana, ab.records, setC);
    const bc = await mergeRecords(ana, setB, setC);
    const aBc = await mergeRecords(ana, setA, bc.records);
    const ba = await mergeRecords(ana, setB, setA);
    const cc = await mergeRecords(ana, abC.records, abC.records);

    expect(ids(abC.records)).toEqual(ids(aBc.records));
    expect(ids(ba.records)).toEqual(ids(ab.records));
    expect(ids(cc.records)).toEqual(ids(abC.records));
    expect(abC.records).toHaveLength(5);
    expect(ids(abC.records)).toEqual(expect.arrayContaining([c.id, d.id, e.id]));
  });

  it('merges an arbitrary number of sets', async () => {
    const { identities } = await createTestIdentities(2);
    const [ana, baz] = identities;
    if (!ana || !baz) throw new Error('identities missing');
    const a = await makeCircleCreated(ana, {
      circleId: 'c1',
      name: 'Circle',
      timezone: 'UTC',
      createdAt: 1,
    });
    const b = await makeInvite(ana, { circleId: 'c1', invitee: baz.selfKey, at: 2 });
    const result = await mergeRecordSets(ana, [[a], [b], []]);
    expect(result.records).toHaveLength(2);
  });

  it('keeps a deterministic record when the same content has two signatures', async () => {
    const { identities } = await createTestIdentities(1);
    const ana = identities[0];
    if (!ana) throw new Error('identity missing');
    const first = await makeCircleCreated(ana, {
      circleId: 'c1',
      name: 'Circle',
      timezone: 'UTC',
      createdAt: 1,
    });
    const second = await makeCircleCreated(ana, {
      circleId: 'c1',
      name: 'Circle',
      timezone: 'UTC',
      createdAt: 1,
    });
    expect(second.id).toBe(first.id);

    const forward = await mergeRecords(ana, [first], [second]);
    const backward = await mergeRecords(ana, [second], [first]);
    expect(forward.records).toHaveLength(1);
    expect(forward.records[0]?.record.sig).toBe(backward.records[0]?.record.sig);
  });
});

describe('merge rejection', () => {
  it('rejects a bad signature while keeping a valid record id', async () => {
    const { identities } = await createTestIdentities(1);
    const ana = identities[0];
    if (!ana) throw new Error('identity missing');
    const valid = await makeCircleCreated(ana, {
      circleId: 'c1',
      name: 'Circle',
      timezone: 'UTC',
      createdAt: 1,
    });
    const invalid: StoredCircleRecord = {
      id: valid.id,
      record: { ...valid.record, sig: `${valid.record.sig.slice(0, -2)}AA` } as CircleRecord,
    };
    const result = await mergeRecords(ana, [], [invalid]);
    expect(result.records).toHaveLength(0);
    expect(result.rejected[0]?.error).toMatch(/signature/u);
  });

  it('rejects an id that does not match the content', async () => {
    const { identities } = await createTestIdentities(1);
    const ana = identities[0];
    if (!ana) throw new Error('identity missing');
    const valid = await makeCircleCreated(ana, {
      circleId: 'c1',
      name: 'Circle',
      timezone: 'UTC',
      createdAt: 1,
    });
    const result = await mergeRecords(ana, [], [{ ...valid, id: 'wrong' }]);
    expect(result.rejected[0]?.error).toMatch(/id does not match/u);
  });

  it('rejects an unsorted swappedWith list', async () => {
    const { identities } = await createTestIdentities(2);
    const [ana, baz] = identities;
    if (!ana || !baz) throw new Error('identities missing');
    // Start from a structurally valid signed Plan, then reorder its list.
    const { signRecord } = await import('./canonical');
    const valid = await signRecord(ana, {
      type: 'Plan',
      rendezvousId: 'r1',
      scheduledAt: 100,
      organizer: ana.selfKey,
      invitees: [ana.selfKey, baz.selfKey].sort(),
    });
    const plan = valid.record as Extract<CircleRecord, { type: 'Plan' }>;
    const invalid: StoredCircleRecord = {
      id: valid.id,
      record: {
        ...plan,
        invitees: [...plan.invitees].reverse(),
      },
    };
    const result = await mergeRecords(ana, [], [invalid]);
    expect(result.records).toHaveLength(0);
    expect(result.rejected[0]?.error).toMatch(/sorted/u);
  });

  it('rejects a circle-scoped record from a different circle', async () => {
    const { identities } = await createTestIdentities(1);
    const ana = identities[0];
    if (!ana) throw new Error('identity missing');
    const other = await makeCircleCreated(ana, {
      circleId: 'other',
      name: 'Other',
      timezone: 'UTC',
      createdAt: 1,
    });
    const result = await mergeRecords(ana, [], [other], { circleId: 'c1' });
    expect(result.rejected[0]?.error).toMatch(/another circle/u);
  });
});
