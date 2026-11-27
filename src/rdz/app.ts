import {
  ANNOUNCEMENT_GRACE_MS,
  createEnvelope,
  envelopeId,
  isNotFromFuture,
  isValidGoing,
  isValidPing,
  PING_INTERVAL_MS,
  PRESENCE_MS,
  SIGNAL_TTL_MS,
  verifyEnvelope,
} from './crypto';
import {
  formatEmoji,
  formatWords,
  idToEmoji,
  idToWords,
  randomRendezvousId,
  shortEmoji,
  shortWords,
  uniqueEmojiDisplay,
  uniqueWordDisplay,
} from './ids';
import instantHeroMark from '../ui/instanthero-mark.svg?raw';
import { ConnectionBudget } from './connection-budget';
import { MeshManager, resolveBootstrapUrl, type MeshStatus } from './mesh';
import { RtcManager } from './rtc';
import {
  activeAnnouncements,
  buildChannels,
  filterChannels,
  filterHumans,
  formatDay,
  formatTime,
  groupAnnouncementsByMinute,
  isOnline,
  audioRemaining,
  dedupeAnnouncements,
  parseTimeInput as parseTime,
  sortAnnouncements,
  sortHumans,
} from './state';
import {
  createMaskRecord,
  deleteEnvelopes,
  loadEnvelopes,
  loadMaskState,
  loadPeerRegistry,
  loadPins,
  loadVerifications,
  removeMaskRecord,
  removePin,
  saveEnvelope,
  saveMask,
  savePeerRegistryEntry,
  savePin,
  setActiveMask,
  setVerification,
} from './store';
import type {
  AudioSession,
  ChannelView,
  Envelope,
  GoingAnnouncement,
  Human,
  ImageTransferProgress,
  IncomingAudioRequest,
  IncomingImageOffer,
  MaskRecord,
  PinRecord,
  SignalKind,
  VerificationRecord,
} from './types';

type Modal =
  | { type: 'set-time'; channelId: string | null }
  | { type: 'pin'; channelId: string }
  | { type: 'human'; humanId: string }
  | { type: 'identity' }
  | { type: 'send-photo'; humanId: string; channelId: string }
  | null;

interface ImageViewer {
  transferId: string;
  url: string;
  label: string;
  size: number;
  filename: string;
}

export class RdzApp {
  private masks: MaskRecord[] = [];
  private identity!: MaskRecord;
  private verifications = new Map<string, VerificationRecord>();
  private pins: PinRecord[] = [];
  private humans = new Map<string, Human>();
  private announcements = new Map<string, GoingAnnouncement>();
  private goingEnvelopes = new Map<string, Envelope>();
  private seen = new Map<string, number>();
  private mesh: MeshManager | null = null;
  private rtc!: RtcManager;
  private meshStatus: MeshStatus = 'offline';
  private readonly budget = new ConnectionBudget();
  private runtimeGeneration = 0;
  private signalChain: Promise<void> = Promise.resolve();
  private now = Date.now();
  private query = '';
  private activeChannelId: string | null = null;
  private modal: Modal = null;
  private incomingImages = new Map<string, IncomingImageOffer>();
  private incomingAudio = new Map<string, IncomingAudioRequest>();
  private imageProgress = new Map<string, ImageTransferProgress>();
  private imageViewer: ImageViewer | null = null;
  private audioSession: AudioSession | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private audioTicker = 0;
  private ticker = 0;
  private pingTicker = 0;
  private renderQueued = false;
  private toast = '';
  private toastTimer = 0;
  private lastImage: File | null = null;
  private pendingSend: { humanId: string; channelId: string } | null = null;
  private fileInput!: HTMLInputElement;

