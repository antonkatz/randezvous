import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadEnvFile } from 'node:process';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  base64UrlToBytes,
  derivePeerId,
  hashToken,
  isPeerId,
  isRawPublicKey,
  normalizeName,
  randomToken,
  signalAuthTranscript,
  verifyText,
} from '../src/lib/crypto';
import { verifyInviteToken, verifyJoinRequest } from '../src/lib/invite';
import type {
  CircleRendezvousInvite,
  ClientSignalMessage,
  JoinRequest,
  PresenceEntry,
  RendezvousWire,
  RtcSignalPayload,
  ServerSignalMessage,
} from '../src/lib/protocol';
import type { SignalNetworkInfo } from '../src/lib/types';
import {
  SignalStore,
  type StoredAppMessage,
  type StoredCircleRendezvous,
  type StoredRemoval,
} from './store';

// Load a local .env when present. Real deployment environment variables win.
try {
  loadEnvFile();
} catch {
  // No .env file is fine.
}

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.RENDEZVOUS_HOST?.trim() || process.env.HOST?.trim() || '::';
const IPV6_ONLY = process.env.RENDEZVOUS_IPV6_ONLY === 'true';
const DUAL_STACK = HOST === '::' && !IPV6_ONLY;
const DATA_FILE =
  process.env.RENDEZVOUS_DATA_FILE?.trim() || resolve(process.cwd(), 'data/signal-store.json');
const DIST_DIR = resolve(process.cwd(), 'dist');
const CHALLENGE_TTL_MS = 60_000;
const MAX_PENDING_RENDEZVOUS_PER_SENDER = 100;
const MAX_CIRCLE_RELAY_BYTES = 512_000;
const MAX_APP_RELAY_BYTES = 256_000;
const MAX_CIRCLE_INVITE_BYTES = 512_000;
const APP_MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A queued join is retried until the recipient acknowledges it. This heals
// dropped messages, transient client storage failures, and silently dead
// mobile sockets that the server still believes are online.
const JOIN_RETRY_MS = Math.max(
  1_000,
  Number(process.env.RENDEZVOUS_JOIN_RETRY_MS ?? 15_000) || 15_000,
);
const HEARTBEAT_MS = 30_000;
const NETWORK_WARNING = DUAL_STACK
  ? null
  : `The bootstrap server is listening on ${HOST} only. IPv6-only peers may be unable to connect. Configure a dual-stack listener (HOST="::") and a dual-stack reverse proxy.`;

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

function parseIceServers(): RTCIceServer[] {
  const raw = process.env.RENDEZVOUS_ICE_SERVERS ?? process.env.ICE_SERVERS;
  if (!raw?.trim()) return DEFAULT_ICE_SERVERS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed
      .filter((entry): entry is RTCIceServer => Boolean(entry) && typeof entry === 'object')
      .map((entry) => ({
        urls: entry.urls,
        ...(entry.username ? { username: entry.username } : {}),
        ...(entry.credential ? { credential: entry.credential } : {}),
      }))
      .filter((entry) => Boolean(entry.urls));
  } catch (error) {
    console.warn('[ice] Invalid ICE_SERVERS JSON; using STUN default:', (error as Error).message);
    return DEFAULT_ICE_SERVERS;
  }
}

const ICE_SERVERS = parseIceServers();
const store = new SignalStore(DATA_FILE);

interface ClientState {
  ws: WebSocket;
  id: string | null;
  name: string;
  publicKey: string | null;
  authenticated: boolean;
  challenge: string;
  challengeExpiresAt: number;
  subscriptions: Set<string>;
  remoteAddress: string | null;
  remoteFamily: 'IPv4' | 'IPv6' | 'unknown';
}

const clients = new Map<WebSocket, ClientState>();
const online = new Map<string, WebSocket>();
const alive = new WeakMap<WebSocket, boolean>();

function send(ws: WebSocket, message: ServerSignalMessage): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function fail(ws: WebSocket, code: string, message: string, fatal = false): void {
  send(ws, { type: 'error', code, message, fatal });
  if (fatal) ws.close(1008, code.slice(0, 100));
}

function validInviteHashes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (hash): hash is string => typeof hash === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(hash),
  );
}

