import { compareStrings } from './canonical';
import type {
  AttendanceRecord,
  CircleConfig,
  CircleConfigInput,
  KeptPair,
  NtpSample,
  ClockEstimate,
  RendezvousId,
  StoredCircleRecord,
} from './types';
import { resolveCircleConfig } from './types';

export interface KeptRendezvous {
  rendezvousId: RendezvousId;
  scheduledAt: number;
  pairs: KeptPair[];
}

export function pairKey(a: string, b: string): string {
  return compareStrings(a, b) <= 0
    ? `${a}\u0000${b}`
    : `${b}\u0000${a}`;
}

export function pairMembers(key: string): [string, string] {
  const separator = key.indexOf('\u0000');
  return [key.slice(0, separator), key.slice(separator + 1)];
}

export function isWithinWindow(
  joinedAt: number,
  scheduledAt: number,
  config: CircleConfigInput | CircleConfig = {},
): boolean {
  const resolved = resolveCircleConfig(config);
  return Math.abs(joinedAt - scheduledAt) <= resolved.windowMs + resolved.skewMs;
}

/**
 * A pair is kept only when both Attendance records agree, both name the other,
 * both use the same scheduled instant, and both arrivals fall inside the
 * window plus clock skew.
 */
export function isKeptPair(
  first: AttendanceRecord,
  second: AttendanceRecord,
  config: CircleConfigInput | CircleConfig = {},
): boolean {
  if (first.type !== 'Attendance' || second.type !== 'Attendance') return false;
  if (first.rendezvousId !== second.rendezvousId) return false;
  if (first.attendee === second.attendee) return false;
  if (first.scheduledAt !== second.scheduledAt) return false;
  if (!first.swappedWith.includes(second.attendee)) return false;
  if (!second.swappedWith.includes(first.attendee)) return false;

  const resolved = resolveCircleConfig(config);
  const tolerance = resolved.windowMs + resolved.skewMs;
  return (
    Math.abs(first.joinedAt - first.scheduledAt) <= tolerance &&
    Math.abs(second.joinedAt - second.scheduledAt) <= tolerance
  );
}

/**
 * Collect every kept pair from the Attendance records. Duplicate Attendance
 * records contribute at most one pair for a given rendezvous and two people.
 */
export function collectKeptPairs(
  records: readonly StoredCircleRecord[],
  config: CircleConfigInput | CircleConfig = {},
): KeptPair[] {
  const resolved = resolveCircleConfig(config);
  const byRendezvous = new Map<string, AttendanceRecord[]>();
  for (const entry of records) {
    if (entry.record.type !== 'Attendance') continue;
    const list = byRendezvous.get(entry.record.rendezvousId) ?? [];
    list.push(entry.record);
    byRendezvous.set(entry.record.rendezvousId, list);
  }

  const pairs = new Map<string, KeptPair>();
  for (const [rendezvousId, attendances] of byRendezvous) {
    for (let i = 0; i < attendances.length; i += 1) {
      const first = attendances[i];
      if (!first) continue;
      for (let j = i + 1; j < attendances.length; j += 1) {
        const second = attendances[j];
        if (!second) continue;
        if (!isKeptPair(first, second, resolved)) continue;
        const sorted = [first.attendee, second.attendee].sort(compareStrings);
        const a = sorted[0];
        const b = sorted[1];
        if (!a || !b) continue;
        const key = `${rendezvousId}\u0000${pairKey(a, b)}`;
        if (!pairs.has(key)) {
          pairs.set(key, {
            rendezvousId,
            scheduledAt: first.scheduledAt,
            a,
            b,
          });
        }
      }
    }
  }

  return [...pairs.values()].sort((left, right) => {
    if (left.scheduledAt !== right.scheduledAt) {
      return left.scheduledAt - right.scheduledAt;
    }
    const rendezvous = compareStrings(left.rendezvousId, right.rendezvousId);
    if (rendezvous !== 0) return rendezvous;
    const first = compareStrings(left.a, right.a);
    if (first !== 0) return first;
    return compareStrings(left.b, right.b);
  });
}

