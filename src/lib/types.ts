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
  | 'awaiting-join'
  | 'scheduled'
  | 'waiting'
  | 'connecting'
  | 'transferring'
  | 'delivered'
  | 'failed';

export interface VoiceNoteAttachment {
  blob: Blob;
  name: string;
  type: string;
  size: number;
  /** Recorded duration in milliseconds, never more than 60,000. */
  durationMs: number;
}

export interface PhotoAttachment {
  blob: Blob;
  name: string;
  type: string;
  size: number;
  /** Stable content-derived id shared by every local re-share. */
  photoId: string;
  note: VoiceNoteAttachment | null;
}

/** One delivered print on the wall. Re-shares create independent prints. */
export interface StoredPrint {
  id: string;
  appointmentId: string;
  photoId: string;
  direction: RendezvousDirection;
  peerId: string;
  peerName: string;
  photo: PhotoAttachment;
  deliveredAt: number;
  createdAt: number;
}

export type PossessionState = 'held' | 'released';

/** Latest signed possession statement from one holder about one photo. */
export interface StoredPossession {
  key: string;
  photoId: string;
  holder: string;
  state: PossessionState;
  at: number;
  appointmentId: string | null;
  /** Distinct delivery appointments seen for this holder and photo. */
  copies: number;
  updatedAt: number;
  /** Last time the owner asked this holder for a fresh check. */
  checkedAt: number | null;
}

export interface PossessionView extends StoredPossession {
  online: boolean;
  connected: boolean;
  /** True when a fresh answer arrived during this browser session. */
  confirmedNow: boolean;
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
  /** A reciprocal photo this browser attached to someone else's appointment. */
  contribution: PhotoAttachment | null;
  /** A reciprocal photo received from the other participant (outgoing record). */
  reciprocal: PhotoAttachment | null;
  /** Set when the first handoff session starts; contributions lock afterwards. */
  sessionStartedAt: number | null;
  /** Set when a live audio minute started successfully. */
  audioWindowUsedAt: number | null;
  /** Creator chose "I won't be able to speak" for this rendezvous. */
  liveAudioDisabled: boolean;
  /** Local-only invitation token while the creator waits for someone new. */
  inviteToken: string | null;
  announcedAt: number | null;
  lastAttemptAt: number | null;
  deliveredAt: number | null;
  error: string | null;
}

export type AudioPhase =
  | 'idle'
  | 'requesting'
  | 'incoming'
  | 'connecting'
  | 'live'
  | 'ended'
  | 'declined'
  | 'error';

export interface AudioSnapshot {
  rendezvousId: string | null;
  peerId: string | null;
  peerName: string;
  phase: AudioPhase;
  muted: boolean;
  remoteMuted: boolean;
  remainingMs: number;
  message: string | null;
}

export const IDLE_AUDIO: AudioSnapshot = Object.freeze({
  rendezvousId: null,
  peerId: null,
  peerName: '',
  phase: 'idle',
  muted: false,
  remoteMuted: false,
  remainingMs: 0,
  message: null,
});

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
  prints: StoredPrint[];
  possessions: PossessionView[];
  audio: AudioSnapshot;
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
  | 'invite-accepted'
  | 'join-retry'
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
  | 'audio-error'
  | 'audio-declined'
  | 'audio-ended'
  | 'possession-updated'
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

export type AppointmentPhase = 'announced' | 'open' | 'due' | 'received';

export interface AppointmentEvent {
  rendezvous: StoredRendezvous;
  phase: AppointmentPhase;
}

export interface CircleRelayEvent {
  fromId: string;
  /** Opaque signed circle-sync or circle-invitation message. */
  message: unknown;
}

export interface AppRelayEvent {
  fromId: string;
  message: unknown;
}

export interface CircleRendezvousEvent {
  fromId: string;
  invite: unknown;
}

export interface AudioEvent {
  audio: AudioSnapshot;
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
  circle: CircleRelayEvent;
  app: AppRelayEvent;
  circleRendezvous: CircleRendezvousEvent;
  audio: AudioEvent;
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
  /** Stable id when the photo is reused from the wall. */
  photoId?: string;
  note?: VoiceNoteAttachment | null;
  scheduledFor: number;
  /** Set when the creator cannot speak during this rendezvous. */
  liveAudioDisabled?: boolean;
}

export interface NewPersonScheduleInput {
  photo: File | Blob;
  fileName?: string;
  note?: VoiceNoteAttachment | null;
  scheduledFor: number;
  /** Set when the creator cannot speak during this rendezvous. */
  liveAudioDisabled?: boolean;
}

export interface ContributionInput {
  rendezvousId: string;
  photo: File | Blob;
  fileName?: string;
  photoId?: string;
  note?: VoiceNoteAttachment | null;
}