function observedFamily(address: string | null, family: string | null | undefined): 'IPv4' | 'IPv6' | 'unknown' {
  if (family === 'IPv6') return address?.startsWith('::ffff:') ? 'IPv4' : 'IPv6';
  if (family === 'IPv4') return 'IPv4';
  if (!address) return 'unknown';
  return address.includes(':') ? 'IPv6' : 'IPv4';
}

function networkInfo(state: ClientState): SignalNetworkInfo {
  return {
    remoteFamily: state.remoteFamily,
    remoteAddress: state.remoteAddress,
    dualStack: DUAL_STACK,
    host: HOST,
    warning: NETWORK_WARNING,
  };
}

function authoritativePresence(id: string): PresenceEntry | null {
  const ws = online.get(id);
  if (!ws) return null;
  const state = clients.get(ws);
  if (!state?.authenticated) return null;
  return { id, name: state.name, online: true };
}

function broadcastPresence(id: string): void {
  const ws = online.get(id);
  const state = ws ? clients.get(ws) : null;
  const entry: PresenceEntry = {
    id,
    name: state?.name ?? '',
    online: Boolean(ws && state?.authenticated),
  };
  for (const watcher of clients.values()) {
    if (!watcher.authenticated || !watcher.subscriptions.has(id)) continue;
    send(watcher.ws, { type: 'presence', peers: [entry] });
  }
}

function deliverJoin(join: JoinRequest): void {
  const target = online.get(join.to);
  if (target) send(target, { type: 'invite:request', join });
}

function deliverPending(target: ClientState): void {
  if (!target.authenticated || !target.id) return;
  for (const join of store.joins) {
    if (join.to === target.id) {
      send(target.ws, { type: 'invite:request', join });
    }
  }
  for (const removal of store.removals) {
    if (removal.toId === target.id) {
      send(target.ws, {
        type: 'contact:removed',
        removalId: removal.id,
        fromId: removal.fromId,
        fromName: removal.fromName,
      });
    }
  }
  for (const rendezvous of store.rendezvous) {
    if (rendezvous.toId === target.id) {
      send(target.ws, {
        type: 'rendezvous:notice',
        rendezvous: {
          id: rendezvous.id,
          fromId: rendezvous.fromId,
          fromName: rendezvous.fromName,
          scheduledFor: rendezvous.scheduledFor,
          createdAt: rendezvous.createdAt,
          liveAudioDisabled: rendezvous.liveAudioDisabled === true,
        },
      });
    }
  }
  for (const message of store.appMessages) {
    if (message.toId === target.id) {
      send(target.ws, {
        type: 'app:relay',
        fromId: message.fromId,
        message: message.message,
        queuedId: message.id,
      });
    }
  }
  for (const entry of store.circleRendezvous) {
    if (entry.invite.recipients.includes(target.id)) {
      send(target.ws, {
        type: 'circle:rendezvous:notice',
        invite: entry.invite,
      });
    }
  }
}

function sanitizeRendezvous(value: unknown, state: ClientState): RendezvousWire | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<RendezvousWire>;
  if (
    typeof input.id !== 'string' ||
    !/^rv_[A-Za-z0-9_-]{12,32}$/u.test(input.id) ||
    typeof input.toId !== 'string' ||
    !isPeerId(input.toId) ||
    input.fromId !== state.id ||
    input.toId === state.id ||
    typeof input.scheduledFor !== 'number' ||
    !Number.isFinite(input.scheduledFor) ||
    input.scheduledFor < 0 ||
    input.scheduledFor > Date.now() + 10 * 365 * 24 * 60 * 60 * 1000 ||
    (input.liveAudioDisabled !== undefined &&
      typeof input.liveAudioDisabled !== 'boolean')
  ) {
    return null;
  }
  return {
    id: input.id,
    fromId: state.id ?? '',
    fromName: state.name,
    toId: input.toId,
    scheduledFor: input.scheduledFor,
    createdAt: Date.now(),
    liveAudioDisabled: input.liveAudioDisabled === true,
  };
}

function sanitizeRtcPayload(value: unknown): RtcSignalPayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as { kind?: unknown; sdp?: unknown; candidate?: unknown };
  if (payload.kind === 'offer' || payload.kind === 'answer') {
    if (typeof payload.sdp !== 'string' || payload.sdp.length > 800_000) return null;
    return { kind: payload.kind, sdp: payload.sdp };
  }
  if (payload.kind === 'ice') {
    if (payload.candidate === null) return { kind: 'ice', candidate: null };
    if (
      typeof payload.candidate === 'object' &&
      payload.candidate !== null &&
      typeof (payload.candidate as RTCIceCandidateInit).candidate === 'string'
    ) {
      const candidate = payload.candidate as RTCIceCandidateInit;
      return {
        kind: 'ice',
        candidate: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
          usernameFragment: candidate.usernameFragment ?? null,
        },
      };
    }
    return null;
  }
  return null;
}

