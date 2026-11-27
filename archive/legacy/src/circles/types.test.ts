import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CIRCLE_CONFIG,
  DEFAULT_DAILY_RUN_TARGET,
  DEFAULT_MILESTONES,
  DEFAULT_MONTHLY_KEPT_TARGET,
  DEFAULT_PAIR_CAP_PER_WEEK,
  DEFAULT_SKEW_MS,
  DEFAULT_WINDOW_MS,
  defaultBanThreshold,
  isCircleScopedRecord,
  isRendezvousRecord,
  recordAuthor,
  recordTimestamp,
  resolveCircleConfig,
} from './types';
import {
  createTestIdentities,
  makeAttendance,
  makeBanVote,
  makeCircleCreated,
  makeInvite,
  makeJoin,
  makeLeave,
  makePlan,
  type TestIdentity,
} from './testing';

describe('circle configuration', () => {
  it('ships the documented defaults', () => {
    expect(DEFAULT_WINDOW_MS).toBe(5 * 60_000);
    expect(DEFAULT_SKEW_MS).toBe(30_000);
    expect(DEFAULT_PAIR_CAP_PER_WEEK).toBe(3);
    expect(DEFAULT_MONTHLY_KEPT_TARGET).toBe(20);
    expect(DEFAULT_DAILY_RUN_TARGET).toBe(14);
    expect(DEFAULT_MILESTONES).toEqual([100, 250, 500, 1000]);
    expect(defaultBanThreshold(0)).toBe(2);
    expect(defaultBanThreshold(1)).toBe(2);
    expect(defaultBanThreshold(2)).toBe(2);
    expect(defaultBanThreshold(3)).toBe(2);
    expect(defaultBanThreshold(4)).toBe(3);
    expect(defaultBanThreshold(5)).toBe(3);
    expect(defaultBanThreshold(6)).toBe(4);
  });

  it('resolves partial input without mutating defaults', () => {
    const resolved = resolveCircleConfig({
      circleId: 'c1',
      windowMs: 60_000,
      targets: { dailyRun: 30 },
      milestones: [2, 4],
      banThreshold: () => 1,
    });
    expect(resolved.windowMs).toBe(60_000);
    expect(resolved.skewMs).toBe(DEFAULT_SKEW_MS);
    expect(resolved.pairCapPerWeek).toBe(DEFAULT_PAIR_CAP_PER_WEEK);
    expect(resolved.targets.monthlyKept).toBe(DEFAULT_MONTHLY_KEPT_TARGET);
    expect(resolved.targets.dailyRun).toBe(30);
    expect(resolved.milestones).toEqual([2, 4]);
    expect(DEFAULT_CIRCLE_CONFIG.targets.dailyRun).toBe(DEFAULT_DAILY_RUN_TARGET);
  });

  it('rejects invalid numbers, milestones and thresholds', () => {
    expect(() => resolveCircleConfig({ windowMs: -1 })).toThrow(/windowMs/u);
    expect(() => resolveCircleConfig({ pairCapPerWeek: 0 })).toThrow(/pairCap/u);
    expect(() => resolveCircleConfig({ milestones: [] })).toThrow(/milestones/u);
    expect(() => resolveCircleConfig({ milestones: [5, 2] })).toThrow(/ascending/u);
    expect(() => resolveCircleConfig({ banThreshold: () => 0 })).toThrow(/banThreshold/u);
  });
});

describe('record helpers', () => {
  it('identifies authors and timestamps for every record type', async () => {
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
    const join = await makeJoin(baz, { circleId: 'c1', at: 3 });
    const leave = await makeLeave(baz, { circleId: 'c1', at: 4 });
    const vote = await makeBanVote(ana, {
      circleId: 'c1',
      target: baz.selfKey,
      vote: 'ban',
      at: 5,
    });
    const plan = await makePlan(ana, {
      circleId: 'c-test',
      rendezvousId: 'r1',
      scheduledAt: 6,
      invitees: [baz.selfKey],
      createdAt: 6,
    });
    const attendance = await makeAttendance(baz, {
      rendezvousId: 'r1',
      scheduledAt: 7,
      joinedAt: 8,
      swappedWith: [ana.selfKey],
    });

    expect(recordAuthor(circle.record)).toBe(ana.selfKey);
    expect(recordAuthor(invite.record)).toBe(ana.selfKey);
    expect(recordAuthor(join.record)).toBe(baz.selfKey);
    expect(recordAuthor(leave.record)).toBe(baz.selfKey);
    expect(recordAuthor(vote.record)).toBe(ana.selfKey);
    expect(recordAuthor(plan.record)).toBe(ana.selfKey);
    expect(recordAuthor(attendance.record)).toBe(baz.selfKey);

    expect(recordTimestamp(circle.record)).toBe(1);
    expect(recordTimestamp(invite.record)).toBe(2);
    expect(recordTimestamp(join.record)).toBe(3);
    expect(recordTimestamp(leave.record)).toBe(4);
    expect(recordTimestamp(vote.record)).toBe(5);
    expect(recordTimestamp(plan.record)).toBe(6);
    expect(recordTimestamp(attendance.record)).toBe(8);
  });

  it('distinguishes circle-scoped and rendezvous records', async () => {
    const identity = (await createTestIdentities(1)).identities[0];
    if (!identity) throw new Error('identity missing');
    const plan = await makePlan(identity, {
      circleId: 'c-test',
      rendezvousId: 'r1',
      scheduledAt: 1,
      invitees: [],
      createdAt: 0,
    });
    const circle = await makeCircleCreated(identity, {
      circleId: 'c1',
      name: 'C',
      timezone: 'UTC',
      createdAt: 1,
    });
    expect(isRendezvousRecord(plan.record)).toBe(true);
    expect(isCircleScopedRecord(plan.record)).toBe(true);
    expect(isCircleScopedRecord(circle.record)).toBe(true);
    expect(isRendezvousRecord(circle.record)).toBe(false);
  });
});
