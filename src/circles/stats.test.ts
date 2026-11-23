import { describe, expect, it } from 'vitest';
import { computeCircleStats } from './stats';
import { deriveMemberView } from './membership';
import { activePrompts } from './prompts';
import {
  MemoryFriends,
  createTestIdentities,
  makeAttendance,
  makeCircleCreated,
  makeInvite,
  makeJoin,
  type TestIdentity,
} from './testing';
import type {
  MemberOverride,
  MemberView,
  StoredCircleRecord,
} from './types';

const at = (iso: string): number => Date.parse(iso);

interface World {
  identities: TestIdentity[];
  creator: TestIdentity;
  members: TestIdentity[];
  circleId: string;
  timezone: string;
  records: StoredCircleRecord[];
  view: MemberView;
  friends: MemoryFriends;
}

async function makeWorld(options: {
  count: number;
  identities?: TestIdentity[];
  circleId?: string;
  timezone?: string;
  createdAt?: number;
  overrides?: Record<string, MemberOverride>;
}): Promise<World> {
  const identities =
    options.identities ?? (await createTestIdentities(options.count)).identities;
  const creator = identities[0];
  if (!creator) throw new Error('creator missing');
  const members = identities.slice(1);
  const circleId = options.circleId ?? 'circle-1';
  const timezone = options.timezone ?? 'UTC';
  const createdAt = options.createdAt ?? 1_000;
  const records: StoredCircleRecord[] = [
    await makeCircleCreated(creator, {
      circleId,
      name: 'Sunday table',
      timezone,
      createdAt,
    }),
  ];
  let eventAt = createdAt + 1_000;
  for (const member of members) {
    records.push(
      await makeInvite(creator, {
        circleId,
        invitee: member.selfKey,
        at: eventAt,
      }),
    );
    eventAt += 10;
    records.push(await makeJoin(member, { circleId, at: eventAt }));
    eventAt += 10;
  }

  const friends = new MemoryFriends(members.map((member) => member.selfKey));
  const view = deriveMemberView(
    records,
    creator.selfKey,
    friends,
    options.overrides ?? {},
    { circleId },
  );
  return {
    identities,
    creator,
    members,
    circleId,
    timezone,
    records,
    view,
    friends,
  };
}

async function swap(
  first: TestIdentity,
  second: TestIdentity,
  input: {
    rendezvousId: string;
    scheduledAt: number;
    joinedAt?: number;
    firstPrompt?: string | null;
    secondPrompt?: string | null;
  },
): Promise<StoredCircleRecord[]> {
  return [
    await makeAttendance(first, {
      rendezvousId: input.rendezvousId,
      scheduledAt: input.scheduledAt,
      joinedAt: input.joinedAt ?? input.scheduledAt,
      swappedWith: [second.selfKey],
      promptId: input.firstPrompt ?? null,
    }),
    await makeAttendance(second, {
      rendezvousId: input.rendezvousId,
      scheduledAt: input.scheduledAt,
      joinedAt: input.joinedAt ?? input.scheduledAt,
      swappedWith: [first.selfKey],
      promptId: input.secondPrompt ?? null,
    }),
  ];
}

async function groupSwap(
  participants: TestIdentity[],
  rendezvousId: string,
  scheduledAt: number,
): Promise<StoredCircleRecord[]> {
  const records: StoredCircleRecord[] = [];
  for (const participant of participants) {
    records.push(
      await makeAttendance(participant, {
        rendezvousId,
        scheduledAt,
        joinedAt: scheduledAt,
        swappedWith: participants
          .filter((other) => other.selfKey !== participant.selfKey)
          .map((other) => other.selfKey),
      }),
    );
  }
  return records;
}

