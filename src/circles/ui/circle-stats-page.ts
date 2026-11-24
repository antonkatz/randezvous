import styles from './styles.css?inline';
import {
  asOfLine,
  escapeHtml,
  shortenKey,
  statLines,
} from './presentation';
import type { CircleOffer, CircleDayPlans } from '../plans';
import type { CircleStats, MemberView, PlanJoinRecord, PlanRecord, PublicKeyId } from '../types';

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
    const offers = this.stateOffers.filter(
      (offer) =>
        (offer.plan.record as PlanRecord).scheduledAt >= Date.now() - 5 * 60_000,
    );
    const offerRows =
      offers.length > 0
        ? offers
            .map((offer) => {
              const plan = offer.plan.record as PlanRecord;
              const joined = offer.joins.some(
                (entry) => (entry.record as PlanJoinRecord).member === selfKey,
              );
              const organizer = plan.organizer === selfKey;
              const people = offer.participants.map((key) => shortenKey(key)).join(' · ');
              return `
                <div class="circle-offer" data-plan-id="${escapeHtml(offer.plan.id)}">
                  <p class="canonical-plan">${escapeHtml(formatWindowMoment(plan.scheduledAt))} <span>by ${escapeHtml(shortenKey(plan.organizer))}</span></p>
                  <p class="offer-state ${offer.confirmed ? 'is-confirmed' : 'is-pending'}">${offer.confirmed ? `confirmed · ${offer.participants.length} going` : 'pending · waiting for someone to join'}${people ? ` · ${escapeHtml(people)}` : ''}</p>
                  <div class="plan-row">
                    <button type="button" class="invite-button" data-action="join-plan" data-plan-id="${escapeHtml(offer.plan.id)}" ${organizer || joined ? 'disabled' : ''}>${organizer ? 'your offer' : joined ? 'joined' : 'join this moment'}</button>
                    <button type="button" class="dashboard-button" data-action="offer-link" data-plan-id="${escapeHtml(offer.plan.id)}">invite by link</button>
                  </div>
                </div>`;
            })
            .join('')
        : '<p class="canonical-plan is-empty">no circle rendezvous offered yet</p>';
    const planBlock = `
      <section class="circle-plan" part="plan">
        <h2>circle rendezvous offers</h2>
        <p>Anyone can offer a moment and anyone can join any offer. Several offers may run independently at different times; nobody has to wait for the whole circle.</p>
        ${offerRows}
        <label class="plan-label" for="circle-plan-at">propose a moment</label>
        <div class="plan-row">
          <input id="circle-plan-at" type="datetime-local" min="${localInputValue(Date.now())}">
          <button type="button" class="invite-button" data-action="set-plan">offer a circle rendezvous</button>
        </div>
      </section>`;

    const windowBlock = `
      <section class="circle-window" part="window">
        <h2>gathering window</h2>
        <p>Optional. Plans signed while the window is active must fall inside it. It never shortens the five-minute handoff.</p>
        ${
          this.stateWindow
            ? `<p class="canonical-plan">active · ${escapeHtml(formatWindowMoment(this.stateWindow.start))} → ${escapeHtml(formatWindowMoment(this.stateWindow.end))}</p>`
            : '<p class="canonical-plan is-empty">no window · any moment is allowed</p>'
        }
        <div class="plan-row">
          <input id="circle-window-start" type="datetime-local">
          <input id="circle-window-end" type="datetime-local">
        </div>
        <div class="plan-row">
          <button type="button" class="invite-button" data-action="set-window">set window</button>
          <button type="button" class="dashboard-button" data-action="clear-window">clear window</button>
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
        ${windowBlock}
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