async function handleHello(state: ClientState, message: Extract<ClientSignalMessage, { type: 'hello' }>): Promise<void> {
  if (state.authenticated) {
    fail(state.ws, 'already-authenticated', 'This connection is already authenticated.');
    return;
  }
  if (Date.now() > state.challengeExpiresAt) {
    fail(state.ws, 'challenge-expired', 'The authentication challenge expired.', true);
    return;
  }
  if (
    message.auth?.nonce !== state.challenge ||
    typeof message.auth.signature !== 'string' ||
    typeof message.id !== 'string' ||
    !isPeerId(message.id) ||
    typeof message.publicKey !== 'string' ||
    !isRawPublicKey(message.publicKey) ||
    !Array.isArray(message.subscribe)
  ) {
    fail(state.ws, 'invalid-hello', 'Invalid authentication response.', true);
    return;
  }
  if (
    !Number.isFinite(Number(message.auth.timestamp)) ||
    Math.abs(Date.now() - Number(message.auth.timestamp)) > CHALLENGE_TTL_MS
  ) {
    fail(state.ws, 'stale-auth', 'Authentication timestamp is outside the allowed window.', true);
    return;
  }

  const derivedId = await derivePeerId(base64UrlToBytes(message.publicKey));
  if (derivedId !== message.id) {
    fail(state.ws, 'identity-mismatch', 'Public key does not match the peer identity.', true);
    return;
  }
  const validSignature = await verifyText(
    message.publicKey,
    'rendezvous/signal-auth/v1',
    signalAuthTranscript(state.challenge),
    message.auth.signature,
  );
  if (!validSignature) {
    fail(state.ws, 'invalid-auth', 'Could not verify the identity signature.', true);
    return;
  }

  const previous = online.get(message.id);
  if (previous && previous !== state.ws) {
    previous.close(4001, 'identity opened in another window');
    online.delete(message.id);
  }

  state.authenticated = true;
  state.id = message.id;
  state.name = normalizeName(String(message.name ?? ''));
  state.publicKey = message.publicKey;
  state.subscriptions = new Set(
    message.subscribe.filter((id): id is string => typeof id === 'string' && isPeerId(id)).slice(0, 500),
  );
  online.set(message.id, state.ws);

  send(state.ws, {
    type: 'hello:ok',
    serverNow: Date.now(),
    iceServers: ICE_SERVERS,
    network: networkInfo(state),
  });

  const peers: PresenceEntry[] = [];
  for (const id of state.subscriptions) {
    const presence = authoritativePresence(id);
    peers.push(presence ?? { id, name: '', online: false });
  }
  if (peers.length > 0) send(state.ws, { type: 'presence', peers });

  deliverPending(state);

  broadcastPresence(state.id);
}

async function handleInviteJoin(state: ClientState, join: JoinRequest): Promise<void> {
  if (!state.id) return;
  if (
    !join ||
    typeof join !== 'object' ||
    typeof join.id !== 'string' ||
    !/^j_[A-Za-z0-9_-]{12,32}$/u.test(join.id) ||
    typeof join.to !== 'string' ||
    !isPeerId(join.to) ||
    join.to === state.id ||
    !join.from ||
    join.from.id !== state.id ||
    typeof join.token !== 'string'
  ) {
    fail(state.ws, 'invalid-join', 'Invalid invitation request.');
    return;
  }

  let tokenHash: string;
  try {
    const invite = await verifyInviteToken(join.token);
    if (invite.id !== join.to) throw new Error('wrong target');
    await verifyJoinRequest(join, {
      id: invite.id,
      name: invite.name,
      publicKey: invite.publicKey,
    });
    tokenHash = await hashToken(join.token);
    if (store.hasRevokedInvite(tokenHash)) {
      send(state.ws, {
        type: 'invite:rejected',
        joinId: join.id,
        inviterId: join.to,
        reason: 'This invitation has been revoked.',
      });
      return;
    }
  } catch {
    fail(state.ws, 'invalid-join-proof', 'The invitation could not be verified.');
    return;
  }

  const binding = store.inviteBinding(tokenHash);
  if (binding && binding.inviteeId !== join.from.id) {
    send(state.ws, {
      type: 'invite:rejected',
      joinId: join.id,
      inviterId: join.to,
      reason: 'This invitation has already been claimed by another browser.',
    });
    return;
  }
  if (!binding) {
    store.bindInvite({
      hash: tokenHash,
      inviterId: join.to,
      inviteeId: join.from.id,
      createdAt: Date.now(),
    });
  }

  if (!store.joins.some((entry) => entry.id === join.id)) {
    store.addJoin(join);
  }
  await store.persist();
  send(state.ws, { type: 'invite:queued', joinId: join.id });
  deliverJoin(join);
}

