import { compareStrings } from './canonical';
import { collectKeptPairs, pairKey, type KeptRendezvous } from './rendezvous';
import { activePrompts } from './prompts';
import {
  dayKey,
  dayNumberFromKey,
  monthKey,
  previousDayKey,
  seasonKey,
  weekKey,
} from './time';
import type {
  CircleConfig,
  CircleConfigInput,
  CircleStats,
  KeptPair,
  MemberView,
  Prompt,
  StoredCircleRecord,
} from './types';
import {
  isCircleScopedRecord,
  recordAuthor,
  recordTimestamp,
  resolveCircleConfig,
} from './types';

function ratio(value: number, target: number, enabled: boolean): number {
  if (!enabled || target <= 0) return 0;
  return Math.min(1, Math.max(0, value / target));
}

function groupKeptPairs(pairs: readonly KeptPair[]): KeptRendezvous[] {
  const map = new Map<string, KeptRendezvous>();
  for (const pair of pairs) {
    const existing = map.get(pair.rendezvousId);
    if (existing) {
      existing.pairs.push(pair);
    } else {
      map.set(pair.rendezvousId, {
        rendezvousId: pair.rendezvousId,
        scheduledAt: pair.scheduledAt,
        pairs: [pair],
      });
    }
  }
  return [...map.values()].sort((a, b) => {
    if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt - b.scheduledAt;
    return compareStrings(a.rendezvousId, b.rendezvousId);
  });
}

function longestConsecutiveRun(days: ReadonlySet<string>): number {
  const numbers = [...days].map(dayNumberFromKey).sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  let previous: number | null = null;
  for (const number of numbers) {
    if (previous !== null && number === previous + 1) {
      run += 1;
    } else if (previous !== number) {
      run = 1;
    }
    previous = number;
    if (run > longest) longest = run;
  }
  return longest;
}

function currentDayRun(days: ReadonlySet<string>, today: string): number {
  let cursor = days.has(today) ? today : previousDayKey(today);
  let run = 0;
  while (days.has(cursor)) {
    run += 1;
    cursor = previousDayKey(cursor);
  }
  return run;
}

function nextMilestone(
  value: number,
  milestones: readonly number[],
): { target: number; complete: boolean } {
  const next = milestones.find((milestone) => milestone > value);
  if (next !== undefined) return { target: next, complete: false };
  const last = milestones[milestones.length - 1] ?? 1;
  return { target: last, complete: true };
}

/**
 * Compute the six circle ratios from the merged records and a member view.
 *
 * The input is expected to be the merged, signature-checked set. Banned
 * authors and records scoped to other circles are ignored. Plan/Attendance
 * records have no circleId; the in-circle pair test supplies their circle
 * association.
 */
