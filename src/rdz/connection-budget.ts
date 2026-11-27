export const MAX_LIVE_PEER_CONNECTIONS = 100;

/**
 * Tracks live peer connections, not known humans. The budget is per browser.
 * A failed acquire means the UI must refuse the new transfer rather than
 * silently exceeding the cap.
 */
export class ConnectionBudget {
  private readonly live = new Set<string>();

  constructor(private readonly limit = MAX_LIVE_PEER_CONNECTIONS) {}

  get size(): number {
    return this.live.size;
  }

  has(id: string): boolean {
    return this.live.has(id);
  }

  tryAcquire(id: string): boolean {
    if (this.live.has(id)) return true;
    if (this.live.size >= this.limit) return false;
    this.live.add(id);
    return true;
  }

  release(id: string): void {
    this.live.delete(id);
  }

  clear(): void {
    this.live.clear();
  }
}
