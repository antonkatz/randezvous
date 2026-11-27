import type {
  AttendanceRecord,
  BanVoteRecord,
  CircleCreatedRecord,
  CircleRecord,
  CircleRecordType,
  Identity,
  InviteRecord,
  JoinRecord,
  LeaveRecord,
  LinkInviteRecord,
  PlanJoinRecord,
  PlanRecord,
  StoredCircleRecord,
  UnsignedCircleRecord,
  WindowRecord,
  WindowClearRecord,
} from './types';
import { recordAuthor } from './types';

const textEncoder = new TextEncoder();
const SIGNATURE_FIELD = 'sig';
const MAX_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 200;
const MAX_PROMPT_LENGTH = 200;

const ALLOWED_KEYS: Record<CircleRecordType, readonly string[]> = {
  CircleCreated: ['type', 'circleId', 'name', 'timezone', 'creator', 'createdAt', 'sig'],
  Invite: ['type', 'circleId', 'invitee', 'inviter', 'at', 'sig'],
  Join: ['type', 'circleId', 'member', 'at', 'sig'],
  Leave: ['type', 'circleId', 'member', 'at', 'sig'],
  LinkInvite: ['type', 'circleId', 'inviter', 'planId', 'at', 'expiresAt', 'sig'],
  BanVote: ['type', 'circleId', 'voter', 'target', 'vote', 'at', 'sig'],
  Plan: ['type', 'circleId', 'rendezvousId', 'scheduledAt', 'organizer', 'invitees', 'createdAt', 'sig'],
  PlanJoin: ['type', 'circleId', 'planId', 'member', 'at', 'sig'],
  Window: ['type', 'circleId', 'start', 'end', 'author', 'createdAt', 'sig'],
  WindowClear: ['type', 'circleId', 'author', 'createdAt', 'sig'],
  Attendance: [
    'type',
    'rendezvousId',
    'scheduledAt',
    'attendee',
    'joinedAt',
    'swappedWith',
    'promptId',
    'sig',
  ],
};

const RECORD_TYPES = new Set<CircleRecordType>([
  'CircleCreated',
  'Invite',
  'Join',
  'Leave',
  'LinkInvite',
  'BanVote',
  'Plan',
  'PlanJoin',
  'Window',
  'WindowClear',
  'Attendance',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace, UTF-8
 * output. Signature fields are excluded at any depth. Array order is preserved
 * because list order is part of the signed content and is validated separately.
 */
export function canonicalString(value: unknown): string {
  const encode = (current: unknown, path: string): string => {
    if (current === null) return 'null';

    switch (typeof current) {
      case 'string':
      case 'boolean':
        return JSON.stringify(current);
      case 'number':
        if (!Number.isFinite(current)) {
          throw new Error(`Non-finite number at ${path}`);
        }
        return JSON.stringify(current);
      case 'object': {
        if (Array.isArray(current)) {
          const parts: string[] = [];
          for (let index = 0; index < current.length; index += 1) {
            if (!(index in current)) throw new Error(`Sparse array at ${path}`);
            parts.push(encode(current[index], `${path}[${index}]`));
          }
          return `[${parts.join(',')}]`;
        }
        if (!isPlainObject(current)) {
          throw new Error(`Non-plain object at ${path}`);
        }
        const keys = Object.keys(current)
          .filter((key) => key !== SIGNATURE_FIELD)
          .sort(compareStrings);
        const parts: string[] = [];
        for (const key of keys) {
          const entry = current[key];
          if (entry === undefined) throw new Error(`Undefined value at ${path}.${key}`);
          parts.push(`${JSON.stringify(key)}:${encode(entry, `${path}.${key}`)}`);
        }
        return `{${parts.join(',')}}`;
      }
      default:
        throw new Error(`Unsupported value at ${path}`);
    }
  };

  return encode(value, '$');
}

export function canonicalBytes(value: unknown): Uint8Array {
  return textEncoder.encode(canonicalString(value));
}

export function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function isStrictlySortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined) return false;
    if (compareStrings(previous, current) >= 0) return false;
  }
  return true;
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function hasOnlyAllowedKeys(record: Record<string, unknown>, type: CircleRecordType): boolean {
  const allowed = new Set(ALLOWED_KEYS[type]);
  return Object.keys(record).every((key) => allowed.has(key));
}

function hasAllKeys(
  record: Record<string, unknown>,
  type: CircleRecordType,
  requireSignature: boolean,
): boolean {
  return ALLOWED_KEYS[type].every(
    (key) => key === SIGNATURE_FIELD && !requireSignature ? true : key in record,
  );
}