/** Group kept pairs into rendezvous, sorted by scheduledAt then id. */
export function collectKeptRendezvous(
  records: readonly StoredCircleRecord[],
  config: CircleConfigInput | CircleConfig = {},
): KeptRendezvous[] {
  const byRendezvous = new Map<string, KeptRendezvous>();
  for (const pair of collectKeptPairs(records, config)) {
    const current = byRendezvous.get(pair.rendezvousId);
    if (current) {
      current.pairs.push(pair);
    } else {
      byRendezvous.set(pair.rendezvousId, {
        rendezvousId: pair.rendezvousId,
        scheduledAt: pair.scheduledAt,
        pairs: [pair],
      });
    }
  }
  return [...byRendezvous.values()].sort((a, b) => {
    if (a.scheduledAt !== b.scheduledAt) return a.scheduledAt - b.scheduledAt;
    return compareStrings(a.rendezvousId, b.rendezvousId);
  });
}

/** Kept pairs whose two attendees are current members in this view. */
export function collectInCirclePairs(
  records: readonly StoredCircleRecord[],
  members: ReadonlySet<string> | readonly string[],
  config: CircleConfigInput | CircleConfig = {},
): KeptPair[] {
  const memberSet = members instanceof Set ? members : new Set(members);
  return collectKeptPairs(records, config).filter(
    (pair) => memberSet.has(pair.a) && memberSet.has(pair.b),
  );
}

/**
 * Sign only when the local clock (after applying the estimated NTP offset)
 * agrees with the claimed joinedAt within skewMs.
 */
export function shouldSign(
  attendance: Pick<AttendanceRecord, 'joinedAt'>,
  localNow: number,
  config: CircleConfigInput | CircleConfig = {},
): boolean {
  const resolved = resolveCircleConfig(config);
  if (!Number.isFinite(localNow) || !Number.isFinite(attendance.joinedAt)) return false;
  return Math.abs(localNow - attendance.joinedAt) <= resolved.skewMs;
}

export interface ClockSampleEstimate extends ClockEstimate {
  t1: number;
  t2: number;
  t3: number;
  t4: number;
}

function sampleEstimate(sample: NtpSample): ClockSampleEstimate | null {
  const { t1, t2, t3, t4 } = sample;
  if (![t1, t2, t3, t4].every(Number.isFinite)) return null;
  if (t4 < t1 || t3 < t2) return null;
  const offsetMs = (t2 - t1 + (t3 - t4)) / 2;
  const delayMs = t4 - t1 - (t3 - t2);
  if (delayMs < 0) return null;
  return { offsetMs, delayMs, samples: 1, t1, t2, t3, t4 };
}

/**
 * Four-timestamp NTP offset. t1 = client send, t2 = server receive,
 * t3 = server send, t4 = client receive:
 *   offset = ((t2 - t1) + (t3 - t4)) / 2
 *   delay  = (t4 - t1) - (t3 - t2)
 * The lowest-delay sample is used; an empty/invalid set yields zero.
 */
export function estimateClockOffset(samples: readonly NtpSample[]): number {
  return estimateClock(samples).offsetMs;
}

export function estimateClock(samples: readonly NtpSample[]): ClockEstimate {
  let best: ClockSampleEstimate | null = null;
  let validSamples = 0;
  for (const sample of samples) {
    const estimate = sampleEstimate(sample);
    if (!estimate) continue;
    validSamples += 1;
    if (
      !best ||
      estimate.delayMs < best.delayMs ||
      (estimate.delayMs === best.delayMs && estimate.t1 < best.t1)
    ) {
      best = estimate;
    }
  }
  if (!best) return { offsetMs: 0, delayMs: 0, samples: 0 };
  return {
    offsetMs: best.offsetMs,
    delayMs: best.delayMs,
    samples: validSamples,
  };
}

/** Apply an NTP offset to a local clock reading. */
export function correctedNow(localNow: number, offsetMs: number): number {
  return localNow + offsetMs;
}
