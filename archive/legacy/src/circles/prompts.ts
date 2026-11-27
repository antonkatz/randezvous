import type { Prompt } from './types';
import { dayNumber, positiveModulo, weekNumber } from './time';

/**
 * Plain replaceable data. Keep the ids stable when changing the wording so
 * attendance records retain their meaning across peers with newer lists.
 */
export const DAILY_PROMPTS: readonly Prompt[] = Object.freeze([
  { id: 'daily-01', text: 'A small thing you noticed today.' },
  { id: 'daily-02', text: 'The light where you are right now.' },
  { id: 'daily-03', text: 'Something your hands made.' },
  { id: 'daily-04', text: 'A place you passed without stopping.' },
  { id: 'daily-05', text: 'One colour you keep returning to.' },
  { id: 'daily-06', text: 'A corner of your everyday.' },
  { id: 'daily-07', text: 'What you are looking at while you wait.' },
]);

export const WEEKLY_PROMPTS: readonly Prompt[] = Object.freeze([
  { id: 'weekly-01', text: 'Something that changed this week.' },
  { id: 'weekly-02', text: 'A person, place or thing you are grateful for.' },
  { id: 'weekly-03', text: 'Evidence of a slow ritual.' },
  { id: 'weekly-04', text: 'A view you would like to share twice.' },
]);

export interface ActivePrompts {
  day: Prompt;
  week: Prompt;
}

function promptAt(list: readonly Prompt[], index: number): Prompt {
  const selected = list[positiveModulo(index, list.length)];
  if (!selected) throw new Error('Prompt list is empty');
  return selected;
}

/**
 * Deterministic for every peer: the local calendar day in the circle timezone
 * picks the daily prompt, and the Monday-aligned week picks the weekly one.
 * No prompt is authored or transmitted.
 */
export function activePrompts(now: number, timeZone: string): ActivePrompts {
  if (!Number.isFinite(now)) throw new Error('now must be finite');
  return {
    day: promptAt(DAILY_PROMPTS, dayNumber(now, timeZone)),
    week: promptAt(WEEKLY_PROMPTS, weekNumber(now, timeZone)),
  };
}

export function promptById(id: string): Prompt | null {
  return (
    DAILY_PROMPTS.find((prompt) => prompt.id === id) ??
    WEEKLY_PROMPTS.find((prompt) => prompt.id === id) ??
    null
  );
}
