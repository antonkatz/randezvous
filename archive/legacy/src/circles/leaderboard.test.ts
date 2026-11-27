import { describe, expect, it } from 'vitest';
import { circleScore, rankCircles } from './leaderboard';
import type { CircleStats } from './types';

function makeStats(circleId: string, ratios: [number, number, number, number, number, number]): CircleStats {
  const stat = (ratio: number, target = 10) => ({
    value: ratio * target,
    target,
    ratio,
  });
  return {
    circleId,
    name: circleId,
    timezone: 'UTC',
    asOf: 1,
    memberCount: 10,
    bannedCount: 0,
    monthlyKept: { ...stat(ratios[0]), counted: 0, pairCapPerWeek: 3 },
    weeklyParticipation: {
      ...stat(ratios[1]),
      activeMembers: 0,
      memberCount: 10,
    },
    seasonPairs: { ...stat(ratios[2]), activePairs: 0, totalPairs: 45 },
    dailyRun: { ...stat(ratios[3]), longestRun: 0, today: '2026-01-01' },
    promptStats: {
      ...stat(ratios[4]),
      dayPrompt: { id: 'd', text: 'd' },
      weekPrompt: { id: 'w', text: 'w' },
      dayCount: 0,
      weekCount: 0,
      weekMembers: 0,
    },
    allTime: { ...stat(ratios[5]), nextMilestone: 100, complete: false },
  };
}

describe('circle leaderboard', () => {
  it('uses the mean of the six ratios', () => {
    const stats = makeStats('a', [1, 0, 0.5, 1, 0, 0.5]);
    expect(circleScore(stats)).toBeCloseTo(0.5);
  });

  it('lets a small, fully active circle beat a large, quiet one', () => {
    const small = makeStats('small', [1, 1, 1, 1, 1, 1]);
    const large = makeStats('large', [0.2, 0.2, 0.2, 0.2, 0.2, 0.2]);
    const ranked = rankCircles([large, small]);
    expect(ranked.map((entry) => entry.circleId)).toEqual(['small', 'large']);
    expect(ranked[0]?.score).toBe(1);
    expect(ranked[0]?.rank).toBe(1);
    expect(ranked[1]?.rank).toBe(2);
  });

  it('breaks ties by circle id and leaves the input untouched', () => {
    const first = makeStats('b', [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const second = makeStats('a', [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const input = [first, second];
    const ranked = rankCircles(input);
    expect(ranked.map((entry) => entry.circleId)).toEqual(['a', 'b']);
    expect(input).toEqual([first, second]);
    expect(ranked[0]?.stats).toBe(second);
  });

  it('clamps malformed ratios and returns an empty ranking for no circles', () => {
    const stats = makeStats('a', [2, -1, Number.NaN, 1, 1, 1]);
    expect(circleScore(stats)).toBeCloseTo((1 + 0 + 0 + 1 + 1 + 1) / 6);
    expect(rankCircles([])).toEqual([]);
  });
});
