import { canonicalString, compareStrings, verifyStoredRecord } from './canonical';
import { planOutsideWindow } from './plans';
import type { CircleId, Identity, StoredCircleRecord } from './types';
import { isCircleScopedRecord } from './types';

export interface MergeRejection {
  id: string | null;
  error: string;
}

export interface MergeResult {
  /** The merged set, sorted by content-derived id. */
  records: StoredCircleRecord[];
  /** Ids that were not present in the verified existing set. */
  added: StoredCircleRecord[];
  /** Existing ids that the merged set no longer accepts. */
  removed: string[];
  /** Invalid or conflicting inputs. Deduplicated and deterministic. */
  rejected: MergeRejection[];
}

export interface MergeOptions {
  /** Reject records scoped to a different circle; global Plan/Attendance pass. */
  circleId?: CircleId;
}

interface ValidEntry {
  entry: StoredCircleRecord;
  canonical: string;
}

function rejectionKey(rejection: MergeRejection): string {
  return `${rejection.id ?? ''}\u0000${rejection.error}`;
}

/**
 * Validate and union two record sets.
 *
 * The output is a set keyed by id. Because signatures are excluded from the
 * id, two signatures over the same content share an id; the lexicographically
 * smaller signature is retained so the result does not depend on input order.
 */
export async function mergeRecords(
  identity: Identity,
  existing: readonly StoredCircleRecord[],
  incoming: readonly StoredCircleRecord[],
  options: MergeOptions = {},
): Promise<MergeResult> {
  const valid = new Map<string, ValidEntry>();
  const existingIds = new Set<string>();
  const rejectedByKey = new Map<string, MergeRejection>();
  const conflicts = new Set<string>();

  const reject = (id: string | null, error: string): void => {
    const rejection = { id, error };
    rejectedByKey.set(rejectionKey(rejection), rejection);
  };

  const consider = async (entry: StoredCircleRecord, isExisting: boolean): Promise<void> => {
    let result;
    try {
      result = await verifyStoredRecord(identity, entry);
    } catch (error) {
      reject(
        typeof entry === 'object' && entry !== null && typeof entry.id === 'string'
          ? entry.id
          : null,
        error instanceof Error ? error.message : 'record verification failed',
      );
      return;
    }
    if (!result.ok) {
      reject(typeof entry.id === 'string' ? entry.id : null, result.error ?? 'invalid record');
      return;
    }

    if (
      options.circleId !== undefined &&
      isCircleScopedRecord(entry.record) &&
      entry.record.circleId !== options.circleId
    ) {
      reject(entry.id, 'record belongs to another circle');
      return;
    }

    if (isExisting) existingIds.add(entry.id);
    if (conflicts.has(entry.id)) return;
    const canonical = canonicalString(entry.record);
    const previous = valid.get(entry.id);
    if (!previous) {
      valid.set(entry.id, { entry, canonical });
      return;
    }

    if (previous.canonical !== canonical) {
      // A genuine hash collision. Reject both rather than choose arbitrarily.
      valid.delete(entry.id);
      conflicts.add(entry.id);
      reject(entry.id, 'conflicting records share an id');
      return;
    }
    if (conflicts.has(entry.id)) return;

    if (compareStrings(entry.record.sig, previous.entry.record.sig) < 0) {
      valid.set(entry.id, { entry, canonical });
    }
  };

  // Existing records are verified too: callers may load an older store from
  // disk, and merge must never propagate an invalid record.
  const ordered = [
    ...existing.map((entry) => ({ entry, isExisting: true })),
    ...incoming.map((entry) => ({ entry, isExisting: false })),
  ].sort((a, b) => {
    const idCompare = compareStrings(
      typeof a.entry?.id === 'string' ? a.entry.id : '',
      typeof b.entry?.id === 'string' ? b.entry.id : '',
    );
    if (idCompare !== 0) return idCompare;
    const sigA = typeof a.entry?.record?.sig === 'string' ? a.entry.record.sig : '';
    const sigB = typeof b.entry?.record?.sig === 'string' ? b.entry.record.sig : '';
    return compareStrings(sigA, sigB);
  });

  for (const { entry, isExisting } of ordered) {
    await consider(entry, isExisting);
  }

  // Cross-record rule: a signed plan outside the window active at its signed
  // creation time never participates in history or canonical selection.
  if (options.circleId !== undefined) {
    const all = [...valid.values()].map(({ entry }) => entry);
    for (const entry of all) {
      if (entry.record.type !== 'Plan') continue;
      if (entry.record.circleId !== options.circleId) continue;
      if (!planOutsideWindow(entry.record, all)) continue;
      valid.delete(entry.id);
      reject(entry.id, 'plan falls outside the active circle time window');
    }
  }

  const records = [...valid.values()]
    .map(({ entry }) => entry)
    .sort((a, b) => compareStrings(a.id, b.id));
  const added = records.filter((entry) => !existingIds.has(entry.id));
  const removed = [...existingIds]
    .filter((id) => !valid.has(id))
    .sort(compareStrings);
  const rejected = [...rejectedByKey.values()].sort((a, b) =>
    compareStrings(rejectionKey(a), rejectionKey(b)),
  );

  return { records, added, removed, rejected };
}

/** Merge an arbitrary number of sets, left to right. */
export async function mergeRecordSets(
  identity: Identity,
  sets: readonly (readonly StoredCircleRecord[])[],
  options: MergeOptions = {},
): Promise<MergeResult> {
  let result: MergeResult = { records: [], added: [], removed: [], rejected: [] };
  for (const set of sets) {
    result = await mergeRecords(identity, result.records, set, options);
  }
  return result;
}

export function recordsForCircle(
  entries: readonly StoredCircleRecord[],
  circleId: CircleId,
): StoredCircleRecord[] {
  return entries.filter(
    (entry) =>
      !isCircleScopedRecord(entry.record) || entry.record.circleId === circleId,
  );
}
