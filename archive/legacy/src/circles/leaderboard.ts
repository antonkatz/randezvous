import { compareStrings } from './canonical';
import type { CircleStats } from './types';

export interface RankedCircle {
  rank: number;
  circleId: string;
  /** Mean of the six locally computed ratios, clamped to [0, 1]. */
  score: number;
  stats: CircleStats;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function circleScore(stats: CircleStats): number {
  const ratios = [
    stats.monthlyKept.ratio,
    stats.weeklyParticipation.ratio,
    stats.seasonPairs.ratio,
    stats.dailyRun.ratio,
    stats.promptStats.ratio,
    stats.allTime.ratio,
  ];
  return ratios.reduce((sum, value) => sum + clampRatio(value), 0) / ratios.length;
}

/**
 * Rank only the circles this user belongs to. The score is computed locally
 * from the six ratios and is never transmitted to another peer or server.
 */
export function rankCircles(statsList: readonly CircleStats[]): RankedCircle[] {
  return statsList
    .map((stats) => ({
      rank: 0,
      circleId: stats.circleId,
      score: circleScore(stats),
      stats,
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return compareStrings(a.circleId, b.circleId);
    })
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}
