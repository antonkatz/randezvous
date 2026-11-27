import styles from './styles.css?inline';
import {
  browserTimezone,
  escapeHtml,
  validateCircleDraft,
} from './presentation';

function timezoneValues(): string[] {
  try {
    const intl = Intl as unknown as {
      supportedValuesOf?: (key: string) => string[];
    };
    return intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

/**
 * Creates no records by itself. It emits `circle-create` with a validated
 * `{ name, timezone }`; the host calls createCircle(), appends the record and
 * flips `busy`/`error`.
 */
export class CircleCreateForm extends HTMLElement {
  private stateBusy = false;
  private stateError = '';
  private stateDefaultTimezone = browserTimezone();

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.render();
    const root = this.shadowRoot;
    root?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
    root?.addEventListener('click', (event) => {
      const target = event.composedPath()[0];
      if (target instanceof HTMLElement && target.getAttribute('data-create-action') === 'cancel') {
        this.dispatchEvent(
          new CustomEvent('circle-create-cancel', { bubbles: true, composed: true }),
        );
      }
    });
  }

  set busy(value: boolean) {
    this.stateBusy = value;
    this.updateState();
  }

  get busy(): boolean {
    return this.stateBusy;
  }

  set error(value: string) {
    this.stateError = value;
    this.updateState();
  }

  get error(): string {
    return this.stateError;
  }

  set defaultTimezone(value: string) {
    this.stateDefaultTimezone = value || 'UTC';
    const input = this.shadowRoot?.querySelector<HTMLInputElement>('[name="timezone"]');
    if (input && input.value.trim().length === 0) input.value = this.stateDefaultTimezone;
  }

  get defaultTimezone(): string {
    return this.stateDefaultTimezone;
  }

  reset(): void {
    const form = this.shadowRoot?.querySelector<HTMLFormElement>('form');
    form?.reset();
    const timezone = this.shadowRoot?.querySelector<HTMLInputElement>('[name="timezone"]');
    if (timezone) timezone.value = this.stateDefaultTimezone;
    this.stateError = '';
    this.updateState();
  }

  connectedCallback(): void {
    const timezone = this.shadowRoot?.querySelector<HTMLInputElement>('[name="timezone"]');
    if (timezone && timezone.value.trim().length === 0) {
      timezone.value = this.stateDefaultTimezone;
    }
  }

  private render(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const zones = timezoneValues();
    root.innerHTML = `
      <style>${styles}</style>
      <article class="create-card" part="create-card">
        <header class="circle-head">
          <p class="kicker">new circle</p>
          <h1>Create a circle.</h1>
        </header>
        <p class="create-copy">A named group with no server and no authority. Every member keeps a full copy of its signed membership and rendezvous records.</p>
        <form novalidate>
          <label class="field">
            <span>circle name</span>
            <input name="name" type="text" maxlength="200" autocomplete="off" spellcheck="false" placeholder="Sunday table" required>
          </label>
          <label class="field">
            <span>time zone</span>
            <input name="timezone" type="text" list="circle-timezones" value="${escapeHtml(this.stateDefaultTimezone)}" autocomplete="off" spellcheck="false" required>
            <small>Days, weeks, months and seasons are read in this timezone.</small>
          </label>
          <datalist id="circle-timezones">
            ${zones.map((zone) => `<option value="${escapeHtml(zone)}"></option>`).join('')}
          </datalist>
          <p class="form-error" role="alert" hidden></p>
          <div class="create-actions">
            <button type="submit" class="create-submit" data-create-submit>create circle</button>
            <button type="button" class="create-cancel" data-create-action="cancel">cancel</button>
          </div>
        </form>
      </article>
    `;
    this.updateState();
  }

  private submit(): void {
    const form = this.shadowRoot?.querySelector<HTMLFormElement>('form');
    if (!form || this.stateBusy) return;
    const data = new FormData(form);
    const result = validateCircleDraft(
      String(data.get('name') ?? ''),
      String(data.get('timezone') ?? ''),
    );
    if (!result.ok || !result.value) {
      this.stateError = result.error ?? 'Check the circle details.';
      this.updateState();
      return;
    }
    this.stateError = '';
    this.updateState();
    this.dispatchEvent(
      new CustomEvent('circle-create', {
        detail: result.value,
        bubbles: true,
        composed: true,
      }),
    );
  }

  private updateState(): void {
    const root = this.shadowRoot;
    if (!root) return;
    const error = root.querySelector<HTMLElement>('.form-error');
    const submit = root.querySelector<HTMLButtonElement>('[data-create-submit]');
    const form = root.querySelector<HTMLFormElement>('form');
    if (error) {
      error.hidden = this.stateError.length === 0;
      error.textContent = this.stateError;
    }
    if (submit) {
      submit.disabled = this.stateBusy;
      submit.textContent = this.stateBusy ? 'creating…' : 'create circle';
    }
    if (form) form.setAttribute('aria-busy', this.stateBusy ? 'true' : 'false');
  }
}

export const CIRCLE_CREATE_FORM_TAG = 'circle-create-form';

export function defineCircleCreateForm(tagName = CIRCLE_CREATE_FORM_TAG): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(tagName)) customElements.define(tagName, CircleCreateForm);
}