export function computeCircleStats(
  records: readonly StoredCircleRecord[],
  view: MemberView,
  now: number,
  config: CircleConfigInput | CircleConfig = {},
): CircleStats {
  if (!Number.isFinite(now)) throw new Error('now must be finite');
  const resolved = resolveCircleConfig({ ...config, circleId: view.circleId });
  const memberSet = new Set(view.members);
  const bannedSet = new Set(view.banned);
  const memberCount = memberSet.size;
  const enabled = memberCount >= 2;

  const usable = records.filter((entry) => {
    const record = entry.record;
    if (bannedSet.has(recordAuthor(record))) return false;
    if (isCircleScopedRecord(record) && record.circleId !== view.circleId) return false;
    return true;
  });

  let asOf: number | null = null;
  for (const entry of usable) {
    const timestamp = recordTimestamp(entry.record);
    if (asOf === null || timestamp > asOf) asOf = timestamp;
  }

  const inCirclePairs = collectKeptPairs(usable, resolved).filter(
    (pair) => memberSet.has(pair.a) && memberSet.has(pair.b),
  );
  const kept = groupKeptPairs(inCirclePairs);

  // The pair cap is a global per-week cap. Count once across all history so a
  // week that spans a month boundary shares one cap, then derive the monthly
  // and daily-run views from the same counted set.
  const currentMonth = monthKey(now, view.timezone);
  const capCounts = new Map<string, number>();
  const countedRendezvous = new Set<string>();
  for (const rendezvous of kept) {
    if (rendezvous.pairs.length === 0) continue;

    const week = weekKey(rendezvous.scheduledAt, view.timezone);
    const capKeys = rendezvous.pairs.map((pair) => `${week}\u0000${pairKey(pair.a, pair.b)}`);
    if (
      !capKeys.some(
        (key) => (capCounts.get(key) ?? 0) < resolved.pairCapPerWeek,
      )
    ) {
      continue;
    }
    countedRendezvous.add(rendezvous.rendezvousId);
    for (const key of capKeys) {
      capCounts.set(key, (capCounts.get(key) ?? 0) + 1);
    }
  }

  const monthlyKeptValue = kept.filter(
    (rendezvous) =>
      countedRendezvous.has(rendezvous.rendezvousId) &&
      monthKey(rendezvous.scheduledAt, view.timezone) === currentMonth,
  ).length;

  const currentWeek = weekKey(now, view.timezone);
  const activeThisWeek = new Set<string>();
  for (const rendezvous of kept) {
    if (weekKey(rendezvous.scheduledAt, view.timezone) !== currentWeek) continue;
    for (const pair of rendezvous.pairs) {
      activeThisWeek.add(pair.a);
      activeThisWeek.add(pair.b);
    }
  }

  const currentSeason = seasonKey(now, view.timezone);
  const seasonPairKeys = new Set<string>();
  for (const rendezvous of kept) {
    if (seasonKey(rendezvous.scheduledAt, view.timezone) !== currentSeason) continue;
    for (const pair of rendezvous.pairs) {
      seasonPairKeys.add(pairKey(pair.a, pair.b));
    }
  }
  const totalPairs = (memberCount * (memberCount - 1)) / 2;

  const activeDays = new Set<string>();
  const promptedRendezvous = new Map<string, Set<string>>();
  for (const rendezvous of kept) {
    if (countedRendezvous.has(rendezvous.rendezvousId)) {
      activeDays.add(dayKey(rendezvous.scheduledAt, view.timezone));
    }
  }
  for (const entry of usable) {
    if (entry.record.type !== 'Attendance') continue;
    if (!memberSet.has(entry.record.attendee)) continue;
    const participants =
      promptedRendezvous.get(entry.record.rendezvousId) ?? new Set<string>();
    participants.add(entry.record.attendee);
    for (const key of entry.record.swappedWith) {
      if (memberSet.has(key)) participants.add(key);
    }
    promptedRendezvous.set(entry.record.rendezvousId, participants);
  }

  const today = dayKey(now, view.timezone);
  const run = currentDayRun(activeDays, today);
  const longestRun = longestConsecutiveRun(activeDays);

  const prompts = activePrompts(now, view.timezone);
  const dayPrompt: Prompt = prompts.day;
  const weekPrompt: Prompt = prompts.week;
  let dayCount = 0;
  let weekCount = 0;
  const weekMembers = new Set<string>();
  const seenAttendanceIds = new Set<string>();
  for (const entry of usable) {
    if (entry.record.type !== 'Attendance') continue;
    if (!memberSet.has(entry.record.attendee)) continue;
    if (seenAttendanceIds.has(entry.id)) continue;
    seenAttendanceIds.add(entry.id);
    if ((promptedRendezvous.get(entry.record.rendezvousId)?.size ?? 0) < 2) {
      continue;
    }
    if (entry.record.promptId === dayPrompt.id) dayCount += 1;
    if (entry.record.promptId === weekPrompt.id) {
      weekCount += 1;
      weekMembers.add(entry.record.attendee);
    }
  }

  const allTimeValue = kept.length;
  const milestone = nextMilestone(allTimeValue, resolved.milestones);

  return {
    circleId: view.circleId,
    name: view.name,
    timezone: view.timezone,
    asOf,
    memberCount,
    bannedCount: view.banned.length,
    monthlyKept: {
      value: monthlyKeptValue,
      target: resolved.targets.monthlyKept,
      ratio: ratio(monthlyKeptValue, resolved.targets.monthlyKept, enabled),
      counted: monthlyKeptValue,
      pairCapPerWeek: resolved.pairCapPerWeek,
    },
    weeklyParticipation: {
      value: activeThisWeek.size,
      target: memberCount,
      ratio: ratio(activeThisWeek.size, memberCount, enabled),
      activeMembers: activeThisWeek.size,
      memberCount,
    },
    seasonPairs: {
      value: seasonPairKeys.size,
      target: totalPairs,
      ratio: ratio(seasonPairKeys.size, totalPairs, enabled),
      activePairs: seasonPairKeys.size,
      totalPairs,
    },
    dailyRun: {
      value: run,
      target: resolved.targets.dailyRun,
      ratio: ratio(run, resolved.targets.dailyRun, enabled),
      longestRun,
      today,
    },
    promptStats: {
      value: weekMembers.size,
      target: memberCount,
      ratio: ratio(weekMembers.size, memberCount, enabled),
      dayPrompt,
      weekPrompt,
      dayCount,
      weekCount,
      weekMembers: weekMembers.size,
    },
    allTime: {
      value: allTimeValue,
      target: milestone.target,
      ratio: ratio(allTimeValue, milestone.target, enabled),
      nextMilestone: milestone.target,
      complete: milestone.complete,
    },
  };
}
