import { describe, expect, it } from 'vitest';
import { mergeRecords } from './merge';
import { deriveMemberView } from './membership';
import {
  activeWindowRecord,
  canonicalPlans,
  clearCircleWindow,
  createAttendanceRecord,
  createCirclePlan,
  createCircleWindow,
  planOutsideWindow,
} from './plans';
import { computeCircleStats } from './stats';
import {
  MemoryFriends,
  createTestIdentities,
  makeCircleCreated,
  makeInvite,
  makeJoin,
} from './testing';
import type { StoredCircleRecord } from './types';

const circleId = 'c-plans';
const timezone = 'Europe/Berlin';

async function membership(): Promise<{
  ana: Awaited<ReturnType<typeof createTestIdentities>>['identities'][number];
  baz: Awaited<ReturnType<typeof createTestIdentities>>['identities'][number];
  records: StoredCircleRecord[];
  view: ReturnType<typeof deriveMemberView>;
}> {
  const { identities } = await createTestIdentities(2);
  const [ana, baz] = identities;
  if (!ana || !baz) throw new Error('identities missing');
  const records: StoredCircleRecord[] = [
    await makeCircleCreated(ana, {
      circleId,
      name: 'Full moon',
      timezone,
      createdAt: 1_000,
    }),
    await makeInvite(ana, { circleId, invitee: baz.selfKey, at: 2_000 }),
    await makeJoin(baz, { circleId, at: 3_000 }),
  ];
  const view = deriveMemberView(records, ana.selfKey, new MemoryFriends(), {}, {
    circleId,
  });
  return { ana, baz, records, view };
}

function localMoment(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): number {
  // Europe/Berlin: November is UTC+1.
  return Date.UTC(year, month - 1, day, hour - 1, minute, 0, 0);
}

