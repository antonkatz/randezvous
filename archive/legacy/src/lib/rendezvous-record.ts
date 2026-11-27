import type { PhotoAttachment, StoredRendezvous } from './types';

export interface RecordParticipant {
  id: string;
  name: string;
}

/** Every participant, including this browser. */
export function participantsFor(
  record: StoredRendezvous,
  selfId: string,
  selfName = '',
): RecordParticipant[] {
  if (record.participants && record.participants.length > 0) {
    return [...record.participants];
  }
  const outgoing = record.direction === 'outgoing';
  const creatorId = outgoing ? selfId : record.peerId;
  const creatorName = outgoing ? selfName : record.peerName;
  const otherId = outgoing ? record.peerId : selfId;
  const otherName = outgoing ? record.peerName : selfName;
  return [
    { id: creatorId, name: creatorName },
    { id: otherId, name: otherName },
  ].filter((entry, index, all) => entry.id && all.findIndex((item) => item.id === entry.id) === index);
}

export function creatorIdFor(record: StoredRendezvous, selfId: string): string {
  if (record.creatorId) return record.creatorId;
  return record.direction === 'outgoing' ? selfId : record.peerId;
}

export function isCreator(record: StoredRendezvous, selfId: string): boolean {
  return creatorIdFor(record, selfId) === selfId;
}

export function otherParticipants(
  record: StoredRendezvous,
  selfId: string,
  selfName = '',
): RecordParticipant[] {
  return participantsFor(record, selfId, selfName).filter(
    (participant) => participant.id && participant.id !== selfId,
  );
}

export function isMultiPerson(record: StoredRendezvous): boolean {
  const ids = new Set(
    (record.participants ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => Boolean(id)),
  );
  return Boolean(record.circleId || ids.size > 2);
}

/** The photo this browser contributes to the rendezvous. */
export function ownPhoto(
  record: StoredRendezvous,
  selfId: string,
): PhotoAttachment | null {
  const bySelf = record.photos?.[selfId];
  if (bySelf) return bySelf;
  return record.direction === 'outgoing' ? record.photo : record.contribution;
}

/** A photo received from one participant. */
export function photoFrom(
  record: StoredRendezvous,
  peerId: string,
): PhotoAttachment | null {
  const received = record.photos?.[peerId];
  if (received) return received;
  if (peerId === record.peerId) {
    return record.direction === 'outgoing' ? record.reciprocal : record.photo;
  }
  return null;
}

export function setOwnPhoto(
  record: StoredRendezvous,
  selfId: string,
  photo: PhotoAttachment | null,
): void {
  record.photos ??= {};
  if (photo) record.photos[selfId] = photo;
  else delete record.photos[selfId];
  if (record.direction === 'outgoing') record.photo = photo;
  else record.contribution = photo;
}

export function setPhotoFrom(
  record: StoredRendezvous,
  peerId: string,
  photo: PhotoAttachment,
): void {
  record.photos ??= {};
  record.photos[peerId] = photo;
  if (record.direction === 'outgoing' && peerId === record.peerId) {
    record.reciprocal = photo;
  }
  if (record.direction === 'incoming' && peerId === creatorIdFor(record, '')) {
    record.photo = photo;
  }
}

export function deliveredTo(record: StoredRendezvous): string[] {
  return record.deliveredTo ?? [];
}

export function hasDeliveredTo(record: StoredRendezvous, peerId: string): boolean {
  return deliveredTo(record).includes(peerId);
}

export function markDeliveredTo(record: StoredRendezvous, peerId: string): void {
  record.deliveredTo ??= [];
  if (!record.deliveredTo.includes(peerId)) record.deliveredTo.push(peerId);
  record.peerStates ??= {};
  record.peerStates[peerId] = { phase: 'delivered', error: null };
}

export function pairTransferId(appointmentId: string, peerId: string): string {
  return `${appointmentId}~${peerId}`;
}

export function appointmentFromTransferId(transferId: string): {
  appointmentId: string;
  peerId: string | null;
} {
  const index = transferId.indexOf('~');
  if (index < 0) return { appointmentId: transferId, peerId: null };
  return {
    appointmentId: transferId.slice(0, index),
    peerId: transferId.slice(index + 1) || null,
  };
}

/**
 * Fill fields added for multi-person rendezvous on records created before the
 * change. Existing one-to-one records keep working through the same helpers.
 */
export function normalizeRendezvousRecord(
  record: StoredRendezvous,
  selfId: string,
  selfName = '',
): StoredRendezvous {
  const participants = participantsFor(record, selfId, selfName);
  record.participants = participants;
  record.creatorId = creatorIdFor(record, selfId);
  record.circleId ??= null;
  record.deliveredTo ??= [];
  record.peerStates ??= {};
  record.keptAt ??= null;
  record.photos ??= {};
  if (Object.keys(record.photos).length === 0) {
    const own = record.direction === 'outgoing' ? record.photo : record.contribution;
    if (own) record.photos[selfId] = own;
    const creatorId = record.creatorId;
    if (record.direction === 'incoming' && record.photo && creatorId) {
      record.photos[creatorId] = record.photo;
    }
    if (record.direction === 'outgoing' && record.reciprocal && record.peerId) {
      record.photos[record.peerId] = record.reciprocal;
    }
  }
  if (record.deliveredTo.length === 0 && record.status === 'delivered' && record.peerId) {
    record.deliveredTo.push(record.peerId);
    record.peerStates[record.peerId] = { phase: 'delivered', error: null };
  }
  return record;
}
