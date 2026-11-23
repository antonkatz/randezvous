import styles from './styles.css?inline';
import {
  asOfLine,
  escapeHtml,
  shortenKey,
  statLines,
} from './presentation';
import type { CircleStats, MemberView, PublicKeyId } from '../types';

const EMPTY_STATS = `
  <p class="empty">No circle stats yet. Merge a circle to begin.</p>
`;

export interface InviteCandidate {
  peerKey: PublicKeyId;
  name?: string;
  online?: boolean;
}

export class CircleStatsPage extends HTMLElement {
  private stateStats: CircleStats | null = null;
  private stateView: MemberView | null = null;
  private stateInviteCandidates: readonly InviteCandidate[] = [];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot?.addEventListener('click', (event) => {
      const target = event.composedPath()[0];
      if (!(target instanceof HTMLElement)) return;
      const peerKey = target.getAttribute('data-invite-key');
      if (!peerKey || !this.stateStats) return;
      this.dispatchEvent(
        new CustomEvent('circle-invite-request', {
          detail: { circleId: this.stateStats.circleId, peerKey },
          bubbles: true,
          composed: true,
        }),
      );
    });
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

    root.innerHTML = `
      <style>${styles}</style>
      <article class="circle-page" part="page">
        <header class="circle-head" part="header">
          <p class="kicker">as you see this circle</p>
          <h1>${name}</h1>
          <p class="sync">${escapeHtml(asOfLine(stats.asOf, stats.timezone))}</p>
        </header>
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
