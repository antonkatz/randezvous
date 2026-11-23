import { describe, expect, it } from 'vitest';
import {
  DAILY_PROMPTS,
  WEEKLY_PROMPTS,
  activePrompts,
  promptById,
} from './prompts';

const dayMs = 86_400_000;
const at = (iso: string): number => Date.parse(iso);

describe('prompt rotation', () => {
  it('ships plain replaceable lists of at least seven daily and four weekly prompts', () => {
    expect(DAILY_PROMPTS.length).toBeGreaterThanOrEqual(7);
    expect(WEEKLY_PROMPTS.length).toBeGreaterThanOrEqual(4);
    const ids = [...DAILY_PROMPTS, ...WEEKLY_PROMPTS].map((prompt) => prompt.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const prompt of [...DAILY_PROMPTS, ...WEEKLY_PROMPTS]) {
      expect(prompt.id.length).toBeGreaterThan(0);
      expect(prompt.text.length).toBeGreaterThan(0);
    }
  });

  it('is identical for identical time and timezone', () => {
    const now = at('2026-11-22T12:00:00Z');
    expect(activePrompts(now, 'Europe/Berlin')).toEqual(
      activePrompts(now, 'Europe/Berlin'),
    );
  });

  it('advances the daily prompt each local day and repeats after the list', () => {
    const first = activePrompts(at('2026-11-22T12:00:00Z'), 'UTC');
    const second = activePrompts(at('2026-11-23T12:00:00Z'), 'UTC');
    const seventh = activePrompts(at('2026-11-28T12:00:00Z'), 'UTC');
    const eighth = activePrompts(at('2026-11-29T12:00:00Z'), 'UTC');
    expect(second.day.id).not.toBe(first.day.id);
    expect(seventh.day.id).not.toBe(first.day.id);
    expect(eighth.day.id).toBe(
      DAILY_PROMPTS[
        (DAILY_PROMPTS.findIndex((prompt) => prompt.id === first.day.id) + 7) %
          DAILY_PROMPTS.length
      ]?.id,
    );
  });

  it('changes the weekly prompt at the Monday boundary', () => {
    const sunday = activePrompts(at('2026-11-22T12:00:00Z'), 'UTC');
    const nextMonday = activePrompts(at('2026-11-23T12:00:00Z'), 'UTC');
    expect(sunday.week.id).not.toBe(nextMonday.week.id);
    expect(sunday.day.id).not.toBe(nextMonday.day.id);
  });

  it('has no dependence on the caller timezone when the day is the same', () => {
    const instant = at('2026-11-22T12:00:00Z');
    expect(activePrompts(instant, 'Europe/Berlin').day.id).toBe(
      activePrompts(instant, 'Africa/Cairo').day.id,
    );
    expect(activePrompts(instant, 'Europe/Berlin').week.id).toBe(
      activePrompts(instant, 'Africa/Cairo').week.id,
    );
  });

  it('finds prompts by id and rejects unknown ids', () => {
    expect(promptById(DAILY_PROMPTS[0]?.id ?? '')).toEqual(DAILY_PROMPTS[0]);
    expect(promptById(WEEKLY_PROMPTS[0]?.id ?? '')).toEqual(WEEKLY_PROMPTS[0]);
    expect(promptById('missing')).toBeNull();
  });

  it('throws for a non-finite now', () => {
    expect(() => activePrompts(Number.NaN, 'UTC')).toThrow(/finite/u);
    expect(() => activePrompts(0, 'Not/AZone')).toThrow(/Invalid IANA/u);
  });
});
