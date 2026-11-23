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

/** Compact countdown such as `04:32`, `01:04:32`, or `2d 03:04:05`. */
export function formatCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return `${pad(minutes)}:${pad(seconds)}`;
}
