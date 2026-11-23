import { describe, expect, it } from 'vitest';
import {
  HANDOFF_WINDOW_MS,
  formatCountdown,
  handoffClosesAt,
  handoffOpensAt,
  handoffPhase,
  isHandoffEligible,
  isHandoffOnTime,
} from '../src/lib/handoff';

const scheduled = 1_700_000_000_000;

describe('handoff window', () => {
  it('is exactly five minutes before and after the scheduled moment', () => {
    expect(handoffOpensAt(scheduled)).toBe(scheduled - HANDOFF_WINDOW_MS);
    expect(handoffClosesAt(scheduled)).toBe(scheduled + HANDOFF_WINDOW_MS);
    expect(HANDOFF_WINDOW_MS).toBe(5 * 60_000);
  });

  it('labels the five-minute early and late boundaries', () => {
    expect(handoffPhase(scheduled, scheduled - HANDOFF_WINDOW_MS - 1)).toBe('scheduled');
    expect(handoffPhase(scheduled, scheduled - HANDOFF_WINDOW_MS)).toBe('open-early');
    expect(handoffPhase(scheduled, scheduled - 1)).toBe('open-early');
    expect(handoffPhase(scheduled, scheduled)).toBe('due');
    expect(handoffPhase(scheduled, scheduled + HANDOFF_WINDOW_MS)).toBe('due');
    expect(handoffPhase(scheduled, scheduled + HANDOFF_WINDOW_MS + 1)).toBe('still-open');
  });

  it('becomes eligible at T-5 and stays eligible when late', () => {
    expect(isHandoffEligible(scheduled, scheduled - HANDOFF_WINDOW_MS - 1)).toBe(false);
    expect(isHandoffEligible(scheduled, scheduled - HANDOFF_WINDOW_MS)).toBe(true);
    expect(isHandoffEligible(scheduled, scheduled - 4 * 60_000)).toBe(true);
    expect(isHandoffEligible(scheduled, scheduled + 4 * 60_000)).toBe(true);
    expect(isHandoffEligible(scheduled, scheduled + HANDOFF_WINDOW_MS + 1)).toBe(true);
  });

  it('marks only the +/- five-minute window as on time', () => {
    expect(isHandoffOnTime(scheduled, scheduled - HANDOFF_WINDOW_MS - 1)).toBe(false);
    expect(isHandoffOnTime(scheduled, scheduled - HANDOFF_WINDOW_MS)).toBe(true);
    expect(isHandoffOnTime(scheduled, scheduled)).toBe(true);
    expect(isHandoffOnTime(scheduled, scheduled + HANDOFF_WINDOW_MS)).toBe(true);
    expect(isHandoffOnTime(scheduled, scheduled + HANDOFF_WINDOW_MS + 1)).toBe(false);
  });

  it('formats the hero countdown at every scale', () => {
    expect(formatCountdown(-1)).toBe('00:00');
    expect(formatCountdown(1)).toBe('00:01');
    expect(formatCountdown(65_000)).toBe('01:05');
    expect(formatCountdown(3_600_000)).toBe('01:00:00');
    expect(formatCountdown(90_061_000)).toBe('1d 01:01:01');
  });
});
