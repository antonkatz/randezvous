import type {
  ClientSignalMessage,
  ServerSignalMessage,
  SignalChallenge,
  SignalHelloOk,
} from './protocol';
import type { SignalStatus } from './types';

export interface SignalTransportOptions {
  url?: string;
  getPeer: () => { id: string; name: string; publicKey: string };
  signNonce: (nonce: string) => Promise<string>;
  getSubscriptions: () => string[];
  onMessage: (message: ServerSignalMessage) => void;
  onStatus: (status: SignalStatus) => void;
  onHelloOk: (message: SignalHelloOk) => void;
}

function defaultSignalUrl(): string {
  const configured = import.meta.env.VITE_SIGNAL_URL as string | undefined;
  if (configured) return configured;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/signal`;
}

function normaliseWebSocketUrl(value: string): string {
  const url = new URL(value, window.location.href);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  return url.toString();
}

export class WebSocketSignalTransport {
  private readonly url: string;
  private readonly options: SignalTransportOptions;
  private socket: WebSocket | null = null;
  private status: SignalStatus = 'starting';
  private stopped = false;
  private connecting = false;
  private attempt = 0;
  private reconnectTimer: number | null = null;
  private handshakeTimer: number | null = null;
  private subscriptions: string[] = [];
  private helloSentForNonce: string | null = null;

  constructor(options: SignalTransportOptions) {
    this.options = options;
    this.url = normaliseWebSocketUrl(options.url?.trim() || defaultSignalUrl());
    this.subscriptions = [...options.getSubscriptions()];
  }

  get isOnline(): boolean {
    return this.status === 'online' && this.socket?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearReconnect();
    this.clearHandshakeTimer();
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close(1000, 'client stopped');
      this.socket = null;
    }
    this.setStatus('offline');
  }

  send(message: ClientSignalMessage): boolean {
    if (!this.isOnline || !this.socket) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  setSubscriptions(ids: string[]): void {
    const next = [...new Set(ids)].sort();
    if (next.join('\0') === this.subscriptions.join('\0')) return;
    this.subscriptions = next;
    if (this.isOnline) {
      this.send({ type: 'presence:subscribe', ids: next });
    }
  }

  wake(): void {
    if (this.stopped || this.status === 'replaced') return;
    if (this.connecting || this.socket?.readyState === WebSocket.OPEN) return;
    this.connect(true);
  }

  private setStatus(status: SignalStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus(status);
  }

  private connect(immediate = false): void {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    this.helloSentForNonce = null;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.connecting = false;
      this.handleDisconnect();
      return;
    }
    this.socket = socket;
    socket.onmessage = (event) => this.handleRawMessage(event.data);
    socket.onerror = () => {
      // The close handler owns reconnection.
    };
    socket.onopen = () => {
      this.connecting = false;
      if (this.handshakeTimer !== null) window.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = window.setTimeout(() => {
        if (this.status !== 'online') socket.close(4000, 'handshake timeout');
      }, 10_000);
      if (!immediate) {
        // A reconnect progresses quickly; no extra status is needed here.
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.connecting = false;
      this.socket = null;
      this.clearHandshakeTimer();
      if (event.code === 4001) {
        this.stopped = true;
        this.setStatus('replaced');
        this.options.onMessage({
          type: 'error',
          code: 'session-replaced',
          message: 'This browser identity was opened in another window.',
        });
        return;
      }
      if (this.stopped) {
        this.setStatus('offline');
        return;
      }
      this.handleDisconnect();
    };
  }

  private handleDisconnect(): void {
    this.clearHandshakeTimer();
    this.setStatus('offline');
    if (this.stopped) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.stopped) return;
    const base = Math.min(500 * 2 ** this.attempt, 15_000);
    const delay = base + Math.floor(Math.random() * 250);
    this.attempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      window.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private handleRawMessage(data: unknown): void {
    if (typeof data !== 'string' || data.length > 2_000_000) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      return;
    }

    if ((parsed as { type: string }).type === 'challenge') {
      void this.answerChallenge(parsed as SignalChallenge);
      return;
    }

    const message = parsed as ServerSignalMessage;
    if (message.type === 'hello:ok') {
      this.attempt = 0;
      this.clearHandshakeTimer();
      this.setStatus('online');
      this.options.onHelloOk(message);
    }

    if (message.type === 'error' && message.fatal) {
      this.stopped = true;
      this.setStatus('offline');
    }
    this.options.onMessage(message);
  }

  private async answerChallenge(challenge: SignalChallenge): Promise<void> {
    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      typeof challenge.nonce !== 'string' ||
      challenge.nonce.length < 16 ||
      this.helloSentForNonce === challenge.nonce
    ) {
      return;
    }
    this.helloSentForNonce = challenge.nonce;
    try {
      const identity = this.options.getPeer();
      const signature = await this.options.signNonce(challenge.nonce);
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      const hello: ClientSignalMessage = {
        type: 'hello',
        id: identity.id,
        name: identity.name,
        publicKey: identity.publicKey,
        subscribe: this.subscriptions,
        auth: {
          nonce: challenge.nonce,
          timestamp: Date.now(),
          signature,
        },
      };
      this.socket.send(JSON.stringify(hello));
    } catch {
      this.socket?.close(4002, 'authentication failed');
    }
  }
}
