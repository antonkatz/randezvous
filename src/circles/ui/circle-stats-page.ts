import styles from './styles.css?inline';
import {
  asOfLine,
  escapeHtml,
  shortenKey,
  statLines,
} from './presentation';
import type { CircleDayPlans } from '../plans';
import type { CircleStats, MemberView, PublicKeyId } from '../types';

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
  private stateWindow: { start: number; end: number } | null = null;

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

  set window(value: { start: number; end: number } | null) {
    this.stateWindow = value;
    this.render();
  }

  get window(): { start: number; end: number } | null {
    return this.stateWindow;
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
    const inviteBlock =
      inviteCandidates.length > 0
        ? `
        <section class="invite" part="invite">
          <h2>invite a human</h2>
          <p>Direct humans who are not in this circle yet. They receive a signed invitation over your existing connection.</p>
          <ul class="invite-list">
            ${inviteCandidates
              .map(
                (candidate) => `
              <li>
                <span class="invite-name">${escapeHtml(candidate.name || shortenKey(candidate.peerKey))}${candidate.online ? '<span class="online">online</span>' : ''}</span>
                <button type="button" class="invite-button" data-invite-key="${escapeHtml(candidate.peerKey)}">invite</button>
              </li>`,
              )
              .join('')}
          </ul>
        </section>`
        : '';

    const nextPlan =
      this.statePlans.find((entry) => entry.canonical.record && (entry.canonical.record as { scheduledAt: number }).scheduledAt >= Date.now() - 5 * 60_000) ??
      this.statePlans[this.statePlans.length - 1] ??
      null;
    const planBlock = `
      <section class="circle-plan" part="plan">
        <h2>the circle rendezvous</h2>
        <p>One shared moment per local day. The first signed plan wins; later plans stay as history. Photographs still travel pairwise.</p>
        ${
          nextPlan
            ? `<p class="canonical-plan">next · ${escapeHtml(formatWindowMoment((nextPlan.canonical.record as { scheduledAt: number }).scheduledAt))} <span>by ${escapeHtml(shortenKey((nextPlan.canonical.record as { organizer: string }).organizer))}</span></p>`
            : '<p class="canonical-plan is-empty">no circle rendezvous set yet</p>'
        }
        <label class="plan-label" for="circle-plan-at">set a moment</label>
        <div class="plan-row">
          <input id="circle-plan-at" type="datetime-local" min="${localInputValue(Date.now())}">
          <button type="button" class="invite-button" data-action="set-plan">set circle rendezvous</button>
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
