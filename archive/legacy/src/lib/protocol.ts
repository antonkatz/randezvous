import type { SignalNetworkInfo } from './types';

export interface PublicIdentityClaim {
  id: string;
  name: string;
  publicKey: string;
}

export interface InviteRendezvous {
  id: string;
  scheduledFor: number;
  createdAt: number;
  liveAudioDisabled?: boolean;
  /** The creator's public identity, so a link can carry a multi-person list. */
  creatorId?: string;
  creatorName?: string;
  /** Every invited participant, including the creator. */
  participants?: Array<{ id: string; name: string }>;
  circleId?: string;
}

/**
 * Self-contained circle data carried by a circle rendezvous link. The records
 * are already signed by their authors; the token signature covers this object
 * as well, so the inviter cannot be impersonated.
 */
export interface InviteCircle {
  id: string;
  /** Content id of the signed LinkInvite record inside `records`. */
  linkId: string;
  /** Membership proof plus the new LinkInvite record. */
  records: unknown[];
  /** Optional signed Plan for the circle rendezvous this link belongs to. */
  plan?: unknown;
  /** Public keys for record authors, keyed by public-key id. */
  keys: Record<string, string>;
}

export interface InvitePayload {
  v: 1;
  id: string;
  name: string;
  publicKey: string;
  issuedAt: number;
  nonce: string;
  /**
   * The already-saved appointment this invitation carries. Older links omit
   * it and only establish the human relationship.
   */
  rendezvous?: InviteRendezvous;
  /**
   * Legacy circle hint for links that only start membership with the inviter
   * online. New links carry the self-contained `circle` object instead.
   */
  circleId?: string;
  /**
   * When present, redeeming this link signs a Join and appends the included
   * membership records locally. No inviter connection is required.
   */
  circle?: InviteCircle;
}

export interface JoinRequest {
  id: string;
  token: string;
  to: string;
  from: PublicIdentityClaim;
  proof: string;
  createdAt: number;
}

export interface SignalHello {
  type: 'hello';
  id: string;
  name: string;
  publicKey: string;
  subscribe: string[];
  auth: {
    nonce: string;
    timestamp: number;
    signature: string;
  };
}

export interface SignalIdentityUpdate {
  type: 'identity:update';
  name: string;
}

export interface SignalPresenceSubscribe {
  type: 'presence:subscribe';
  ids: string[];
}

export interface SignalInviteJoin {
  type: 'invite:join';
  join: JoinRequest;
}

export interface SignalInviteAck {
  type: 'invite:ack';
  joinId: string;
}

export interface SignalContactRemove {
  type: 'contact:remove';
  removalId: string;
  to: string;
  revokedInvites?: string[];
}

export interface SignalInviteReject {
  type: 'invite:reject';
  joinId: string;
  to: string;
  revokedInvites: string[];
}

export interface SignalContactRemoveAck {
  type: 'contact:remove:ack';
  removalId: string;
}

export interface RendezvousWire {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  scheduledFor: number;
  createdAt: number;
  liveAudioDisabled?: boolean;
  /** The creator of the rendezvous; updates may come from any participant. */
  creatorId?: string;
  /** Every invited participant, including the creator. */
  participants?: Array<{ id: string; name: string }>;
  /** Every invitee named by the creator, including this recipient. */
  recipientIds?: string[];
  /** Set when this rendezvous was posted to a circle channel. */
  circleId?: string;
  /** Who proposed the current time. */
  proposedBy?: string;
  /** Humans that confirmed the current time. */
  confirmedBy?: string[];
  /** Monotonic revision; each counter-proposal increments it. */
  revision?: number;
  /** Server-only routing hint: which participant still needs this notice. */
  noticeTo?: string;
}

export interface SignalRendezvousCreate {
  type: 'rendezvous:create';
  rendezvous: RendezvousWire;
}

export interface SignalRendezvousUpdate {
  type: 'rendezvous:update';
  action: 'counter' | 'confirm';
  rendezvous: RendezvousWire;
}

export interface SignalRendezvousAck {
  type: 'rendezvous:ack';
  id: string;
}

export interface SignalRendezvousUpdated {
  type: 'rendezvous:updated';
  id: string;
}

export type RtcSignalPayload =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'ice'; candidate: RTCIceCandidateInit | null };

export interface SignalRtc {
  type: 'rtc';
  to: string;
  transferId: string;
  payload: RtcSignalPayload;
}

/** Opaque, already-signed circle metadata. The server relays, never verifies. */
export interface SignalCircleRelay {
  type: 'circle:relay';
  to: string;
  message: unknown;
}