function stringListProblem(value: unknown, field: string): string | null {
  if (!Array.isArray(value)) return `${field} must be an array`;
  const seen: string[] = [];
  for (const item of value) {
    if (!isNonEmptyId(item)) return `${field} must contain public-key ids`;
    seen.push(item);
  }
  if (!isStrictlySortedUnique(seen)) {
    return `${field} must be strictly sorted and free of duplicates`;
  }
  return null;
}

/**
 * Structural validation. Signature material is required unless
 * `requireSignature` is false (used while preparing a record for signing).
 */
export function recordProblem(record: unknown, requireSignature = true): string | null {
  if (!isPlainObject(record)) return 'record must be a plain object';
  const type = record.type;
  if (typeof type !== 'string' || !RECORD_TYPES.has(type as CircleRecordType)) {
    return 'unknown record type';
  }
  const recordType = type as CircleRecordType;
  if (!hasOnlyAllowedKeys(record, recordType)) return 'record contains unknown fields';
  if (!hasAllKeys(record, recordType, requireSignature)) {
    return 'record is missing required fields';
  }

  if (requireSignature) {
    if (typeof record.sig !== 'string' || record.sig.length === 0) {
      return 'sig must be a non-empty signature';
    }
  } else if (record.sig !== undefined && typeof record.sig !== 'string') {
    return 'sig must be a string';
  }

  switch (recordType) {
    case 'CircleCreated': {
      const value = record as unknown as Partial<CircleCreatedRecord>;
      if (!isNonEmptyId(value.circleId)) return 'circleId must be a non-empty id';
      if (typeof value.name !== 'string' || value.name.trim().length === 0) {
        return 'name must be non-empty';
      }
      if (value.name.length > MAX_NAME_LENGTH) return 'name is too long';
      if (typeof value.timezone !== 'string' || !isValidIanaTimeZone(value.timezone)) {
        return 'timezone must be a valid IANA timezone';
      }
      if (!isNonEmptyId(value.creator)) return 'creator must be a public-key id';
      if (!isTimestamp(value.createdAt)) return 'createdAt must be a UTC timestamp';
      return null;
    }
    case 'Invite': {
      const value = record as unknown as Partial<InviteRecord>;
      if (!isNonEmptyId(value.circleId)) return 'circleId must be a non-empty id';
      if (!isNonEmptyId(value.invitee)) return 'invitee must be a public-key id';
      if (!isNonEmptyId(value.inviter)) return 'inviter must be a public-key id';
      if (!isTimestamp(value.at)) return 'at must be a UTC timestamp';
      return null;
    }
    case 'Join': {
      const value = record as unknown as Partial<JoinRecord>;
      if (!isNonEmptyId(value.circleId)) return 'circleId must be a non-empty id';
      if (!isNonEmptyId(value.member)) return 'member must be a public-key id';
      if (!isTimestamp(value.at)) return 'at must be a UTC timestamp';
      return null;
    }
    case 'Leave': {
      const value = record as unknown as Partial<LeaveRecord>;
      if (!isNonEmptyId(value.circleId)) return 'circleId must be a non-empty id';
      if (!isNonEmptyId(value.member)) return 'member must be a public-key id';
      if (!isTimestamp(value.at)) return 'at must be a UTC timestamp';
      return null;
    }
    case 'LinkInvite': {
      const value = record as unknown as Partial<LinkInviteRecord>;
      if (!isNonEmptyId(value.circleId)) return 'circleId must be a non-empty id';
      if (!isNonEmptyId(value.inviter)) return 'inviter must be a public-key id';
      if (value.planId !== null && !isNonEmptyId(value.planId)) {
        return 'planId must be a record id or null';
      }
      if (!isTimestamp(value.at)) return 'at must be a UTC timestamp';
      if (!isTimestamp(value.expiresAt)) return 'expiresAt must be a UTC timestamp';
      if (value.expiresAt <= value.at) return 'expiresAt must follow at';
      return null;
    }
    case 'BanVote': {
      const value = record as unknown as Partial<BanVoteRecord>;
      if (!isNonEmptyId(value.circleId)) return 'circleId must be a non-empty id';
      if (!isNonEmptyId(value.voter)) return 'voter must be a public-key id';
      if (!isNonEmptyId(value.target)) return 'target must be a public-key id';
      if (value.vote !== 'ban' && value.vote !== 'unban') return 'vote must be ban or unban';
      if (!isTimestamp(value.at)) return 'at must be a UTC timestamp';
      return null;
    }
    case 'Plan': {
      const value = record as unknown as Partial<PlanRecord>;
      if (!isNonEmptyId(value.circleId)) return 'circleId must be a non-empty id';
      if (!isNonEmptyId(value.rendezvousId)) {
        return 'rendezvousId must be a non-empty id';
      }
      if (!isTimestamp(value.scheduledAt)) return 'scheduledAt must be a UTC timestamp';
      if (!isNonEmptyId(value.organizer)) return 'organizer must be a public-key id';
      if (!isTimestamp(value.createdAt)) return 'createdAt must be a UTC timestamp';
      return stringListProblem(value.invitees, 'invitees');
    }
    case 'PlanJoin': {
      const value = record as unknown as Partial<PlanJoinRecord>;
      if (!isNonEmptyId(value.circleId)) return 'circleId must be a non-empty id';
      if (!isNonEmptyId(value.planId)) return 'planId must be a non-empty id';
      if (!isNonEmptyId(value.member)) return 'member must be a public-key id';
      if (!isTimestamp(value.at)) return 'at must be a UTC timestamp';
      return null;
    }
    case 'Window': {
      const value = record as unknown as Partial<WindowRecord>;
      if (!isNonEmptyId(value.circleId)) return 'circleId must be a non-empty id';
      if (!isNonEmptyId(value.author)) return 'author must be a public-key id';
      if (!isTimestamp(value.createdAt)) return 'createdAt must be a UTC timestamp';
      if (!isTimestamp(value.start)) return 'start must be a UTC timestamp';
      if (!isTimestamp(value.end)) return 'end must be a UTC timestamp';
      if (value.start >= value.end) return 'window start must precede its end';
      return null;
    }
    case 'WindowClear': {
      const value = record as unknown as Partial<WindowClearRecord>;
      if (!isNonEmptyId(value.circleId)) return 'circleId must be a non-empty id';
      if (!isNonEmptyId(value.author)) return 'author must be a public-key id';
      if (!isTimestamp(value.createdAt)) return 'createdAt must be a UTC timestamp';
      return null;
    }
    case 'Attendance': {
      const value = record as unknown as Partial<AttendanceRecord>;
      if (!isNonEmptyId(value.rendezvousId)) {
        return 'rendezvousId must be a non-empty id';
      }
      if (!isTimestamp(value.scheduledAt)) return 'scheduledAt must be a UTC timestamp';
      if (!isNonEmptyId(value.attendee)) return 'attendee must be a public-key id';
      if (!isTimestamp(value.joinedAt)) return 'joinedAt must be a UTC timestamp';
      if (value.promptId !== null && typeof value.promptId !== 'string') {
        return 'promptId must be a string or null';
      }
      if (typeof value.promptId === 'string') {
        if (value.promptId.length === 0) return 'promptId must not be empty';
        if (value.promptId.length > MAX_PROMPT_LENGTH) return 'promptId is too long';
      }
      return stringListProblem(value.swappedWith, 'swappedWith');
    }
  }
}

