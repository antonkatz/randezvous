import { describe, expect, it } from 'vitest';
import {
  collectInCirclePairs,
  collectKeptPairs,
  collectKeptRendezvous,
  correctedNow,
  estimateClock,
  estimateClockOffset,
  isKeptPair,
  isWithinWindow,
  shouldSign,
} from './rendezvous';
import {
  createTestIdentities,
  makeAttendance,
  type TestIdentity,
} from './testing';
import type { AttendanceRecord, StoredCircleRecord } from './types';

const scheduledAt = 1_700_000_000_000;
const minute = 60_000;

function asAttendance(entry: StoredCircleRecord): AttendanceRecord {
  if (entry.record.type !== 'Attendance') throw new Error('not attendance');
  return entry.record;
}

async function attendanceFor(
  identity: TestIdentity,
  swappedWith: string[],
  joinedAt: number,
  id = 'r-1',
): Promise<StoredCircleRecord> {
  return makeAttendance(identity, {
    rendezvousId: id,
    scheduledAt,
    joinedAt,
    swappedWith,
  });
}

describe('rendezvous window', () => {
  it('accepts T-5:00 and T+5:00, and rejects beyond the tolerance without skew', () => {
    expect(isWithinWindow(scheduledAt - 5 * minute, scheduledAt, { skewMs: 0 })).toBe(true);
    expect(isWithinWindow(scheduledAt + 5 * minute, scheduledAt, { skewMs: 0 })).toBe(true);
    expect(isWithinWindow(scheduledAt - 5 * minute - 1, scheduledAt, { skewMs: 0 })).toBe(
      false,
    );
    expect(isWithinWindow(scheduledAt + 5 * minute + 1, scheduledAt, { skewMs: 0 })).toBe(
      false,
    );
  });

  it('applies the ±30s skew at every edge', () => {
    const near = scheduledAt - 5 * minute - 1;
    const far = scheduledAt + 5 * minute + 1;
    expect(isWithinWindow(near, scheduledAt, { skewMs: 30_000 })).toBe(true);
    expect(isWithinWindow(far, scheduledAt, { skewMs: 30_000 })).toBe(true);
    expect(isWithinWindow(scheduledAt - 5 * minute - 30_000, scheduledAt)).toBe(true);
    expect(isWithinWindow(scheduledAt + 5 * minute + 30_000, scheduledAt)).toBe(true);
    expect(isWithinWindow(scheduledAt + 5 * minute + 30_001, scheduledAt)).toBe(false);
  });

  it('counts a transfer finishing just after the nominal window only within skew', () => {
    expect(isWithinWindow(scheduledAt + 5 * minute + 1, scheduledAt, { skewMs: 0 })).toBe(
      false,
    );
    expect(isWithinWindow(scheduledAt + 5 * minute + 1, scheduledAt)).toBe(true);
    expect(isWithinWindow(scheduledAt + 5 * minute + 30_001, scheduledAt)).toBe(false);
  });

  it('requires both sides of a pair to be inside the window', async () => {
    const { identities } = await createTestIdentities(2);
    const [ana, baz] = identities;
    if (!ana || !baz) throw new Error('identities missing');
    const a = await attendanceFor(ana, [baz.selfKey], scheduledAt);
    const b = await attendanceFor(baz, [ana.selfKey], scheduledAt + 5 * minute + 1);
    expect(isKeptPair(asAttendance(a), asAttendance(b), { skewMs: 0 })).toBe(false);
    expect(isKeptPair(asAttendance(a), asAttendance(b))).toBe(true);

    const c = await attendanceFor(baz, [ana.selfKey], scheduledAt + 5 * minute + 30_001);
    expect(isKeptPair(asAttendance(a), asAttendance(c))).toBe(false);
  });

  it('does not keep a one-sided attendance', async () => {
    const { identities } = await createTestIdentities(2);
    const [ana, baz] = identities;
    if (!ana || !baz) throw new Error('identities missing');
    const a = await attendanceFor(ana, [baz.selfKey], scheduledAt);
    const b = await attendanceFor(baz, [], scheduledAt);
    expect(isKeptPair(asAttendance(a), asAttendance(b))).toBe(false);
    expect(collectKeptPairs([a, b])).toEqual([]);
  });

  it('does not pair attendances that disagree about scheduledAt', async () => {
    const { identities } = await createTestIdentities(2);
    const [ana, baz] = identities;
    if (!ana || !baz) throw new Error('identities missing');
    const a = await attendanceFor(ana, [baz.selfKey], scheduledAt);
    const b = await makeAttendance(baz, {
      rendezvousId: 'r-1',
      scheduledAt: scheduledAt + 1,
      joinedAt: scheduledAt + 1,
      swappedWith: [ana.selfKey],
    });
    expect(collectKeptPairs([a, b])).toEqual([]);
  });

  it('counts a five-person swap once for volume and fills every pair', async () => {
    const { identities } = await createTestIdentities(5);
    const keys = identities.map((identity) => identity.selfKey);
    const records: StoredCircleRecord[] = [];
    for (const identity of identities) {
      const others = keys.filter((key) => key !== identity.selfKey);
      records.push(await attendanceFor(identity, others, scheduledAt));
    }
    const pairs = collectKeptPairs(records);
    expect(pairs).toHaveLength(10);
    const rendezvous = collectKeptRendezvous(records);
    expect(rendezvous).toHaveLength(1);
    expect(rendezvous[0]?.pairs).toHaveLength(10);
    expect(
      collectInCirclePairs(records, new Set(keys.slice(0, 4))),
    ).toHaveLength(6);
  });
});