export interface SignalCircleRelayed {
  type: 'circle:relay';
  fromId: string;
  message: unknown;
}

/** Generic, already-signed app metadata (possession, audio consent). */
export interface SignalAppRelay {
  type: 'app:relay';
  to: string;
  message: unknown;
  /** When true the server holds the notice for an offline human. */
  queue?: boolean;
}

export interface SignalAppRelayed {
  type: 'app:relay';
  fromId: string;
  message: unknown;
  queuedId?: string;
}

export interface SignalAppAck {
  type: 'app:ack';
  queuedId: string;
}

/** A signed circle rendezvous invite. The server stores only this notice. */
export interface CircleRendezvousInvite {
  id: string;
  circleId: string;
  fromId: string;
  fromName: string;
  recipients: string[];
  /** The signed Plan record, opaque to the server. */
  plan: unknown;
  scheduledAt: number;
  createdAt: number;
}

export interface SignalCircleRendezvousCreate {
  type: 'circle:rendezvous:create';
  invite: CircleRendezvousInvite;
}

export interface SignalCircleRendezvousCreated {
  type: 'circle:rendezvous:created';
  id: string;
}

export interface SignalCircleRendezvousNotice {
  type: 'circle:rendezvous:notice';
  invite: CircleRendezvousInvite;
}

export type ClientSignalMessage =
  | SignalHello
  | SignalIdentityUpdate
  | SignalPresenceSubscribe
  | SignalInviteJoin
  | SignalInviteAck
  | SignalContactRemove
  | SignalContactRemoveAck
  | SignalInviteReject
  | SignalRendezvousCreate
  | SignalRendezvousUpdate
  | SignalRendezvousAck
  | SignalRtc
  | SignalCircleRelay
  | SignalAppRelay
  | SignalAppAck
  | SignalCircleRendezvousCreate;

export interface PresenceEntry {
  id: string;
  name: string;
  online: boolean;
}

export interface RendezvousNotice {
  id: string;
  fromId: string;
  fromName: string;
  scheduledFor: number;
  createdAt: number;
  liveAudioDisabled?: boolean;
  creatorId?: string;
  participants?: Array<{ id: string; name: string }>;
  recipientIds?: string[];
  circleId?: string;
  proposedBy?: string;
  confirmedBy?: string[];
  revision?: number;
}

export interface SignalChallenge {
  type: 'challenge';
  nonce: string;
  expiresAt: number;
}

export interface SignalHelloOk {
  type: 'hello:ok';
  serverNow: number;
  iceServers: RTCIceServer[];
  network: SignalNetworkInfo;
}

export interface SignalPresence {
  type: 'presence';
  peers: PresenceEntry[];
}

export interface SignalInviteQueued {
  type: 'invite:queued';
  joinId: string;
}

export interface SignalInviteRequest {
  type: 'invite:request';
  join: JoinRequest;
}

export interface SignalInviteAccepted {
  type: 'invite:accepted';
  joinId: string;
  humanId: string;
}

export interface SignalInviteRejected {
  type: 'invite:rejected';
  joinId: string;
  inviterId: string;
  reason: string;
}

export interface SignalContactRemoveQueued {
  type: 'contact:remove:queued';
  removalId: string;
}

export interface SignalContactRemoved {
  type: 'contact:removed';
  removalId: string;
  fromId: string;
  fromName?: string;
}

export interface SignalRendezvousCreated {
  type: 'rendezvous:created';
  id: string;
}

export interface SignalRendezvousNotice {
  type: 'rendezvous:notice';
  rendezvous: RendezvousNotice;
}

export interface SignalRtcRelay {
  type: 'rtc';
  fromId: string;
  transferId: string;
  payload: RtcSignalPayload;
}

export interface SignalError {
  type: 'error';
  code: string;
  message: string;
  fatal?: boolean;
}

export type ServerSignalMessage =
  | SignalChallenge
  | SignalHelloOk
  | SignalPresence
  | SignalInviteQueued
  | SignalInviteRequest
  | SignalInviteAccepted
  | SignalInviteRejected
  | SignalContactRemoveQueued
  | SignalContactRemoved
  | SignalRendezvousCreated
  | SignalRendezvousUpdated
  | SignalRendezvousNotice
  | SignalRtcRelay
  | SignalCircleRelayed
  | SignalAppRelayed
  | SignalCircleRendezvousCreated
  | SignalCircleRendezvousNotice
  | SignalError;

export type RawSignalMessage = ClientSignalMessage | ServerSignalMessage;