function handleContactRemove(
  state: ClientState,
  removalId: string,
  to: string,
  revokedInvites: unknown,
): void {
  if (!state.id || !isPeerId(to) || to === state.id || !/^rm_[A-Za-z0-9_-]{12,32}$/u.test(removalId)) {
    fail(state.ws, 'invalid-removal', 'Invalid human removal.');
    return;
  }
  const hashes = validInviteHashes(revokedInvites);
  store.addRevokedInvites(hashes);
  const removal: StoredRemoval = {
    id: removalId,
    fromId: state.id,
    fromName: state.name,
    toId: to,
    createdAt: Date.now(),
    revokedInvites: hashes,
  };
  store.addRemoval(removal);
  store.cleanupPair(state.id, to);
  void store.persist();
  send(state.ws, { type: 'contact:remove:queued', removalId });
  const target = online.get(to);
  if (target) {
    send(target, {
      type: 'contact:removed',
      removalId,
      fromId: state.id,
      fromName: state.name,
    });
  }
}

async function handleInviteReject(
  state: ClientState,
  joinId: string,
  to: string,
  revokedInvites: unknown,
): Promise<void> {
  if (!state.id || typeof joinId !== 'string' || !isPeerId(to)) return;
  const hashes = validInviteHashes(revokedInvites);
  if (hashes.length > 0) store.addRevokedInvites(hashes);
  const join = store.joins.find((entry) => entry.id === joinId && entry.to === state.id);
  if (join) store.removeJoin(joinId);
  await store.persist();
  const target = online.get(join?.from.id ?? to);
  if (target) {
    send(target, {
      type: 'invite:rejected',
      joinId,
      inviterId: state.id,
      reason: 'This invitation has been revoked.',
    });
  }
}

async function handleRendezvousCreate(state: ClientState, input: unknown): Promise<void> {
  const rendezvous = sanitizeRendezvous(input, state);
  if (!rendezvous) {
    fail(state.ws, 'invalid-rendezvous', 'Invalid rendezvous details.');
    return;
  }
  const pendingFromSender = store.rendezvous.filter(
    (entry) => entry.fromId === state.id && entry.createdAt > Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).length;
  if (pendingFromSender > MAX_PENDING_RENDEZVOUS_PER_SENDER) {
    fail(state.ws, 'rendezvous-limit', 'Too many pending rendezvous.');
    return;
  }

  store.addRendezvous(rendezvous);
  await store.persist();
  send(state.ws, { type: 'rendezvous:created', id: rendezvous.id });
  const target = online.get(rendezvous.toId);
  if (target) {
    send(target, {
      type: 'rendezvous:notice',
      rendezvous: {
        id: rendezvous.id,
        fromId: rendezvous.fromId,
        fromName: rendezvous.fromName,
        scheduledFor: rendezvous.scheduledFor,
        createdAt: rendezvous.createdAt,
        liveAudioDisabled: rendezvous.liveAudioDisabled === true,
      },
    });
  }
}

function sanitizeAppMessage(value: unknown): unknown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    return JSON.stringify(value).length > MAX_APP_RELAY_BYTES ? null : value;
  } catch {
    return null;
  }
}

