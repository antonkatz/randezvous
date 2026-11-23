/** Public, shareable identity. `publicKey` is a base64url-encoded raw P-256 key. */
export interface PublicIdentity {
  id: string;
  name: string;
  publicKey: string;
}

/** Full local identity. Never exposed in snapshots or events. */
export interface StoredIdentity extends PublicIdentity {
  key: 'self';
  privateKey: CryptoKey;
  createdAt: number;
}

export type SignalStatus = 'starting' | 'connecting' | 'online' | 'offline' | 'replaced';

export interface StoredHuman {
  id: string;
  name: string;
  /** Pinned, base64url raw P-256 public key. */
  publicKey: string;
  addedAt: number;
  verifiedAt: number | null;
  /** Invite token hashes associated with this relationship, revoked on removal. */
  inviteHashes: string[];
}

export interface Human extends StoredHuman {
  online: boolean;
  lastSeenAt: number | null;
  /** Set only if a presence claim conflicts with the pinned key. */
  keyMismatch?: boolean;
}

export type RendezvousDirection = 'outgoing' | 'incoming';

export type RendezvousStatus =
  | 'scheduled'
  | 'waiting'
  | 'connecting'
  | 'transferring'
  | 'delivered'
  | 'failed';

export interface PhotoAttachment {
  blob: Blob;
  name: string;
  type: string;
  size: number;
}

export interface StoredRendezvous {
  id: string;
  direction: RendezvousDirection;
  peerId: string;
  peerName: string;
  createdAt: number;
  scheduledFor: number;
  status: RendezvousStatus;
  /** Present on outgoing appointments from the start; on incoming after receipt. */
  photo: PhotoAttachment | null;
  announcedAt: number | null;
  lastAttemptAt: number | null;
  deliveredAt: number | null;
  error: string | null;
}

export interface SignalNetworkInfo {
  remoteFamily: 'IPv4' | 'IPv6' | 'unknown';
  remoteAddress: string | null;
  dualStack: boolean;
  host: string;
  /** Human-readable warning if the bootstrap server is not dual-stack. */
  warning: string | null;
}

export type IpFamily = 'IPv4' | 'IPv6' | 'unknown';

export interface IceFamilyCounts {
  ipv4: number;
  ipv6: number;
  unknown: number;
}

export interface TransferDiagnostics {
  transferId: string;
  at: number;
  localCandidates: IceFamilyCounts;
  remoteCandidates: IceFamilyCounts;
  selected: {
    localFamily: IpFamily;
    remoteFamily: IpFamily;
    localType: string;
    remoteType: string;
    protocol: string;
  } | null;
}

export interface RendezvousSnapshot {
  ready: boolean;
  identity: PublicIdentity;
  signal: SignalStatus;
  network: SignalNetworkInfo | null;
  lastTransferDiagnostics: TransferDiagnostics | null;
  humans: Human[];
  rendezvous: StoredRendezvous[];
}

export interface RendezvousError extends Error {
  code: string;
}

export type NoticeCode =
  | 'human-added'
  | 'human-joined'
  | 'human-removed'
  | 'human-removed-remotely'
  | 'invite-queued'
  | 'invalid-invite'
  | 'own-invite'
  | 'already-human'
  | 'photo-too-large'
  | 'invalid-photo'
  | 'invalid-time'
  | 'no-human'
  | 'signal-restored'
  | 'signal-lost'
  | 'signal-replaced'
  | 'transfer-failed'
  | 'handshake-failed'
  | 'transfer-delivered'
  | 'photo-received'
  | 'server-error'
  | 'storage-error'
  | 'key-mismatch'
  | 'invite-revoked';

export interface ClientNotice {
  tone: 'info' | 'success' | 'warning' | 'error';
  code: NoticeCode;
  message: string;
  humanId?: string;
  rendezvousId?: string;
}

export type AppointmentPhase = 'announced' | 'due' | 'received';

export interface AppointmentEvent {
  rendezvous: StoredRendezvous;
  phase: AppointmentPhase;
}

export interface TransferEvent {
  rendezvousId: string;
  peerId: string;
  direction: RendezvousDirection;
  phase: 'connecting' | 'progress' | 'complete' | 'error';
  transferred: number;
  total: number;
  message?: string;
}

export interface RendezvousClientEvents {
  state: RendezvousSnapshot;
  notice: ClientNotice;
  appointment: AppointmentEvent;
  transfer: TransferEvent;
}

export interface RendezvousClientOptions {
  signalUrl?: string;
  iceServers?: RTCIceServer[];
  /** Used to namespace data if multiple instances share an origin. */
  storageName?: string;
  fetchIceServers?: boolean;
}

export interface ScheduleInput {
  humanId: string;
  photo: File | Blob;
  fileName?: string;
  scheduledFor: number;
}
