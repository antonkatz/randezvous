import type { Envelope } from './types';

export type RelayStatus = 'connecting' | 'online' | 'offline';

interface RelayOptions {
  url: string;
  onEnvelope: (value: unknown) => void;
  onStatus: (status: RelayStatus) => void;
}

export class RelayClient {
  private socket: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private queue: Envelope[] = [];
  private status: RelayStatus = 'offline';

  constructor(private readonly options: RelayOptions) {}

  get currentStatus(): RelayStatus {
    return this.status;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
    this.setStatus('offline');
  }

  send(envelope: Envelope): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(envelope));
      return;
    }
    this.queue.push(envelope);
    if (this.queue.length > 200) this.queue.shift();
  }

  private connect(): void {
    if (this.stopped) return;
    this.setStatus('connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.setStatus('online');
      const queued = this.queue;
      this.queue = [];
      for (const envelope of queued) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(envelope));
      }
    });
    socket.addEventListener('message', (event) => {
      try {
        this.options.onEnvelope(JSON.parse(String(event.data)));
      } catch {
        // Malformed relay traffic is ignored.
      }
    });
    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      this.setStatus('offline');
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      socket.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    const base = Math.min(30_000, 500 * 2 ** this.attempt);
    const jitter = Math.floor(Math.random() * 500);
    this.attempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, base + jitter);
  }

  private setStatus(status: RelayStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus(status);
  }
}

export function resolveRelayUrl(): string {
  const params = new URLSearchParams(window.location.search);
  const override = params.get('seed');
  if (override === 'off') return '';
  if (override) return override;
  const configured = import.meta.env.VITE_SEED_URL as string | undefined;
  if (configured?.trim()) return configured.trim();
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === 'randezvous.instanthero.ca') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}/signal`;
  }
  return 'wss://randezvous.instanthero.ca/signal';
}
