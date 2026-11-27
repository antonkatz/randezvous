import styles from './styles.css?inline';
import { escapeHtml, ringGeometry, scorePercent } from './presentation';
import type { RankedCircle } from '../leaderboard';

export class CircleStatsList extends HTMLElement {
  private stateEntries: readonly RankedCircle[] = [];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot?.addEventListener('click', (event) => {
      this.selectFromEvent(event);
    });
    this.shadowRoot?.addEventListener('keydown', (event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (this.selectFromEvent(event)) event.preventDefault();
    });
  }

  set entries(value: readonly RankedCircle[]) {
    this.stateEntries = value;
    this.render();
  }

  get entries(): readonly RankedCircle[] {
    return this.stateEntries;
  }

  connectedCallback(): void {
    this.render();
  }

  private selectFromEvent(event: Event): boolean {
    const target = event.composedPath()[0];
    if (!(target instanceof HTMLElement)) return false;
    const row = target.closest('.circle-row');
    const circleId = row?.getAttribute('data-circle-id');
    if (!circleId) return false;
    this.dispatchEvent(
      new CustomEvent('circle-select', {
        detail: { circleId },
        bubbles: true,
        composed: true,
      }),
    );
    return true;
  }

  private render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const entries = [...this.stateEntries].sort((a, b) => a.rank - b.rank);

    const rows = entries
      .map((entry) => {
        const ring = ringGeometry(entry.score);
        const percent = scorePercent(entry.score);
        const name = escapeHtml(entry.stats.name || entry.circleId);
        return `
          <li class="circle-row" part="row" role="button" tabindex="0" data-circle-id="${escapeHtml(entry.circleId)}" aria-label="${name}, score ${percent} percent, rank ${entry.rank}. Open circle.">
            <span class="rank" part="rank" aria-hidden="true">${entry.rank}</span>
            <span class="ring" part="ring" aria-hidden="true">
              <svg viewBox="0 0 80 80">
                <circle class="ring-track" cx="40" cy="40" r="${ring.radius}" stroke-width="${ring.strokeWidth}"></circle>
                <circle class="ring-value" cx="40" cy="40" r="${ring.radius}" stroke-width="${ring.strokeWidth}"
                  stroke-dasharray="${ring.circumference}"
                  stroke-dashoffset="${ring.dashOffset}"
                  transform="rotate(-90 40 40)"></circle>
              </svg>
              <span class="ring-label">${percent}%</span>
            </span>
            <span class="circle-name" part="name">${name}</span>
            <span class="circle-meta">${entry.stats.memberCount} humans</span>
          </li>`;
      })
      .join('');

    root.innerHTML = `
      <style>${styles}</style>
      <section class="circle-list" part="list">
        <header class="list-head">
          <div>
            <p class="kicker">ranked on this browser</p>
            <h1>Your circles</h1>
          </div>
          <p class="sync">scores never leave this device</p>
        </header>
        ${
          entries.length > 0
            ? `<ol class="circles" part="rows">${rows}</ol>`
            : '<p class="empty">No circles yet.</p>'
        }
      </section>
    `;
  }
}

export const CIRCLE_STATS_LIST_TAG = 'circle-stats-list';

export function defineCircleStatsList(tagName = CIRCLE_STATS_LIST_TAG): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(tagName)) customElements.define(tagName, CircleStatsList);
}
