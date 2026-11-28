export type BeingId = string;
export type RendezvousId = string;

export interface Being {
  id: BeingId;
  publicKey: string;
  words: string[];
  emoji: string[];
  lastSeen: number;
  verified: boolean;
}

export interface PingPayload {
  kind: 'PING';
}

export interface GoingPayload {
  kind: 'GOING';
  rendezvousId: RendezvousId;
  scheduledAt: number;
}

export type SignalKind =
  | 'mesh-offer'
  | 'mesh-answer'
  | 'mesh-ice'
  | 'offer'
  | 'answer'
  | 'ice'
  | 'image-offer'
  | 'image-accept'
  | 'image-decline'
  | 'audio-request'
  | 'audio-accepting'
  | 'audio-accept'
  | 'audio-decline'
  | 'audio-end'
  | 'audio-mute';

export interface SignalPayload {
  kind: 'SIGNAL';
  target: BeingId;
  channelId: RendezvousId;
  signal: SignalKind;
  transferId: string;
  data?: unknown;
}

export type EnvelopePayload = PingPayload | GoingPayload | SignalPayload;
export type EnvelopeType = EnvelopePayload['kind'];

export interface Envelope<T extends EnvelopePayload = EnvelopePayload> {
  v: 1;
  type: T['kind'];
  author: BeingId;
  publicKey: string;
  createdAt: number;
  payload: T;
  signature: string;
}

export interface StoredIdentity {
  privateKey: CryptoKey;
  publicKey: string;
  humanId: BeingId;
}

export interface MaskRecord extends StoredIdentity {
  id: string;
  createdAt: number;
  /** Limit direct mesh links and SIGNAL traffic to locally verified beings. */
  verifiedOnlySignalling: boolean;
}

export interface MaskState {
  masks: MaskRecord[];
  activeMaskId: string;
}

export interface MaskVerificationRecord extends VerificationRecord {
  id: string;
  maskId: string;
}

export interface VerificationRecord {
  humanId: BeingId;
  publicKey: string;
  verifiedAt: number | null;
}

export interface MeshPeerInfo {
  humanId: BeingId;
  publicKey: string;
}

export interface PinRecord {
  channelId: RendezvousId;
  label: string;
  createdAt: number;
}

export interface PeerRecord {
  humanId: BeingId;
  publicKey: string;
  lastSeen: number;
}

export interface GoingAnnouncement {
  envelopeId: string;
  author: BeingId;
  publicKey: string;
  channelId: RendezvousId;
  scheduledAt: number;
  createdAt: number;
}

export interface ChannelView {
  id: RendezvousId;
  announcements: GoingAnnouncement[];
  nextAt: number;
  pinnedLabel: string | null;
}

export interface IncomingImageOffer {
  transferId: string;
  channelId: RendezvousId;
  sender: BeingId;
  senderWords: string[];
  senderEmoji: string[];
  verified: boolean;
  sizeMb: number;
  receivedAt: number;
}

export interface IncomingAudioRequest {
  transferId: string;
  channelId: RendezvousId;
  sender: BeingId;
  senderWords: string[];
  senderEmoji: string[];
  verified: boolean;
  receivedAt: number;
}

export interface ImageTransferProgress {
  transferId: string;
  direction: 'outgoing' | 'incoming';
  peer: BeingId;
  name: string;
  size: number;
  phase: 'offer' | 'waiting' | 'connecting' | 'transferring' | 'done' | 'failed' | 'declined' | 'cancelled';
  transferred: number;
  error: string | null;
}

export interface AudioSession {
  transferId: string;
  peer: BeingId;
  phase: 'requesting' | 'incoming' | 'connecting' | 'live' | 'ended' | 'failed';
  startedAt: number | null;
  muted: boolean;
  remoteStream: MediaStream | null;
  error: string | null;
}
