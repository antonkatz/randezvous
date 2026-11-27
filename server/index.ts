import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadEnvFile } from 'node:process';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { canonicalJson, utf8 } from '../src/rdz/bytes';
import { verifyEnvelope } from '../src/rdz/crypto';
import type { Envelope } from '../src/rdz/types';

try {
  loadEnvFile();
} catch {
  // A local .env is optional.
}

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.RENDEZVOUS_HOST?.trim() || process.env.HOST?.trim() || '::';
const DIST_DIR = resolve(process.cwd(), 'dist');
const MAX_MESSAGE_BYTES = 200_000;
const PING_TTL_MS = 5 * 60 * 1000;
const GOING_GRACE_MS = 3 * 60 * 1000;
const SIGNAL_TTL_MS = 2 * 60 * 1000;
const HEARTBEAT_MS = 30_000;

interface CachedEnvelope {
  envelope: Envelope;
  expiresAt: number;
}

interface ClientState {
  socket: WebSocket;
  humanId: string | null;
  alive: boolean;
}

const clients = new Map<WebSocket, ClientState>();
const byHuman = new Map<string, WebSocket>();
const cache = new Map<string, CachedEnvelope>();
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(value));
  } catch {
    socket.close();
  }
}

function messageId(envelope: Envelope): string {
  return canonicalJson(envelope);
}

function cacheExpiry(envelope: Envelope): number {
  if (envelope.type === 'PING') return envelope.createdAt + PING_TTL_MS;
  if (envelope.type === 'GOING' && envelope.payload.kind === 'GOING') {
    return envelope.payload.scheduledAt + GOING_GRACE_MS;
  }
  return envelope.createdAt + SIGNAL_TTL_MS;
}

function isExpired(entry: CachedEnvelope, now = Date.now()): boolean {
  return entry.expiresAt <= now;
}

function prune(): void {
  const now = Date.now();
  for (const [id, entry] of cache) {
    if (isExpired(entry, now)) cache.delete(id);
  }
}

function snapshot(socket: WebSocket): void {
  prune();
  for (const { envelope } of cache.values()) send(socket, envelope);
}

function broadcast(envelope: Envelope, except: WebSocket): void {
  for (const state of clients.values()) {
    if (state.socket !== except) send(state.socket, envelope);
  }
}

async function handleEnvelope(socket: WebSocket, raw: string): Promise<void> {
  if (utf8(raw).length > MAX_MESSAGE_BYTES) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const envelope = await verifyEnvelope(parsed);
  if (!envelope) return;

  const state = clients.get(socket);
  if (!state) return;
  if (state.humanId && state.humanId !== envelope.author) return;
  state.humanId = envelope.author;
  byHuman.set(envelope.author, socket);

  if (envelope.createdAt > Date.now() + 1_000) return;
  if (envelope.type === 'GOING' && envelope.payload.kind === 'GOING') {
    if (envelope.payload.scheduledAt + GOING_GRACE_MS <= Date.now()) return;
  }
  if (envelope.type === 'PING' && envelope.createdAt + PING_TTL_MS <= Date.now()) return;
  if (envelope.type === 'SIGNAL' && envelope.createdAt + SIGNAL_TTL_MS <= Date.now()) return;

  if (envelope.type === 'SIGNAL' && envelope.payload.kind === 'SIGNAL') {
    const target = byHuman.get(envelope.payload.target);
    if (target) send(target, envelope);
    return;
  }

  const id = messageId(envelope);
  if (cache.has(id)) return;
  cache.set(id, { envelope, expiresAt: cacheExpiry(envelope) });
  broadcast(envelope, socket);
}

wss.on('connection', (socket) => {
  const state: ClientState = { socket, humanId: null, alive: true };
  clients.set(socket, state);
  snapshot(socket);

  socket.on('pong', () => {
    state.alive = true;
  });
  socket.on('message', (data) => {
    void handleEnvelope(socket, String(data));
  });
  socket.on('close', () => {
    clients.delete(socket);
    if (state.humanId && byHuman.get(state.humanId) === socket) byHuman.delete(state.humanId);
  });
  socket.on('error', () => socket.close());
});

const heartbeat = setInterval(() => {
  for (const state of clients.values()) {
    if (!state.alive) {
      state.socket.terminate();
      continue;
    }
    state.alive = false;
    try {
      state.socket.ping();
    } catch {
      state.socket.terminate();
    }
  }
  prune();
}, HEARTBEAT_MS);
heartbeat.unref();

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const resolved = resolve(DIST_DIR, `.${requested}`);
  if (!resolved.startsWith(DIST_DIR + sep) && resolved !== resolve(DIST_DIR, 'index.html')) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(resolved);
    response.writeHead(200, {
      'content-type': MIME[extname(resolved)] ?? 'application/octet-stream',
      'cache-control': requested === '/index.html' ? 'no-cache' : 'public, max-age=3600',
    });
    response.end(body);
  } catch {
    try {
      const body = await readFile(resolve(DIST_DIR, 'index.html'));
      response.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  }
}

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        ok: true,
        clients: clients.size,
        cached: cache.size,
        dualStack: HOST === '::',
      }),
    );
    return;
  }
  if (url.pathname === '/signal') {
    response.writeHead(426).end('Upgrade required');
    return;
  }
  void serveStatic(url.pathname, response);
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/signal') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

server.listen(PORT, HOST, () => {
  const family = HOST === '::' ? 'dual-stack' : HOST;
  console.log(`[rdz] seed peer listening on ${HOST}:${PORT} (${family})`);
});