  async start(): Promise<void> {
    const maskState = await loadMaskState();
    this.masks = maskState.masks;
    this.identity = this.masks.find((mask) => mask.id === maskState.activeMaskId) ?? this.masks[0]!;
    this.verifications = await loadVerifications(this.identity.id);
    this.pins = await loadPins();
    this.addSelfHuman();
    this.rtc = this.createRtc();
    this.mesh = this.createMesh();

    const cached = await loadEnvelopes();
    const expired: string[] = [];
    for (const entry of cached) {
      if (entry.envelope.type === 'GOING' && isValidGoing(entry.envelope)) {
        this.goingEnvelopes.set(entry.id, entry.envelope);
        this.mesh.remember(entry.envelope);
        void this.processEnvelope(entry.envelope, false);
      } else {
        expired.push(entry.id);
      }
    }
    await deleteEnvelopes(expired);

    this.mesh.start();
    void this.considerKnownPeers();

    this.ticker = window.setInterval(() => this.tick(), 10_000);
    this.pingTicker = window.setInterval(() => this.sendPing(), PING_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.sendPing();
        this.tick();
      }
    });
    this.bind();
    this.render();
    this.sendPing();
  }

  private createRtc(): RtcManager {
    const generation = this.runtimeGeneration;
    const current = (): boolean => this.runtimeGeneration === generation;
    return new RtcManager(
      this.identity,
      {
        sendSignal: (target, channelId, signal, transferId, data) => {
          if (current()) this.sendSignal(target, channelId, signal, transferId, data);
        },
        isVerified: (humanId) => this.isVerified(humanId),
        canAcceptChannel: (humanId, channelId) => this.canAcceptChannel(humanId, channelId),
        onImageOffer: (offer) => {
          if (current()) this.handleImageOffer(offer);
        },
        onImageProgress: (progress) => {
          if (current()) this.handleImageProgress(progress);
        },
        onImageComplete: (transferId, blob, mime) => {
          if (current()) this.handleImageComplete(transferId, blob, mime);
        },
        onImageFailed: (transferId, message) => {
          if (current()) this.handleImageFailed(transferId, message);
        },
        onAudioRequest: (request) => {
          if (current()) this.handleAudioRequest(request);
        },
        onAudioState: (session) => {
          if (current()) this.handleAudioState(session);
        },
      },
      this.budget,
    );
  }

  private createMesh(): MeshManager {
    const generation = this.runtimeGeneration;
    const current = (): boolean => this.runtimeGeneration === generation;
    return new MeshManager(this.identity, {
      budget: this.budget,
      bootstrapUrl: resolveBootstrapUrl(),
      isVerified: (humanId) => this.isVerified(humanId),
      isBusy: (humanId) => this.rtc.busyPeers().has(humanId),
      onEnvelope: (value) => {
        if (current()) void this.handleMeshEnvelope(value);
      },
      onStatus: (status) => {
        if (current()) this.handleMeshStatus(status);
      },
      onPeers: (peers) => {
        if (!current()) return;
        for (const peer of peers) {
          if (this.isLocalMask(peer.humanId)) continue;
          this.mesh?.considerPeer(peer.humanId, peer.publicKey);
          void savePeerRegistryEntry({ ...peer, lastSeen: Date.now() });
        }
      },
    });
  }

  private addSelfHuman(): void {
    this.humans.set(this.identity.humanId, {
      id: this.identity.humanId,
      publicKey: this.identity.publicKey,
      words: idToWords(this.identity.humanId),
      emoji: idToEmoji(this.identity.humanId),
      lastSeen: Date.now(),
      verified: true,
    });
  }

  private bind(): void {
    const root = document.querySelector<HTMLDivElement>('#app');
    if (!root) throw new Error('App root missing.');
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/*';
    this.fileInput.hidden = true;
    document.body.append(this.fileInput);
    this.fileInput.addEventListener('change', () => void this.onFileChosen());

    root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
      if (!action) return;
      const id = target.closest<HTMLElement>('[data-id]')?.dataset.id ?? '';
      const transferId = target.closest<HTMLElement>('[data-transfer]')?.dataset.transfer ?? '';
      void this.onAction(action, id, transferId);
    });
    root.addEventListener('input', (event) => {
      const target = event.target as HTMLInputElement;
      if (target.id === 'filter') {
        this.query = target.value;
        this.render();
        const next = document.querySelector<HTMLInputElement>('#filter');
        if (next) {
          next.focus();
          next.setSelectionRange(next.value.length, next.value.length);
        }
      }
    });
    root.addEventListener('submit', (event) => {
      event.preventDefault();
      const form = event.target as HTMLFormElement;
      void this.onSubmit(form);
    });
    root.addEventListener('change', (event) => {
      const target = event.target as HTMLInputElement;
      if (target.id === 'time-input') {
        // The value is read on submit; no re-render needed.
      }
    });
  }

  private async handleMeshEnvelope(value: unknown): Promise<void> {
    await this.processEnvelope(value, true);
  }

  private async processEnvelope(value: unknown, persist: boolean): Promise<void> {
    const envelope = await verifyEnvelope(value);
    if (!envelope) return;
    if (!isNotFromFuture(envelope)) return;
    if (envelope.type === 'PING' && !isValidPing(envelope)) return;
    if (envelope.type === 'GOING' && !isValidGoing(envelope)) return;
    if (envelope.type === 'SIGNAL' && Date.now() - envelope.createdAt > SIGNAL_TTL_MS) return;

    const id = await envelopeId(envelope);
    const expiresAt = envelopeExpiry(envelope);
    if (expiresAt <= Date.now()) return;
    const prior = this.seen.get(id);
    if (prior && prior > Date.now()) return;
    this.seen.set(id, expiresAt);

    this.upsertHuman(envelope);
    if (envelope.author !== this.identity.humanId && !this.isLocalMask(envelope.author)) {
      this.mesh?.considerPeer(envelope.author, envelope.publicKey);
      void savePeerRegistryEntry({
        humanId: envelope.author,
        publicKey: envelope.publicKey,
        lastSeen: Date.now(),
      });
    }
    if (persist && envelope.type === 'GOING') {
      void saveEnvelope(id, envelope);
    }

    if (envelope.type === 'GOING' && envelope.payload.kind === 'GOING') {
      this.goingEnvelopes.set(id, envelope);
      this.announcements.set(id, {
        envelopeId: id,
        author: envelope.author,
        publicKey: envelope.publicKey,
        channelId: envelope.payload.rendezvousId,
        scheduledAt: envelope.payload.scheduledAt,
        createdAt: envelope.createdAt,
      });
      this.scheduleRender();
      return;
    }
    if (envelope.type === 'SIGNAL') {
      await this.rtc.handleSignal(envelope);
      return;
    }
    this.scheduleRender();
  }

  private upsertHuman(envelope: Envelope): void {
    const existing = this.humans.get(envelope.author);
    const verification = this.verifications.get(envelope.author);
    const otherLocalMask = this.masks.some(
      (mask) => mask.id !== this.identity.id && mask.humanId === envelope.author,
    );
    const verified =
      !otherLocalMask &&
      (envelope.author === this.identity.humanId ||
        Boolean(verification?.verifiedAt && verification.publicKey === envelope.publicKey));
    const next: Human = {
      id: envelope.author,
      publicKey: envelope.publicKey,
      words: idToWords(envelope.author),
      emoji: idToEmoji(envelope.author),
      lastSeen: otherLocalMask ? 0 : Math.max(existing?.lastSeen ?? 0, envelope.createdAt),
      verified,
    };
    this.humans.set(envelope.author, next);
  }

  private handleMeshStatus(status: MeshStatus): void {
    this.meshStatus = status;
    if (status === 'online') {
      this.sendPing();
    }
    this.scheduleRender();
  }

  private sendPing(): void {
    void this.buildAndSend({ kind: 'PING' }).then((envelope) => {
      if (!envelope) return;
      const self = this.humans.get(this.identity.humanId);
      if (self) {
        self.publicKey = this.identity.publicKey;
        self.lastSeen = Date.now();
        self.verified = true;
      }
      this.scheduleRender();
    });
  }

  private async buildAndSend(payload: Parameters<typeof createEnvelope>[1]): Promise<Envelope | null> {
    if (!this.identity) return null;
    const generation = this.runtimeGeneration;
    const envelope = await createEnvelope(this.identity, payload);
    if (generation !== this.runtimeGeneration) return null;
    void this.mesh?.publish(envelope);
    return envelope;
  }

  private sendSignal(
    target: string,
    channelId: string,
    signal: SignalKind,
    transferId: string,
    data?: unknown,
  ): void {
    const generation = this.runtimeGeneration;
    this.signalChain = this.signalChain
      .then(async () => {
        if (generation !== this.runtimeGeneration) return;
        const envelope = await createEnvelope(this.identity, {
          kind: 'SIGNAL',
          target,
          channelId,
          signal,
          transferId,
          ...(data === undefined ? {} : { data }),
        });
        if (generation !== this.runtimeGeneration) return;
        await this.mesh?.publish(envelope);
      })
      .catch(() => undefined);
  }

  private isVerified(humanId: string): boolean {
    if (humanId === this.identity.humanId) return true;
    const record = this.verifications.get(humanId);
    const human = this.humans.get(humanId);
    return Boolean(record?.verifiedAt && human?.publicKey === record.publicKey);
  }

  private canAcceptChannel(humanId: string, channelId: string): boolean {
    if (!this.isVerified(humanId)) return false;
    if (this.activeChannelId === channelId) return true;
    const now = Date.now();
    return [...this.announcements.values()].some(
      (entry) =>
        entry.author === this.identity.humanId &&
        entry.channelId === channelId &&
        entry.scheduledAt + ANNOUNCEMENT_GRACE_MS >= now,
    );
  }

  private tick(): void {
    this.now = Date.now();
    const cutoff = this.now - ANNOUNCEMENT_GRACE_MS - 5 * 60_000;
    const removed: string[] = [];
    for (const [id, entry] of this.announcements) {
      if (entry.scheduledAt < cutoff) {
        this.announcements.delete(id);
        this.goingEnvelopes.delete(id);
        removed.push(id);
      }
    }
    if (removed.length) void deleteEnvelopes(removed);
    for (const [id, expiresAt] of this.seen) {
      if (expiresAt <= this.now) this.seen.delete(id);
    }
    this.scheduleRender();
  }

  private handleImageOffer(offer: IncomingImageOffer): void {
    const human = this.humans.get(offer.sender);
    this.incomingImages.set(offer.transferId, {
      ...offer,
      senderWords: human?.words ?? idToWords(offer.sender),
      senderEmoji: human?.emoji ?? idToEmoji(offer.sender),
      verified: this.isVerified(offer.sender),
    });
    this.scheduleRender();
  }

  private handleImageProgress(progress: ImageTransferProgress): void {
    this.imageProgress.set(progress.transferId, progress);
    if (progress.phase === 'done') {
      window.setTimeout(() => {
        this.imageProgress.delete(progress.transferId);
        this.scheduleRender();
      }, 2500);
    }
    if (progress.phase === 'declined') {
      this.showToast('The image was declined.');
    }
    this.scheduleRender();
  }

  private handleImageComplete(transferId: string, blob: Blob, mime: string): void {
    this.incomingImages.delete(transferId);
    this.imageProgress.delete(transferId);
    if (this.imageViewer) URL.revokeObjectURL(this.imageViewer.url);
    const url = URL.createObjectURL(blob);
    this.imageViewer = {
      transferId,
      url,
      label: 'image',
      size: blob.size,
      filename: safeImageFilename(mime),
    };
    this.scheduleRender();
  }

  private handleImageFailed(transferId: string, message: string): void {
    const existing = this.imageProgress.get(transferId);
    if (existing) this.imageProgress.set(transferId, { ...existing, phase: 'failed', error: message });
    this.showToast(message);
    this.scheduleRender();
  }

  private handleAudioRequest(request: IncomingAudioRequest): void {
    const human = this.humans.get(request.sender);
    this.incomingAudio.set(request.transferId, {
      ...request,
      senderWords: human?.words ?? idToWords(request.sender),
      senderEmoji: human?.emoji ?? idToEmoji(request.sender),
      verified: this.isVerified(request.sender),
    });
    this.scheduleRender();
  }

  private handleAudioState(session: AudioSession | null): void {
    this.audioSession = session;
    if (session?.remoteStream) {
      if (!this.remoteAudio) {
        this.remoteAudio = document.createElement('audio');
        this.remoteAudio.autoplay = true;
        this.remoteAudio.hidden = true;
        document.body.append(this.remoteAudio);
      }
      if (this.remoteAudio.srcObject !== session.remoteStream) {
        this.remoteAudio.srcObject = session.remoteStream;
        void this.remoteAudio.play().catch(() => undefined);
      }
    } else if (this.remoteAudio) {
      this.remoteAudio.pause();
      this.remoteAudio.srcObject = null;
    }
    if (session?.phase === 'live') {
      if (!this.audioTicker) {
        this.audioTicker = window.setInterval(() => this.scheduleRender(), 250);
      }
    } else if (this.audioTicker) {
      window.clearInterval(this.audioTicker);
      this.audioTicker = 0;
    }
    this.scheduleRender();
  }

  private async onAction(action: string, id: string, transferId: string): Promise<void> {
    if (action === 'open-channel') {
      this.activeChannelId = id;
      this.modal = null;
      this.render();
      return;
    }
    if (action === 'back') {
      this.activeChannelId = null;
      if (this.imageViewer) URL.revokeObjectURL(this.imageViewer.url);
      this.imageViewer = null;
      this.render();
      return;
    }
    if (action === 'new-rendezvous') {
      this.modal = { type: 'set-time', channelId: null };
      this.render();
      return;
    }
    if (action === 'set-time') {
      this.modal = { type: 'set-time', channelId: this.activeChannelId };
      this.render();
      return;
    }
    if (action === 'pin') {
      if (this.activeChannelId) {
        this.modal = { type: 'pin', channelId: this.activeChannelId };
        this.render();
      }
      return;
    }
    if (action === 'unpin') {
      await removePin(id);
      this.pins = await loadPins();
      this.render();
      return;
    }
    if (action === 'open-human') {
      this.modal = { type: 'human', humanId: id };
      this.render();
      return;
    }
    if (action === 'identity') {
      this.modal = { type: 'identity' };
      this.render();
      return;
    }
    if (action === 'create-mask') {
      await this.createMask();
      return;
    }
    if (action === 'switch-mask') {
      await this.activateMask(id);
      return;
    }
    if (action === 'remove-mask') {
      await this.removeMask(id);
      return;
    }
    if (action === 'close-modal') {
      this.modal = null;
      this.render();
      return;
    }
    if (action === 'verify-human') {
      const human = this.humans.get(id);
      if (!human) return;
      await setVerification(this.identity.id, id, human.publicKey, true);
      this.verifications = await loadVerifications(this.identity.id);
      human.verified = true;
      this.showToast('Human verified.');
      this.modal = null;
      this.render();
      return;
    }
    if (action === 'unverify-human') {
      const human = this.humans.get(id);
      if (!human) return;
      await setVerification(this.identity.id, id, human.publicKey, false);
      this.verifications = await loadVerifications(this.identity.id);
      human.verified = false;
      this.render();
      return;
    }
    if (action === 'send-photo') {
      const human = this.humans.get(id);
      if (!human || !this.isVerified(id)) {
        this.showToast('Verify this human before sending.');
        return;
      }
      if (this.rtc.isSendingImage) {
        this.showToast('Wait for the current image to finish.');
        return;
      }
      this.modal = { type: 'send-photo', humanId: id, channelId: this.activeChannelId ?? '' };
      this.render();
      return;
    }
    if (action === 'choose-photo') {
      this.pendingSend = { humanId: id, channelId: this.activeChannelId ?? '' };
      this.modal = null;
      this.fileInput.value = '';
      this.fileInput.click();
      this.render();
      return;
    }
    if (action === 'reuse-photo') {
      if (!this.lastImage) return;
      this.modal = null;
      this.startSend(id, this.activeChannelId ?? '', this.lastImage);
      this.render();
      return;
    }
    if (action === 'open-voice') {
      if (!this.isVerified(id)) {
        this.showToast('Verify this human before opening voice.');
        return;
      }
      if (this.audioSession) {
        this.showToast('An audio conversation is already active.');
        return;
      }
      await this.rtc.requestAudio(id, this.activeChannelId ?? '');
      this.render();
      return;
    }
    if (action === 'accept-image') {
      if (this.hasActiveIncomingImage()) {
        this.showToast('Finish the current image first.');
        return;
      }
      await this.rtc.acceptImage(transferId);
      this.incomingImages.delete(transferId);
      this.render();
      return;
    }
    if (action === 'decline-image') {
      this.rtc.declineImage(transferId);
      this.incomingImages.delete(transferId);
      this.render();
      return;
    }
    if (action === 'accept-audio') {
      if (this.audioSession) {
        this.showToast('Finish the current voice conversation first.');
        return;
      }
      await this.rtc.acceptAudio(transferId);
      this.incomingAudio.delete(transferId);
      this.render();
      return;
    }
    if (action === 'decline-audio') {
      this.rtc.declineAudio(transferId);
      this.incomingAudio.delete(transferId);
      this.render();
      return;
    }
    if (action === 'end-audio') {
      this.rtc.endAudio();
      this.render();
      return;
    }
    if (action === 'mute-audio') {
      this.rtc.toggleMute();
      this.render();
      return;
    }
    if (action === 'dismiss-image') {
      if (this.imageViewer) URL.revokeObjectURL(this.imageViewer.url);
      this.imageViewer = null;
      this.render();
    }
  }

  private async onSubmit(form: HTMLFormElement): Promise<void> {
    if (form.dataset.form === 'set-time') {
      const input = form.querySelector<HTMLInputElement>('input[name="time"]');
      const channelId = form.dataset.channel ?? '';
      const scheduledAt = input ? parseTime(input.value) : null;
      if (scheduledAt === null) {
        this.showToast('Choose a valid time.');
        return;
      }
      const id = channelId || randomRendezvousId();
      const envelope = await this.buildAndSend({
        kind: 'GOING',
        rendezvousId: id,
        scheduledAt,
      });
      if (envelope) {
        const envelopeKey = await envelopeId(envelope);
        this.seen.set(envelopeKey, scheduledAt + ANNOUNCEMENT_GRACE_MS);
        this.announcements.set(envelopeKey, {
          envelopeId: envelopeKey,
          author: envelope.author,
          publicKey: envelope.publicKey,
          channelId: id,
          scheduledAt,
          createdAt: envelope.createdAt,
        });
        void saveEnvelope(envelopeKey, envelope);
      }
      this.activeChannelId = id;
      this.modal = null;
      this.render();
      return;
    }
    if (form.dataset.form === 'pin') {
      const input = form.querySelector<HTMLInputElement>('input[name="label"]');
      const channelId = form.dataset.channel ?? '';
      const label = input?.value.trim() || 'circle';
      await savePin({ channelId, label, createdAt: Date.now() });
      this.pins = await loadPins();
      this.modal = null;
      this.render();
    }
  }

  private async createMask(): Promise<void> {
    const mask = await createMaskRecord();
    await saveMask(mask);
    this.masks = (await loadMaskState()).masks;
    await this.activateMask(mask.id);
  }

  private async activateMask(maskId: string): Promise<void> {
    const mask = this.masks.find((entry) => entry.id === maskId);
    if (!mask) return;
    await setActiveMask(maskId);
    if (mask.id === this.identity.id) {
      this.scheduleRender();
      return;
    }
    this.identity = mask;
    this.verifications = await loadVerifications(maskId);
    this.teardownForMaskSwitch();
    this.restartRuntime();
    this.refreshVerifiedFlags();
    this.addSelfHuman();
    this.showToast('Mask active. Reconnecting.');
    this.render();
  }

  private async removeMask(maskId: string): Promise<void> {
    const mask = this.masks.find((entry) => entry.id === maskId);
    if (!mask) return;
    const human = this.humans.get(mask.humanId);
    if (human) {
      human.lastSeen = 0;
      human.verified = false;
    }
    const wasActive = this.identity.id === maskId;
    await removeMaskRecord(maskId);
    const state = await loadMaskState();
    this.masks = state.masks;
    if (wasActive) {
      await this.activateMask(state.activeMaskId);
      return;
    }
    this.verifications = await loadVerifications(this.identity.id);
    this.refreshVerifiedFlags();
    this.showToast('Mask removed.');
    this.render();
  }

  private teardownForMaskSwitch(): void {
    this.runtimeGeneration += 1;
    this.mesh?.stop();
    this.mesh = null;
    this.rtc?.stop();
    this.signalChain = Promise.resolve();
    this.budget.clear();
    this.incomingImages.clear();
    this.incomingAudio.clear();
    this.imageProgress.clear();
    this.audioSession = null;
    if (this.imageViewer) URL.revokeObjectURL(this.imageViewer.url);
    this.imageViewer = null;
    this.lastImage = null;
    this.pendingSend = null;
    if (this.remoteAudio) {
      this.remoteAudio.pause();
      this.remoteAudio.srcObject = null;
    }
    if (this.audioTicker) {
      window.clearInterval(this.audioTicker);
      this.audioTicker = 0;
    }
    if (this.modal && this.modal.type !== 'identity') this.modal = null;
  }

  private restartRuntime(): void {
    this.rtc = this.createRtc();
    this.mesh = this.createMesh();
    this.mesh.start();
    this.sendPing();
    void this.considerKnownPeers();
  }

  private async considerKnownPeers(): Promise<void> {
    const peers = await loadPeerRegistry();
    for (const peer of peers) {
      if (this.isLocalMask(peer.humanId)) continue;
      this.mesh?.considerPeer(peer.humanId, peer.publicKey);
    }
  }

  private isLocalMask(humanId: string): boolean {
    return this.masks.some((mask) => mask.humanId === humanId);
  }

  private refreshVerifiedFlags(): void {
    for (const human of this.humans.values()) {
      const record = this.verifications.get(human.id);
      human.verified =
        human.id === this.identity.humanId ||
        Boolean(record?.verifiedAt && record.publicKey === human.publicKey);
    }
    for (const mask of this.masks) {
      if (mask.humanId === this.identity.humanId) continue;
      const human = this.humans.get(mask.humanId);
      if (human) {
        human.lastSeen = 0;
        human.verified = false;
      }
    }
  }

  private onFileChosen(): void {
    const file = this.fileInput.files?.[0];
    if (!file || !this.pendingSend) return;
    const { humanId, channelId } = this.pendingSend;
    this.pendingSend = null;
    this.startSend(humanId, channelId, file);
  }

  private startSend(humanId: string, channelId: string, file: File): void {
    try {
      this.rtc.sendImage(humanId, channelId, file);
      this.lastImage = file;
      this.render();
    } catch (error) {
      this.showToast(error instanceof Error ? error.message : 'Could not send the image.');
    }
  }

  private hasActiveIncomingImage(): boolean {
    if (this.imageViewer) return true;
    return [...this.imageProgress.values()].some(
      (entry) =>
        entry.direction === 'incoming' &&
        (entry.phase === 'connecting' || entry.phase === 'transferring'),
    );
  }

  private showToast(message: string): void {
    this.toast = message;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast = '';
      this.render();
    }, 4000);
    this.render();
  }

  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    if (!this.identity) return;
    const root = document.querySelector<HTMLDivElement>('#app');
    if (!root) return;
    this.now = Date.now();
    const statusLabel =
      this.meshStatus === 'online' ? 'live' : this.meshStatus === 'connecting' ? 'connecting' : 'off';
    const statusClass = this.meshStatus === 'online' ? 'is-live' : '';
    const ownShortWords = formatWords(shortWords(idToWords(this.identity.humanId)));
    const ownShortEmoji = formatEmoji(shortEmoji(idToEmoji(this.identity.humanId)));
    const body = this.activeChannelId
      ? this.renderChannel(this.activeChannelId)
      : this.renderLanding();
    root.innerHTML = `
      <div class="shell">
        <p class="masthead">
          <span class="masthead-name">rendezvous</span>
          <span class="masthead-star" aria-hidden="true">
            <svg viewBox="0 0 32 32"><path d="M16 4v24M5.6 10l20.8 12M26.4 10 5.6 22" /></svg>
          </span>
          <span class="masthead-by">by</span>
          <span class="masthead-stamp" role="img" aria-label="InstantHero">${instantHeroMark}</span>
        </p>
        <header class="topbar">
          <button class="brand" data-action="identity" type="button">
            <span class="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 32 32"><path d="M16 4v24M5.6 10l20.8 12M26.4 10 5.6 22" /></svg>
            </span>
            <span>RDZ</span>
          </button>
          <div class="top-actions">
            <span class="live ${statusClass}" title="WebRTC mesh"><span class="dot"></span>${statusLabel}</span>
            <button class="identity-chip" data-action="identity" type="button">
              <span class="identity-emoji">${escapeHtml(ownShortEmoji)}</span>
              <span class="identity-words">${escapeHtml(ownShortWords)}</span>
            </button>
          </div>
        </header>
        ${body}
      </div>
      ${this.renderDock()}
      ${this.renderModal()}
      ${this.renderImage()}
      ${this.toast ? `<div class="toast" role="status">${escapeHtml(this.toast)}</div>` : ''}
    `;
  }

  private renderLanding(): string {
    const humans = sortHumans(
      [...this.humans.values()].filter(
        (human) =>
          human.id === this.identity.humanId || isOnline(human, this.now) || human.verified,
      ),
      this.now,
    );
    const allChannels = buildChannels([...this.announcements.values()], this.pins, this.now);
    const channels = filterChannels(allChannels, this.query);
    const visibleHumans = filterHumans(humans, this.query);
    const humanIds = visibleHumans.map((human) => human.id);
    const channelIds = allChannels.map((channel) => channel.id);
    return `
      <main class="landing">
        <section class="hero">
          <div class="orbit" aria-hidden="true"></div>
          <div class="hero-content">
            <p class="eyebrow">public presence · no accounts</p>
            <h1>The Internet is Here</h1>
            <button class="primary" data-action="new-rendezvous" type="button">Set a rendezvous</button>
          </div>
        </section>
        <div class="filter-row">
          <div class="filter-field">
            <svg class="filter-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <circle cx="10.5" cy="10.5" r="6.25"></circle>
              <path d="m15.2 15.2 4.3 4.3"></path>
            </svg>
            <input id="filter" class="filter" type="search" placeholder="filter humans or channels by words or emoji" value="${escapeAttr(this.query)}" />
          </div>
        </div>
        <div class="columns">
          <section class="panel">
            <div class="panel-head"><h2>Rendezvous</h2><span>${channels.length}</span></div>
            <div class="list">
              ${
                channels.length
                  ? channels.map((channel) => this.renderChannelCard(channel, channelIds)).join('')
                  : '<p class="empty">No live rendezvous. Set one.</p>'
              }
            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Humans</h2><span>${visibleHumans.length}</span></div>
            <div class="list humans">
              ${
                visibleHumans.length
                  ? visibleHumans.map((human) => this.renderHumanRow(human, false, humanIds)).join('')
                  : '<p class="empty">Nobody else is visible yet.</p>'
              }
            </div>
          </section>
        </div>
      </main>
    `;
  }

  private renderChannelCard(channel: ChannelView, ids: readonly string[]): string {
    const words = formatWords(uniqueWordDisplay(ids, channel.id));
    const emoji = formatEmoji(uniqueEmojiDisplay(ids, channel.id, 3));
    const next = channel.nextAt ? `${formatTime(channel.nextAt)}${formatDay(channel.nextAt, this.now) ? ` · ${formatDay(channel.nextAt, this.now)}` : ''}` : 'pinned';
    return `
      <button class="channel-card" data-action="open-channel" data-id="${escapeAttr(channel.id)}" type="button">
        <span class="channel-emoji">${escapeHtml(emoji)}</span>
        <span class="channel-copy">
          <strong>${escapeHtml(channel.pinnedLabel ?? words)}</strong>
          <span>${escapeHtml(words)}</span>
        </span>
        <span class="channel-meta">${escapeHtml(next)}<small>${channel.announcements.length} going</small></span>
      </button>
    `;
  }

  private renderHumanRow(human: Human, channel: boolean, ids?: readonly string[]): string {
    const words = formatWords(ids ? uniqueWordDisplay(ids, human.id) : shortWords(human.words));
    const emoji = formatEmoji(ids ? uniqueEmojiDisplay(ids, human.id) : shortEmoji(human.emoji));
    const isSelf = human.id === this.identity.humanId;
    const online = isSelf || isOnline(human, this.now);
    return `
      <div class="human-row ${human.verified ? 'is-verified' : ''} ${isSelf ? 'is-self' : ''}">
        <button class="human-main" data-action="${isSelf ? 'identity' : 'open-human'}" data-id="${escapeAttr(human.id)}" type="button">
          <span class="human-emoji">${escapeHtml(emoji)}</span>
          <span class="human-copy">
            <strong>${escapeHtml(words)}</strong>
            <span>${isSelf ? 'me · active mask' : human.verified ? 'verified' : 'not verified'}</span>
          </span>
          <span class="presence ${online ? 'online' : ''}">${online ? 'here now' : 'away'}</span>
        </button>
        ${
          channel
            ? isSelf
              ? '<span class="row-actions"><span class="mask-active">me</span></span>'
              : `<span class="row-actions">
                ${
                  online && human.verified
                    ? `<button class="small" data-action="send-photo" data-id="${escapeAttr(human.id)}" type="button">send photo</button>
                       <button class="small ghost" data-action="open-voice" data-id="${escapeAttr(human.id)}" type="button">open voice</button>`
                    : `<button class="small ghost" data-action="open-human" data-id="${escapeAttr(human.id)}" type="button">${human.verified ? 'offline' : 'verify'}</button>`
                }
              </span>`
            : ''
        }
      </div>
    `;
  }

  private renderChannel(channelId: string): string {
    const channel = buildChannels([...this.announcements.values()], this.pins, this.now).find(
      (entry) => entry.id === channelId,
    );
    const entries = sortAnnouncements(
      dedupeAnnouncements(
        activeAnnouncements(
          [...this.announcements.values()].filter(
            (entry) => entry.channelId === channelId && entry.author !== this.identity.humanId,
          ),
          this.now,
        ),
      ),
      this.humans,
    );
    const ownEntries = sortAnnouncements(
      dedupeAnnouncements(
        activeAnnouncements(
          [...this.announcements.values()].filter(
            (entry) =>
              entry.channelId === channelId && entry.author === this.identity.humanId,
          ),
          this.now,
        ),
      ),
      this.humans,
    );
    const groups = groupAnnouncementsByMinute(entries);
    const authorIds = [...new Set(entries.map((entry) => entry.author))];
    const words = formatWords(shortWords(idToWords(channelId)));
    const emoji = formatEmoji(shortEmoji(idToEmoji(channelId)));
    const channelPins = this.pins.find((pin) => pin.channelId === channelId);
    const incoming = [...this.incomingImages.values()]
      .filter((offer) => offer.channelId === channelId)
      .sort((left, right) => Number(right.verified) - Number(left.verified) || left.receivedAt - right.receivedAt);
    const audioRequests = [...this.incomingAudio.values()]
      .filter((request) => request.channelId === channelId)
      .sort((left, right) => Number(right.verified) - Number(left.verified) || left.receivedAt - right.receivedAt);
    const progress = [...this.imageProgress.values()].filter(
      (entry) => entry.phase === 'waiting' || entry.phase === 'connecting' || entry.phase === 'transferring',
    );
    return `
      <main class="channel">
        <div class="channel-head">
          <button class="back" data-action="back" type="button">← landing</button>
          <div class="channel-title">
            <span class="channel-emoji">${escapeHtml(emoji)}</span>
            <div>
              <p class="eyebrow">rendezvous channel</p>
              <h1>${escapeHtml(channelPins?.label ?? words)}</h1>
              <p class="mono">${escapeHtml(words)}</p>
            </div>
          </div>
          <div class="channel-actions">
            <button class="small ghost" data-action="set-time" type="button">set a time</button>
            ${
              channelPins
                ? `<button class="small ghost" data-action="unpin" data-id="${escapeAttr(channelId)}" type="button">unpin</button>`
                : `<button class="small ghost" data-action="pin" type="button">pin circle</button>`
            }
          </div>
        </div>
        ${this.renderAudioPanel()}
        ${audioRequests.length ? this.renderAudioRequests(audioRequests) : ''}
        ${incoming.length ? this.renderImageOffers(incoming) : ''}
        ${progress.length ? this.renderProgress(progress) : ''}
        ${ownEntries.length ? this.renderOwnAnnouncements(ownEntries) : ''}
        <section class="time-groups">
          ${
            groups.size
              ? [...groups.entries()]
                  .map(
                    ([minute, rows]) => `
                      <div class="time-group">
                        <div class="time-separator"><span>${escapeHtml(formatTime(minute))}${formatDay(minute, this.now) ? ` · ${escapeHtml(formatDay(minute, this.now))}` : ''}</span></div>
                        ${rows
                          .map((row) => {
                            const human = this.humans.get(row.author);
                            if (!human) return '';
                            return this.renderHumanRow(human, true, authorIds);
                          })
                          .join('')}
                      </div>
                    `,
                  )
                  .join('')
              : '<p class="empty">No one else has announced a time here yet.</p>'
          }
        </section>
        ${
          channel
            ? ''
            : '<p class="empty">This channel is pinned but has no live announcements.</p>'
        }
      </main>
    `;
  }

  private renderOwnAnnouncements(entries: GoingAnnouncement[]): string {
    return `
      <section class="own-announcements" aria-label="Your rendezvous announcements">
        <p class="eyebrow">your rendezvous</p>
        ${entries
          .map(
            (entry) => `
              <p class="own-announcement">
                You set this rendezvous for
                <strong>${escapeHtml(formatTime(entry.scheduledAt))}</strong>${formatDay(entry.scheduledAt, this.now) ? ` · ${escapeHtml(formatDay(entry.scheduledAt, this.now))}` : ''}.
              </p>
            `,
          )
          .join('')}
      </section>
    `;
  }

  private renderImageOffers(offers: IncomingImageOffer[]): string {
    return `
      <section class="offers panel">
        <div class="panel-head"><h2>Image offers</h2><span>${offers.length}</span></div>
        ${offers
          .map(
            (offer) => `
              <div class="offer ${offer.verified ? 'is-verified' : ''}">
                <div>
                  <strong>${escapeHtml(formatWords(shortWords(offer.senderWords)))}</strong>
                  <span>${formatMb(offer.sizeMb)}${offer.verified ? ' · verified' : ''}</span>
                </div>
                <div class="row-actions">
                  <button class="small" data-action="accept-image" data-transfer="${escapeAttr(offer.transferId)}" type="button">accept</button>
                  <button class="small ghost" data-action="decline-image" data-transfer="${escapeAttr(offer.transferId)}" type="button">decline</button>
                </div>
              </div>
            `,
          )
          .join('')}
      </section>
    `;
  }

  private renderAudioRequests(requests: IncomingAudioRequest[]): string {
    return `
      <section class="offers panel">
        <div class="panel-head"><h2>Voice requests</h2><span>${requests.length}</span></div>
        ${requests
          .map(
            (request) => `
              <div class="offer ${request.verified ? 'is-verified' : ''}">
                <div>
                  <strong>${escapeHtml(formatWords(shortWords(request.senderWords)))}</strong>
                  <span>one minute · ${request.verified ? 'verified' : 'not verified'}</span>
                </div>
                <div class="row-actions">
                  <button class="small" data-action="accept-audio" data-transfer="${escapeAttr(request.transferId)}" type="button">accept</button>
                  <button class="small ghost" data-action="decline-audio" data-transfer="${escapeAttr(request.transferId)}" type="button">decline</button>
                </div>
              </div>
            `,
          )
          .join('')}
      </section>
    `;
  }

  private renderProgress(progress: ImageTransferProgress[]): string {
    return `
      <section class="progress-panel panel">
        ${progress
          .map(
            (entry) => `
              <div class="transfer">
                <div class="transfer-copy">
                  <strong>${entry.direction === 'outgoing' ? 'sending' : 'receiving'} ${escapeHtml(entry.name)}</strong>
                  <span>${entry.phase}${entry.error ? ` · ${escapeHtml(entry.error)}` : ''}</span>
                </div>
                <div class="bar"><span style="width:${entry.size ? Math.min(100, (entry.transferred / entry.size) * 100) : 10}%"></span></div>
              </div>
            `,
          )
          .join('')}
      </section>
    `;
  }

  private renderAudioPanel(): string {
    const session = this.audioSession;
    if (!session) return '';
    const remaining = audioRemaining(session.startedAt, this.now);
    return `
      <section class="audio-panel panel">
        <div class="panel-head"><h2>voice · one minute</h2><span>${session.phase}</span></div>
        <p>${escapeHtml(formatWords(shortWords(idToWords(session.peer))))}</p>
        <div class="pink-bar"><span style="width:${(remaining / 60_000) * 100}%"></span></div>
        <div class="row-actions">
          <button class="small ghost" data-action="mute-audio" type="button">${session.muted ? 'unmute' : 'mute'}</button>
          <button class="small" data-action="end-audio" type="button">end</button>
        </div>
      </section>
    `;
  }

  private renderDock(): string {
    if (this.pins.length === 0) return '';
    return `
      <nav class="dock" aria-label="pinned circles">
        ${this.pins
          .map(
            (pin) => `
              <button class="dock-item" data-action="open-channel" data-id="${escapeAttr(pin.channelId)}" title="${escapeAttr(pin.label)}" type="button">
                ${escapeHtml(formatEmoji(shortEmoji(idToEmoji(pin.channelId), 2)))}
              </button>
            `,
          )
          .join('')}
      </nav>
    `;
  }

  private renderModal(): string {
    if (!this.modal) return '';
    if (this.modal.type === 'set-time') {
      const channelId = this.modal.channelId ?? '';
      const now = new Date(this.now + 5 * 60_000);
      const value = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      return this.modalShell(
        channelId ? 'Set a time here' : 'Set a rendezvous',
        `
          <p class="modal-copy">${channelId ? 'This sends a signed GOING for this channel.' : 'A new channel ID is generated and announced.'}</p>
          <form data-form="set-time" data-channel="${escapeAttr(channelId)}">
            <label class="field">time<input id="time-input" name="time" type="time" value="${value}" required /></label>
            <div class="modal-actions"><button class="primary" type="submit">${channelId ? 'announce time' : 'create & go'}</button><button class="small ghost" data-action="close-modal" type="button">cancel</button></div>
          </form>
        `,
      );
    }
    if (this.modal.type === 'pin') {
      return this.modalShell(
        'Pin this channel',
        `
          <form data-form="pin" data-channel="${escapeAttr(this.modal.channelId)}">
            <label class="field">local label<input name="label" type="text" maxlength="48" placeholder="circle" autofocus /></label>
            <p class="modal-copy">The label stays on this browser.</p>
            <div class="modal-actions"><button class="primary" type="submit">pin</button><button class="small ghost" data-action="close-modal" type="button">cancel</button></div>
          </form>
        `,
      );
    }
    if (this.modal.type === 'human') {
      const human = this.humans.get(this.modal.humanId);
      if (!human) return '';
      return this.modalShell(
        human.verified ? 'Verified human' : 'Verify this human',
        `
          <div class="identity-words full">${escapeHtml(formatEmoji(human.emoji))}</div>
          <div class="identity-words full mono">${escapeHtml(formatWords(human.words))}</div>
          <p class="modal-copy">Compare these eight words out loud or through another app. Do not compare them over the same channel that delivered the introduction.</p>
          <p class="presence ${isOnline(human, this.now) ? 'online' : ''}">${isOnline(human, this.now) ? 'here now' : 'away'}</p>
          <div class="modal-actions">
            ${
              human.verified
                ? `<button class="small" data-action="unverify-human" data-id="${escapeAttr(human.id)}" type="button">unverify</button>`
                : `<button class="primary" data-action="verify-human" data-id="${escapeAttr(human.id)}" type="button">mark as verified</button>`
            }
            <button class="small ghost" data-action="close-modal" type="button">close</button>
          </div>
        `,
      );
    }
    if (this.modal.type === 'identity') {
      const ids = this.masks.map((mask) => mask.humanId);
      return this.modalShell(
        'Masks',
        `
          <p class="modal-copy">One mask is active at a time. Switching closes media and reconnects as the chosen identity.</p>
          <div class="mask-list">
            ${this.masks
              .map((mask) => {
                const active = mask.id === this.identity.id;
                const words = formatWords(uniqueWordDisplay(ids, mask.humanId));
                const emoji = formatEmoji(uniqueEmojiDisplay(ids, mask.humanId));
                return `
                  <div class="mask-row ${active ? 'is-active' : ''}">
                    <div class="mask-copy">
                      <span class="mask-emoji">${escapeHtml(emoji)}</span>
                      <strong>${escapeHtml(words)}</strong>
                    </div>
                    <div class="row-actions">
                      ${active ? '<span class="mask-active">active</span>' : `<button class="small ghost" data-action="switch-mask" data-id="${escapeAttr(mask.id)}" type="button">switch</button>`}
                      <button class="small ghost" data-action="remove-mask" data-id="${escapeAttr(mask.id)}" type="button">remove</button>
                    </div>
                  </div>
                `;
              })
              .join('')}
          </div>
          <p class="modal-copy">Verification words for the active mask:</p>
          <div class="identity-words full">${escapeHtml(formatEmoji(idToEmoji(this.identity.humanId)))}</div>
          <div class="identity-words full mono">${escapeHtml(formatWords(idToWords(this.identity.humanId)))}</div>
          <p class="modal-copy">These eight words are this mask's verification set. They are derived from its key. There is no account to recover.</p>
          <div class="modal-actions">
            <button class="primary" data-action="create-mask" type="button">new mask</button>
            <button class="small ghost" data-action="close-modal" type="button">close</button>
          </div>
        `,
      );
    }
    if (this.modal.type === 'send-photo') {
      return this.modalShell(
        'Send an image',
        `
          <p class="modal-copy">One image at a time. The recipient must accept before any bytes move.</p>
          <div class="modal-actions">
            <button class="primary" data-action="choose-photo" data-id="${escapeAttr(this.modal.humanId)}" type="button">choose image</button>
            ${this.lastImage ? `<button class="small" data-action="reuse-photo" data-id="${escapeAttr(this.modal.humanId)}" type="button">reuse last image</button>` : ''}
            <button class="small ghost" data-action="close-modal" type="button">cancel</button>
          </div>
        `,
      );
    }
    return '';
  }

  private renderImage(): string {
    if (!this.imageViewer) return '';
    return this.modalShell(
      this.imageViewer.label,
      `
        <img class="received-image" src="${escapeAttr(this.imageViewer.url)}" alt="received image" />
        <p class="modal-copy">${formatBytes(this.imageViewer.size)} · save it now; dismissing removes the in-app copy.</p>
        <div class="modal-actions">
          <a class="primary" href="${escapeAttr(this.imageViewer.url)}" download="${escapeAttr(this.imageViewer.filename)}">save to device</a>
          <button class="small ghost" data-action="dismiss-image" type="button">dismiss</button>
        </div>
      `,
    );
  }

  private modalShell(title: string, body: string): string {
    return `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
          <div class="modal-head"><h2>${title}</h2><button class="icon-button" data-action="close-modal" type="button" aria-label="close">×</button></div>
          ${body}
        </div>
      </div>
    `;
  }
}

function envelopeExpiry(envelope: Envelope): number {
  if (envelope.type === 'PING') return envelope.createdAt + PRESENCE_MS;
  if (envelope.type === 'GOING' && envelope.payload.kind === 'GOING') {
    return envelope.payload.scheduledAt + ANNOUNCEMENT_GRACE_MS;
  }
  return envelope.createdAt + SIGNAL_TTL_MS;
}

function formatMb(sizeMb: number): string {
  return `${Math.max(0.1, sizeMb).toFixed(1)} MB`;
}

function safeImageFilename(mime: string): string {
  const extension =
    mime === 'image/png'
      ? 'png'
      : mime === 'image/jpeg'
        ? 'jpg'
        : mime === 'image/webp'
          ? 'webp'
          : mime === 'image/gif'
            ? 'gif'
            : mime === 'image/avif'
              ? 'avif'
              : 'img';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `rdz-image-${stamp}.${extension}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
