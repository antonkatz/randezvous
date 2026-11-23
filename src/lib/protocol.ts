import type { SignalNetworkInfo } from './types';

export interface PublicIdentityClaim {
  id: string;
  name: string;
  publicKey: string;
}

export interface InvitePayload {
  v: 1;
  id: string;
  name: string;
  publicKey: string;
  issuedAt: number;
  nonce: string;
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
}

export interface SignalRendezvousCreate {
  type: 'rendezvous:create';
  rendezvous: RendezvousWire;
}

export interface SignalRendezvousAck {
  type: 'rendezvous:ack';
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
  | SignalRendezvousNotice
  | SignalRtcRelay
  | SignalCircleRelayed
  | SignalAppRelayed
  | SignalCircleRendezvousCreated
  | SignalCircleRendezvousNotice
  | SignalError;

export type RawSignalMessage = ClientSignalMessage | ServerSignalMessage;

