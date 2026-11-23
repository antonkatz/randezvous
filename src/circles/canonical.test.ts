import { describe, expect, it } from 'vitest';
import {
  canonicalBytes,
  canonicalString,
  recordId,
  recordProblem,
  signRecord,
  verifyStoredRecord,
} from './canonical';
import {
  createTestIdentity,
  makeAttendance,
  makeCircleCreated,
} from './testing';
import type { StoredCircleRecord } from './types';

describe('canonical encoding', () => {
  it('sorts object keys recursively, preserves array order and drops signatures', () => {
    const value = {
      z: 1,
      a: { d: 2, c: [3, { z: 1, y: 2 }] },
      sig: 'ignored',
      nested: { sig: 'also ignored', b: true },
    };
    expect(canonicalString(value)).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"nested":{"b":true},"z":1}',
    );
  });

  it('encodes as UTF-8 without whitespace', () => {
    const bytes = canonicalBytes({ text: 'café' });
    expect(new TextDecoder().decode(bytes)).toBe('{"text":"café"}');
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it('is stable for identical content and rejects non-finite numbers', () => {
    expect(canonicalString({ b: 2, a: 1 })).toBe(canonicalString({ a: 1, b: 2 }));
    expect(() => canonicalString({ value: Number.NaN })).toThrow(/Non-finite/u);
    expect(() => canonicalString({ value: undefined })).toThrow(/Undefined/u);
  });
});

describe('record signing and verification', () => {
  it('signs, derives a content id and verifies the stored record', async () => {
    const ana = await createTestIdentity(undefined, 'Ana');
    const record = await makeCircleCreated(ana, {
      circleId: 'circle-1',
      name: 'Sunday table',
      timezone: 'Europe/Berlin',
      createdAt: 1_700_000_000_000,
    });

    expect(record.id).toBe(await recordId(ana, record.record));
    expect(await verifyStoredRecord(ana, record)).toEqual({ ok: true });
    expect(record.record.sig.length).toBeGreaterThan(10);

    const withoutSignature = canonicalString({
      ...record.record,
      sig: 'replacement',
    });
    expect(withoutSignature).toBe(canonicalString(record.record));
  });

  it('rejects an id that does not match the content', async () => {
    const ana = await createTestIdentity();
    const record = await makeCircleCreated(ana, {
      circleId: 'circle-1',
      name: 'Sunday table',
      timezone: 'Europe/Berlin',
      createdAt: 1_700_000_000_000,
    });
    const tampered: StoredCircleRecord = { id: 'not-the-hash', record: record.record };
    await expect(verifyStoredRecord(ana, tampered)).resolves.toEqual({
      ok: false,
      error: 'record id does not match its content',
    });
  });

  it('rejects a bad signature', async () => {
    const ana = await createTestIdentity();
    const record = await makeCircleCreated(ana, {
      circleId: 'circle-1',
      name: 'Sunday table',
      timezone: 'Europe/Berlin',
      createdAt: 1_700_000_000_000,
    });
    const first = record.record.sig.charAt(0) === 'A' ? 'B' : 'A';
    const tampered: StoredCircleRecord = {
      id: record.id,
      record: { ...record.record, sig: `${first}${record.record.sig.slice(1)}` },
    };
    const result = await verifyStoredRecord(ana, tampered);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/id does not match|signature/u);
  });

  it('rejects unsorted invitee and swappedWith lists before signing', async () => {
    const ana = await createTestIdentity();
    await expect(
      signRecord(ana, {
        type: 'Plan',
        rendezvousId: 'r-1',
        scheduledAt: 100,
        organizer: ana.selfKey,
        invitees: ['z', 'a'],
      }),
    ).rejects.toThrow(/sorted/u);

    await expect(
      signRecord(ana, {
        type: 'Attendance',
        rendezvousId: 'r-1',
        scheduledAt: 100,
        attendee: ana.selfKey,
        joinedAt: 100,
        swappedWith: ['z', 'a'],
        promptId: null,
      }),
    ).rejects.toThrow(/sorted/u);
  });

  it('rejects duplicate list entries and unknown fields', async () => {
    const ana = await createTestIdentity();
    const record = await makeAttendance(ana, {
      rendezvousId: 'r-1',
      scheduledAt: 100,
      joinedAt: 100,
      swappedWith: [ana.selfKey],
    });
    expect(
      recordProblem({ ...record.record, swappedWith: [ana.selfKey, ana.selfKey] }),
    ).toMatch(/sorted/u);
    expect(recordProblem({ ...record.record, extra: true })).toMatch(/unknown fields/u);
  });
});
