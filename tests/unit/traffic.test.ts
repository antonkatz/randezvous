import { describe, expect, it } from 'vitest';
import { TrafficLog } from '../../src/rdz/traffic';
import type { Envelope, GoingPayload, PingPayload, SignalPayload } from '../../src/rdz/types';

function envelope<T extends PingPayload | GoingPayload | SignalPayload>(
  payload: T,
  author = 'author-id',
  createdAt = 1_000,
): Envelope<T> {
  return {
    v: 1,
    type: payload.kind,
    author,
    publicKey: `pk-${author}`,
    createdAt,
    payload,
    signature: 'signature',
  };
}

describe('traffic log', () => {
  it('keeps newest events first and assigns sequence numbers', () => {
    const log = new TrafficLog();
    log.record({ direction: 'coming', envelope: envelope({ kind: 'PING' }) }, 10);
    log.record(
      { direction: 'going', envelope: envelope({ kind: 'PING' }, 'self-id'), destinations: 2 },
      20,
    );

    expect(log.all().map((event) => event.seq)).toEqual([2, 1]);
    expect(log.all()[0]?.direction).toBe('going');
    expect(log.all()[0]?.destinations).toBe(2);
    expect(log.all()[1]?.direction).toBe('coming');
  });

  it('extracts GOING and SIGNAL routing metadata without payload bodies', () => {
    const log = new TrafficLog();
    const going = log.record({
      direction: 'coming',
      envelope: envelope({
        kind: 'GOING',
        rendezvousId: 'rendezvous-id',
        scheduledAt: 42_000,
      }),
      peer: 'peer-id',
      peerRole: 'from',
    });
    const signal = log.record({
      direction: 'relaying',
      envelope: envelope({
        kind: 'SIGNAL',
        target: 'target-id',
        channelId: 'channel-id',
        signal: 'mesh-ice',
        transferId: 'transfer-id',
        data: { candidate: 'secret-sdp-candidate' },
      }),
      peer: 'peer-id',
      peerRole: 'from',
      destinations: 3,
    });

    expect(going.channelId).toBe('rendezvous-id');
    expect(going.signal).toBeNull();
    expect(going.target).toBeNull();
    expect(signal.signal).toBe('mesh-ice');
    expect(signal.target).toBe('target-id');
    expect(signal.channelId).toBe('channel-id');
    expect(signal.destinations).toBe(3);
    expect(signal).not.toHaveProperty('data');
  });

  it('caps retained events and counts only what remains', () => {
    const log = new TrafficLog(3);
    for (let index = 0; index < 5; index += 1) {
      log.record({ direction: 'coming', envelope: envelope({ kind: 'PING' }) }, index);
    }

    expect(log.size).toBe(3);
    expect(log.all().map((event) => event.seq)).toEqual([5, 4, 3]);
    expect(log.counts()).toEqual({ coming: 3, going: 0, relaying: 0 });
  });

  it('filters by direction and clears the log', () => {
    const log = new TrafficLog();
    log.record({ direction: 'coming', envelope: envelope({ kind: 'PING' }) });
    log.record({ direction: 'going', envelope: envelope({ kind: 'PING' }, 'self-id') });
    log.record({ direction: 'relaying', envelope: envelope({ kind: 'PING' }), destinations: 2 });

    expect(log.filtered('coming')).toHaveLength(1);
    expect(log.filtered('going')).toHaveLength(1);
    expect(log.filtered('relaying')).toHaveLength(1);
    expect(log.filtered('all')).toHaveLength(3);

    log.clear();
    expect(log.size).toBe(0);
    expect(log.counts()).toEqual({ coming: 0, going: 0, relaying: 0 });
  });

  it('rejects a non-positive limit', () => {
    expect(() => new TrafficLog(0)).toThrow(RangeError);
  });
});
