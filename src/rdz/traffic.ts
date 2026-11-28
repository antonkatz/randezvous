import type { Envelope, EnvelopeType, HumanId, SignalKind } from './types';

export type TrafficDirection = 'coming' | 'going' | 'relaying';
export type TrafficPeer = HumanId | 'seed' | null;
export type TrafficPeerRole = 'from' | 'to' | null;
export type TrafficFilter = TrafficDirection | 'all';

export interface TrafficReport {
  direction: TrafficDirection;
  envelope: Envelope;
  peer?: TrafficPeer;
  peerRole?: TrafficPeerRole;
  destinations?: number;
  replayed?: boolean;
  bytes?: number;
}

export interface TrafficEvent {
  seq: number;
  at: number;
  direction: TrafficDirection;
  type: EnvelopeType;
  author: HumanId;
  createdAt: number;
  bytes: number;
  peer: TrafficPeer;
  peerRole: TrafficPeerRole;
  destinations: number;
  replayed: boolean;
  signal: SignalKind | null;
  target: HumanId | null;
  channelId: string | null;
}

export const DEFAULT_TRAFFIC_LIMIT = 250;

/**
 * A bounded, session-only view of signed envelopes crossing this browser's
 * mesh. It stores routing metadata and sizes, never payload bodies.
 */
export class TrafficLog {
  private readonly events: TrafficEvent[] = [];
  private nextSeq = 1;

  constructor(private readonly limit: number = DEFAULT_TRAFFIC_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('Traffic limit must be a positive integer.');
    }
  }

  get size(): number {
    return this.events.length;
  }

  record(report: TrafficReport, at = Date.now()): TrafficEvent {
    const payload = report.envelope.payload;
    const event: TrafficEvent = {
      seq: this.nextSeq,
      at,
      direction: report.direction,
      type: report.envelope.type,
      author: report.envelope.author,
      createdAt: report.envelope.createdAt,
      bytes: Math.max(0, Math.floor(report.bytes ?? 0)),
      peer: report.peer ?? null,
      peerRole: report.peerRole ?? null,
      destinations: Math.max(0, Math.floor(report.destinations ?? 0)),
      replayed: Boolean(report.replayed),
      signal: payload.kind === 'SIGNAL' ? payload.signal : null,
      target: payload.kind === 'SIGNAL' ? payload.target : null,
      channelId:
        payload.kind === 'GOING'
          ? payload.rendezvousId
          : payload.kind === 'SIGNAL' && payload.channelId
            ? payload.channelId
            : null,
    };
    this.nextSeq += 1;
    this.events.unshift(event);
    if (this.events.length > this.limit) this.events.length = this.limit;
    return event;
  }

  all(): readonly TrafficEvent[] {
    return this.events;
  }

  filtered(direction: TrafficFilter): readonly TrafficEvent[] {
    if (direction === 'all') return this.events;
    return this.events.filter((event) => event.direction === direction);
  }

  counts(): Record<TrafficDirection, number> {
    const counts: Record<TrafficDirection, number> = {
      coming: 0,
      going: 0,
      relaying: 0,
    };
    for (const event of this.events) counts[event.direction] += 1;
    return counts;
  }

  clear(): void {
    this.events.length = 0;
  }
}
