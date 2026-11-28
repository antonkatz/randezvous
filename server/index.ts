import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadEnvFile } from 'node:process';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { bytesToBase64Url } from '../src/rdz/bytes';
import {
  envelopeId,
  MAX_CLOCK_SKEW_MS,
  verifyEnvelope,
  verifyText,
} from '../src/rdz/crypto';
import { humanIdFromPublicKey } from '../src/rdz/ids';
import { envelopeTransportKey, meshHelloBody } from '../src/rdz/mesh-control';
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
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

interface CachedEnvelope {
  envelope: Envelope;
  expiresAt: number;
}

interface Session {
  socket: WebSocket;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  humanId: string | null;
  publicKey: string | null;
  alive: boolean;
  remoteReady: boolean;
  pendingIce: RTCIceCandidateInit[];
  challenge: string | null;
  welcomed: boolean;
  pendingEnvelopes: string[];
}

const sessions = new Set<Session>();
const byHuman = new Map<string, Session>();
const cache = new Map<string, CachedEnvelope>();
const inFlight = new Set<string>();
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

function send(socket: WebSocket, value: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(value));
  } catch {
    socket.close();
  }
}

function sendChannel(session: Session, value: unknown): void {
  if (!session.dc || session.dc.readyState !== 'open') return;
  try {
    session.dc.send(JSON.stringify(value));
  } catch {
    // A closed channel is cleaned up by its state handler.
  }
}

function cacheExpiry(envelope: Envelope): number {
  if (envelope.type === 'PING') return envelope.createdAt + PING_TTL_MS;
  if (envelope.type === 'GOING' && envelope.payload.kind === 'GOING') {
    return envelope.payload.scheduledAt + GOING_GRACE_MS;
  }
  return envelope.createdAt + SIGNAL_TTL_MS;
}

