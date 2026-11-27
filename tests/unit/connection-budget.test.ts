import { describe, expect, it } from 'vitest';
import {
  ConnectionBudget,
  MAX_LIVE_PEER_CONNECTIONS,
} from '../../src/rdz/connection-budget';

describe('live peer connection budget', () => {
  it('allows exactly 100 live connections', () => {
    const budget = new ConnectionBudget();
    for (let index = 0; index < MAX_LIVE_PEER_CONNECTIONS; index += 1) {
      expect(budget.tryAcquire(`peer-${index}`)).toBe(true);
    }
    expect(budget.size).toBe(MAX_LIVE_PEER_CONNECTIONS);
    expect(budget.tryAcquire('one-too-many')).toBe(false);
  });

  it('reuses an existing connection id without double-counting', () => {
    const budget = new ConnectionBudget(1);
    expect(budget.tryAcquire('same')).toBe(true);
    expect(budget.tryAcquire('same')).toBe(true);
    expect(budget.size).toBe(1);
    expect(budget.tryAcquire('other')).toBe(false);
  });

  it('frees a slot when a connection closes', () => {
    const budget = new ConnectionBudget(1);
    expect(budget.tryAcquire('first')).toBe(true);
    expect(budget.tryAcquire('second')).toBe(false);
    budget.release('first');
    expect(budget.tryAcquire('second')).toBe(true);
  });
});
