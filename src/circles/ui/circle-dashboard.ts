import styles from './styles.css?inline';
import { CircleCreateForm, defineCircleCreateForm } from './circle-create-form';
import { CircleInviteCard, defineCircleInviteCard } from './circle-invite-card';
import {
  CircleStatsPage,
  defineCircleStatsPage,
  type InviteCandidate,
} from './circle-stats-page';
import { CircleStatsList, defineCircleStatsList } from './circle-stats-list';
import type { CircleInviteBundle } from '../invitations';
import type { RankedCircle } from '../leaderboard';
import type { CircleStats, MemberView } from '../types';

type Panel = 'list' | 'create' | 'circle';

/**
 * Minimal composition shell for a circles tab. It owns presentation state
 * only: all creation, persistence, verification and sending is host code.
 *
 * Events leaving the dashboard:
 * - circle-create { name, timezone }
 * - circle-select { circleId }
 * - circle-invite-request { circleId, peerKey }
 * - circle-invite-accept { bundle }
 * - circle-invite-decline { bundle }
 */
export class CircleDashboard extends HTMLElement {
  private stateEntries: readonly RankedCircle[] = [];
  private stateStats: CircleStats | null = null;
  private stateView: MemberView | null = null;
  private stateInviteCandidates: readonly InviteCandidate[] = [];
  private statePendingInvite: CircleInviteBundle | null = null;
  private stateBusy = false;
  private stateError = '';
  private stateDefaultTimezone = '';
  private stateInviteCircleName = '';
  private stateInviteInviterName = '';
  private panel: Panel = 'list';

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot?.addEventListener('click', (event) => {
      const target = event.composedPath()[0];
      if (!(target instanceof HTMLElement)) return;
      const action = target.getAttribute('data-dashboard-action');
      if (action === 'create') {
        this.panel = 'create';
        this.stateError = '';
        this.render();
      } else if (action === 'back') {
        this.stateStats = null;
        this.panel = 'list';
        this.render();
      }
    });
  }

  set entries(value: readonly RankedCircle[]) {
    this.stateEntries = value;
    this.render();
  }

  get entries(): readonly RankedCircle[] {
    return this.stateEntries;
  }

  set stats(value: CircleStats | null) {
    this.stateStats = value;
    this.panel = value ? 'circle' : 'list';
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

  set pendingInvite(value: CircleInviteBundle | null) {
    this.statePendingInvite = value;
    this.render();
  }

  get pendingInvite(): CircleInviteBundle | null {
    return this.statePendingInvite;
  }

  set busy(value: boolean) {
    this.stateBusy = value;
    this.updateCreateForm();
  }

  get busy(): boolean {
    return this.stateBusy;
  }

  set error(value: string) {
    this.stateError = value;
    this.updateCreateForm();
  }

  get error(): string {
    return this.stateError;
  }

  set defaultTimezone(value: string) {
    this.stateDefaultTimezone = value;
    this.updateCreateForm();
  }

  get defaultTimezone(): string {
    return this.stateDefaultTimezone;
  }

  set inviteCircleName(value: string) {
    this.stateInviteCircleName = value;
    this.render();
  }

  get inviteCircleName(): string {
    return this.stateInviteCircleName;
  }

  set inviteInviterName(value: string) {
    this.stateInviteInviterName = value;
    this.render();
  }

  get inviteInviterName(): string {
    return this.stateInviteInviterName;
  }

  showList(): void {
    this.stateStats = null;
    this.panel = 'list';
    this.render();
  }

  showCreate(): void {
    this.panel = 'create';
    this.stateError = '';
    this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  private ensureElements(): void {
    if (typeof customElements === 'undefined') return;
    defineCircleStatsPage();
    defineCircleStatsList();
    defineCircleCreateForm();
    defineCircleInviteCard();
  }

  private render(): void {
    const root = this.shadowRoot;
    if (!root || typeof document === 'undefined') return;
    this.ensureElements();

    if (this.statePendingInvite) {
      root.innerHTML = `
        <style>${styles}</style>
        <div class="dashboard" part="dashboard">
          <div class="dashboard-body"></div>
        </div>
      `;
      const body = root.querySelector<HTMLElement>('.dashboard-body');
      const card = document.createElement('circle-invite-card') as CircleInviteCard;
      card.bundle = this.statePendingInvite;
      card.circleName = this.stateInviteCircleName || this.pendingCircleName();
      card.inviterName = this.stateInviteInviterName;
      body?.append(card);
      return;
    }

    const panel = this.stateStats && this.panel === 'circle' ? 'circle' : this.panel;
    const showBack = panel !== 'list';
    root.innerHTML = `
      <style>${styles}</style>
      <div class="dashboard" part="dashboard">
        <header class="dashboard-head" part="dashboard-head">
          <p class="kicker">circles</p>
          <nav class="dashboard-actions" aria-label="Circle navigation">
            ${
              panel === 'list'
                ? '<button type="button" class="dashboard-button" data-dashboard-action="create">new circle</button>'
                : ''
            }
            ${
              showBack
                ? '<button type="button" class="dashboard-button" data-dashboard-action="back">back</button>'
                : ''
            }
          </nav>
        </header>
        <div class="dashboard-body"></div>
      </div>
    `;
    const body = root.querySelector<HTMLElement>('.dashboard-body');
    if (!body) return;

    if (panel === 'create') {
      const form = document.createElement('circle-create-form') as CircleCreateForm;
      form.busy = this.stateBusy;
      form.error = this.stateError;
      if (this.stateDefaultTimezone) form.defaultTimezone = this.stateDefaultTimezone;
      form.addEventListener('circle-create-cancel', () => this.showList());
      body.append(form);
      return;
    }

    if (panel === 'circle' && this.stateStats) {
      const page = document.createElement('circle-stats-page') as CircleStatsPage;
      page.stats = this.stateStats;
      page.view = this.stateView;
      page.inviteCandidates = this.stateInviteCandidates;
      body.append(page);
      return;
    }

    const list = document.createElement('circle-stats-list') as CircleStatsList;
    list.entries = this.stateEntries;
    body.append(list);
  }

  private updateCreateForm(): void {
    if (this.panel !== 'create' || this.statePendingInvite) {
      this.render();
      return;
    }
    const form = this.shadowRoot?.querySelector(
      'circle-create-form',
    ) as CircleCreateForm | null;
    if (!form) {
      this.render();
      return;
    }
    form.busy = this.stateBusy;
    form.error = this.stateError;
    if (this.stateDefaultTimezone) form.defaultTimezone = this.stateDefaultTimezone;
  }

  private pendingCircleName(): string {
    const bundle = this.statePendingInvite;
    if (!bundle) return '';
    for (const entry of bundle.records) {
      if (entry.record.type === 'CircleCreated') return entry.record.name;
    }
    return bundle.circleId;
  }
}

export const CIRCLE_DASHBOARD_TAG = 'circle-dashboard';

export function defineCircleDashboard(tagName = CIRCLE_DASHBOARD_TAG): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(tagName)) customElements.define(tagName, CircleDashboard);
}
