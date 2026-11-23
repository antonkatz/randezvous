import { bytesToBase64Url, sha256 } from './crypto';
import type { PhotoAttachment, VoiceNoteAttachment } from './types';

export const MAX_VOICE_NOTE_MS = 60_000;
export const MAX_VOICE_NOTE_BYTES = 8 * 1024 * 1024;

/** Stable, content-derived identity for a photograph. */
export async function photoIdFor(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return `p_${bytesToBase64Url(await sha256(bytes))}`;
}

export interface AttachmentInput {
  photo: Blob;
  fileName?: string;
  photoId?: string;
  note?: VoiceNoteAttachment | null;
}

export async function makePhotoAttachment(
  input: AttachmentInput,
): Promise<PhotoAttachment> {
  const photoId = input.photoId ?? (await photoIdFor(input.photo));
  const fallbackName =
    input.fileName?.trim() ||
    (typeof File !== 'undefined' && input.photo instanceof File
      ? input.photo.name
      : '') ||
    'photograph';
  return {
    blob: input.photo,
    name: fallbackName,
    type: input.photo.type || 'image/jpeg',
    size: input.photo.size,
    photoId,
    note: input.note ?? null,
  };
}

export function isValidVoiceNote(note: unknown): note is VoiceNoteAttachment {
  if (!note || typeof note !== 'object') return false;
  const value = note as Partial<VoiceNoteAttachment>;
  return (
    value.blob instanceof Blob &&
    typeof value.name === 'string' &&
    typeof value.type === 'string' &&
    value.type.startsWith('audio/') &&
    typeof value.size === 'number' &&
    value.size > 0 &&
    value.size <= MAX_VOICE_NOTE_BYTES &&
    typeof value.durationMs === 'number' &&
    value.durationMs > 0 &&
    value.durationMs <= MAX_VOICE_NOTE_MS + 1_000
  );
}

export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
