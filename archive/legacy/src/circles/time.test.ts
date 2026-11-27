import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarDate,
  dayKey,
  dayKeyFromNumber,
  dayNumber,
  dayNumberFromKey,
  isValidTimeZone,
  monthKey,
  nextDayKey,
  previousDayKey,
  quarter,
  seasonKey,
  weekKey,
  weekNumber,
} from './time';

const at = (iso: string): number => Date.parse(iso);

describe('timezone calendar keys', () => {
  it('uses Monday as the start of the week', () => {
    const sunday = at('2026-11-22T12:00:00Z');
    expect(dayKey(sunday, 'UTC')).toBe('2026-11-22');
    expect(weekKey(sunday, 'UTC')).toBe('2026-11-16');
    expect(dayKey(at('2026-11-16T00:00:00Z'), 'UTC')).toBe('2026-11-16');
    expect(weekKey(at('2026-11-16T23:59:59Z'), 'UTC')).toBe('2026-11-16');
    expect(weekKey(at('2026-03-08T12:00:00Z'), 'UTC')).toBe('2026-03-02');
  });

  it('changes the calendar day across a timezone boundary', () => {
    const instant = at('2026-01-01T00:30:00Z');
    expect(dayKey(instant, 'Asia/Tokyo')).toBe('2026-01-01');
    expect(dayKey(instant, 'America/Los_Angeles')).toBe('2025-12-31');
    expect(monthKey(instant, 'Asia/Tokyo')).toBe('2026-01');
    expect(monthKey(instant, 'America/Los_Angeles')).toBe('2025-12');
    expect(seasonKey(instant, 'Asia/Tokyo')).toBe('2026-Q1');
    expect(seasonKey(instant, 'America/Los_Angeles')).toBe('2025-Q4');
  });

  it('keeps the scheduled day across midnight and a DST change', () => {
    const scheduled = at('2026-03-07T23:58:00-05:00');
    const joined = at('2026-03-08T00:02:00-05:00');
    expect(dayKey(scheduled, 'America/New_York')).toBe('2026-03-07');
    expect(dayKey(joined, 'America/New_York')).toBe('2026-03-08');

    const beforeSpringForward = at('2026-03-08T06:30:00Z'); // 01:30 EST
    const afterSpringForward = at('2026-03-08T07:30:00Z'); // 03:30 EDT
    expect(dayKey(beforeSpringForward, 'America/New_York')).toBe('2026-03-08');
    expect(dayKey(afterSpringForward, 'America/New_York')).toBe('2026-03-08');
    expect(dayNumber(afterSpringForward, 'America/New_York')).toBe(
      dayNumber(beforeSpringForward, 'America/New_York'),
    );
  });

  it('rolls weeks, months and seasons deterministically', () => {
    const lastOfMarch = at('2026-03-31T23:30:00Z');
    const firstOfApril = at('2026-04-01T00:30:00Z');
    expect(monthKey(lastOfMarch, 'UTC')).toBe('2026-03');
    expect(monthKey(firstOfApril, 'UTC')).toBe('2026-04');
    expect(seasonKey(lastOfMarch, 'UTC')).toBe('2026-Q1');
    expect(seasonKey(firstOfApril, 'UTC')).toBe('2026-Q2');
    expect(quarter(firstOfApril, 'UTC')).toBe(2);

    expect(weekKey(at('2026-03-29T23:59:59Z'), 'UTC')).toBe('2026-03-23');
    expect(weekKey(at('2026-03-30T00:00:00Z'), 'UTC')).toBe('2026-03-30');
  });

  it('adds days across DST without losing or duplicating a day', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(previousDayKey('2026-03-09')).toBe('2026-03-08');
    expect(nextDayKey('2026-11-30')).toBe('2026-12-01');
    expect(dayKeyFromNumber(dayNumberFromKey('2026-03-08'))).toBe('2026-03-08');
  });

  it('reports the timezone and calendar parts', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(() => dayKey(0, 'Not/AZone')).toThrow(/Invalid IANA/u);
    expect(calendarDate(at('2026-11-22T23:00:00Z'), 'Europe/Berlin')).toEqual({
      year: 2026,
      month: 11,
      day: 23,
    });
    expect(weekNumber(at('2026-11-22T12:00:00Z'), 'UTC')).toBe(
      Math.floor(dayNumberFromKey('2026-11-16') / 7),
    );
  });
});
