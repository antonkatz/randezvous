import { compareStrings, isStrictlySortedUnique, signRecord } from './canonical';
import { dayKey } from './time';
import type {
  CircleId,
  Identity,
  PlanRecord,
  PublicKeyId,
  StoredCircleRecord,
  WindowClearRecord,
  WindowRecord,
} from './types';

export interface CreateCirclePlanInput {
  identity: Identity;
  circleId: CircleId;
  scheduledAt: number;
  invitees: readonly PublicKeyId[];
  createdAt: number;
  /** Existing records are used to reject a plan outside the active window. */
  records?: readonly StoredCircleRecord[];
}

export interface CreatedCirclePlan {
  plan: StoredCircleRecord;
  canonical: boolean;
}

function uniqueSorted(values: readonly PublicKeyId[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function assertTimestamp(name: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a UTC timestamp`);
  }
}

function assertSortedIds(name: string, values: readonly PublicKeyId[]): void {
  if (values.length === 0 || !isStrictlySortedUnique(values)) {
    throw new Error(`${name} must be strictly sorted and free of duplicates`);
  }
}

/** Select the window or clear record in force when a plan was signed. */
export function activeWindowRecord(
  records: readonly StoredCircleRecord[],
  circleId: CircleId,
  at: number,
): StoredCircleRecord | null {
  const candidates = records
    .filter((entry) => {
      const record = entry.record;
      return (
        (record.type === 'Window' || record.type === 'WindowClear') &&
        record.circleId === circleId &&
        record.createdAt <= at
      );
    })
    .sort((left, right) => {
      const a = left.record as WindowRecord | WindowClearRecord;
      const b = right.record as WindowRecord | WindowClearRecord;
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
      return compareStrings(left.id, right.id);
    });
  return candidates[0] ?? null;
}

export function windowRecordFor(
  records: readonly StoredCircleRecord[],
  circleId: CircleId,
  at: number,
): WindowRecord | null {
  const selected = activeWindowRecord(records, circleId, at);
  return selected?.record.type === 'Window' ? selected.record : null;
}

export function planOutsideWindow(
  plan: PlanRecord,
  records: readonly StoredCircleRecord[],
): boolean {
  const window = windowRecordFor(records, plan.circleId, plan.createdAt);
  if (!window) return false;
  return plan.scheduledAt < window.start || plan.scheduledAt > window.end;
}

/**
 * Create a signed circle plan. The client refuses to sign a plan that falls
 * outside the window active at the new record's signed creation time.
 */
export async function createCirclePlan(
  input: CreateCirclePlanInput,
): Promise<CreatedCirclePlan> {
  assertTimestamp('scheduledAt', input.scheduledAt);
  assertTimestamp('createdAt', input.createdAt);
  const invitees = uniqueSorted(input.invitees);
  if (invitees.length > 0) assertSortedIds('invitees', invitees);
  const unsigned = {
    type: 'Plan' as const,
    circleId: input.circleId,
    rendezvousId: `crv_${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
    scheduledAt: input.scheduledAt,
    organizer: input.identity.selfKey,
    invitees,
    createdAt: input.createdAt,
  };
  if (
    input.records &&
    planOutsideWindow({ ...unsigned, sig: '' }, input.records)
  ) {
    throw new Error('That moment is outside the circle’s active time window');
  }
  const plan = await signRecord(input.identity, unsigned);
  const existing = input.records ?? [];
  const canonical =
    canonicalPlans([...existing, plan], input.circleId, timezoneFrom(existing) ?? 'UTC')
      .find((entry) => entry.canonical.id === plan.id) !== undefined;
  return { plan, canonical };
}

export interface CreateCircleWindowInput {
  identity: Identity;
  circleId: CircleId;
  start: number;
  end: number;
  createdAt: number;
}

export async function createCircleWindow(
  input: CreateCircleWindowInput,
): Promise<StoredCircleRecord> {
  assertTimestamp('start', input.start);
  assertTimestamp('end', input.end);
  assertTimestamp('createdAt', input.createdAt);
  if (input.start >= input.end) {
    throw new Error('The window must start before it ends');
  }
  return signRecord(input.identity, {
    type: 'Window',
    circleId: input.circleId,
    start: input.start,
    end: input.end,
    author: input.identity.selfKey,
    createdAt: input.createdAt,
  });
}

export async function clearCircleWindow(input: {
  identity: Identity;
  circleId: CircleId;
  createdAt: number;
}): Promise<StoredCircleRecord> {
  assertTimestamp('createdAt', input.createdAt);
  return signRecord(input.identity, {
    type: 'WindowClear',
    circleId: input.circleId,
    author: input.identity.selfKey,
    createdAt: input.createdAt,
  });
}

export interface CreateAttendanceInput {
  identity: Identity;
  rendezvousId: string;
  scheduledAt: number;
  joinedAt: number;
  swappedWith: readonly PublicKeyId[];
  promptId?: string | null;
}

export async function createAttendanceRecord(
  input: CreateAttendanceInput,
): Promise<StoredCircleRecord> {
  assertTimestamp('scheduledAt', input.scheduledAt);
  assertTimestamp('joinedAt', input.joinedAt);
  const swappedWith = uniqueSorted(input.swappedWith);
  assertSortedIds('swappedWith', swappedWith);
  return signRecord(input.identity, {
    type: 'Attendance',
    rendezvousId: input.rendezvousId,
    scheduledAt: input.scheduledAt,
    attendee: input.identity.selfKey,
    joinedAt: input.joinedAt,
    swappedWith,
    promptId: input.promptId ?? null,
  });
}

export interface CircleDayPlans {
  day: string;
  /** The earliest signed plan for this circle and local day. */
  canonical: StoredCircleRecord;
  /** Every valid plan for the day, ordered by createdAt then id. */
  plans: StoredCircleRecord[];
}

function timezoneFrom(records: readonly StoredCircleRecord[]): string | null {
  for (const entry of records) {
    if (entry.record.type === 'CircleCreated') return entry.record.timezone;
  }
  return null;
}

/** Recompute the canonical plan for every local day from signed records. */
export function canonicalPlans(
  records: readonly StoredCircleRecord[],
  circleId: CircleId,
  timezone: string,
  members?: ReadonlySet<PublicKeyId> | readonly PublicKeyId[],
): CircleDayPlans[] {
  const memberSet =
    members === undefined
      ? null
      : members instanceof Set
        ? members
        : new Set(members);
  const byDay = new Map<string, StoredCircleRecord[]>();
  for (const entry of records) {
    const record = entry.record;
    if (record.type !== 'Plan' || record.circleId !== circleId) continue;
    if (memberSet && !memberSet.has(record.organizer)) continue;
    const key = dayKey(record.scheduledAt, timezone);
    const list = byDay.get(key) ?? [];
    list.push(entry);
    byDay.set(key, list);
  }
  const result: CircleDayPlans[] = [];
  for (const [day, plans] of byDay) {
    plans.sort((left, right) => {
      const a = left.record as PlanRecord;
      const b = right.record as PlanRecord;
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return compareStrings(left.id, right.id);
    });
    const canonical = plans[0];
    if (canonical) result.push({ day, canonical, plans });
  }
  return result.sort((a, b) => compareStrings(a.day, b.day));
}

export function canonicalPlanForDay(
  records: readonly StoredCircleRecord[],
  circleId: CircleId,
  timezone: string,
  day: string,
): StoredCircleRecord | null {
  return canonicalPlans(records, circleId, timezone).find((entry) => entry.day === day)
    ?.canonical ?? null;
}

/** Non-canonical plan ids never count in circle stats. */
export function nonCanonicalPlanIds(
  records: readonly StoredCircleRecord[],
  circleId: CircleId,
  timezone: string,
  members?: ReadonlySet<PublicKeyId> | readonly PublicKeyId[],
): Set<string> {
  const ids = new Set<string>();
  for (const day of canonicalPlans(records, circleId, timezone, members)) {
    for (const plan of day.plans) {
      if (plan.id === day.canonical.id || plan.record.type !== 'Plan') continue;
      ids.add(plan.record.rendezvousId);
    }
  }
  return ids;
}