describe('circle stats', () => {
  it('uses the scheduled day, not the day the swap finished', async () => {
    const world = await makeWorld({ count: 2 });
    const [ana, baz] = world.identities;
    if (!ana || !baz) throw new Error('identities missing');
    const scheduledAt = at('2026-11-22T23:58:00Z');
    const joinedAt = at('2026-11-23T00:02:00Z');
    const records = [
      ...world.records,
      ...(await swap(ana, baz, { rendezvousId: 'r-late', scheduledAt, joinedAt })),
    ];
    const stats = computeCircleStats(records, world.view, at('2026-11-24T12:00:00Z'));
    expect(stats.monthlyKept.value).toBe(1);
    expect(stats.allTime.value).toBe(1);
    // The rendezvous belongs to 22 Nov. On 24 Nov neither today nor yesterday
    // has a rendezvous, so the run is broken even though it finished on the 23rd.
    expect(stats.dailyRun.value).toBe(0);
    expect(stats.asOf).toBe(joinedAt);
  });

  it('counts the same rendezvous in two circles', async () => {
    const first = await makeWorld({ count: 2, circleId: 'c-utc', timezone: 'UTC' });
    const second = await makeWorld({
      identities: first.identities,
      count: 2,
      circleId: 'c-la',
      timezone: 'America/Los_Angeles',
    });
    const [ana, baz] = first.identities;
    if (!ana || !baz) throw new Error('identities missing');
    const scheduledAt = at('2026-11-22T23:58:00Z');
    const swapRecords = await swap(ana, baz, { rendezvousId: 'shared', scheduledAt });
    const all = [...first.records, ...second.records, ...swapRecords];
    const firstView = deriveMemberView(
      all,
      ana.selfKey,
      first.friends,
      {},
      { circleId: 'c-utc' },
    );
    const secondView = deriveMemberView(
      all,
      ana.selfKey,
      second.friends,
      {},
      { circleId: 'c-la' },
    );
    const now = at('2026-11-23T12:00:00Z');
    const a = computeCircleStats(all, firstView, now);
    const b = computeCircleStats(all, secondView, now);
    expect(a.monthlyKept.value).toBe(1);
    expect(b.monthlyKept.value).toBe(1);
    expect(a.allTime.value).toBe(1);
    expect(b.allTime.value).toBe(1);
    expect(a.seasonPairs.value).toBe(1);
    expect(b.seasonPairs.value).toBe(1);
  });

  it('caps a pair at three counted rendezvous per week and resets weekly', async () => {
    const world = await makeWorld({ count: 2 });
    const [ana, baz] = world.identities;
    if (!ana || !baz) throw new Error('identities missing');
    const records = [...world.records];
    const days = [
      '2026-11-16T12:00:00Z',
      '2026-11-17T12:00:00Z',
      '2026-11-18T12:00:00Z',
      '2026-11-19T12:00:00Z',
    ];
    for (let index = 0; index < days.length; index += 1) {
      records.push(
        ...(await swap(ana, baz, {
          rendezvousId: `capped-${index}`,
          scheduledAt: at(days[index] ?? ''),
        })),
      );
    }
    const stats = computeCircleStats(records, world.view, at('2026-11-22T12:00:00Z'));
    expect(stats.monthlyKept.value).toBe(3);
    expect(stats.allTime.value).toBe(4);
    // The fourth rendezvous in the same week is over the pair cap, so it is
    // not a counted day for the daily run either.
    expect(stats.dailyRun.longestRun).toBe(3);

    records.push(
      ...(await swap(ana, baz, {
        rendezvousId: 'next-week',
        scheduledAt: at('2026-11-23T12:00:00Z'),
      })),
    );
    const nextWeek = computeCircleStats(
      records,
      world.view,
      at('2026-11-23T18:00:00Z'),
    );
    expect(nextWeek.monthlyKept.value).toBe(4);
    expect(nextWeek.allTime.value).toBe(5);
  });

  it('shares one weekly pair cap across a month boundary', async () => {
    const world = await makeWorld({ count: 2 });
    const [ana, baz] = world.identities;
    if (!ana || !baz) throw new Error('identities missing');
    const records = [...world.records];
    const days = [
      '2026-03-31T12:00:00Z',
      '2026-04-01T12:00:00Z',
      '2026-04-02T12:00:00Z',
      '2026-04-03T12:00:00Z',
    ];
    for (let index = 0; index < days.length; index += 1) {
      records.push(
        ...(await swap(ana, baz, {
          rendezvousId: `boundary-${index}`,
          scheduledAt: at(days[index] ?? ''),
        })),
      );
    }
    const stats = computeCircleStats(records, world.view, at('2026-04-03T18:00:00Z'));
    // Mar 31 + Apr 1 + Apr 2 consume the single week's cap; Apr 3 does not
    // count. April therefore has two counted rendezvous, not three.
    expect(stats.monthlyKept.value).toBe(2);
    expect(stats.allTime.value).toBe(4);
    expect(stats.dailyRun.value).toBe(3);
    expect(stats.dailyRun.longestRun).toBe(3);
  });

  it('counts a five-person swap once for volume and fills every season pair', async () => {
    const world = await makeWorld({ count: 5 });
    const scheduledAt = at('2026-11-20T12:00:00Z');
    const records = [
      ...world.records,
      ...(await groupSwap(world.identities, 'group', scheduledAt)),
    ];
    const stats = computeCircleStats(records, world.view, at('2026-11-22T12:00:00Z'));
    expect(stats.monthlyKept.value).toBe(1);
    expect(stats.allTime.value).toBe(1);
    expect(stats.seasonPairs.value).toBe(10);
    expect(stats.seasonPairs.target).toBe(10);
    expect(stats.seasonPairs.ratio).toBe(1);
    expect(stats.weeklyParticipation.value).toBe(5);
    expect(stats.weeklyParticipation.ratio).toBe(1);
  });

  it('runs through a DST change and respects the circle timezone boundary', async () => {
    const world = await makeWorld({
      count: 2,
      timezone: 'America/New_York',
    });
    const [ana, baz] = world.identities;
    if (!ana || !baz) throw new Error('identities missing');
    const records = [...world.records];
    const localDays = [
      '2026-03-07T12:00:00-05:00',
      '2026-03-08T12:00:00-04:00',
      '2026-03-09T12:00:00-04:00',
    ];
    for (let index = 0; index < localDays.length; index += 1) {
      records.push(
        ...(await swap(ana, baz, {
          rendezvousId: `dst-${index}`,
          scheduledAt: at(localDays[index] ?? ''),
        })),
      );
    }
    const stats = computeCircleStats(
      records,
      world.view,
      at('2026-03-10T12:00:00Z'),
    );
    expect(stats.dailyRun.value).toBe(3);
    expect(stats.dailyRun.longestRun).toBe(3);

    // Same instant, two timezone views: Tokyo sees yesterday, Los Angeles
    // sees a rendezvous two days ago by the chosen now.
    const tokyo = await makeWorld({
      count: 2,
      circleId: 'c-tokyo',
      timezone: 'Asia/Tokyo',
    });
    const la = await makeWorld({
      count: 2,
      circleId: 'c-la',
      timezone: 'America/Los_Angeles',
    });
    const scheduledAt = at('2026-01-01T00:30:00Z');
    const tokyoAna = tokyo.identities[0];
    const tokyoBaz = tokyo.identities[1];
    const laAna = la.identities[0];
    const laBaz = la.identities[1];
    if (!tokyoAna || !tokyoBaz || !laAna || !laBaz) {
      throw new Error('timezone identities missing');
    }
    const tokyoAll = [
      ...tokyo.records,
      ...(await swap(tokyoAna, tokyoBaz, {
        rendezvousId: 'timezone-boundary',
        scheduledAt,
      })),
    ];
    const laAll = [
      ...la.records,
      ...(await swap(laAna, laBaz, {
        rendezvousId: 'timezone-boundary',
        scheduledAt,
      })),
    ];
    const tokyoView = deriveMemberView(
      tokyoAll,
      tokyoAna.selfKey,
      tokyo.friends,
      {},
      { circleId: 'c-tokyo' },
    );
    const laView = deriveMemberView(laAll, laAna.selfKey, la.friends, {}, {
      circleId: 'c-la',
    });
    const now = at('2026-01-02T12:00:00Z');
    expect(computeCircleStats(tokyoAll, tokyoView, now).dailyRun.value).toBe(1);
    expect(computeCircleStats(laAll, laView, now).dailyRun.value).toBe(0);
  });

  it('resets monthly and seasonal windows while keeping all-time volume', async () => {
    const world = await makeWorld({ count: 2 });
    const [ana, baz] = world.identities;
    if (!ana || !baz) throw new Error('identities missing');
    const records = [
      ...world.records,
      ...(await swap(ana, baz, {
        rendezvousId: 'march',
        scheduledAt: at('2026-03-31T12:00:00Z'),
      })),
      ...(await swap(ana, baz, {
        rendezvousId: 'april',
        scheduledAt: at('2026-04-01T12:00:00Z'),
      })),
    ];
    const april = computeCircleStats(records, world.view, at('2026-04-01T18:00:00Z'));
    expect(april.monthlyKept.value).toBe(1);
    expect(april.seasonPairs.value).toBe(1);
    expect(april.allTime.value).toBe(2);
    expect(april.weeklyParticipation.value).toBe(2);

    const march = computeCircleStats(records, world.view, at('2026-03-31T18:00:00Z'));
    expect(march.monthlyKept.value).toBe(1);
    expect(march.seasonPairs.value).toBe(1);
    expect(march.allTime.value).toBe(2);
  });

  it('does not count yesterday as part of a broken daily run and reports the longest', async () => {
    const world = await makeWorld({ count: 2 });
    const [ana, baz] = world.identities;
    if (!ana || !baz) throw new Error('identities missing');
    const records = [
      ...world.records,
      ...(await swap(ana, baz, {
        rendezvousId: 'old',
        scheduledAt: at('2026-11-20T12:00:00Z'),
      })),
    ];
    const stale = computeCircleStats(records, world.view, at('2026-11-23T12:00:00Z'));
    expect(stale.dailyRun.value).toBe(0);
    expect(stale.dailyRun.longestRun).toBe(1);

    records.push(
      ...(await swap(ana, baz, {
        rendezvousId: 'yesterday',
        scheduledAt: at('2026-11-22T12:00:00Z'),
      })),
    );
    const yesterday = computeCircleStats(
      records,
      world.view,
      at('2026-11-23T12:00:00Z'),
    );
    expect(yesterday.dailyRun.value).toBe(1);
  });

  it('reaches the next all-time milestone and clamps at the top', async () => {
    const world = await makeWorld({ count: 2 });
    const [ana, baz] = world.identities;
    if (!ana || !baz) throw new Error('identities missing');
    const records = [...world.records];
    for (let index = 0; index < 5; index += 1) {
      records.push(
        ...(await swap(ana, baz, {
          rendezvousId: `milestone-${index}`,
          scheduledAt: at('2026-11-10T12:00:00Z') + index * 60_000,
        })),
      );
    }
    const stats = computeCircleStats(records, world.view, at('2026-11-22T12:00:00Z'), {
      milestones: [2, 5, 10],
    });
    expect(stats.allTime.value).toBe(5);
    expect(stats.allTime.target).toBe(10);
    expect(stats.allTime.complete).toBe(false);
    expect(stats.allTime.ratio).toBeCloseTo(0.5);

    for (let index = 5; index < 10; index += 1) {
      records.push(
        ...(await swap(ana, baz, {
          rendezvousId: `milestone-${index}`,
          scheduledAt: at('2026-11-10T12:00:00Z') + index * 60_000,
        })),
      );
    }
    const top = computeCircleStats(records, world.view, at('2026-11-22T12:00:00Z'), {
      milestones: [2, 5, 10],
    });
    expect(top.allTime.value).toBe(10);
    expect(top.allTime.target).toBe(10);
    expect(top.allTime.complete).toBe(true);
    expect(top.allTime.ratio).toBe(1);

    const defaultStats = computeCircleStats(
      records,
      world.view,
      at('2026-11-22T12:00:00Z'),
    );
    expect(defaultStats.allTime.nextMilestone).toBe(100);
    expect(defaultStats.allTime.ratio).toBeCloseTo(10 / 100);
  });

  it('counts active prompts and distinct weekly prompt members', async () => {
    const world = await makeWorld({ count: 3 });
    const [ana, baz, cy] = world.identities;
    if (!ana || !baz || !cy) throw new Error('identities missing');
    const now = at('2026-11-22T12:00:00Z');
    const prompts = activePrompts(now, world.timezone);
    const records = [
      ...world.records,
      ...(await swap(ana, baz, {
        rendezvousId: 'prompt-day',
        scheduledAt: at('2026-11-21T12:00:00Z'),
        firstPrompt: prompts.day.id,
        secondPrompt: prompts.day.id,
      })),
      ...(await swap(ana, cy, {
        rendezvousId: 'prompt-week',
        scheduledAt: at('2026-11-20T12:00:00Z'),
        firstPrompt: prompts.week.id,
        secondPrompt: prompts.week.id,
      })),
      ...(await swap(baz, cy, {
        rendezvousId: 'prompt-week-2',
        scheduledAt: at('2026-11-19T12:00:00Z'),
        firstPrompt: prompts.week.id,
        secondPrompt: prompts.week.id,
      })),
    ];
    const stats = computeCircleStats(records, world.view, now);
    expect(stats.promptStats.dayPrompt).toEqual(prompts.day);
    expect(stats.promptStats.weekPrompt).toEqual(prompts.week);
    expect(stats.promptStats.dayCount).toBe(2);
    expect(stats.promptStats.weekCount).toBe(4);
    expect(stats.promptStats.weekMembers).toBe(3);
    expect(stats.promptStats.value).toBe(3);
    expect(stats.promptStats.ratio).toBe(1);
  });

  it('ignores a banned member and their past records', async () => {
    const world = await makeWorld({ count: 2 });
    const [ana, baz] = world.identities;
    if (!ana || !baz) throw new Error('identities missing');
    const scheduledAt = at('2026-11-20T12:00:00Z');
    const records = [
      ...world.records,
      ...(await swap(ana, baz, { rendezvousId: 'before-ban', scheduledAt })),
    ];
    const bannedView = deriveMemberView(
      records,
      ana.selfKey,
      world.friends,
      { [baz.selfKey]: 'ban' },
      { circleId: world.circleId },
    );
    const stats = computeCircleStats(records, bannedView, at('2026-11-22T12:00:00Z'));
    expect(stats.memberCount).toBe(1);
    expect(stats.bannedCount).toBe(1);
    expect(stats.monthlyKept.value).toBe(0);
    expect(stats.allTime.value).toBe(0);
    expect(stats.weeklyParticipation.ratio).toBe(0);
    expect(stats.seasonPairs.ratio).toBe(0);
    expect(stats.dailyRun.ratio).toBe(0);
    expect(stats.promptStats.ratio).toBe(0);
    expect(stats.allTime.ratio).toBe(0);
    expect(stats.asOf).toBe(scheduledAt);
  });

  it('returns zero ratios rather than NaN for a one-member circle', async () => {
    const world = await makeWorld({ count: 1 });
    const stats = computeCircleStats(
      world.records,
      world.view,
      at('2026-11-22T12:00:00Z'),
    );
    expect(stats.memberCount).toBe(1);
    expect(stats.weeklyParticipation.ratio).toBe(0);
    expect(stats.seasonPairs.ratio).toBe(0);
    expect(stats.promptStats.ratio).toBe(0);
    expect(stats.monthlyKept.ratio).toBe(0);
    expect(stats.dailyRun.ratio).toBe(0);
    expect(stats.allTime.ratio).toBe(0);
    expect(stats.monthlyKept.ratio).not.toBeNaN();
  });

  it('is deterministic for identical inputs', async () => {
    const world = await makeWorld({ count: 3 });
    const [ana, baz, cy] = world.identities;
    if (!ana || !baz || !cy) throw new Error('identities missing');
    const records = [
      ...world.records,
      ...(await swap(ana, baz, {
        rendezvousId: 'stable',
        scheduledAt: at('2026-11-20T12:00:00Z'),
      })),
    ];
    const now = at('2026-11-22T12:00:00Z');
    expect(computeCircleStats(records, world.view, now)).toEqual(
      computeCircleStats(records, world.view, now),
    );
  });
});
