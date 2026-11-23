/** The normal on-time handoff window around a scheduled rendezvous. */
export const HANDOFF_WINDOW_MS = 5 * 60_000;

export type HandoffPhase = 'scheduled' | 'open-early' | 'due' | 'still-open';

export function handoffOpensAt(scheduledFor: number): number {
  return scheduledFor - HANDOFF_WINDOW_MS;
}

export function handoffClosesAt(scheduledFor: number): number {
  return scheduledFor + HANDOFF_WINDOW_MS;
}

/**
 * Returns the UI phase for a rendezvous. `open-early` and `due` are the normal
 * on-time window; `still-open` means the appointment is late but never expired.
 */
export function handoffPhase(scheduledFor: number, now = Date.now()): HandoffPhase {
  if (now < handoffOpensAt(scheduledFor)) return 'scheduled';
  if (now < scheduledFor) return 'open-early';
  if (now <= handoffClosesAt(scheduledFor)) return 'due';
  return 'still-open';
}

/** True from `T - 5 minutes` onward. A late appointment remains eligible. */
export function isHandoffEligible(scheduledFor: number, now = Date.now()): boolean {
  return now >= handoffOpensAt(scheduledFor);
}

/** True inside the normal on-time window `[T - 5, T + 5]`. */
export function isHandoffOnTime(scheduledFor: number, now = Date.now()): boolean {
  return now >= handoffOpensAt(scheduledFor) && now <= handoffClosesAt(scheduledFor);
}