describe('circle plans and gathering windows', () => {
  it('signs circle-scoped plans and selects one plan per local day', async () => {
    const { ana, baz, records } = await membership();
    const first = await createCirclePlan({
      identity: ana,
      circleId,
      scheduledAt: localMoment(2026, 11, 24, 21, 30),
      invitees: [baz.selfKey],
      createdAt: 10_000,
      records,
    });
    const later = await createCirclePlan({
      identity: baz,
      circleId,
      scheduledAt: localMoment(2026, 11, 24, 22, 0),
      invitees: [ana.selfKey],
      createdAt: 11_000,
      records: [...records, first.plan],
    });
    const plans = canonicalPlans(
      [...records, later.plan, first.plan],
      circleId,
      timezone,
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]?.canonical.id).toBe(first.plan.id);
    expect(plans[0]?.plans).toHaveLength(2);
    expect(first.plan.record.type).toBe('Plan');
    if (first.plan.record.type === 'Plan') {
      expect(first.plan.record.circleId).toBe(circleId);
      expect(first.plan.record.createdAt).toBe(10_000);
    }
  });

  it('counts a canonical plan once and ignores attendance on a later plan', async () => {
    const { ana, baz, records, view } = await membership();
    const first = await createCirclePlan({
      identity: ana,
      circleId,
      scheduledAt: localMoment(2026, 11, 24, 21, 30),
      invitees: [baz.selfKey],
      createdAt: 10_000,
      records,
    });
    const later = await createCirclePlan({
      identity: baz,
      circleId,
      scheduledAt: localMoment(2026, 11, 24, 22, 30),
      invitees: [ana.selfKey],
      createdAt: 11_000,
    });
    const firstPlan = first.plan.record;
    const laterPlan = later.plan.record;
    if (firstPlan.type !== 'Plan' || laterPlan.type !== 'Plan') {
      throw new Error('plans missing');
    }
    const allRecords = [...records, first.plan, later.plan];
    const attendanceA = await createAttendanceRecord({
      identity: ana,
      rendezvousId: firstPlan.rendezvousId,
      scheduledAt: firstPlan.scheduledAt,
      joinedAt: firstPlan.scheduledAt,
      swappedWith: [baz.selfKey],
    });
    const attendanceB = await createAttendanceRecord({
      identity: baz,
      rendezvousId: firstPlan.rendezvousId,
      scheduledAt: firstPlan.scheduledAt,
      joinedAt: firstPlan.scheduledAt,
      swappedWith: [ana.selfKey],
    });
    const staleA = await createAttendanceRecord({
      identity: ana,
      rendezvousId: laterPlan.rendezvousId,
      scheduledAt: laterPlan.scheduledAt,
      joinedAt: laterPlan.scheduledAt,
      swappedWith: [baz.selfKey],
    });
    const staleB = await createAttendanceRecord({
      identity: baz,
      rendezvousId: laterPlan.rendezvousId,
      scheduledAt: laterPlan.scheduledAt,
      joinedAt: laterPlan.scheduledAt,
      swappedWith: [ana.selfKey],
    });
    const stats = computeCircleStats(
      [...allRecords, attendanceA, attendanceB, staleA, staleB],
      view,
      localMoment(2026, 11, 25, 9),
      { circleId },
    );
    expect(stats.allTime.value).toBe(1);
    expect(stats.monthlyKept.value).toBe(1);
  });

  it('rejects plans outside the window active at their signed creation time', async () => {
    const { ana, baz, records } = await membership();
    const window = await createCircleWindow({
      identity: ana,
      circleId,
      start: localMoment(2026, 11, 24, 19),
      end: localMoment(2026, 11, 24, 23),
      createdAt: 10_000,
    });
    const outside = await createCirclePlan({
      identity: ana,
      circleId,
      scheduledAt: localMoment(2026, 11, 24, 18, 30),
      invitees: [baz.selfKey],
      createdAt: 11_000,
    });
    expect(planOutsideWindow(outside.plan.record as never, [window])).toBe(true);
    const merged = await mergeRecords(
      ana,
      [...records, window],
      [outside.plan],
      { circleId },
    );
    expect(merged.added).toHaveLength(0);
    expect(merged.rejected[0]?.error).toMatch(/window/u);

    const inside = await createCirclePlan({
      identity: baz,
      circleId,
      scheduledAt: localMoment(2026, 11, 24, 21, 30),
      invitees: [ana.selfKey],
      createdAt: 12_000,
    });
    const accepted = await mergeRecords(
      baz,
      [...records, window],
      [inside.plan],
      { circleId },
    );
    expect(accepted.added).toHaveLength(1);
  });

  it('does not let a later window invalidate an earlier valid plan', async () => {
    const { ana, baz, records } = await membership();
    const window = await createCircleWindow({
      identity: ana,
      circleId,
      start: localMoment(2026, 11, 24, 19),
      end: localMoment(2026, 11, 24, 23),
      createdAt: 10_000,
    });
    const plan = await createCirclePlan({
      identity: ana,
      circleId,
      scheduledAt: localMoment(2026, 11, 24, 21, 30),
      invitees: [baz.selfKey],
      createdAt: 11_000,
    });
    const laterWindow = await createCircleWindow({
      identity: baz,
      circleId,
      start: localMoment(2026, 11, 26, 19),
      end: localMoment(2026, 11, 26, 23),
      createdAt: 12_000,
    });
    const merged = await mergeRecords(
      ana,
      [...records, window, plan.plan],
      [laterWindow],
      { circleId },
    );
    expect(merged.records.some((entry) => entry.id === plan.plan.id)).toBe(true);
  });

  it('lets a late earlier window record change the verdict, and treats a clear as unconstrained', async () => {
    const { ana, baz, records } = await membership();
    const plan = await createCirclePlan({
      identity: ana,
      circleId,
      scheduledAt: localMoment(2026, 11, 24, 18, 30),
      invitees: [baz.selfKey],
      createdAt: 11_000,
    });
    const earlyWindow = await createCircleWindow({
      identity: baz,
      circleId,
      start: localMoment(2026, 11, 24, 19),
      end: localMoment(2026, 11, 24, 23),
      createdAt: 10_000,
    });
    const merged = await mergeRecords(
      ana,
      [...records, plan.plan],
      [earlyWindow],
      { circleId },
    );
    expect(merged.added).toHaveLength(1);
    expect(merged.added[0]?.id).toBe(earlyWindow.id);
    expect(merged.removed).toContain(plan.plan.id);
    expect(merged.records.some((entry) => entry.id === plan.plan.id)).toBe(false);

    const clear = await clearCircleWindow({
      identity: ana,
      circleId,
      createdAt: 12_000,
    });
    expect(activeWindowRecord([...records, earlyWindow, clear], circleId, 12_500)?.id).toBe(
      clear.id,
    );
    const second = await createCirclePlan({
      identity: ana,
      circleId,
      scheduledAt: localMoment(2026, 11, 25, 18, 30),
      invitees: [baz.selfKey],
      createdAt: 13_000,
    });
    const accepted = await mergeRecords(
      ana,
      [...records, earlyWindow, clear],
      [second.plan],
      { circleId },
    );
    expect(accepted.added).toHaveLength(1);
  });
});
