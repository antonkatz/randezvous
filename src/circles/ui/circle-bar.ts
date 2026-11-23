import { escapeHtml } from './presentation';

export interface CircleBarItem {
  circleId: string;
  name: string;
}

const STYLES = `
:host {
  position: fixed;
  left: 50%;
  bottom: calc(16px + env(safe-area-inset-bottom));
  z-index: 70;
  display: block;
  width: fit-content;
  max-width: min(760px, calc(100vw - 24px));
  transform: translateX(-50%);
}

.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px;
  color: var(--ink, #151310);
  background: var(--paper-bright, #faf6ed);
  border: 1px solid var(--line-strong, rgba(21, 19, 16, 0.32));
  border-radius: 999px;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.7) inset,
    0 12px 34px rgba(21, 19, 16, 0.18);
  font-family: var(--sans, ui-sans-serif, system-ui, sans-serif);
}

.add {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 48px;
  padding: 0 17px;
  color: var(--paper-bright, #faf6ed);
  background: var(--ink, #151310);
  border: 1px solid var(--ink, #151310);
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  white-space: nowrap;
  transition:
    background 150ms ease,
    transform 150ms ease;
}

.add:hover {
  background: #24211c;
}

.add:active {
  transform: translateY(1px);
}

.add-plus {
  margin-top: -1px;
  font-size: 19px;
  font-weight: 300;
  line-height: 1;
}

.add-text {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 10px;
  letter-spacing: 0.02em;
}

.list {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 7px;
  overflow-x: auto;
  padding: 1px;
  scrollbar-width: none;
}

.list::-webkit-scrollbar {
  display: none;
}

.circle {
  flex: 0 0 auto;
  width: 48px;
  height: 48px;
  display: grid;
  place-items: center;
  padding: 0;
  color: var(--ink, #151310);
  background: transparent;
  border: 1px solid var(--line-strong, rgba(21, 19, 16, 0.32));
  border-radius: 50%;
  font-family: var(--serif, Georgia, serif);
  font-size: 19px;
  line-height: 1;
  text-transform: uppercase;
  transition:
    background 150ms ease,
    color 150ms ease,
    border-color 150ms ease,
    box-shadow 150ms ease,
    transform 150ms ease;
}

.circle:hover {
  background: var(--paper-deep, #e7dfd1);
  transform: translateY(-1px);
}

.circle.is-active {
  color: var(--paper-bright, #faf6ed);
  background: var(--ink, #151310);
  border-color: var(--ink, #151310);
  box-shadow: 0 0 0 3px var(--accent-wash, #efc4b5);
}

@media (max-width: 720px) {
  :host {
    bottom: calc(10px + env(safe-area-inset-bottom));
    max-width: calc(100vw - 16px);
  }

  .bar {
    gap: 6px;
    padding: 5px;
  }

  .add {
    min-height: 44px;
    padding: 0 13px;
  }

  .add-plus {
    font-size: 17px;
  }

  .circle {
    width: 44px;
    height: 44px;
    font-size: 17px;
  }
}
`;

function initialFor(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '·';
}

/**
 * Persistent bottom navigation for circles. Presentation only: it never
 * creates or selects a circle itself. The host listens for `circle-add` and
 * `circle-open` and owns the active circle.
 */
export class CircleBar extends HTMLElement {
  private stateEntries: readonly CircleBarItem[] = [];
  private stateActiveCircleId: string | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot?.addEventListener('click', (event) => {
      const target = event.composedPath()[0];
      if (!(target instanceof HTMLElement)) return;

      if (target.closest('[data-circle-add]')) {
        this.dispatchEvent(
          new CustomEvent('circle-add', { bubbles: true, composed: true }),
        );
        return;
      }

      const button = target.closest<HTMLElement>('[data-circle-id]');
      const circleId = button?.getAttribute('data-circle-id');
      if (!circleId) return;
      this.dispatchEvent(
        new CustomEvent('circle-open', {
          detail: { circleId },
          bubbles: true,
          composed: true,
        }),
      );
    });
  }

  set entries(value: readonly CircleBarItem[]) {
    this.stateEntries = [...value];
    this.render();
  }

  get entries(): readonly CircleBarItem[] {
    return this.stateEntries;
  }

  set activeCircleId(value: string | null) {
    this.stateActiveCircleId = value;
    this.render();
  }

  get activeCircleId(): string | null {
    return this.stateActiveCircleId;
  }

  connectedCallback(): void {
    this.render();
  }

  private render(): void {
    const root = this.shadowRoot;
    if (!root) return;

    const circles = this.stateEntries
      .map((entry) => {
        const name = entry.name.trim() || entry.circleId;
        const active = entry.circleId === this.stateActiveCircleId;
        return `
          <button
            class="circle${active ? ' is-active' : ''}"
            type="button"
            part="circle"
            data-circle-id="${escapeHtml(entry.circleId)}"
            aria-label="${escapeHtml(name)}"
            title="${escapeHtml(name)}"
            ${active ? 'aria-current="true"' : ''}
          >${escapeHtml(initialFor(name))}</button>
        `;
      })
      .join('');

    root.innerHTML = `
      <style>${STYLES}</style>
      <nav class="bar" part="bar" aria-label="Your circles">
        <button
          class="add"
          type="button"
          part="add"
          data-circle-add
          aria-haspopup="dialog"
          aria-label="Create a circle"
        >
          <span class="add-plus" aria-hidden="true">+</span>
          <span class="add-text" aria-hidden="true">circle</span>
        </button>
        <div class="list" part="list">${circles}</div>
      </nav>
    `;
  }
}

export const CIRCLE_BAR_TAG = 'circle-bar';

export function defineCircleBar(tagName = CIRCLE_BAR_TAG): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(tagName)) customElements.define(tagName, CircleBar);
}
