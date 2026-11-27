import type { CircleStats, Stat } from '../types';
import { isValidTimeZone } from '../time';

export type StatKey =
  | 'monthlyKept'
  | 'weeklyParticipation'
  | 'seasonPairs'
  | 'dailyRun'
  | 'promptStats'
  | 'allTime';

export const STAT_KEYS: readonly StatKey[] = [
  'monthlyKept',
  'weeklyParticipation',
  'seasonPairs',
  'dailyRun',
  'promptStats',
  'allTime',
];

export interface StatLine {
  key: StatKey;
  label: string;
  value: number;
  target: number;
  ratio: number;
  percent: number;
  detail: string;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function base(stat: Stat): Pick<StatLine, 'value' | 'target' | 'ratio' | 'percent'> {
  return {
    value: stat.value,
    target: stat.target,
    ratio: clamp01(stat.ratio),
    percent: Math.round(clamp01(stat.ratio) * 100),
  };
}

export function statLines(stats: CircleStats): StatLine[] {
  return [
    {
      key: 'monthlyKept',
      label: 'monthly kept',
      ...base(stats.monthlyKept),
      detail: `${stats.monthlyKept.value} kept this month · pairs capped at ${stats.monthlyKept.pairCapPerWeek} per week`,
    },
    {
      key: 'weeklyParticipation',
      label: 'weekly participation',
      ...base(stats.weeklyParticipation),
      detail: `${stats.weeklyParticipation.value} of ${stats.weeklyParticipation.target} humans in a kept pair this week`,
    },
    {
      key: 'seasonPairs',
      label: 'season pairs',
      ...base(stats.seasonPairs),
      detail: `${stats.seasonPairs.value} of ${stats.seasonPairs.target} possible pairs this season`,
    },
    {
      key: 'dailyRun',
      label: 'daily run',
      ...base(stats.dailyRun),
      detail: `${stats.dailyRun.value} days now · longest ${stats.dailyRun.longestRun}`,
    },
    {
      key: 'promptStats',
      label: 'weekly prompt',
      ...base(stats.promptStats),
      detail: `${stats.promptStats.weekMembers} of ${stats.promptStats.target} humans · “${stats.promptStats.weekPrompt.text}”`,
    },
    {
      key: 'allTime',
      label: 'all time',
      ...base(stats.allTime),
      detail: `${stats.allTime.value} kept · next ${stats.allTime.nextMilestone}`,
    },
  ];
}

export function formatAsOf(
  asOf: number | null,
  timeZone: string,
  locale = 'en-GB',
): string {
  if (asOf === null || !Number.isFinite(asOf)) return 'never';
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(asOf);
  } catch {
    return new Date(asOf).toISOString();
  }
}

export function asOfLine(
  asOf: number | null,
  timeZone: string,
  locale = 'en-GB',
): string {
  return `as of last sync · ${formatAsOf(asOf, timeZone, locale)}`;
}

export function scorePercent(score: number): number {
  return Math.round(clamp01(score) * 100);
}

export function ringGeometry(
  score: number,
  radius = 34,
  strokeWidth = 4,
): {
  radius: number;
  strokeWidth: number;
  circumference: number;
  dashOffset: number;
  percent: number;
} {
  const circumference = 2 * Math.PI * radius;
  const percent = scorePercent(score);
  return {
    radius,
    strokeWidth,
    circumference,
    dashOffset: circumference * (1 - percent / 100),
    percent,
  };
}

export function shortenKey(key: string, leading = 6, trailing = 4): string {
  if (key.length <= leading + trailing + 1) return key;
  return `${key.slice(0, leading)}…${key.slice(-trailing)}`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

export interface CircleDraft {
  name: string;
  timezone: string;
}

export interface CircleDraftResult {
  ok: boolean;
  error?: string;
  value?: CircleDraft;
}

/** Shared validation used by the create form and host code. */
export function validateCircleDraft(name: string, timezone: string): CircleDraftResult {
  const normalizedName = name.replace(/\s+/gu, ' ').trim();
  if (normalizedName.length === 0) {
    return { ok: false, error: 'Give the circle a name.' };
  }
  if (normalizedName.length > 200) {
    return { ok: false, error: 'Circle names are limited to 200 characters.' };
  }
  const normalizedTimezone = timezone.trim();
  if (!isValidTimeZone(normalizedTimezone)) {
    return { ok: false, error: 'Choose a valid IANA timezone, such as Europe/Berlin.' };
  }
  return {
    ok: true,
    value: { name: normalizedName, timezone: normalizedTimezone },
  };
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