export function assertRecordShape(record: unknown, requireSignature = true): asserts record is CircleRecord {
  const problem = recordProblem(record, requireSignature);
  if (problem) throw new Error(problem);
}

export async function recordId(identity: Identity, record: CircleRecord): Promise<string> {
  return identity.hash(canonicalBytes(record));
}

export async function verifyRecordSignature(
  identity: Identity,
  record: CircleRecord,
): Promise<boolean> {
  try {
    return await identity.verify(
      recordAuthor(record),
      canonicalBytes(record),
      record.sig,
    );
  } catch {
    return false;
  }
}

/** Sign an unsigned record and return the record plus its content-derived id. */
export async function signRecord(
  identity: Identity,
  unsigned: UnsignedCircleRecord,
): Promise<StoredCircleRecord> {
  assertRecordShape(unsigned, false);
  const signature = await identity.sign(canonicalBytes(unsigned));
  const record = { ...unsigned, sig: signature } as CircleRecord;
  assertRecordShape(record, true);
  return {
    id: await recordId(identity, record),
    record,
  };
}

export interface RecordVerification {
  ok: boolean;
  error?: string;
}

/** Validate shape, signature, sorted lists and the content-derived id. */
export async function verifyStoredRecord(
  identity: Identity,
  stored: StoredCircleRecord,
): Promise<RecordVerification> {
  if (!isPlainObject(stored)) return { ok: false, error: 'stored record must be an object' };
  if (typeof stored.id !== 'string' || stored.id.length === 0) {
    return { ok: false, error: 'record id must be a non-empty string' };
  }
  const problem = recordProblem(stored.record);
  if (problem) return { ok: false, error: problem };

  const expectedId = await recordId(identity, stored.record);
  if (expectedId !== stored.id) {
    return { ok: false, error: 'record id does not match its content' };
  }

  if (!(await verifyRecordSignature(identity, stored.record))) {
    return { ok: false, error: 'invalid record signature' };
  }
  return { ok: true };
}

export async function assertStoredRecord(
  identity: Identity,
  stored: StoredCircleRecord,
): Promise<void> {
  const result = await verifyStoredRecord(identity, stored);
  if (!result.ok) throw new Error(result.error ?? 'invalid record');
}
