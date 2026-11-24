import styles from './styles.css?inline';
import {
  asOfLine,
  escapeHtml,
  shortenKey,
  statLines,
} from './presentation';
import type { CircleOffer, CircleDayPlans } from '../plans';
import type { CircleStats, MemberView, PlanJoinRecord, PlanRecord, PublicKeyId } from '../types';
import type { StoredRendezvous } from '../../lib/types';

const EMPTY_STATS = `
  <p class="empty">No circle stats yet. Merge a circle to begin.</p>
`;

export interface InviteCandidate {
  peerKey: PublicKeyId;
  name?: string;
  online?: boolean;
}

function localInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatWindowMoment(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export class CircleStatsPage extends HTMLElement {
  private stateStats: CircleStats | null = null;
  private stateView: MemberView | null = null;
  private stateInviteCandidates: readonly InviteCandidate[] = [];
  private statePlans: readonly CircleDayPlans[] = [];
  private stateOffers: readonly CircleOffer[] = [];
  private stateWindow: { start: number; end: number } | null = null;
  private stateNewInviteLink = '';
  private stateRendezvous: readonly StoredRendezvous[] = [];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot?.addEventListener('click', (event) => {
      const target = event.composedPath()[0];
      if (!(target instanceof HTMLElement)) return;
      const peerKey = target.getAttribute('data-invite-key');
      if (peerKey && this.stateStats) {
        this.dispatchEvent(
          new CustomEvent('circle-invite-request', {
            detail: { circleId: this.stateStats.circleId, peerKey },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
      if (!this.stateStats) return;
      if (target.getAttribute('data-action') === 'invite-new') {
        this.dispatchEvent(
          new CustomEvent('circle-invite-new', {
            detail: { circleId: this.stateStats.circleId },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
      if (target.getAttribute('data-action') === 'copy-new-invite') {
        const input = this.shadowRoot?.querySelector<HTMLInputElement>('#new-circle-link');
        if (!input || !input.value.startsWith('http')) return;
        void navigator.clipboard.writeText(input.value).then(
          () => {
            target.textContent = 'copied';
            window.setTimeout(() => {
              target.textContent = 'copy';
            }, 2200);
          },
          () => {
            input.focus();
            input.select();
          },
        );
        return;
      }
      if (target.getAttribute('data-action') === 'new-rendezvous') {
        this.dispatchEvent(
          new CustomEvent('circle-rendezvous-new', {
            detail: { circleId: this.stateStats.circleId },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
      if (target.getAttribute('data-action') === 'open-rendezvous') {
        const rendezvousId = target.getAttribute('data-rendezvous-id');
        if (!rendezvousId) return;
        this.dispatchEvent(
          new CustomEvent('circle-rendezvous-open', {
            detail: { circleId: this.stateStats.circleId, rendezvousId },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
      if (target.getAttribute('data-action') === 'set-plan') {
        const start = this.shadowRoot?.querySelector<HTMLInputElement>('#circle-plan-at');
        const at = start ? new Date(start.value).getTime() : NaN;
        if (!Number.isFinite(at)) return;
        this.dispatchEvent(
          new CustomEvent('circle-plan-request', {
            detail: { circleId: this.stateStats.circleId, scheduledAt: at },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
      if (target.getAttribute('data-action') === 'offer-link') {
        const planId = target.getAttribute('data-plan-id');
        if (!planId) return;
        this.dispatchEvent(
          new CustomEvent('circle-offer-link', {
            detail: { circleId: this.stateStats.circleId, planId },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
      if (target.getAttribute('data-action') === 'join-plan') {
        const planId = target.getAttribute('data-plan-id');
        if (!planId) return;
        this.dispatchEvent(
          new CustomEvent('circle-plan-join', {
            detail: { circleId: this.stateStats.circleId, planId },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
      if (
        target.getAttribute('data-action') === 'set-window' ||
        target.getAttribute('data-action') === 'clear-window'
      ) {
        if (target.getAttribute('data-action') === 'clear-window') {
          this.dispatchEvent(
            new CustomEvent('circle-window-clear', {
              detail: { circleId: this.stateStats.circleId },
              bubbles: true,
              composed: true,
            }),
          );
          return;
        }
        const start = this.shadowRoot?.querySelector<HTMLInputElement>('#circle-window-start');
        const end = this.shadowRoot?.querySelector<HTMLInputElement>('#circle-window-end');
        const startAt = start ? new Date(start.value).getTime() : NaN;
        const endAt = end ? new Date(end.value).getTime() : NaN;
        if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt >= endAt) return;
        this.dispatchEvent(
          new CustomEvent('circle-window-request', {
            detail: {
              circleId: this.stateStats.circleId,
              start: startAt,
              end: endAt,
            },
            bubbles: true,
            composed: true,
          }),
        );
      }
    });
  }

  set plans(value: readonly CircleDayPlans[]) {
    this.statePlans = value;
    this.render();
  }

  get plans(): readonly CircleDayPlans[] {
    return this.statePlans;
  }

  set offers(value: readonly CircleOffer[]) {
    this.stateOffers = value;
    this.render();
  }

  get offers(): readonly CircleOffer[] {
    return this.stateOffers;
  }

  set window(value: { start: number; end: number } | null) {
    this.stateWindow = value;
    this.render();
  }

  get window(): { start: number; end: number } | null {
    return this.stateWindow;
  }

  set newInviteLink(value: string) {
    this.stateNewInviteLink = value;
    this.render();
  }

  get newInviteLink(): string {
    return this.stateNewInviteLink;
  }

  set rendezvous(value: readonly StoredRendezvous[]) {
    this.stateRendezvous = value;
    this.render();
  }

  get rendezvous(): readonly StoredRendezvous[] {
    return this.stateRendezvous;
  }

  set stats(value: CircleStats | null) {
    this.stateStats = value;
    this.render();
  }

  get stats(): CircleStats | null {
    return this.stateStats;
  }

  set view(value: MemberView | null) {
    this.stateView = value;
    this.render();
  }

  get view(): MemberView | null {
    return this.stateView;
  }

  set inviteCandidates(value: readonly InviteCandidate[]) {
    this.stateInviteCandidates = value;
    this.render();
  }

  get inviteCandidates(): readonly InviteCandidate[] {
    return this.stateInviteCandidates;
  }

  connectedCallback(): void {
    this.render();
  }

  private render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const stats = this.stateStats;
    const view = this.stateView;

    if (!stats) {
      root.innerHTML = `<style>${styles}</style><article class="circle-page" part="page">${EMPTY_STATS}</article>`;
      return;
    }

    const name = escapeHtml(stats.name || 'circle');
    const lines = statLines(stats)
      .map(
        (line) => `
        <div class="stat" data-stat="${escapeHtml(line.key)}" part="stat">
          <div class="stat-head">
            <span class="stat-label">${escapeHtml(line.label)}</span>
            <span class="stat-value">${line.value} <span class="of">/ ${line.target}</span></span>
          </div>
          <div class="bar" part="bar" role="progressbar"
            aria-label="${escapeHtml(line.label)}"
            aria-valuemin="0"
            aria-valuemax="${line.target}"
            aria-valuenow="${line.value}"
            aria-valuetext="${line.value} of ${line.target}">
            <span class="bar-fill" part="bar-fill" style="width: ${line.percent}%"></span>
          </div>
          <p class="stat-detail">${escapeHtml(line.detail)}</p>
        </div>`,
      )
      .join('');

    const unconnected = view?.unconnectedToYou ?? [];
    const unconnectedBlock =
      unconnected.length > 0
        ? `
        <section class="unconnected" part="unconnected">
          <h2>not yet direct humans</h2>
          <p>These members are in your view of the circle, but you have not linked them directly. Add a human to sync with them.</p>
          <ul class="key-list">
            ${unconnected
              .map((key) => `<li title="${escapeHtml(key)}">${escapeHtml(shortenKey(key))}</li>`)
              .join('')}
          </ul>
        </section>`
        : '';

    const inviteCandidates = this.stateInviteCandidates;
    const inviteBlock = `
        <section class="invite" part="invite">
          <h2>invite a human</h2>
          <p>A circle invitation is also a human invitation. Existing humans receive it over your connection; someone new redeems a link that creates the human link and the circle membership locally.</p>
          ${
            inviteCandidates.length > 0
              ? `<ul class="invite-list">
            ${inviteCandidates
              .map(
                (candidate) => `
              <li>
                <span class="invite-name">${escapeHtml(candidate.name || shortenKey(candidate.peerKey))}${candidate.online ? '<span class="online">online</span>' : ''}</span>
                <button type="button" class="invite-button" data-invite-key="${escapeHtml(candidate.peerKey)}">invite</button>
              </li>`,
              )
              .join('')}
          </ul>`
              : `<p class="invite-empty">No linked humans are waiting to join this circle.</p>`
          }
          <div class="plan-row">
            <button type="button" class="invite-button" data-action="invite-new">invite someone new</button>
          </div>
          ${
            this.stateNewInviteLink
              ? `<div class="new-circle-link">
                  <label for="new-circle-link">the circle invitation link</label>
                  <div class="link-row">
                    <input id="new-circle-link" readonly value="${escapeHtml(this.stateNewInviteLink)}">
                    <button type="button" class="invite-button" data-action="copy-new-invite">copy</button>
                  </div>
                  <p>Opening this link creates the direct-human link, adds the person to this circle immediately, and joins the offered moment when the link came from one. The inviter does not need to be online.</p>
                </div>`
              : ''
          }
        </section>`;

    const selfKey = this.stateView?.selfKey ?? '';
    const upcoming = this.stateRendezvous
      .filter(
        (record) =>
          record.circleId === stats.circleId &&
          record.status !== 'cancelled' &&
          record.status !== 'missed' &&
          record.scheduledFor >= Date.now() - 5 * 60_000,
      )
      .sort((left, right) => left.scheduledFor - right.scheduledFor);
    const rendezvousRows =
      upcoming.length > 0
        ? upcoming
            .map((record) => {
              const others = (record.participants ?? []).filter(
                (entry) => entry.id !== selfKey,
              );
              const creator = record.participants?.find(
                (entry) => entry.id === (record.creatorId ?? record.peerId),
              );
              const kept = Boolean(record.keptAt) || record.status === 'kept';
              const delivered = record.status === 'delivered';
              const state = delivered
                ? 'delivered'
                : kept
                  ? `kept · ${(record.deliveredTo ?? []).length} delivered`
                  : record.status === 'transferring'
                    ? 'moving directly'
                    : `${others.length} invited · ${record.confirmedBy?.length ?? 0} confirmed`;
              return `
                <div class="circle-offer" data-rendezvous-id="${escapeHtml(record.id)}">
                  <p class="canonical-plan">${escapeHtml(formatWindowMoment(record.scheduledFor))} <span>by ${escapeHtml(shortenKey(creator?.name || record.peerName || 'you'))}</span></p>
                  <p class="offer-state ${kept || delivered ? 'is-confirmed' : 'is-pending'}">${escapeHtml(state)}</p>
                  <div class="plan-row">
                    <button type="button" class="invite-button" data-action="open-rendezvous" data-rendezvous-id="${escapeHtml(record.id)}">open</button>
                  </div>
                </div>`;
            })
            .join('')
        : '<p class="canonical-plan is-empty">no circle rendezvous yet</p>';
    const planBlock = `
      <section class="circle-plan" part="plan">
        <h2>circle rendezvous</h2>
        <p>A circle rendezvous is a normal rendezvous on this circle channel. Every current non-banned member receives it; any two people who show up keep the meeting.</p>
        ${rendezvousRows}
        <div class="plan-row">
          <button type="button" class="invite-button" data-action="new-rendezvous">set a circle rendezvous</button>
        </div>
      </section>`;

    root.innerHTML = `
      <style>${styles}</style>
      <article class="circle-page" part="page">
        <header class="circle-head" part="header">
          <p class="kicker">as you see this circle</p>
          <h1>${name}</h1>
          <p class="sync">${escapeHtml(asOfLine(stats.asOf, stats.timezone))}</p>
        </header>
        ${planBlock}
        <section class="stats" part="stats" aria-label="circle progress">
          ${lines}
        </section>
        ${unconnectedBlock}
        ${inviteBlock}
      </article>
    `;
  }
}

export const CIRCLE_STATS_PAGE_TAG = 'circle-stats-page';

export function defineCircleStatsPage(tagName = CIRCLE_STATS_PAGE_TAG): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(tagName)) customElements.define(tagName, CircleStatsPage);
}