describe('signing guard and clock estimate', () => {
  it('signs only while the corrected clock agrees with joinedAt within skew', () => {
    expect(shouldSign({ joinedAt: 1_000 }, 1_000)).toBe(true);
    expect(shouldSign({ joinedAt: 1_000 }, 31_000, { skewMs: 30_000 })).toBe(true);
    expect(shouldSign({ joinedAt: 1_000 }, 31_001, { skewMs: 30_000 })).toBe(false);
    expect(shouldSign({ joinedAt: 1_000 }, -29_000, { skewMs: 30_000 })).toBe(true);
    expect(shouldSign({ joinedAt: 1_000 }, -29_001, { skewMs: 30_000 })).toBe(false);

    const offset = estimateClockOffset([{ t1: 1_000, t2: 1_150, t3: 1_150, t4: 1_200 }]);
    expect(offset).toBe(50);
    expect(shouldSign({ joinedAt: 1_050 }, correctedNow(1_000, offset))).toBe(true);
  });

  it('implements the four-timestamp NTP formula', () => {
    const estimate = estimateClock([{ t1: 1_000, t2: 1_100, t3: 1_100, t4: 1_200 }]);
    expect(estimate.offsetMs).toBe(0);
    expect(estimate.delayMs).toBe(200);
    expect(estimate.samples).toBe(1);

    const ahead = estimateClockOffset([{ t1: 1_000, t2: 1_150, t3: 1_150, t4: 1_200 }]);
    expect(ahead).toBe(50);
  });

  it('chooses the lowest-delay sample and tolerates bad samples', () => {
    const fast = { t1: 10_000, t2: 10_005, t3: 10_005, t4: 10_010 };
    const slow = { t1: 10_000, t2: 10_500, t3: 10_500, t4: 10_200 };
    const estimate = estimateClock([slow, fast]);
    expect(estimate.delayMs).toBe(10);
    expect(estimate.offsetMs).toBe(0);
    expect(estimate.samples).toBe(2);
    expect(estimateClockOffset([])).toBe(0);
    expect(estimateClockOffset([{ t1: 10, t2: 20, t3: 20, t4: 5 }])).toBe(0);
  });
});
