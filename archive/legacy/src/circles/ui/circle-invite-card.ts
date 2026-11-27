import styles from './styles.css?inline';
import { escapeHtml, shortenKey } from './presentation';
import type { CircleInviteBundle } from '../invitations';

/**
 * Consent surface for a received invitation. The host wires the two events to
 * `acceptCircleInvite` / a local dismissal; this element never signs or sends.
 */
export class CircleInviteCard extends HTMLElement {
  private stateBundle: CircleInviteBundle | null = null;
  private stateInviterName = '';
  private stateCircleName = '';

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot?.addEventListener('click', (event) => {
      const target = event.composedPath()[0];
      if (!(target instanceof HTMLElement) || !this.stateBundle) return;
      const action = target.getAttribute('data-invite-action');
      if (action !== 'accept' && action !== 'decline') return;
      this.dispatchEvent(
        new CustomEvent(
          action === 'accept' ? 'circle-invite-accept' : 'circle-invite-decline',
          {
            detail: { bundle: this.stateBundle },
            bubbles: true,
            composed: true,
          },
        ),
      );
    });
  }

  set bundle(value: CircleInviteBundle | null) {
    this.stateBundle = value;
    this.render();
  }

  get bundle(): CircleInviteBundle | null {
    return this.stateBundle;
  }

  set inviterName(value: string) {
    this.stateInviterName = value;
    this.render();
  }

  get inviterName(): string {
    return this.stateInviterName;
  }

  set circleName(value: string) {
    this.stateCircleName = value;
    this.render();
  }

  get circleName(): string {
    return this.stateCircleName;
  }

  connectedCallback(): void {
    this.render();
  }

  private render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const bundle = this.stateBundle;
    if (!bundle) {
      root.innerHTML = `<style>${styles}</style><p class="empty">No pending invitation.</p>`;
      return;
    }

    const circleName = escapeHtml(this.stateCircleName || bundle.circleId);
    const inviter = escapeHtml(
      this.stateInviterName || shortenKey(bundle.inviter),
    );
    root.innerHTML = `
      <style>${styles}</style>
      <section class="invite-card" part="invite-card">
        <p class="kicker">circle invitation</p>
        <h1>${circleName}</h1>
        <p class="invite-copy">${inviter} invited you to join. Your browser will check the signed membership chain before anything is accepted.</p>
        <div class="invite-actions">
          <button type="button" class="invite-primary" data-invite-action="accept">join circle</button>
          <button type="button" class="invite-secondary" data-invite-action="decline">not now</button>
        </div>
      </section>
    `;
  }
}

export const CIRCLE_INVITE_CARD_TAG = 'circle-invite-card';

export function defineCircleInviteCard(tagName = CIRCLE_INVITE_CARD_TAG): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(tagName)) customElements.define(tagName, CircleInviteCard);
}
