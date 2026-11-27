import { describe, expect, it } from 'vitest';
import {
  asOfLine,
  escapeHtml,
  formatAsOf,
  ringGeometry,
  scorePercent,
  shortenKey,
  statLines,
  validateCircleDraft,
} from './presentation';
import type { CircleStats } from '../types';

function fixture(): CircleStats {
  return {
    circleId: 'c1',
    name: 'Sunday table',
    timezone: 'Europe/Berlin',
    asOf: Date.UTC(2026, 10, 22, 20, 4),
    memberCount: 5,
    bannedCount: 0,
    monthlyKept: {
      value: 10,
      target: 20,
      ratio: 0.5,
      counted: 10,
      pairCapPerWeek: 3,
    },
    weeklyParticipation: {
      value: 3,
      target: 5,
      ratio: 0.6,
      activeMembers: 3,
      memberCount: 5,
    },
    seasonPairs: { value: 4, target: 10, ratio: 0.4, activePairs: 4, totalPairs: 10 },
    dailyRun: { value: 7, target: 14, ratio: 0.5, longestRun: 9, today: '2026-11-22' },
    promptStats: {
      value: 2,
      target: 5,
      ratio: 0.4,
      dayPrompt: { id: 'd', text: 'A small thing.' },
      weekPrompt: { id: 'w', text: 'Something that changed.' },
      dayCount: 4,
      weekCount: 6,
      weekMembers: 2,
    },
    allTime: {
      value: 42,
      target: 100,
      ratio: 0.42,
      nextMilestone: 100,
      complete: false,
    },
  };
}

describe('circle presentation', () => {
  it('presents the six stats in order with labels and clamped percentages', () => {
    const stats = fixture();
    stats.monthlyKept.ratio = 2;
    const lines = statLines(stats);
    expect(lines).toHaveLength(6);
    expect(lines.map((line) => line.key)).toEqual([
      'monthlyKept',
      'weeklyParticipation',
      'seasonPairs',
      'dailyRun',
      'promptStats',
      'allTime',
    ]);
    expect(lines[0]?.percent).toBe(100);
    expect(lines[4]?.label).toBe('weekly prompt');
    expect(lines[4]?.detail).toContain('Something that changed.');
  });

  it('formats the last-sync line honestly', () => {
    expect(formatAsOf(null, 'UTC')).toBe('never');
    expect(formatAsOf(fixture().asOf, 'Europe/Berlin')).toContain('2026');
    expect(asOfLine(null, 'UTC')).toBe('as of last sync · never');
  });

  it('builds a clamped progress ring', () => {
    const ring = ringGeometry(0.5);
    expect(ring.percent).toBe(50);
    expect(ring.dashOffset).toBeCloseTo(ring.circumference / 2);
    expect(ringGeometry(4).percent).toBe(100);
    expect(ringGeometry(-1).percent).toBe(0);
    expect(scorePercent(Number.NaN)).toBe(0);
  });

  it('shortens keys and escapes rendered text', () => {
    expect(shortenKey('h_abcdefghijklmnop')).toBe('h_abcd…mnop');
    expect(shortenKey('short')).toBe('short');
    expect(escapeHtml('<b>"x"</b>')).toBe('&lt;b&gt;&quot;x&quot;&lt;/b&gt;');
  });

  it('validates a circle draft before signing', () => {
    expect(validateCircleDraft('  Sunday   table ', 'Europe/Berlin')).toEqual({
      ok: true,
      value: { name: 'Sunday table', timezone: 'Europe/Berlin' },
    });
    expect(validateCircleDraft('', 'UTC').ok).toBe(false);
    expect(validateCircleDraft('x'.repeat(201), 'UTC').error).toMatch(/200/u);
    expect(validateCircleDraft('Circle', 'Not/AZone').error).toMatch(/IANA/u);
  });
});
