import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { JoinRequest, RendezvousWire } from '../src/lib/protocol';

export interface StoredRemoval {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  createdAt: number;
  revokedInvites: string[];
}

interface StoreData {
  version: 1;
  joins: JoinRequest[];
  rendezvous: RendezvousWire[];
  removals: StoredRemoval[];
  revokedInvites: string[];
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function emptyStore(): StoreData {
  return { version: 1, joins: [], rendezvous: [], removals: [], revokedInvites: [] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

export class SignalStore {
  private readonly filePath: string;
  private data: StoreData = emptyStore();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isObject(parsed)) throw new Error('Store is not an object');
      const data = emptyStore();
      data.joins = Array.isArray(parsed.joins) ? parsed.joins.filter(isJoinRequest) : [];
      data.rendezvous = Array.isArray(parsed.rendezvous)
        ? parsed.rendezvous.filter(isRendezvousWire)
        : [];
      data.removals = Array.isArray(parsed.removals)
        ? parsed.removals
            .filter(isRemoval)
            .map((removal) => ({
              ...removal,
              revokedInvites: Array.isArray(removal.revokedInvites)
                ? removal.revokedInvites
                : [],
            }))
        : [];
      data.revokedInvites = Array.isArray(parsed.revokedInvites)
        ? parsed.revokedInvites.filter((hash): hash is string => typeof hash === 'string')
        : [];
      this.data = data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[store] Could not read state; starting empty:', (error as Error).message);
      }
      this.data = emptyStore();
    }
    this.prune();
  }

  private prune(): void {
    const cutoff = Date.now() - RETENTION_MS;
    this.data.joins = this.data.joins.filter((join) => join.createdAt > cutoff);
    this.data.removals = this.data.removals.filter((removal) => removal.createdAt > cutoff);
    this.data.rendezvous = this.data.rendezvous.filter(
      (rendezvous) => rendezvous.createdAt > cutoff,
    );
  }

  get joins(): readonly JoinRequest[] {
    this.data.joins = this.data.joins.filter((join) => join.createdAt > Date.now() - RETENTION_MS);
    return this.data.joins;
  }

  get rendezvous(): readonly RendezvousWire[] {
    this.data.rendezvous = this.data.rendezvous.filter(
      (rendezvous) => rendezvous.createdAt > Date.now() - RETENTION_MS,
    );
    return this.data.rendezvous;
  }

  get removals(): readonly StoredRemoval[] {
    this.data.removals = this.data.removals.filter(
      (removal) => removal.createdAt > Date.now() - RETENTION_MS,
    );
    return this.data.removals;
  }

  addJoin(join: JoinRequest): void {
    if (!this.data.joins.some((entry) => entry.id === join.id)) {
      this.data.joins.push(join);
    }
  }

  removeJoin(id: string): void {
    this.data.joins = this.data.joins.filter((entry) => entry.id !== id);
  }

  addRendezvous(rendezvous: RendezvousWire): void {
    if (!this.data.rendezvous.some((entry) => entry.id === rendezvous.id)) {
      this.data.rendezvous.push(rendezvous);
    }
  }

  removeRendezvous(id: string): void {
    this.data.rendezvous = this.data.rendezvous.filter((entry) => entry.id !== id);
  }

  addRemoval(removal: StoredRemoval): void {
    if (!this.data.removals.some((entry) => entry.id === removal.id)) {
      this.data.removals.push(removal);
    }
  }

  hasRevokedInvite(hash: string): boolean {
    return this.data.revokedInvites.includes(hash);
  }

  addRevokedInvites(hashes: string[]): void {
    const known = new Set(this.data.revokedInvites);
    for (const hash of hashes) known.add(hash);
    this.data.revokedInvites = [...known];
  }

  removeRemoval(id: string): void {
    this.data.removals = this.data.removals.filter((entry) => entry.id !== id);
  }

  cleanupPair(first: string, second: string): void {
    this.data.joins = this.data.joins.filter(
      (join) =>
        !(
          (join.from.id === first && join.to === second) ||
          (join.from.id === second && join.to === first)
        ),
    );
    this.data.rendezvous = this.data.rendezvous.filter(
      (rendezvous) =>
        !(
          (rendezvous.fromId === first && rendezvous.toId === second) ||
          (rendezvous.fromId === second && rendezvous.toId === first)
        ),
    );
  }

  async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
      await rename(tmp, this.filePath);
    });
    return this.writeChain;
  }
}

function isJoinRequest(value: unknown): value is JoinRequest {
  if (!isObject(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.token === 'string' &&
    typeof value.to === 'string' &&
    typeof value.from === 'object' &&
    value.from !== null &&
    typeof (value.from as Record<string, unknown>).id === 'string' &&
    typeof value.proof === 'string' &&
    typeof value.createdAt === 'number'
  );
}

function isRendezvousWire(value: unknown): value is RendezvousWire {
  if (!isObject(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.fromId === 'string' &&
    typeof value.fromName === 'string' &&
    typeof value.toId === 'string' &&
    typeof value.scheduledFor === 'number' &&
    typeof value.createdAt === 'number'
  );
}

function isRemoval(value: unknown): value is StoredRemoval {
  if (!isObject(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.fromId === 'string' &&
    typeof value.toId === 'string' &&
    typeof value.createdAt === 'number'
  );
}