function handleAppRelay(
  state: ClientState,
  to: unknown,
  message: unknown,
  queue: unknown,
): void {
  if (!state.id || typeof to !== 'string' || !isPeerId(to) || to === state.id) return;
  const payload = sanitizeAppMessage(message);
  if (!payload) return;
  const target = online.get(to);
  const targetState = target ? clients.get(target) : null;
  const mutual =
    Boolean(target && targetState?.authenticated) &&
    state.subscriptions.has(to) &&
    targetState!.subscriptions.has(state.id);

  if (target && mutual) {
    send(target, { type: 'app:relay', fromId: state.id, message: payload });
    return;
  }
  if (queue !== true) return;
  if (!state.subscriptions.has(to)) return;
  const now = Date.now();
  const stored: StoredAppMessage = {
    id: `ap_${randomToken(12)}`,
    fromId: state.id,
    toId: to,
    message: payload,
    createdAt: now,
    expiresAt: now + APP_MESSAGE_TTL_MS,
  };
  store.addAppMessage(stored);
  void store.persist();
  if (target) {
    send(target, {
      type: 'app:relay',
      fromId: state.id,
      message: payload,
      queuedId: stored.id,
    });
  }
}

function sanitizeCircleRendezvousInvite(
  value: unknown,
  state: ClientState,
): CircleRendezvousInvite | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const invite = value as Partial<CircleRendezvousInvite>;
  if (
    typeof invite.id !== 'string' ||
    !/^ri_[A-Za-z0-9_-]{8,64}$/u.test(invite.id) ||
    typeof invite.circleId !== 'string' ||
    invite.circleId.length === 0 ||
    invite.circleId.length > 512 ||
    invite.fromId !== state.id ||
    typeof invite.scheduledAt !== 'number' ||
    !Number.isFinite(invite.scheduledAt) ||
    invite.scheduledAt < 0 ||
    invite.scheduledAt > Date.now() + 10 * 365 * 24 * 60 * 60 * 1000 ||
    !Array.isArray(invite.recipients) ||
    invite.recipients.length === 0 ||
    invite.recipients.length > 500 ||
    !invite.recipients.every(
      (id): id is string => typeof id === 'string' && isPeerId(id) && id !== state.id,
    ) ||
    !invite.plan ||
    typeof invite.plan !== 'object'
  ) {
    return null;
  }
  try {
    if (JSON.stringify(invite.plan).length > MAX_CIRCLE_INVITE_BYTES) return null;
  } catch {
    return null;
  }
  return {
    id: invite.id,
    circleId: invite.circleId,
    fromId: state.id,
    fromName: state.name,
    recipients: [...new Set(invite.recipients)],
    plan: invite.plan,
    scheduledAt: invite.scheduledAt,
    createdAt: Date.now(),
  };
}

async function handleCircleRendezvousCreate(state: ClientState, value: unknown): Promise<void> {
  const invite = sanitizeCircleRendezvousInvite(value, state);
  if (!invite) {
    fail(state.ws, 'invalid-circle-invite', 'Invalid circle rendezvous invite.');
    return;
  }
  if (invite.scheduledAt <= Date.now()) {
    fail(state.ws, 'expired-circle-invite', 'That circle rendezvous has already happened.');
    return;
  }
  const entry: StoredCircleRendezvous = {
    invite,
    expiresAt: invite.scheduledAt,
  };
  store.addCircleRendezvous(entry);
  await store.persist();
  send(state.ws, { type: 'circle:rendezvous:created', id: invite.id });
  for (const recipient of invite.recipients) {
    const target = online.get(recipient);
    if (!target) continue;
    send(target, { type: 'circle:rendezvous:notice', invite });
  }
}

