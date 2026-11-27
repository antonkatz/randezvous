export type HumanId = string;
export type RendezvousId = string;

export interface Human {
  id: HumanId;
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
  | 'offer'
  | 'answer'
  | 'ice'
  | 'image-offer'
  | 'image-accept'
  | 'image-decline'
  | 'audio-request'
  | 'audio-accept'
  | 'audio-decline'
  | 'audio-end'
  | 'audio-mute';

export interface SignalPayload {
  kind: 'SIGNAL';
  target: HumanId;
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
  author: HumanId;
  publicKey: string;
  createdAt: number;
  payload: T;
  signature: string;
}

export interface StoredIdentity {
  key: string;
  privateKey: CryptoKey;
  publicKey: string;
  humanId: HumanId;
}

export interface VerificationRecord {
  humanId: HumanId;
  publicKey: string;
  verifiedAt: number | null;
}

export interface PinRecord {
  channelId: RendezvousId;
  label: string;
  createdAt: number;
}

export interface GoingAnnouncement {
  envelopeId: string;
  author: HumanId;
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
  sender: HumanId;
  senderWords: string[];
  senderEmoji: string[];
  verified: boolean;
  size: number;
  name: string;
  mime: string;
  receivedAt: number;
}

export interface IncomingAudioRequest {
  transferId: string;
  channelId: RendezvousId;
  sender: HumanId;
  senderWords: string[];
  senderEmoji: string[];
  verified: boolean;
  receivedAt: number;
}

export interface ImageTransferProgress {
  transferId: string;
  direction: 'outgoing' | 'incoming';
  peer: HumanId;
  name: string;
  size: number;
  phase: 'offer' | 'waiting' | 'connecting' | 'transferring' | 'done' | 'failed' | 'declined';
  transferred: number;
  error: string | null;
}

export interface AudioSession {
  transferId: string;
  peer: HumanId;
  phase: 'requesting' | 'incoming' | 'connecting' | 'live' | 'ended' | 'failed';
  startedAt: number | null;
  muted: boolean;
  remoteStream: MediaStream | null;
  error: string | null;
}