function prune(): void {
  const now = Date.now();
  for (const [id, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(id);
  }
}

function replay(session: Session): void {
  prune();
  for (const { envelope } of cache.values()) sendChannel(session, envelope);
}

function peerList(): Array<{ humanId: string; publicKey: string }> {
  const peers: Array<{ humanId: string; publicKey: string }> = [];
  for (const session of sessions) {
    if (!session.humanId || !session.publicKey) continue;
    if (!session.dc || session.dc.readyState !== 'open') continue;
    peers.push({ humanId: session.humanId, publicKey: session.publicKey });
  }
  return peers;
}

function broadcastPeers(): void {
  const peers = peerList();
  for (const session of sessions) {
    if (!session.humanId) continue;
    sendChannel(session, {
      type: 'mesh-peers',
      peers: peers.filter((peer) => peer.humanId !== session.humanId),
    });
  }
}

function broadcast(envelope: Envelope, except: Session): void {
  for (const session of sessions) {
    if (session === except) continue;
    sendChannel(session, envelope);
  }
}

async function handleData(session: Session, raw: string): Promise<void> {
  if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  const type = (parsed as { type?: unknown }).type;

  if (type === 'mesh-hello') {
    await handleMeshHello(session, parsed);
    return;
  }
  if (!session.welcomed) {
    if (session.pendingEnvelopes.length >= 32) session.pendingEnvelopes.shift();
    session.pendingEnvelopes.push(raw);
    return;
  }
  if (type === 'mesh-peers-request') {
    broadcastPeers();
    return;
  }

  const transportKey = envelopeTransportKey(parsed);
  if (transportKey) {
    if (inFlight.has(transportKey)) return;
    inFlight.add(transportKey);
  }
  try {
    await processEnvelopeData(session, parsed);
  } finally {
    if (transportKey) inFlight.delete(transportKey);
  }
}

async function processEnvelopeData(session: Session, parsed: unknown): Promise<void> {
  const envelope = await verifyEnvelope(parsed);
  if (!envelope) return;
  if (envelope.createdAt > Date.now() + MAX_CLOCK_SKEW_MS) return;

  if (envelope.type === 'GOING' && envelope.payload.kind === 'GOING') {
    if (envelope.payload.scheduledAt + GOING_GRACE_MS <= Date.now()) return;
  }
  if (envelope.type === 'PING' && envelope.createdAt + PING_TTL_MS <= Date.now()) return;
  if (envelope.type === 'SIGNAL' && envelope.createdAt + SIGNAL_TTL_MS <= Date.now()) return;

  if (envelope.type === 'SIGNAL') {
    if (envelope.payload.kind !== 'SIGNAL') return;
    const target = byHuman.get(envelope.payload.target);
    if (target && target !== session) sendChannel(target, envelope);
    else if (!target) broadcast(envelope, session);
    return;
  }

  const id = await envelopeId(envelope);
  if (cache.has(id)) return;
  cache.set(id, { envelope, expiresAt: cacheExpiry(envelope) });
  broadcast(envelope, session);
}

async function handleMeshHello(session: Session, value: unknown): Promise<void> {
  const record = value as {
    humanId?: unknown;
    publicKey?: unknown;
    nonce?: unknown;
    signature?: unknown;
  };
  if (
    session.welcomed ||
    !session.challenge ||
    typeof record.humanId !== 'string' ||
    typeof record.publicKey !== 'string' ||
    typeof record.nonce !== 'string' ||
    typeof record.signature !== 'string' ||
    record.nonce !== session.challenge
  ) {
    return;
  }
  try {
    const derived = await humanIdFromPublicKey(record.publicKey);
    if (derived !== record.humanId) return;
    const valid = await verifyText(
      record.publicKey,
      record.signature,
      meshHelloBody(record.nonce),
    );
    if (!valid) return;
  } catch {
    return;
  }
  session.humanId = record.humanId;
  session.publicKey = record.publicKey;
  session.welcomed = true;
  byHuman.set(record.humanId, session);
  sendChannel(session, { type: 'mesh-welcome' });
  replay(session);
  broadcastPeers();
  const pending = session.pendingEnvelopes.splice(0);
  for (const raw of pending) void handleData(session, raw);
}

function onDataOpen(session: Session): void {
  if (session.humanId && byHuman.get(session.humanId) === session) {
    byHuman.delete(session.humanId);
  }
  session.humanId = null;
  session.publicKey = null;
  session.challenge = bytesToBase64Url(new Uint8Array(randomBytes(16)));
  session.welcomed = false;
  session.pendingEnvelopes = [];
  sendChannel(session, { type: 'mesh-challenge', nonce: session.challenge });
  broadcastPeers();
}

function attachChannel(session: Session, channel: RTCDataChannel): void {
  session.dc = channel;
  channel.onMessage.subscribe((data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    void handleData(session, text);
  });
  channel.stateChange.subscribe((state) => {
    if (state === 'open') {
      session.dc = channel;
      onDataOpen(session);
    } else if (state === 'closing' || state === 'closed') {
      if (session.dc === channel) session.dc = null;
      if (session.humanId && byHuman.get(session.humanId) === session) {
        byHuman.delete(session.humanId);
      }
      broadcastPeers();
    }
  });
}

async function handleBootstrap(session: Session, raw: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  const message = parsed as {
    type?: unknown;
    sdp?: unknown;
    candidate?: unknown;
  };

  if (message.type === 'PING' || message.type === 'GOING' || message.type === 'SIGNAL') {
    // FR-0: application messages are never accepted over WebSocket.
    session.socket.close(1008, 'Application messages require WebRTC');
    return;
  }

  if (message.type === 'bootstrap-offer') {
    const sdp = message.sdp as RTCSessionDescriptionInit | undefined;
    if (!sdp || typeof sdp.sdp !== 'string' || sdp.type !== 'offer') return;
    closePeerConnection(session);
    session.remoteReady = false;
    session.pendingIce = [];
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    session.pc = pc;
    pc.onDataChannel.subscribe((channel) => attachChannel(session, channel));
    pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate) return;
      send(session.socket, { type: 'bootstrap-ice', candidate: candidate.toJSON() });
    });
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed') {
        if (session.pc === pc) closePeerConnection(session);
      }
    });
    try {
      await pc.setRemoteDescription(sdp);
      session.remoteReady = true;
      for (const candidate of session.pendingIce) {
        await pc.addIceCandidate(candidate).catch(() => undefined);
      }
      session.pendingIce = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const description = pc.localDescription;
      if (description) {
        send(session.socket, {
          type: 'bootstrap-answer',
          sdp: { type: description.type, sdp: description.sdp },
        });
      }
    } catch {
      closePeerConnection(session);
    }
    return;
  }

  if (message.type === 'bootstrap-ice') {
    const candidate = message.candidate as RTCIceCandidateInit | undefined;
    if (!candidate || !session.pc) return;
    if (!session.remoteReady) {
      session.pendingIce.push(candidate);
    } else {
      await session.pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }
}

function closePeerConnection(session: Session): void {
  if (session.humanId && byHuman.get(session.humanId) === session) {
    byHuman.delete(session.humanId);
  }
  if (session.dc) {
    try {
      session.dc.close();
    } catch {
      // Ignore.
    }
    session.dc = null;
  }
  if (!session.pc) return;
  try {
    session.pc.close();
  } catch {
    // Ignore.
  }
  session.pc = null;
  session.remoteReady = false;
  session.pendingIce = [];
  session.challenge = null;
  session.welcomed = false;
  session.pendingEnvelopes = [];
}

wss.on('connection', (socket) => {
  const session: Session = {
    socket,
    pc: null,
    dc: null,
    humanId: null,
    publicKey: null,
    alive: true,
    remoteReady: false,
    pendingIce: [],
    challenge: null,
    welcomed: false,
    pendingEnvelopes: [],
  };
  sessions.add(session);

  socket.on('pong', () => {
    session.alive = true;
  });
  socket.on('message', (data) => {
    void handleBootstrap(session, String(data));
  });
  socket.on('close', () => {
    if (session.humanId && byHuman.get(session.humanId) === session) {
      byHuman.delete(session.humanId);
    }
    closePeerConnection(session);
    sessions.delete(session);
    broadcastPeers();
  });
  socket.on('error', () => socket.close());
});

const heartbeat = setInterval(() => {
  for (const session of sessions) {
    if (!session.alive) {
      session.socket.terminate();
      continue;
    }
    session.alive = false;
    try {
      session.socket.ping();
    } catch {
      session.socket.terminate();
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
        sessions: sessions.size,
        peers: peerList().length,
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
  console.log(`[rdz] headless seed peer listening on ${HOST}:${PORT} (${family})`);
});