async function handleMessage(ws: WebSocket, message: ClientSignalMessage): Promise<void> {
  const state = clients.get(ws);
  if (!state) return;

  if (message.type === 'hello') {
    await handleHello(state, message);
    return;
  }
  if (!state.authenticated || !state.id) {
    fail(ws, 'not-authenticated', 'Authenticate before sending messages.', true);
    return;
  }

  switch (message.type) {
    case 'identity:update': {
      state.name = normalizeName(String(message.name ?? ''));
      broadcastPresence(state.id);
      break;
    }
    case 'presence:subscribe': {
      if (!Array.isArray(message.ids)) return;
      state.subscriptions = new Set(
        message.ids.filter((id): id is string => typeof id === 'string' && isPeerId(id)).slice(0, 500),
      );
      const peers: PresenceEntry[] = [];
      for (const id of state.subscriptions) {
        peers.push(authoritativePresence(id) ?? { id, name: '', online: false });
      }
      send(ws, { type: 'presence', peers });
      break;
    }
    case 'invite:join':
      await handleInviteJoin(state, message.join);
      break;
    case 'invite:ack': {
      if (typeof message.joinId !== 'string') return;
      const join = store.joins.find((entry) => entry.id === message.joinId);
      if (join?.to === state.id) {
        store.removeJoin(message.joinId);
        await store.persist();
        const sender = online.get(join.from.id);
        if (sender) {
          send(sender, {
            type: 'invite:accepted',
            joinId: join.id,
            humanId: join.to,
          });
        }
      }
      break;
    }
    case 'contact:remove':
      handleContactRemove(state, message.removalId, message.to, message.revokedInvites);
      break;
    case 'contact:remove:ack': {
      if (typeof message.removalId !== 'string') return;
      const removal = store.removals.find((entry) => entry.id === message.removalId);
      if (removal?.toId === state.id) {
        store.removeRemoval(message.removalId);
        await store.persist();
      }
      break;
    }
    case 'invite:reject':
      await handleInviteReject(state, message.joinId, message.to, message.revokedInvites);
      break;
    case 'rendezvous:create':
      await handleRendezvousCreate(state, message.rendezvous);
      break;
    case 'rendezvous:ack': {
      if (typeof message.id !== 'string') return;
      const rendezvous = store.rendezvous.find((entry) => entry.id === message.id);
      if (rendezvous?.toId === state.id) {
        store.removeRendezvous(message.id);
        await store.persist();
      }
      break;
    }
    case 'circle:relay': {
      if (
        typeof message.to !== 'string' ||
        !isPeerId(message.to) ||
        message.to === state.id ||
        !message.message ||
        typeof message.message !== 'object'
      ) {
        return;
      }
      let payloadSize = 0;
      try {
        payloadSize = JSON.stringify(message.message).length;
      } catch {
        return;
      }
      if (payloadSize > MAX_CIRCLE_RELAY_BYTES) return;
      const target = online.get(message.to);
      const targetState = target ? clients.get(target) : null;
      if (!target || !targetState?.authenticated) return;
      // Only mutual direct humans may exchange circle metadata. The circle
      // signatures and membership rules decide what is actually accepted.
      if (!state.subscriptions.has(message.to) || !targetState.subscriptions.has(state.id)) {
        return;
      }
      send(target, {
        type: 'circle:relay',
        fromId: state.id,
        message: message.message,
      });
      break;
    }
    case 'app:relay':
      handleAppRelay(state, message.to, message.message, message.queue);
      break;
    case 'app:ack': {
      if (typeof message.queuedId !== 'string') return;
      const stored = store.appMessages.find((entry) => entry.id === message.queuedId);
      if (stored?.toId === state.id) {
        store.removeAppMessage(message.queuedId);
        void store.persist();
      }
      break;
    }
    case 'circle:rendezvous:create':
      await handleCircleRendezvousCreate(state, message.invite);
      break;
    case 'rtc': {
      if (
        typeof message.to !== 'string' ||
        !isPeerId(message.to) ||
        message.to === state.id ||
        typeof message.transferId !== 'string' ||
        message.transferId.length < 4 ||
        message.transferId.length > 128
      ) {
        return;
      }
      const payload = sanitizeRtcPayload(message.payload);
      if (!payload) return;
      const target = online.get(message.to);
      if (!target) return;
      send(target, {
        type: 'rtc',
        fromId: state.id,
        transferId: message.transferId,
        payload,
      });
      break;
    }
    default:
      break;
  }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400).end('Bad request');
      return;
    }
    let filePath = resolve(DIST_DIR, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!filePath.startsWith(`${DIST_DIR}${sep}`) && filePath !== DIST_DIR) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    let file;
    try {
      const info = await stat(filePath);
      if (info.isDirectory()) filePath = resolve(filePath, 'index.html');
      file = await readFile(filePath);
    } catch {
      if (request.headers.accept?.includes('text/html')) {
        file = await readFile(resolve(DIST_DIR, 'index.html'));
        filePath = resolve(DIST_DIR, 'index.html');
      } else {
        response.writeHead(404).end('Not found');
        return;
      }
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': filePath.endsWith('index.html')
        ? 'no-cache'
        : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    response.end(file);
  } catch {
    response.writeHead(500).end('Server error');
  }
}

const httpServer = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    response.end(
      JSON.stringify({
        ok: true,
        service: 'rendezvous-signal',
        online: online.size,
        network: {
          host: HOST,
          dualStack: DUAL_STACK,
          ipv6Only: IPV6_ONLY,
          warning: NETWORK_WARNING,
        },
        retentionDays: 30,
        storesPhotos: false,
      }),
    );
    return;
  }
  void serveStatic(request, response);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000, perMessageDeflate: false });

httpServer.on('upgrade', (request, socket, head) => {
  let pathname = '';
  try {
    pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (pathname !== '/signal') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws, request) => {
  const remoteAddress = request.socket.remoteAddress ?? null;
  const state: ClientState = {
    ws,
    id: null,
    name: '',
    publicKey: null,
    authenticated: false,
    challenge: randomToken(24),
    challengeExpiresAt: Date.now() + CHALLENGE_TTL_MS,
    subscriptions: new Set(),
    remoteAddress,
    remoteFamily: observedFamily(remoteAddress, request.socket.remoteFamily),
  };
  clients.set(ws, state);
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));
  send(ws, {
    type: 'challenge',
    nonce: state.challenge,
    expiresAt: state.challengeExpiresAt,
  });

  ws.on('message', (raw) => {
    const rawSize = Array.isArray(raw)
      ? raw.reduce((sum, part) => sum + part.byteLength, 0)
      : raw instanceof ArrayBuffer
        ? raw.byteLength
        : raw.byteLength;
    if (rawSize > 1_000_000) {
      ws.close(1009, 'message too large');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      fail(ws, 'invalid-json', 'Messages must be JSON.');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || typeof (parsed as { type?: unknown }).type !== 'string') {
      fail(ws, 'invalid-message', 'Invalid message.');
      return;
    }
    void handleMessage(ws, parsed as ClientSignalMessage).catch((error: unknown) => {
      console.error('[signal] message handler error:', error);
      fail(ws, 'server-error', 'The signalling server could not process that message.', true);
    });
  });

  ws.on('close', () => {
    const current = clients.get(ws);
    clients.delete(ws);
    if (!current?.id) return;
    if (online.get(current.id) !== ws) return;
    online.delete(current.id);
    broadcastPresence(current.id);
  });

  ws.on('error', () => {
    // The close handler performs cleanup.
  });
});

// Re-send unacknowledged joins to online recipients. The recipient acks only
// after it has persisted the human, so this retries until the link is durable.
const joinRetryTimer = setInterval(() => {
  for (const join of store.joins) {
    deliverJoin(join);
  }
}, JOIN_RETRY_MS);

// Detect mobile browsers that disappear without closing their socket: the
// server keeps thinking they are online and their pending joins never arrive.
const heartbeatTimer = setInterval(() => {
  for (const ws of [...wss.clients]) {
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, HEARTBEAT_MS);

await store.load();
console.log(
  `[store] loaded ${store.joins.length} join(s), ${store.rendezvous.length} rendezvous notice(s)`,
);

httpServer.listen(
  {
    port: PORT,
    host: HOST,
    ...(HOST.includes(':') ? { ipv6Only: IPV6_ONLY } : {}),
  },
  () => {
    const protocol = HOST.includes(':') ? `http://[${HOST}]` : `http://${HOST}`;
    console.log(`[signal] Rendezvous signal listening on ${protocol}:${PORT}`);
    if (DUAL_STACK) {
      console.log('[signal] dual-stack listener enabled (IPv4 + IPv6)');
    } else {
      console.warn(
        `[signal] WARNING: not dual-stack (HOST=${HOST}). ` +
          'IPv6-only peers may fail to reach the bootstrap server. Bind HOST="::" and use a dual-stack reverse proxy.',
      );
    }
    console.log(`[signal] state: ${DATA_FILE}`);
    console.log(
      `[signal] ICE servers: ${ICE_SERVERS.map((server) =>
        Array.isArray(server.urls) ? server.urls.join(', ') : server.urls,
      ).join(' | ')}`,
    );
  },
);

async function shutdown(signal: string): Promise<void> {
  console.log(`[signal] ${signal}; shutting down`);
  clearInterval(joinRetryTimer);
  clearInterval(heartbeatTimer);
  await store.persist().catch(() => undefined);
  httpServer.close();
  wss.close();
  setTimeout(() => process.exit(0), 200);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
