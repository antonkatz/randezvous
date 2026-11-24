import styles from './styles.css?inline';
import instantHeroMark from './instanthero-mark.svg?raw';
import {
  CircleKeyDirectory,
  CircleSync,
  IndexedDbCircleStore,
  acceptCircleInvite,
  activePrompts,
  activeWindowRecord,
  availableInvitees,
  canonicalPlans,
  circleOffers,
  clearCircleWindow,
  computeCircleStats,
  createAttendanceRecord,
  createBrowserCircleIdentity,
  createCircle,
  createCircleInvite,
  createCirclePlan,
  createCircleWindow,
  createPlanJoin,
  createRelayPeerChannel,
  deriveMemberView,
  isCircleInviteMessage,
  mergeCircleInviteAcceptance,
  mergeRecords,
  rankCircles,
  sendCircleInvite,
  sendCircleInviteAcceptance,
  type CircleInviteBundle,
  type CircleStats,
  type Friends as CircleFriends,
  type Identity as CircleIdentity,
  type MemberView,
  type PeerChannel,
  type PlanJoinRecord,
  type PlanRecord,
  type RankedCircle,
  type StoredCircleRecord,
} from '../../circles';
import {
  CircleBar,
  CircleDashboard,
  defineCircleStatsElements,
} from '../../circles/ui';
import { displayName, normalizeName } from '../crypto';
import { formatCountdown, handoffPhase } from '../handoff';
import { buildInviteUrl } from '../invite';
import { formatDuration, MAX_VOICE_NOTE_MS } from '../media';
import { RendezvousClient } from '../client';
import { RendezvousStore } from '../store';
import { wallPhotoWidth } from './wall';
import type {
  AppointmentEvent,
  AudioSnapshot,
  ClientNotice,
  Human,
  PhotoAttachment,
  PossessionView,
  RendezvousSnapshot,
  StoredPrint,
  StoredRendezvous,
  TransferEvent,
  VoiceNoteAttachment,
} from '../types';

const NEW_PERSON_ID = '__someone_new__';

const TEMPLATE = `
<style>${styles}</style>
<div class="app is-loading" id="app">
  <p class="masthead">
    <span class="masthead-name">rendezvous</span>
    <span class="masthead-star" aria-hidden="true">✳</span>
    <span class="masthead-by">by</span>
    <span class="masthead-stamp" role="img" aria-label="InstantHero">${instantHeroMark}</span>
  </p>

  <header class="topbar">
    <div class="add-slot" aria-hidden="true"></div>

    <div class="name-area">
      <label class="sr-only" for="code-name">Code name</label>
      <span class="code-name-wrap">
        <input class="code-name" id="code-name" placeholder="Code Name" maxlength="32" autocomplete="off" spellcheck="false" disabled>
        <span class="code-name-ghost" aria-hidden="true">Code Name<span class="code-caret"></span></span>
      </span>
      <span class="name-hint">this is how you appear to others</span>
    </div>

    <div class="diag-area" id="diag-area">
      <button class="signal-button" id="signal-button" type="button" data-status="starting" aria-expanded="false" aria-controls="diagnostics-panel" aria-label="Connection diagnostics">
        <span class="signal-dot" aria-hidden="true"></span>
        <span class="signal-label" id="signal-label">starting</span>
      </button>
      <section class="diagnostics" id="diagnostics-panel" role="dialog" aria-label="Connection diagnostics" hidden>
        <div class="diag-title">
          <h3>Connection.</h3>
          <span>live notes</span>
        </div>
        <dl class="diag-list">
          <div class="diag-row"><dt>signal</dt><dd id="diag-signal">—</dd></div>
          <div class="diag-row"><dt>this socket</dt><dd id="diag-socket">—</dd></div>
          <div class="diag-row"><dt>bootstrap</dt><dd id="diag-bootstrap">—</dd></div>
          <div class="diag-row"><dt>last direct</dt><dd id="diag-direct">none yet</dd></div>
          <div class="diag-row"><dt>candidates</dt><dd id="diag-candidates">—</dd></div>
        </dl>
        <p class="diag-warning" id="diag-warning" hidden></p>
        <p class="diag-note" id="diag-note">IPv4 and IPv6 addresses belong to the network this device is on. Rendezvous uses IPv6 when the browser gathers it, and never filters either family. The app cannot create an IPv6 address for you.</p>
      </section>
    </div>
  </header>

  <main class="stage">
    <div class="orbit" aria-hidden="true"></div>
    <div class="hero">
      <p class="eyebrow" id="hero-eyebrow" hidden></p>
      <h1 id="hero-title" hidden></h1>
      <p class="lede" id="hero-lede" hidden></p>
      <button class="cta" id="set-rendezvous" type="button">
        <span class="cta-label">set a rendezvous</span>
        <span class="cta-arrow" aria-hidden="true">↗</span>
      </button>
    </div>
  </main>

  <section class="humans" aria-labelledby="humans-title">
    <div class="section-heading">
      <span id="humans-title">your humans</span>
      <span class="rule" aria-hidden="true"></span>
      <span class="section-count" id="humans-count">none yet</span>
    </div>
    <div class="humans-list" id="humans-list"></div>
  </section>

  <section class="wall-wrap" id="wall-wrap" hidden aria-labelledby="wall-title">
    <div class="wall-head">
      <span id="wall-title">the wall</span>
      <span class="rule" aria-hidden="true"></span>
      <span id="wall-summary"></span>
    </div>
    <div class="wall-next" id="wall-next" hidden></div>
    <div class="wall-board" id="wall-board"></div>
  </section>

  <footer class="footer">
    <span class="footer-brand">rendezvous <span>✳</span></span>
    <span class="footer-center"><span class="footer-mark" aria-hidden="true"></span> the photograph crosses directly, browser to browser</span>
    <span>v0.1 · instant hero</span>
  </footer>
</div>

<circle-bar id="circle-bar"></circle-bar>

<div class="toast-region" id="toast-region" aria-live="polite" aria-atomic="false"></div>

<dialog class="modal rv-modal" id="rendezvous-dialog" aria-labelledby="rv-title">
  <div class="modal-card">
    <div class="modal-head">
      <div>
        <p class="modal-kicker">a photograph for later</p>
        <h2 id="rv-title">Set a rendezvous</h2>
      </div>
      <button class="modal-close" id="rv-close" type="button" aria-label="Close">×</button>
    </div>

    <div class="rv-steps" aria-hidden="true">
      <span class="step-marker is-active" id="rv-marker-1"></span>
      <span class="step-marker" id="rv-marker-2"></span>
      <span class="step-marker" id="rv-marker-3"></span>
      <span class="step-count" id="rv-step-count">01 / 03</span>
    </div>

    <section class="rv-step" id="rv-step-1">
      <div class="rv-grid">
        <div>
          <p class="field-label">01 · the photograph</p>
          <button class="photo-drop" id="photo-drop" type="button" aria-label="Choose a photograph">
            <img class="photo-preview" id="photo-preview" alt="" hidden>
            <span class="photo-empty" id="photo-empty">
              <span class="plus-ring" aria-hidden="true">+</span>
              <span>choose a photograph</span>
              <small>tap, or drop one here · 25 MB max</small>
            </span>
            <span class="photo-reselect" id="photo-reselect" hidden>change</span>
          </button>
          <input id="photo-input" type="file" accept="image/*" hidden>
          <p class="photo-caption" id="photo-caption" hidden><span id="photo-name"></span><span id="photo-size"></span></p>
          <p class="field-error" id="photo-error" hidden></p>
          <div class="voice-note" id="composer-note">
            <p class="voice-note-label">voice note <span>optional · up to 1:00</span></p>
            <div class="voice-note-idle" id="composer-note-idle">
              <button class="note-action" id="composer-note-add" type="button" disabled>＋ add a voice note</button>
            </div>
            <div class="voice-note-recording" id="composer-note-recording" hidden>
              <span class="note-dot" aria-hidden="true"></span>
              <span class="note-time" id="composer-note-time">0:00</span>
              <button class="note-action" id="composer-note-stop" type="button">stop</button>
              <button class="note-action quiet" id="composer-note-discard" type="button">discard</button>
            </div>
            <div class="voice-note-attached" id="composer-note-attached" hidden>
              <audio id="composer-note-audio" controls preload="metadata"></audio>
              <span class="note-duration" id="composer-note-duration"></span>
              <button class="note-action quiet" id="composer-note-remove" type="button">remove</button>
            </div>
            <p class="note-help">A private voice note. It travels with the photo and is not recorded by Rendezvous.</p>
            <p class="field-error" id="composer-note-error" hidden></p>
          </div>
        </div>

        <div>
          <p class="field-label">02 · the human</p>
          <div class="human-options" id="human-options"></div>
          <p class="field-note" id="human-note">A rendezvous is between two people.</p>
        </div>
      </div>
      <div class="rv-actions">
        <p class="rv-aside">You’ll both need to be here.</p>
        <button class="primary" id="rv-next" type="button" disabled>Continue <span aria-hidden="true">→</span></button>
      </div>
    </section>

    <section class="rv-step" id="rv-step-2" hidden>
      <div class="pick-summary">
        <img class="pick-thumb" id="pick-thumb" alt="">
        <div class="pick-copy">
          <span class="pick-kicker">on its way to</span>
          <span class="pick-name" id="pick-name"></span>
        </div>
      </div>

      <div class="time-grid">
        <div>
          <label class="time-label" for="rv-time">time</label>
          <div class="time-picker">
            <span class="time-readout" id="rv-time-readout" aria-hidden="true">--:--</span>
            <span class="time-clock" aria-hidden="true">
              <svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.2">
                <circle cx="16" cy="16" r="13.5"></circle>
                <path d="M16 9.5V16l4.4 2.8"></path>
              </svg>
            </span>
            <input class="time-input" id="rv-time" type="time" required>
          </div>
          <p class="resolved" id="rv-resolved">Choose a time.</p>
        </div>
        <div>
          <label class="date-label" for="rv-date">date <span>(optional)</span></label>
          <input class="date-input" id="rv-date" type="date">
          <p class="time-note" id="rv-date-note">Leave empty for the next time that comes around.</p>
        </div>
      </div>

      <label class="speak-option">
        <input type="checkbox" id="rv-audio-disabled">
        <span class="speak-option-check" aria-hidden="true"></span>
        <span class="speak-option-copy">
          <span class="speak-option-label">I won’t be able to speak</span>
          <span class="speak-option-note">Live audio will be off for this rendezvous.</span>
        </span>
      </label>

      <p class="critical-note">This is a meeting. At the chosen moment, the photograph moves only if both browsers are open and online. Otherwise it waits for your next overlap.</p>
      <p class="field-error" id="rv-error" hidden></p>

      <div class="rv-actions">
        <button class="back-button" id="rv-back" type="button">← Back</button>
        <button class="primary" id="rv-schedule" type="button">Set a rendezvous <span aria-hidden="true">↗</span></button>
      </div>
    </section>

    <section class="rv-step done-step" id="rv-step-3" hidden>
      <div class="done-mark" aria-hidden="true">✓</div>
      <h3>DONE.</h3>
      <p class="done-summary" id="done-summary"></p>
      <p class="done-audio-off" id="done-audio-off" hidden>Live audio off · I won’t be able to speak.</p>
      <dl class="done-detail">
        <dt>for</dt><dd id="done-human"></dd>
        <dt>at</dt><dd id="done-moment"></dd>
        <dt>the photograph</dt><dd id="done-photo"></dd>
      </dl>
      <div class="done-link-block" id="done-link-block" hidden>
        <p class="done-link-kicker">their invitation</p>
        <p class="done-link-copy">Send this link to one person. Opening it creates your human link and puts this rendezvous in their upcoming list immediately.</p>
        <div class="link-row">
          <input class="done-link" id="done-link" readonly value="">
          <button class="copy-link" id="done-link-copy" type="button">copy</button>
        </div>
      </div>
      <p class="critical-note" id="done-note">The photo is still here. It will only travel when you are both present at the same time. We’ll tell them when they next arrive.</p>
      <div class="done-actions">
        <p>You can close this. Keep Rendezvous open at the appointed time.</p>
        <button class="primary" id="rv-finish" type="button">Done</button>
      </div>
    </section>
  </div>
</dialog>

<dialog class="modal human-modal" id="human-dialog" aria-labelledby="human-dialog-name">
  <div class="modal-card">
    <div class="human-head">
      <div class="human-identity">
        <span class="human-avatar" id="human-dialog-avatar" aria-hidden="true"></span>
        <div>
          <p class="modal-kicker">one of your humans</p>
          <h2 id="human-dialog-name"></h2>
          <p class="human-sub" id="human-dialog-sub"></p>
        </div>
      </div>
      <button class="modal-close" id="human-close" type="button" aria-label="Close">×</button>
    </div>

    <section class="verify-section" aria-labelledby="verify-heading">
      <div class="verify-section-head">
        <p id="verify-heading">your comparison words</p>
        <span class="badge is-unverified" id="human-dialog-badge">not verified</span>
      </div>
      <ol class="verification-words" id="verification-words" aria-label="Eight verification words"></ol>
      <p class="verify-instruction">Say these eight words out loud, or compare them in another app. If they match, nobody swapped your keys. Do not send the words through the same link.</p>
      <div class="verify-actions">
        <button class="secondary" id="mark-verified" type="button">Mark as verified</button>
      </div>
    </section>

    <div class="remove-zone">
      <button class="text-danger" id="remove-human" type="button">Forget this human</button>
      <div class="remove-confirm" id="remove-confirm" hidden>
        <span>This cancels pending rendezvous and revokes the old link.</span>
        <button class="confirm-remove" id="confirm-remove" type="button">Forget permanently</button>
        <button class="back-button" id="cancel-remove" type="button">Keep</button>
      </div>
    </div>
  </div>
</dialog>

<dialog class="modal rendezvous-detail" id="rendezvous-detail-dialog" aria-labelledby="rv-detail-title">
  <div class="modal-card rv-detail-card">
    <div class="rv-detail-head">
      <button class="rv-detail-human" id="rv-detail-human" type="button">
        <span class="human-avatar" id="rv-detail-avatar" aria-hidden="true"></span>
        <span class="rv-detail-human-copy">
          <span class="modal-kicker" id="rv-detail-kicker">a rendezvous</span>
          <span class="rv-detail-title" id="rv-detail-title">with them</span>
          <span class="human-sub" id="rv-detail-sub"></span>
        </span>
      </button>
      <button class="modal-close" id="rv-detail-close" type="button" aria-label="Close">×</button>
    </div>

    <div class="rv-detail-moment">
      <span class="rv-detail-when" id="rv-detail-moment"></span>
      <span class="rv-detail-window" id="rv-detail-window"></span>
      <span class="rv-detail-confirmation" id="rv-detail-confirmation"></span>
      <span class="rv-detail-state" id="rv-detail-state" aria-live="polite"></span>
    </div>

    <section class="rv-detail-exchange" aria-labelledby="rv-detail-exchange-title">
      <div class="rv-detail-exchange-head">
        <p class="modal-kicker" id="rv-detail-exchange-title">what you’re bringing</p>
        <span class="badge is-unverified" id="rv-detail-direction">toward them</span>
      </div>
      <div class="rv-detail-attachment">
        <img class="rv-detail-photo" id="rv-detail-photo" alt="" hidden>
        <div class="rv-detail-photo-empty" id="rv-detail-photo-empty" aria-hidden="true">
          <span class="plus-ring">+</span>
        </div>
        <div class="rv-detail-attachment-copy">
          <p class="rv-detail-photo-state" id="rv-detail-photo-state">your photo · not added yet</p>
          <p class="rv-detail-photo-meta" id="rv-detail-photo-meta"></p>
          <div class="voice-note-attached" id="rv-detail-note" hidden>
            <audio id="rv-detail-note-audio" controls preload="metadata"></audio>
            <span class="note-duration" id="rv-detail-note-duration"></span>
          </div>
        </div>
      </div>
      <p class="rv-detail-peer-state" id="rv-detail-peer-state"></p>
      <p class="rv-detail-audio-off" id="rv-detail-audio-off" hidden>Live audio off for this rendezvous.</p>
      <div class="rv-detail-actions">
        <button class="secondary" id="rv-detail-confirm" type="button" hidden>confirm time</button>
        <button class="secondary" id="rv-detail-counter" type="button" hidden>propose another time</button>
        <button class="secondary" id="rv-detail-share" type="button" hidden>share link</button>
        <button class="secondary" id="rv-detail-add" type="button" hidden>add a photo</button>
        <button class="secondary" id="rv-detail-live" type="button" hidden>live</button>
        <button class="note-action quiet" id="rv-detail-replace" type="button" hidden>replace</button>
        <button class="note-action quiet" id="rv-detail-remove" type="button" hidden>remove</button>
      </div>
    </section>

    <section class="rv-detail-verify" id="rv-detail-verify-section">
      <button
        class="rv-detail-verify-toggle"
        id="rv-detail-verify-toggle"
        type="button"
        aria-expanded="false"
        aria-controls="rv-detail-verify-panel"
      >
        <span>comparison words · <span id="rv-detail-verify-badge">not verified</span></span>
        <span class="rv-detail-chevron" aria-hidden="true">⌄</span>
      </button>
      <div class="rv-detail-verify-panel" id="rv-detail-verify-panel" hidden>
        <ol class="verification-words" id="rv-detail-verification-words" aria-label="Eight verification words"></ol>
        <p class="verify-instruction">Say these eight words out loud, or compare them in another app. If they match, nobody swapped your keys. Do not send the words through the same link.</p>
        <div class="verify-actions">
          <button class="secondary" id="rv-detail-mark-verified" type="button">Mark as verified</button>
        </div>
      </div>
    </section>

    <p class="rv-detail-footnote" id="rv-detail-footnote">The photo stays on this device until you are both here at the same time.</p>
  </div>
</dialog>

<dialog class="modal rv-modal" id="rendezvous-counter-dialog" aria-labelledby="rv-counter-title">
  <div class="modal-card">
    <div class="modal-head">
      <div>
        <p class="modal-kicker">another moment</p>
        <h2 id="rv-counter-title">Propose another time</h2>
      </div>
      <button class="modal-close" id="rv-counter-close" type="button" aria-label="Close">×</button>
    </div>
    <p class="critical-note" id="rv-counter-context">The original time is cancelled when you propose a new one. Both of you will need to confirm it.</p>
    <label class="date-label" for="rv-counter-when">new moment</label>
    <input class="date-input" id="rv-counter-when" type="datetime-local">
    <p class="field-error" id="rv-counter-error" hidden></p>
    <div class="rv-actions">
      <button class="back-button" id="rv-counter-cancel" type="button">Cancel</button>
      <button class="primary" id="rv-counter-submit" type="button">Propose this time</button>
    </div>
  </div>
</dialog>

<dialog class="circle-dialog" id="circle-dialog" aria-labelledby="circle-dialog-title">
  <div class="circle-dialog-card">
    <div class="circle-dialog-head">
      <span class="circle-dialog-kicker" id="circle-dialog-title">named groups</span>
      <button class="circle-dialog-close" id="circle-close" type="button" aria-label="Close circles">×</button>
    </div>
    <circle-dashboard id="circle-dashboard"></circle-dashboard>
  </div>
</dialog>

<dialog class="photo-dialog" id="photo-dialog" aria-labelledby="photo-viewer-title">
  <div class="photo-viewer">
    <div class="photo-viewer-head">
      <div>
        <h2 class="photo-viewer-title" id="photo-viewer-title">A photograph.</h2>
        <p class="photo-viewer-sub" id="photo-viewer-sub"></p>
      </div>
      <button class="photo-viewer-close" id="photo-viewer-close" type="button" aria-label="Close">×</button>
    </div>
    <div class="photo-viewer-image-wrap">
      <img class="photo-viewer-image" id="photo-viewer-image" alt="Shared photograph">
    </div>
    <div class="voice-note-attached viewer-note" id="viewer-note" hidden>
      <audio id="viewer-note-audio" controls preload="metadata"></audio>
      <span class="note-duration" id="viewer-note-duration"></span>
    </div>
    <section class="possession" id="viewer-possession" hidden>
      <div class="possession-head">
        <h3>known copies delivered by Rendezvous</h3>
        <button class="note-action" id="possession-check" type="button">check now</button>
      </div>
      <ul class="possession-list" id="possession-list"></ul>
      <p class="possession-note">Best effort only. Downloads, screenshots, and copies sent through other apps are not listed, and a delivered copy can never be remotely recalled.</p>
    </section>
    <div class="photo-viewer-actions">
      <button class="viewer-button" id="photo-share" type="button" hidden>Share again</button>
      <button class="viewer-button" id="photo-delete" type="button">Delete locally</button>
      <a class="viewer-button" id="photo-download" href="#" download>Save to device</a>
    </div>
  </div>
</dialog>

<dialog class="modal contribution-modal" id="contribution-dialog" aria-labelledby="contribution-title">
  <div class="modal-card">
    <div class="modal-head">
      <div>
        <p class="modal-kicker">your side of the meeting</p>
        <h2 id="contribution-title">Add your photo</h2>
      </div>
      <button class="modal-close" id="contribution-close" type="button" aria-label="Close">×</button>
    </div>
    <p class="contribution-copy" id="contribution-copy"></p>
    <button class="photo-drop" id="contribution-drop" type="button" aria-label="Choose a photograph">
      <img class="photo-preview" id="contribution-preview" alt="" hidden>
      <span class="photo-empty" id="contribution-empty">
        <span class="plus-ring" aria-hidden="true">+</span>
        <span>choose a photograph</span>
        <small>it stays in this browser until you meet</small>
      </span>
      <span class="photo-reselect" id="contribution-reselect" hidden>change</span>
    </button>
    <input id="contribution-input" type="file" accept="image/*" hidden>
    <p class="photo-caption" id="contribution-caption" hidden><span id="contribution-name"></span><span id="contribution-size"></span></p>
    <p class="field-error" id="contribution-error" hidden></p>
    <div class="voice-note" id="contribution-note">
      <p class="voice-note-label">voice note <span>optional · up to 1:00</span></p>
      <div class="voice-note-idle" id="contribution-note-idle">
        <button class="note-action" id="contribution-note-add" type="button" disabled>＋ add a voice note</button>
      </div>
      <div class="voice-note-recording" id="contribution-note-recording" hidden>
        <span class="note-dot" aria-hidden="true"></span>
        <span class="note-time" id="contribution-note-time">0:00</span>
        <button class="note-action" id="contribution-note-stop" type="button">stop</button>
        <button class="note-action quiet" id="contribution-note-discard" type="button">discard</button>
      </div>
      <div class="voice-note-attached" id="contribution-note-attached" hidden>
        <audio id="contribution-note-audio" controls preload="metadata"></audio>
        <span class="note-duration" id="contribution-note-duration"></span>
        <button class="note-action quiet" id="contribution-note-remove" type="button">remove</button>
      </div>
      <p class="note-help">Nothing is recorded until you press record. The note is not sent to a server.</p>
      <p class="field-error" id="contribution-note-error" hidden></p>
    </div>
    <div class="rv-actions">
      <button class="back-button" id="contribution-remove" type="button" hidden>Remove my photo</button>
      <button class="primary" id="contribution-save" type="button" disabled>Add to the rendezvous</button>
    </div>
  </div>
</dialog>

<dialog class="live-modal" id="live-dialog" aria-labelledby="live-title">
  <div class="live-scene">
    <div class="live-head">
      <p class="live-kicker">live rendezvous</p>
      <button class="live-minimise" id="live-minimise" type="button" aria-label="Minimise the live rendezvous">minimise</button>
    </div>
    <h2 class="live-title" id="live-title">
      <span id="live-self">You</span>
      <em>&</em>
      <span id="live-peer">them</span>
    </h2>
    <p class="live-moment" id="live-moment"></p>
    <p class="live-state" id="live-state" aria-live="polite"></p>
    <div class="live-contributions" id="live-contributions"></div>
    <div class="live-audio">
      <button class="live-audio-start" id="live-start-audio" type="button">
        <span class="live-mic" aria-hidden="true"></span>
        <span>start audio 1min</span>
        <small>1:00</small>
      </button>
      <div class="live-audio-controls" id="live-audio-controls" hidden>
        <span class="live-countdown" id="live-countdown">1:00</span>
        <button class="live-control" id="live-mute" type="button">mute</button>
        <button class="live-control live-end" id="live-end" type="button">end</button>
      </div>
      <div class="live-consent" id="live-consent" hidden>
        <p><span id="live-consent-name">They</span> asks for one live minute. Nothing is recorded. Your microphone is live for at most sixty seconds.</p>
        <button class="primary" id="live-allow" type="button">Allow a minute</button>
        <button class="back-button" id="live-not-now" type="button">Not now</button>
      </div>
      <p class="live-audio-message" id="live-audio-message" aria-live="polite"></p>
      <p class="live-audio-disabled" id="live-audio-disabled" hidden>Live audio is off for this rendezvous.</p>
    </div>
    <div class="live-actions">
      <button class="back-button" id="live-close" type="button">back to the wall</button>
    </div>
  </div>
</dialog>

<div class="audio-strip" id="audio-strip" hidden>
  <span class="strip-dot" aria-hidden="true"></span>
  <span class="strip-name" id="audio-strip-name"></span>
  <span class="strip-time" id="audio-strip-time">1:00</span>
  <button class="strip-button" id="audio-strip-open" type="button">open</button>
  <button class="strip-button" id="audio-strip-mute" type="button">mute</button>
  <button class="strip-button strip-end" id="audio-strip-end" type="button">end</button>
</div>
`;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toTimeValue(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toDateValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function nextDefaultTime(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  date.setMinutes(Math.ceil(date.getMinutes() / 5) * 5);
  return toTimeValue(date);
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

function formatMoment(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const thatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const difference = Math.round((thatDay - today) / 86_400_000);
  if (difference === 0) return `today at ${formatClock(timestamp)}`;
  if (difference === 1) return `tomorrow at ${formatClock(timestamp)}`;
  if (difference === -1) return `yesterday at ${formatClock(timestamp)}`;
  const day = new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
  return `${day} at ${formatClock(timestamp)}`;
}

function formatShortDay(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const thatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const difference = Math.round((thatDay - today) / 86_400_000);
  if (difference === 0) return 'today';
  if (difference === 1) return 'tomorrow';
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function initialFor(name: string): string {
  const characters = [...(normalizeName(name) || '?')];
  return characters[0] ?? '?';
}

function escapePunctuation(name: string): string {
  return displayName(name);
}

interface ToastHandle {
  element: HTMLElement;
  timer: number | null;
  close: () => void;
  cleanup: () => void;
  cleaned: boolean;
}

interface ToastContent {
  tone: ClientNotice['tone'];
  title: string;
  message: string;
  actionLabel?: string;
  action?: () => void;
  photoUrl?: string;
  progress?: number;
  persistent?: boolean;
  duration?: number;
  onClose?: () => void;
}

export class RendezvousApp extends HTMLElement {
  private client: RendezvousClient | null = null;
  private state: RendezvousSnapshot | null = null;
  private initialized = false;
  private subscriptions: Array<() => void> = [];
  private objectUrls = new Map<string, string>();
  private toasts = new Map<string, ToastHandle>();
  private transferToastIds = new Map<string, string>();
  private celebrated = new Set<string>();
  private toastSequence = 0;
  private countdownTimer: number | null = null;
  private nameSaveTimer: number | null = null;
  private copyResetTimer: number | null = null;
  private diagnosticsOpen = false;
  private rvStep = 1;
  private selectedHumanId: string | null = null;
  private photo: File | null = null;
  private photoUrl: string | null = null;
  private composerNote: VoiceNoteAttachment | null = null;
  private composerNoteUrl: string | null = null;
  private resharePrint: StoredPrint | null = null;
  private recorder: MediaRecorder | null = null;
  private recorderChunks: Blob[] = [];
  private recorderStartedAt = 0;
  private recorderTimer: number | null = null;
  private recorderLimit: number | null = null;
  private recorderMode: 'composer' | 'contribution' | null = null;
  private contributionRecordId: string | null = null;
  private contributionPhoto: File | null = null;
  private contributionPhotoUrl: string | null = null;
  private contributionNote: VoiceNoteAttachment | null = null;
  private contributionNoteUrl: string | null = null;
  private liveDismissed = new Set<string>();
  private liveRecordId: string | null = null;
  private liveCloseTimer: number | null = null;
  private audioStripOpen = false;
  private activeHumanId: string | null = null;
  private verificationRequest = 0;
  private detailRecordId: string | null = null;
  private counterRecordId: string | null = null;
  private detailVerificationRequest = 0;
  private detailPhotoUrl: string | null = null;
  private detailNoteUrl: string | null = null;
  private detailAttachmentKey: string | null = null;
  private detailNoteKey: string | null = null;
  private viewerRecordId: string | null = null;
  private viewerPrintId: string | null = null;
  private viewerPhotoId: string | null = null;
  private viewerUrl: string | null = null;
  private deleteArmed = false;
  private deleteTimer: number | null = null;
  private root!: ShadowRoot;
  private wallResizeObserver: ResizeObserver | null = null;
  private circleDashboard: CircleDashboard | null = null;
  private circleAppStore: RendezvousStore | null = null;
  private circleStore: IndexedDbCircleStore | null = null;
  private circleIdentity: CircleIdentity | null = null;
  private readonly circleDirectory = new CircleKeyDirectory();
  private circleSelfPublicKey: string | null = null;
  private circleFriendKeys = new Set<string>();
  private readonly circleFriends: CircleFriends = {
    directFriends: () => new Set(this.circleFriendKeys),
  };
  private circleHumans: Human[] = [];
  private circleSync: CircleSync | null = null;
  private readonly circlePeers = new Map<
    string,
    { channel: PeerChannel; cleanups: Array<() => void> }
  >();
  private circleOnline = new Set<string>();
  private circleBar: CircleBar | null = null;
  private circleEntries: readonly RankedCircle[] = [];
  private activeCircleId: string | null = null;
  private activeCircleView: MemberView | null = null;
  private pendingCircleInvite: CircleInviteBundle | null = null;

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    const path = event.composedPath();
    if (this.diagnosticsOpen && !path.includes(this.$('#diag-area'))) {
      this.closeDiagnostics();
    }
  };

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;
    void this.circleSync?.refresh();
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    if (this.diagnosticsOpen) this.closeDiagnostics();
  };

  get clientInstance(): RendezvousClient | null {
    return this.client;
  }

  getClient(): RendezvousClient | null {
    return this.client;
  }

  connectedCallback(): void {
    if (this.initialized) return;
    this.initialized = true;
    defineCircleStatsElements();
    this.root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    this.root.innerHTML = TEMPLATE;
    this.bindStaticEvents();
    if (typeof ResizeObserver !== 'undefined') {
      this.wallResizeObserver = new ResizeObserver(() => this.layoutWall());
      this.wallResizeObserver.observe(this.$('#wall-board'));
    }
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.addEventListener('keydown', this.onDocumentKeyDown);
    this.countdownTimer = window.setInterval(() => this.renderHero(), 1_000);
    this.startClient();
  }

  disconnectedCallback(): void {
    this.initialized = false;
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.wallResizeObserver?.disconnect();
    this.wallResizeObserver = null;
    if (this.countdownTimer !== null) window.clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    if (this.nameSaveTimer !== null) window.clearTimeout(this.nameSaveTimer);
    if (this.copyResetTimer !== null) window.clearTimeout(this.copyResetTimer);
    if (this.deleteTimer !== null) window.clearTimeout(this.deleteTimer);
    if (this.liveCloseTimer !== null) window.clearTimeout(this.liveCloseTimer);
    this.liveCloseTimer = null;
    this.stopRecorder(true);
    if (this.composerNoteUrl) URL.revokeObjectURL(this.composerNoteUrl);
    this.composerNoteUrl = null;
    if (this.contributionNoteUrl) URL.revokeObjectURL(this.contributionNoteUrl);
    this.contributionNoteUrl = null;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
    for (const handle of this.toasts.values()) {
      if (handle.timer !== null) window.clearTimeout(handle.timer);
      if (!handle.cleaned) {
        handle.cleaned = true;
        handle.cleanup();
      }
    }
    this.toasts.clear();
    this.revokeObjectUrls();
    this.closePhotoViewer();
    this.closeRendezvousDetail();
    this.client?.stop();
    this.client = null;
    this.state = null;
    this.circleDashboard = null;
    this.circleIdentity = null;
    this.circleDirectory.clear();
    this.circleSelfPublicKey = null;
    this.circleFriendKeys.clear();
    this.circleAppStore = null;
    this.circleStore = null;
    this.circleHumans = [];
    for (const peer of this.circlePeers.values()) {
      for (const cleanup of peer.cleanups) cleanup();
    }
    this.circlePeers.clear();
    this.circleOnline.clear();
    this.circleSync?.stop();
    this.circleSync = null;
    this.circleBar = null;
    this.circleEntries = [];
    this.activeCircleId = null;
    this.activeCircleView = null;
    this.pendingCircleInvite = null;
  }

  private $<T extends Element = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Missing UI element ${selector}`);
    return element;
  }

  private async startClient(): Promise<void> {
    const signalUrl = this.getAttribute('signal-url') || undefined;
    const storageName = this.getAttribute('storage-name') || undefined;
    let iceServers: RTCIceServer[] | undefined;
    const iceAttribute = this.getAttribute('ice-servers');
    if (iceAttribute) {
      try {
        const parsed: unknown = JSON.parse(iceAttribute);
        if (Array.isArray(parsed)) iceServers = parsed as RTCIceServer[];
      } catch {
        // Ignore malformed configuration; the server will provide ICE servers.
      }
    }

    this.client = new RendezvousClient({ signalUrl, storageName, iceServers });
    this.subscriptions.push(
      this.client.on('state', (snapshot) => {
        this.render(snapshot);
        this.emitHostEvent('rendezvous:state', snapshot);
      }),
      this.client.on('notice', (notice) => {
        this.handleNotice(notice);
        this.emitHostEvent('rendezvous:notice', notice);
      }),
      this.client.on('appointment', (event) => {
        this.handleAppointment(event);
        this.emitHostEvent('rendezvous:appointment', event);
      }),
      this.client.on('transfer', (event) => {
        this.handleTransfer(event);
        this.emitHostEvent('rendezvous:transfer', event);
      }),
      this.client.on('audio', (event) => {
        this.renderAudio(event.audio);
        this.emitHostEvent('rendezvous:audio', event);
      }),
      this.client.on('circleRendezvous', (event) => {
        void this.handleCircleRendezvousEvent(event.invite);
        this.emitHostEvent('rendezvous:circle-rendezvous', event);
      }),
    );
    this.renderEmptyState();
    try {
      await this.client.start();
      this.$('#app').classList.remove('is-loading');
    } catch (error) {
      this.showBootError(
        error instanceof Error
          ? error.message
          : 'Rendezvous could not open its local identity store.',
      );
    } finally {
      void this.refreshCircleBar();
    }
  }

  private async openCircles(
    options: { create?: boolean; circleId?: string } = {},
  ): Promise<void> {
    const dialog = this.$<HTMLDialogElement>('#circle-dialog');
    if (!dialog.open) dialog.showModal();
    try {
      await this.prepareCircles();
      await this.reloadCircles();
      if (options.circleId) await this.selectCircle(options.circleId);
      else if (options.create) this.circleDashboard?.showCreate();
      else this.circleDashboard?.showList();
    } catch (error) {
      dialog.close();
      this.showToast({
        tone: 'error',
        title: 'Circles unavailable',
        message:
          error instanceof Error
            ? error.message
            : 'The local circle store could not be opened.',
      });
    }
  }

  private async refreshCircleBar(): Promise<void> {
    try {
      await this.prepareCircles();
      await this.reloadCircles();
    } catch {
      // The bar still offers "+ circle"; opening the dialog will report the error.
    }
  }

  private async prepareCircles(): Promise<void> {
    const storageName = this.getAttribute('storage-name') || 'rendezvous';
    if (!this.circleAppStore) this.circleAppStore = new RendezvousStore(storageName);
    const [storedIdentity, humans] = await Promise.all([
      this.circleAppStore.getIdentity(),
      this.circleAppStore.getHumans(),
    ]);
    if (!storedIdentity) {
      throw new Error('Your browser identity is still opening. Try again in a moment.');
    }

    this.circleSelfPublicKey = storedIdentity.publicKey;
    this.circleDirectory.replace([
      { id: storedIdentity.id, publicKey: storedIdentity.publicKey },
      ...humans.map((human) => ({ id: human.id, publicKey: human.publicKey })),
    ]);
    if (!this.circleIdentity) {
      this.circleIdentity = createBrowserCircleIdentity(
        storedIdentity,
        this.circleDirectory,
      );
    }
    this.circleHumans = humans.map((human) => {
      const live = this.state?.humans.find((entry) => entry.id === human.id);
      return {
        ...human,
        online: live?.online ?? false,
        lastSeenAt: live?.lastSeenAt ?? null,
      };
    });
    this.circleFriendKeys = new Set(humans.map((human) => human.id));
    if (!this.circleStore) {
      this.circleStore = new IndexedDbCircleStore(`${storageName}-circles`);
    }
    const store = this.circleStore;
    if (!this.circleSync) {
      this.circleSync = new CircleSync({
        identity: this.circleIdentity,
        friends: this.circleFriends,
        store,
        onRecords: (event) => {
          void this.onCircleRecords(event.circleId);
        },
        onError: (error, peerKey) => {
          console.warn('[circles] relay error', peerKey, error);
        },
      });
    }

    if (!this.circleDashboard) {
      const dashboard = this.$<CircleDashboard>('#circle-dashboard');
      dashboard.addEventListener('circle-create', (event) =>
        void this.createCircleFromDashboard(event),
      );
      dashboard.addEventListener('circle-select', (event) => {
        const detail = (event as CustomEvent<{ circleId?: string }>).detail;
        if (detail?.circleId) void this.selectCircle(detail.circleId);
      });
      dashboard.addEventListener('circle-invite-request', (event) =>
        void this.inviteToCircle(event),
      );
      dashboard.addEventListener('circle-invite-accept', (event) =>
        void this.acceptCircleInvitation(event),
      );
      dashboard.addEventListener('circle-invite-decline', () =>
        this.clearPendingCircleInvite(),
      );
      dashboard.addEventListener('circle-plan-request', (event) =>
        void this.setCirclePlan(event),
      );
      dashboard.addEventListener('circle-plan-join', (event) =>
        void this.joinCirclePlan(event),
      );
      dashboard.addEventListener('circle-window-request', (event) =>
        void this.setCircleWindow(event),
      );
      dashboard.addEventListener('circle-window-clear', (event) =>
        void this.clearCircleGatheringWindow(event),
      );
      this.circleDashboard = dashboard;
    }

    this.syncCirclePeers();
    await this.circleSync.start();
  }

  private async reloadCircles(): Promise<void> {
    const identity = this.circleIdentity;
    const store = this.circleStore;
    const friends = this.circleFriends;
    const dashboard = this.circleDashboard;
    if (!identity || !store || !friends || !dashboard) return;

    const now = Date.now();
    const statsList: CircleStats[] = [];
    for (const circleId of await store.listCircles()) {
      const records = await store.load(circleId);
      const view = deriveMemberView(records, identity.selfKey, friends, {}, { circleId });
      if (!view.members.includes(identity.selfKey)) continue;
      statsList.push(computeCircleStats(records, view, now, { circleId }));
    }
    this.circleEntries = rankCircles(statsList);
    if (
      this.activeCircleId &&
      !this.circleEntries.some((entry) => entry.circleId === this.activeCircleId)
    ) {
      this.activeCircleId = null;
    }
    dashboard.entries = this.circleEntries;
    this.renderCircleBar();
  }

  private renderCircleBar(): void {
    if (!this.circleBar) return;
    this.circleBar.entries = this.circleEntries.map((entry) => ({
      circleId: entry.circleId,
      name: entry.stats.name || entry.circleId,
    }));
    this.circleBar.activeCircleId = this.activeCircleId;
  }

  private async selectCircle(circleId: string): Promise<void> {
    const identity = this.circleIdentity;
    const store = this.circleStore;
    const friends = this.circleFriends;
    const dashboard = this.circleDashboard;
    if (!identity || !store || !friends || !dashboard) return;

    const records = await store.load(circleId);
    const view = deriveMemberView(records, identity.selfKey, friends, {}, { circleId });
    if (!view.members.includes(identity.selfKey)) {
      this.showToast({
        tone: 'warning',
        title: 'Circle not available',
        message: 'You are not a current member in this browser’s view.',
      });
      return;
    }
    dashboard.view = view;
    dashboard.inviteCandidates = availableInvitees(view, this.circleFriends).map(
      (peerKey) => {
        const human = this.circleHumans.find((entry) => entry.id === peerKey);
        const live = this.state?.humans.find((entry) => entry.id === peerKey);
        return {
          peerKey,
          name: human?.name,
          online: Boolean(live?.online),
        };
      },
    );
    dashboard.stats = computeCircleStats(records, view, Date.now(), { circleId });
    dashboard.plans = canonicalPlans(records, circleId, view.timezone, view.members);
    dashboard.offers = circleOffers(records, circleId, Date.now(), view.members);
    const windowEntry = activeWindowRecord(records, circleId, Date.now());
    dashboard.window =
      windowEntry?.record.type === 'Window'
        ? { start: windowEntry.record.start, end: windowEntry.record.end }
        : null;
    this.activeCircleId = circleId;
    this.activeCircleView = view;
    this.renderCircleBar();
  }

  private async createCircleFromDashboard(event: Event): Promise<void> {
    const detail = (event as CustomEvent<{ name?: string; timezone?: string }>).detail;
    const identity = this.circleIdentity;
    const store = this.circleStore;
    const dashboard = this.circleDashboard;
    if (!identity || !store || !dashboard || !detail?.name || !detail.timezone) return;

    dashboard.busy = true;
    dashboard.error = '';
    try {
      const created = await createCircle({
        identity,
        name: detail.name,
        timezone: detail.timezone,
        createdAt: Date.now(),
      });
      await store.append(created.circleId, [created.record]);
      await this.reloadCircles();
      await this.selectCircle(created.circleId);
      void this.circleSync?.refresh();
      this.showToast({
        tone: 'success',
        title: 'Circle created',
        message: `${detail.name} is ready.`,
      });
    } catch (error) {
      dashboard.error =
        error instanceof Error ? error.message : 'The circle could not be created.';
    } finally {
      dashboard.busy = false;
    }
  }

  private syncCirclePeers(): void {
    const humans = (this.state?.humans ?? this.circleHumans).slice();
    this.circleHumans = humans;
    this.circleFriendKeys = new Set(humans.map((human) => human.id));
    if (this.circleIdentity && this.circleSelfPublicKey) {
      this.circleDirectory.replace([
        {
          id: this.circleIdentity.selfKey,
          publicKey: this.circleSelfPublicKey,
        },
        ...humans.map((human) => ({
          id: human.id,
          publicKey: human.publicKey,
        })),
      ]);
    }

    const sync = this.circleSync;
    const client = this.client;
    if (!sync || !client) return;

    const ids = new Set(humans.map((human) => human.id));
    for (const human of humans) {
      if (!this.circlePeers.has(human.id)) this.addCirclePeer(human.id);
    }
    for (const peerKey of [...this.circlePeers.keys()]) {
      if (!ids.has(peerKey)) this.removeCirclePeer(peerKey);
    }

    const online = new Set(
      humans.filter((human) => human.online).map((human) => human.id),
    );
    const becameOnline = [...online].some((id) => !this.circleOnline.has(id));
    this.circleOnline = online;
    if (becameOnline) void sync.refresh();
  }

  private addCirclePeer(peerKey: string): void {
    const client = this.client;
    const sync = this.circleSync;
    if (!client || !sync || this.circlePeers.has(peerKey)) return;
    const channel = createRelayPeerChannel(client, peerKey);
    const cleanups: Array<() => void> = [];
    cleanups.push(sync.addPeer(channel));
    cleanups.push(
      channel.onMessage((message) => {
        if (!isCircleInviteMessage(message)) return;
        void this.handleCircleRelayMessage(peerKey, message);
      }),
    );
    this.circlePeers.set(peerKey, { channel, cleanups });
  }

  private removeCirclePeer(peerKey: string): void {
    const peer = this.circlePeers.get(peerKey);
    if (!peer) return;
    for (const cleanup of peer.cleanups) cleanup();
    this.circlePeers.delete(peerKey);
  }

  private async handleCircleRelayMessage(
    peerKey: string,
    message: unknown,
  ): Promise<void> {
    if (!isCircleInviteMessage(message)) return;
    const identity = this.circleIdentity;
    const dashboard = this.circleDashboard;
    if (!identity || !dashboard) return;

    if (message.type === 'circle-invite/offer') {
      const bundle = message.bundle;
      if (bundle.inviter !== peerKey || bundle.invitee !== identity.selfKey) return;
      const circleName = this.circleNameFromBundle(bundle);
      const human = this.state?.humans.find((entry) => entry.id === peerKey);
      try {
        await this.prepareCircles();
        const freshIdentity = this.circleIdentity;
        const store = this.circleStore;
        if (!freshIdentity || !store) throw new Error('The circle store is not ready.');
        const acceptance = await acceptCircleInvite({
          identity: freshIdentity,
          bundle,
          at: Date.now(),
          friends: this.circleFriends,
        });
        await store.append(bundle.circleId, acceptance.records);
        const peer = this.circlePeers.get(bundle.inviter);
        if (peer) await sendCircleInviteAcceptance(peer.channel, acceptance);
        await this.reloadCircles();
        await this.selectCircle(bundle.circleId);
        void this.circleSync?.refresh();
        this.showToast({
          tone: 'success',
          title: 'Circle joined.',
          message: `${human?.name ? displayName(human.name) : 'A human'} added you to ${circleName}.`,
        });
      } catch (error) {
        this.showToast({
          tone: 'warning',
          title: 'A circle invitation was ignored.',
          message:
            error instanceof Error
              ? error.message
              : 'The invitation did not pass the signed membership chain.',
        });
      }
      return;
    }

    if (message.type === 'circle-invite/accept') {
      await this.mergeCircleAcceptance(message.acceptance);
    }
  }

  private circleNameFromBundle(bundle: CircleInviteBundle): string {
    for (const entry of bundle.records) {
      if (
        entry &&
        typeof entry === 'object' &&
        entry.record &&
        entry.record.type === 'CircleCreated'
      ) {
        return entry.record.name;
      }
    }
    return bundle.circleId;
  }

  private async inviteToCircle(event: Event): Promise<void> {
    const detail = (event as CustomEvent<{ circleId?: string; peerKey?: string }>).detail;
    const identity = this.circleIdentity;
    const store = this.circleStore;
    const dashboard = this.circleDashboard;
    if (!identity || !store || !dashboard || !detail?.circleId || !detail.peerKey) return;

    const human = this.state?.humans.find((entry) => entry.id === detail.peerKey);
    if (!human?.online) {
      this.showToast({
        tone: 'warning',
        title: 'Not online',
        message: 'Both browsers must be open and connected to send a circle invitation.',
      });
      return;
    }

    try {
      const records = await store.load(detail.circleId);
      const bundle = await createCircleInvite({
        identity,
        records,
        circleId: detail.circleId,
        invitee: detail.peerKey,
        at: Date.now(),
        friends: this.circleFriends,
      });
      const peer = this.circlePeers.get(detail.peerKey);
      if (!peer) throw new Error('No relay channel is open for that human.');
      await sendCircleInvite(peer.channel, bundle);
      dashboard.inviteCandidates = dashboard.inviteCandidates.filter(
        (candidate) => candidate.peerKey !== detail.peerKey,
      );
      this.showToast({
        tone: 'success',
        title: 'Invitation sent',
        message: `${human.name || 'They'} can now join ${this.circleNameFromBundle(bundle)}.`,
      });
    } catch (error) {
      this.showToast({
        tone: 'error',
        title: 'Invitation not sent',
        message: error instanceof Error ? error.message : 'The invitation could not be sent.',
      });
    }
  }

  private async acceptCircleInvitation(event: Event): Promise<void> {
    const detail = (event as CustomEvent<{ bundle?: CircleInviteBundle }>).detail;
    const bundle = detail?.bundle ?? this.pendingCircleInvite;
    if (!bundle) return;

    try {
      await this.prepareCircles();
      const identity = this.circleIdentity;
      const store = this.circleStore;
      if (!identity || !store) throw new Error('The circle store is not ready.');
      const acceptance = await acceptCircleInvite({
        identity,
        bundle,
        at: Date.now(),
        friends: this.circleFriends,
      });
      await store.append(bundle.circleId, acceptance.records);
      const peer = this.circlePeers.get(bundle.inviter);
      if (peer) {
        await sendCircleInviteAcceptance(peer.channel, acceptance);
      } else {
        this.showToast({
          tone: 'warning',
          title: 'Acceptance not sent',
          message: 'The circle was saved locally, but the inviter is not connected.',
        });
      }
      this.clearPendingCircleInvite();
      await this.reloadCircles();
      await this.selectCircle(bundle.circleId);
      void this.circleSync?.refresh();
      this.showToast({
        tone: 'success',
        title: 'Circle joined',
        message: `You joined ${this.circleNameFromBundle(bundle)}.`,
      });
    } catch (error) {
      this.showToast({
        tone: 'error',
        title: 'Could not join',
        message: error instanceof Error ? error.message : 'The invitation was not accepted.',
      });
    }
  }

  private clearPendingCircleInvite(): void {
    this.pendingCircleInvite = null;
    if (this.circleDashboard) this.circleDashboard.pendingInvite = null;
  }

  private async mergeCircleAcceptance(
    acceptance: Parameters<typeof mergeCircleInviteAcceptance>[2],
  ): Promise<void> {
    const identity = this.circleIdentity;
    const store = this.circleStore;
    if (!identity || !store) return;
    try {
      const existing = await store.load(acceptance.circleId);
      const merged = await mergeCircleInviteAcceptance(identity, existing, acceptance);
      if (merged.rejected.length > 0) {
        this.showToast({
          tone: 'warning',
          title: 'Join rejected',
          message: merged.rejected[0]?.error ?? 'The Join did not pass the membership chain.',
        });
        return;
      }
      if (merged.added.length > 0) {
        await store.append(acceptance.circleId, merged.added);
      }
      await this.reloadCircles();
      if (this.activeCircleId === acceptance.circleId) {
        await this.selectCircle(acceptance.circleId);
      }
      await this.circleSync?.refresh();
      const human = this.state?.humans.find((entry) => entry.id === acceptance.invitee);
      this.showToast({
        tone: 'success',
        title: 'New member',
        message: `${human?.name || 'A human'} joined the circle.`,
      });
    } catch (error) {
      this.showToast({
        tone: 'warning',
        title: 'Join rejected',
        message: error instanceof Error ? error.message : 'The Join could not be verified.',
      });
    }
  }

  private async onCircleRecords(circleId: string): Promise<void> {
    await this.reloadCircles();
    if (this.activeCircleId === circleId) {
      await this.selectCircle(circleId);
    }
  }

  private async setCirclePlan(event: Event): Promise<void> {
    const detail = (event as CustomEvent<{ circleId?: string; scheduledAt?: number }>).detail;
    const identity = this.circleIdentity;
    const store = this.circleStore;
    const dashboard = this.circleDashboard;
    if (!identity || !store || !dashboard || !detail?.circleId || !detail.scheduledAt) return;
    try {
      const records = await store.load(detail.circleId);
      const view = deriveMemberView(records, identity.selfKey, this.circleFriends, {}, {
        circleId: detail.circleId,
      });
      if (!view.members.includes(identity.selfKey)) {
        throw new Error('You are not a current member of this circle.');
      }
      const created = await createCirclePlan({
        identity,
        circleId: detail.circleId,
        scheduledAt: detail.scheduledAt,
        invitees: view.members.filter((member) => member !== identity.selfKey),
        createdAt: Date.now(),
        records,
      });
      await store.append(detail.circleId, [created.plan]);
      const recipients = view.members.filter((member) => member !== identity.selfKey);
      if (recipients.length > 0) {
        const plan = created.plan.record;
        if (plan.type === 'Plan') {
          this.client?.publishCircleRendezvousInvite({
            id: `ri_${(crypto.randomUUID?.() ?? String(Date.now())).replace(/-/gu, '')}`,
            circleId: detail.circleId,
            recipients,
            plan: created.plan,
            scheduledAt: plan.scheduledAt,
          });
        }
      }
      await this.reloadCircles();
      await this.selectCircle(detail.circleId);
      void this.circleSync?.refresh();
      this.showToast({
        tone: 'success',
        title: 'Circle offer proposed.',
        message:
          'It is independent of every other offer. Members can join whichever moment works for them.',
      });
    } catch (error) {
      this.showToast({
        tone: 'warning',
        title: 'The circle rendezvous was not set.',
        message: error instanceof Error ? error.message : 'The plan could not be signed.',
      });
    }
  }

  private async joinCirclePlan(event: Event): Promise<void> {
    const detail = (event as CustomEvent<{ circleId?: string; planId?: string }>).detail;
    const identity = this.circleIdentity;
    const store = this.circleStore;
    if (!identity || !store || !detail?.circleId || !detail.planId) return;
    try {
      const records = await store.load(detail.circleId);
      const view = deriveMemberView(records, identity.selfKey, this.circleFriends, {}, {
        circleId: detail.circleId,
      });
      if (!view.members.includes(identity.selfKey)) {
        throw new Error('You are not a current member of this circle.');
      }
      const plan = records.find(
        (entry) => entry.id === detail.planId && entry.record.type === 'Plan',
      );
      if (!plan || plan.record.type !== 'Plan') {
        throw new Error('That circle offer is not in the merged record set.');
      }
      if (plan.record.organizer === identity.selfKey) {
        throw new Error('You already made this offer.');
      }
      const already = records.some(
        (entry) =>
          entry.record.type === 'PlanJoin' &&
          entry.record.planId === detail.planId &&
          entry.record.member === identity.selfKey,
      );
      if (!already) {
        const join = await createPlanJoin({
          identity,
          circleId: detail.circleId,
          planId: detail.planId,
          at: Date.now(),
        });
        await store.append(detail.circleId, [join]);
      }
      await this.reloadCircles();
      await this.selectCircle(detail.circleId);
      void this.circleSync?.refresh();
      this.showToast({
        tone: 'success',
        title: 'You joined that moment.',
        message:
          'The offer is confirmed for you and its other participants. You do not need the whole circle.',
      });
    } catch (error) {
      this.showToast({
        tone: 'warning',
        title: 'The offer was not joined.',
        message: error instanceof Error ? error.message : 'The PlanJoin could not be signed.',
      });
    }
  }

  private async setCircleWindow(event: Event): Promise<void> {
    const detail = (event as CustomEvent<{ circleId?: string; start?: number; end?: number }>).detail;
    const identity = this.circleIdentity;
    const store = this.circleStore;
    if (!identity || !store || !detail?.circleId || !detail.start || !detail.end) return;
    try {
      const record = await createCircleWindow({
        identity,
        circleId: detail.circleId,
        start: detail.start,
        end: detail.end,
        createdAt: Date.now(),
      });
      await store.append(detail.circleId, [record]);
      await this.reloadCircles();
      await this.selectCircle(detail.circleId);
      void this.circleSync?.refresh();
      this.showToast({
        tone: 'success',
        title: 'Gathering window set.',
        message: 'New circle plans must fall inside it. Earlier valid plans stay untouched.',
      });
    } catch (error) {
      this.showToast({
        tone: 'warning',
        title: 'The window was not set.',
        message: error instanceof Error ? error.message : 'The window could not be signed.',
      });
    }
  }

  private async clearCircleGatheringWindow(event: Event): Promise<void> {
    const detail = (event as CustomEvent<{ circleId?: string }>).detail;
    const identity = this.circleIdentity;
    const store = this.circleStore;
    if (!identity || !store || !detail?.circleId) return;
    try {
      const record = await clearCircleWindow({
        identity,
        circleId: detail.circleId,
        createdAt: Date.now(),
      });
      await store.append(detail.circleId, [record]);
      await this.reloadCircles();
      await this.selectCircle(detail.circleId);
      void this.circleSync?.refresh();
      this.showToast({
        tone: 'info',
        title: 'Window cleared.',
        message: 'New circle plans are unconstrained again.',
      });
    } catch (error) {
      this.showToast({
        tone: 'warning',
        title: 'The window was not cleared.',
        message: error instanceof Error ? error.message : 'The clear record could not be signed.',
      });
    }
  }

  private async handleCircleRendezvousEvent(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== 'object') return;
    const invite = raw as {
      fromId?: unknown;
      circleId?: unknown;
      recipients?: unknown;
      plan?: unknown;
    };
    const identity = this.circleIdentity;
    const store = this.circleStore;
    if (
      !identity ||
      !store ||
      typeof invite.circleId !== 'string' ||
      typeof invite.fromId !== 'string' ||
      !Array.isArray(invite.recipients) ||
      !invite.recipients.includes(identity.selfKey) ||
      !invite.plan ||
      typeof invite.plan !== 'object'
    ) {
      return;
    }
    if (!this.state?.humans.some((human) => human.id === invite.fromId)) return;
    try {
      const entry = invite.plan as StoredCircleRecord;
      const existing = await store.load(invite.circleId);
      const view = deriveMemberView(existing, identity.selfKey, this.circleFriends, {}, {
        circleId: invite.circleId,
      });
      if (
        !view.members.includes(identity.selfKey) ||
        !view.members.includes(invite.fromId)
      ) {
        return;
      }
      const merged = await mergeRecords(identity, existing, [entry], {
        circleId: invite.circleId,
      });
      if (merged.added.length === 0 && merged.removed.length === 0) {
        if (merged.rejected.length > 0) {
          console.warn('[circles] rejected rendezvous invite', merged.rejected[0]);
        }
        return;
      }
      if (merged.removed.length > 0) {
        await store.remove?.(invite.circleId, merged.removed);
      }
      await store.append(invite.circleId, merged.added);
      await this.reloadCircles();
      if (this.activeCircleId === invite.circleId) {
        await this.selectCircle(invite.circleId);
      }
      void this.circleSync?.refresh();
      const human = this.state?.humans.find((candidate) => candidate.id === invite.fromId);
      this.showToast({
        tone: 'info',
        title: 'A circle rendezvous arrived.',
        message: `${human ? displayName(human.name) : 'A member'} set a shared moment.`,
      });
    } catch (error) {
      console.warn('[circles] circle rendezvous invite failed', error);
    }
  }

  private emitHostEvent(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private showBootError(message: string): void {
    const panel = document.createElement('div');
    panel.className = 'boot-error';
    const card = document.createElement('div');
    card.className = 'boot-error-card';
    const heading = document.createElement('h2');
    heading.textContent = 'The door stuck.';
    const copy = document.createElement('p');
    copy.textContent = `${message} Rendezvous needs IndexedDB and Web Crypto, and works on localhost or HTTPS.`;
    card.append(heading, copy);
    panel.append(card);
    this.root.append(panel);
  }

  private bindStaticEvents(): void {
    this.$('#done-link-copy').addEventListener('click', () => void this.copyDoneLink());
    this.$('#signal-button').addEventListener('click', () => this.toggleDiagnostics());
    this.$('#set-rendezvous').addEventListener('click', () => this.openRendezvous());
    const circleBar = this.$<CircleBar>('#circle-bar');
    circleBar.addEventListener('circle-add', () => void this.openCircles({ create: true }));
    circleBar.addEventListener('circle-open', (event) => {
      const detail = (event as CustomEvent<{ circleId?: string }>).detail;
      if (detail?.circleId) void this.openCircles({ circleId: detail.circleId });
    });
    this.circleBar = circleBar;
    this.$('#circle-close').addEventListener('click', () =>
      this.$<HTMLDialogElement>('#circle-dialog').close(),
    );
    this.$('#rv-close').addEventListener('click', () => this.$<HTMLDialogElement>('#rendezvous-dialog').close());
    this.$('#rv-next').addEventListener('click', () => this.goToStepTwo());
    this.$('#rv-back').addEventListener('click', () => this.setStep(1));
    this.$('#rv-schedule').addEventListener('click', () => void this.scheduleRendezvous());
    this.$('#rv-finish').addEventListener('click', () => this.$<HTMLDialogElement>('#rendezvous-dialog').close());
    this.$('#human-close').addEventListener('click', () => this.$<HTMLDialogElement>('#human-dialog').close());
    this.$('#mark-verified').addEventListener('click', () => void this.markVerified());
    this.$('#rv-detail-close').addEventListener('click', () => this.closeRendezvousDetail());
    this.$('#rv-detail-human').addEventListener('click', () => this.openHumanFromDetail());
    this.$('#rv-detail-share').addEventListener('click', () => this.shareLinkFromDetail());
    this.$('#rv-detail-verify-toggle').addEventListener('click', () => this.toggleDetailVerification());
    this.$('#rv-detail-mark-verified').addEventListener('click', () => void this.markDetailVerified());
    this.$('#rv-detail-add').addEventListener('click', () => this.openContributionFromDetail());
    this.$('#rv-detail-replace').addEventListener('click', () => this.openContributionFromDetail());
    this.$('#rv-detail-remove').addEventListener('click', () => void this.removeContributionFromDetail());
    this.$('#rv-detail-live').addEventListener('click', () => this.openLiveFromDetail());
    this.$('#rv-detail-confirm').addEventListener('click', () => void this.confirmActiveRendezvous());
    this.$('#rv-detail-counter').addEventListener('click', () => this.openCounterDialog());
    this.$('#rv-counter-close').addEventListener('click', () => this.closeCounterDialog());
    this.$('#rv-counter-cancel').addEventListener('click', () => this.closeCounterDialog());
    this.$('#rv-counter-submit').addEventListener('click', () => void this.submitCounterProposal());
    this.$('#remove-human').addEventListener('click', () => this.beginHumanRemoval());
    this.$('#cancel-remove').addEventListener('click', () => this.resetHumanRemoval());
    this.$('#confirm-remove').addEventListener('click', () => void this.confirmHumanRemoval());
    this.$('#photo-viewer-close').addEventListener('click', () => this.closePhotoViewer());
    this.$('#photo-delete').addEventListener('click', () => void this.deleteViewedPhoto());
    this.$('#photo-share').addEventListener('click', () => this.shareAgain());
    this.$('#possession-check').addEventListener('click', () => void this.checkPossession());
    this.$('#composer-note-add').addEventListener('click', () => void this.startRecorder('composer'));
    this.$('#composer-note-stop').addEventListener('click', () => this.stopRecorder(false));
    this.$('#composer-note-discard').addEventListener('click', () => {
      this.stopRecorder(true);
      this.setComposerNote(null);
    });
    this.$('#composer-note-remove').addEventListener('click', () => this.setComposerNote(null));
    this.$('#contribution-note-add').addEventListener('click', () => void this.startRecorder('contribution'));
    this.$('#contribution-note-stop').addEventListener('click', () => this.stopRecorder(false));
    this.$('#contribution-note-discard').addEventListener('click', () => {
      this.stopRecorder(true);
      this.setContributionNote(null);
    });
    this.$('#contribution-note-remove').addEventListener('click', () => this.setContributionNote(null));
    this.$('#contribution-close').addEventListener('click', () => this.closeContribution());
    this.$('#contribution-save').addEventListener('click', () => void this.saveContribution());
    this.$('#contribution-remove').addEventListener('click', () => void this.removeContribution());
    this.$('#contribution-drop').addEventListener('click', () =>
      this.$<HTMLInputElement>('#contribution-input').click(),
    );
    this.$('#contribution-input').addEventListener('change', (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      if (file) this.setContributionPhoto(file);
      input.value = '';
    });
    this.$('#contribution-dialog').addEventListener('click', (event) => {
      if (event.target === this.$('#contribution-dialog')) this.closeContribution();
    });
    this.$('#contribution-dialog').addEventListener('close', () => {
      this.stopRecorder(true);
      this.contributionRecordId = null;
    });
    this.$('#live-close').addEventListener('click', () => this.closeLive());
    this.$('#live-minimise').addEventListener('click', () => this.closeLive());
    this.$('#live-start-audio').addEventListener('click', () => void this.startAudio());
    this.$('#live-allow').addEventListener('click', () => void this.client?.respondAudioMinute(true));
    this.$('#live-not-now').addEventListener('click', () => void this.client?.respondAudioMinute(false));
    this.$('#live-mute').addEventListener('click', () => this.client?.toggleAudioMute());
    this.$('#live-end').addEventListener('click', () => this.client?.endAudioMinute());
    this.$('#audio-strip-open').addEventListener('click', () => {
      if (this.state?.audio.rendezvousId) this.openLive(this.state.audio.rendezvousId, true);
    });
    this.$('#audio-strip-mute').addEventListener('click', () => this.client?.toggleAudioMute());
    this.$('#audio-strip-end').addEventListener('click', () => this.client?.endAudioMinute());
    this.$('#live-dialog').addEventListener('click', (event) => {
      if (event.target === this.$('#live-dialog')) this.closeLive();
    });
    this.$('#live-dialog').addEventListener('close', () => {
      if (this.liveRecordId) this.liveDismissed.add(this.liveRecordId);
      this.renderAudio(this.state?.audio ?? {
        rendezvousId: null,
        peerId: null,
        peerName: '',
        phase: 'idle',
        muted: false,
        remoteMuted: false,
        remainingMs: 0,
        message: null,
      });
    });
    this.$('#rendezvous-dialog').addEventListener('click', (event) => {
      if (event.target === this.$('#rendezvous-dialog')) {
        this.$<HTMLDialogElement>('#rendezvous-dialog').close();
      }
    });
    this.$('#human-dialog').addEventListener('click', (event) => {
      if (event.target === this.$('#human-dialog')) {
        this.$<HTMLDialogElement>('#human-dialog').close();
      }
    });
    this.$('#rendezvous-detail-dialog').addEventListener('click', (event) => {
      if (event.target === this.$('#rendezvous-detail-dialog')) this.closeRendezvousDetail();
    });
    this.$('#rendezvous-counter-dialog').addEventListener('click', (event) => {
      if (event.target === this.$('#rendezvous-counter-dialog')) this.closeCounterDialog();
    });
    this.$('#rendezvous-counter-dialog').addEventListener('close', () => {
      this.counterRecordId = null;
      this.$('#rv-counter-error').hidden = true;
      this.$<HTMLButtonElement>('#rv-counter-submit').disabled = false;
    });
    this.$('#photo-dialog').addEventListener('click', (event) => {
      if (event.target === this.$('#photo-dialog')) this.closePhotoViewer();
    });
    this.$('#circle-dialog').addEventListener('click', (event) => {
      if (event.target === this.$('#circle-dialog')) {
        this.$<HTMLDialogElement>('#circle-dialog').close();
      }
    });
    this.$('#rendezvous-dialog').addEventListener('close', () => this.resetRendezvousFlow());
    this.$('#human-dialog').addEventListener('close', () => {
      this.activeHumanId = null;
      this.resetHumanRemoval();
    });
    this.$('#rendezvous-detail-dialog').addEventListener('close', () => {
      this.resetDetailState();
    });
    this.$('#photo-dialog').addEventListener('close', () => this.releaseViewerUrl());
    this.$('#photo-input').addEventListener('change', (event) => {
      const input = event.currentTarget as HTMLInputElement;
      const file = input.files?.[0];
      if (file) this.setPhoto(file);
      input.value = '';
    });
    this.$('#photo-drop').addEventListener('click', () => this.$<HTMLInputElement>('#photo-input').click());
    const drop = this.$('#photo-drop');
    drop.addEventListener('dragover', (event) => {
      event.preventDefault();
      drop.classList.add('is-dragging');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-dragging'));
    drop.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('is-dragging');
      const file = event.dataTransfer?.files[0];
      if (file) this.setPhoto(file);
    });

    const codeName = this.$<HTMLInputElement>('#code-name');
    codeName.addEventListener('input', () => {
      if (this.nameSaveTimer !== null) window.clearTimeout(this.nameSaveTimer);
      this.nameSaveTimer = window.setTimeout(() => void this.commitCodeName(), 360);
    });
    codeName.addEventListener('blur', () => void this.commitCodeName());
    codeName.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        codeName.blur();
      }
    });

    const time = this.$<HTMLInputElement>('#rv-time');
    const date = this.$<HTMLInputElement>('#rv-date');
    time.addEventListener('input', () => {
      this.updateTimeReadout();
      this.updateScheduleResolution();
    });
    time.addEventListener('click', () => {
      try {
        time.showPicker();
      } catch {
        // Browsers without a popup picker still support keyboard editing.
      }
    });
    date.addEventListener('input', () => this.updateScheduleResolution());
    this.$('#humans-list').addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-human-id]');
      if (target?.dataset.humanId) this.openHuman(target.dataset.humanId);
    });
  }

  private renderEmptyState(): void {
    const humans = this.$('#humans-list');
    humans.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'humans-empty';
    const copy = document.createElement('span');
    copy.className = 'humans-empty-copy';
    copy.textContent = 'No humans yet. Set a rendezvous for someone new.';
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'inline-add';
    start.textContent = 'Set a rendezvous ↗';
    start.addEventListener('click', () => this.openRendezvous());
    empty.append(copy, start);
    humans.append(empty);
  }

  private render(snapshot: RendezvousSnapshot): void {
    this.state = snapshot;
    if (!snapshot.ready) return;
    this.$('#app').classList.remove('is-loading');
    const codeName = this.$<HTMLInputElement>('#code-name');
    if (this.root.activeElement !== codeName && codeName.value !== snapshot.identity.name) {
      codeName.value = snapshot.identity.name;
    }
    codeName.disabled = false;
    this.renderHero();
    this.renderSignal(snapshot);
    this.renderHumans(snapshot);
    this.syncCirclePeers();
    this.renderWall(snapshot);
    this.renderAudio(snapshot.audio);
    this.maybeOpenLive(snapshot);
    if (this.activeHumanId) this.refreshHumanDialog(snapshot);
    if (this.detailRecordId) this.refreshRendezvousDetail();
    if (this.rvStep === 1 && this.$<HTMLDialogElement>('#rendezvous-dialog').open) {
      this.renderHumanOptions(snapshot);
    }
  }

  private renderHero(): void {
    if (!this.state) return;
    const eyebrow = this.$('#hero-eyebrow');
    const title = this.$('#hero-title');
    const lede = this.$('#hero-lede');
    const now = Date.now();
    const pending = this.state.rendezvous
      .filter((record) => record.status !== 'delivered')
      .sort((a, b) => a.scheduledFor - b.scheduledFor);
    const next = pending.find((record) => record.scheduledFor >= now) ?? pending[0];
    const cta = this.$<HTMLButtonElement>('#set-rendezvous');
    cta.hidden = Boolean(next);

    if (!next) {
      eyebrow.hidden = true;
      eyebrow.textContent = '';
      title.hidden = true;
      title.replaceChildren();
      title.removeAttribute('aria-label');
      lede.hidden = true;
      lede.textContent = '';
      return;
    }

    const awaitingJoin = next.status === 'awaiting-join' || !next.peerId;
    const human = this.state.humans.find((entry) => entry.id === next.peerId);
    const person = awaitingJoin
      ? 'someone new'
      : displayName(next.peerName || human?.name || '');
    const phase = handoffPhase(next.scheduledFor, now);
    const main =
      phase === 'scheduled' || phase === 'open-early'
        ? formatCountdown(next.scheduledFor - now)
        : phase === 'due'
          ? 'now'
          : 'still open';

    eyebrow.hidden = false;
    eyebrow.textContent = `next rendezvous · ${person}`;
    title.hidden = false;
    title.replaceChildren();
    const value = document.createElement('span');
    value.className = 'hero-countdown';
    value.textContent = main;
    const when = document.createElement('em');
    when.className = 'hero-when';
    when.textContent = formatMoment(next.scheduledFor);
    title.append(value, document.createElement('br'), when);
    title.setAttribute(
      'aria-label',
      `${main}. ${formatMoment(next.scheduledFor)}. ${person}.`,
    );
    lede.hidden = false;
    lede.textContent = awaitingJoin
      ? 'Share their link. Opening it gives them this rendezvous immediately and connects your browsers.'
      : phase === 'scheduled'
        ? 'The handoff opens five minutes early. Both browsers need to be here.'
        : phase === 'open-early' || phase === 'due'
          ? 'The handoff is open. Both browsers connect automatically when they are here.'
          : 'The handoff stays open. The photograph moves at your next overlap.';
  }

  private renderSignal(snapshot: RendezvousSnapshot): void {
    const button = this.$('#signal-button');
    button.dataset.status = snapshot.signal;
    const labels: Record<string, string> = {
      starting: 'starting',
      connecting: 'connecting',
      online: 'live',
      offline: 'off',
      replaced: 'another window',
    };
    const label = labels[snapshot.signal] ?? snapshot.signal;
    this.$('#signal-label').textContent = label;
    button.setAttribute(
      'aria-label',
      `Connection diagnostics. Current status: ${label}.`,
    );
    this.renderDiagnostics(snapshot);
  }

  private renderDiagnostics(snapshot: RendezvousSnapshot): void {
    const onlineHumans = snapshot.humans.filter((human) => human.online).length;
    this.$('#diag-signal').textContent =
      `${snapshot.signal} · ${onlineHumans} of ${snapshot.humans.length} human${snapshot.humans.length === 1 ? '' : 's'} online`;
    const network = snapshot.network;
    if (network) {
      this.$('#diag-socket').textContent =
        `${network.remoteFamily}${network.remoteAddress ? ` · ${network.remoteAddress}` : ''}`;
      this.$('#diag-bootstrap').textContent = network.dualStack
        ? `dual-stack advertised · listening on ${network.host}`
        : `single-stack · listening on ${network.host}`;
    } else {
      this.$('#diag-socket').textContent = snapshot.signal === 'online' ? 'negotiating…' : '—';
      this.$('#diag-bootstrap').textContent = '—';
    }

    const diagnostics = snapshot.lastTransferDiagnostics;
    if (diagnostics?.selected) {
      this.$('#diag-direct').textContent =
        `${diagnostics.selected.localFamily} → ${diagnostics.selected.remoteFamily} · ${diagnostics.selected.protocol.toUpperCase()} · ${diagnostics.selected.localType}/${diagnostics.selected.remoteType}`;
      this.$('#diag-candidates').textContent =
        `local ${diagnostics.localCandidates.ipv4} v4 · ${diagnostics.localCandidates.ipv6} v6 · ${diagnostics.localCandidates.unknown} hidden / remote ${diagnostics.remoteCandidates.ipv4} v4 · ${diagnostics.remoteCandidates.ipv6} v6 · ${diagnostics.remoteCandidates.unknown} hidden`;
    } else if (diagnostics) {
      this.$('#diag-direct').textContent = 'no successful candidate pair';
      this.$('#diag-candidates').textContent =
        `local ${diagnostics.localCandidates.ipv4} v4 · ${diagnostics.localCandidates.ipv6} v6 · ${diagnostics.localCandidates.unknown} hidden / remote ${diagnostics.remoteCandidates.ipv4} v4 · ${diagnostics.remoteCandidates.ipv6} v6 · ${diagnostics.remoteCandidates.unknown} hidden`;
    } else {
      this.$('#diag-direct').textContent = 'no direct session yet';
      this.$('#diag-candidates').textContent = 'gathered when a handoff begins';
    }

    const warning = this.$('#diag-warning');
    if (network?.warning) {
      warning.hidden = false;
      warning.textContent = network.warning;
    } else {
      warning.hidden = true;
      warning.textContent = '';
    }
    const note = this.$('#diag-note');
    const hasV6 =
      diagnostics &&
      (diagnostics.localCandidates.ipv6 > 0 || diagnostics.remoteCandidates.ipv6 > 0);
    const hidden =
      diagnostics &&
      diagnostics.localCandidates.unknown + diagnostics.remoteCandidates.unknown > 0;
    note.textContent = diagnostics
      ? hasV6
        ? 'This connection produced IPv6 candidates. WebRTC uses both address families when the network offers them.'
        : hidden
          ? 'Some host candidates use mDNS names, so their address family is hidden. No IPv6 candidate was visible. IPv6 comes from the network and is used automatically when available.'
          : 'This connection did not produce an IPv6 candidate. That is a property of this network, not something the app can assign. The browser uses IPv6 automatically when it is available.'
      : 'IPv4 and IPv6 addresses belong to the network this device is on. Rendezvous uses IPv6 when the browser gathers it, and never filters either family. The app cannot create an IPv6 address for you.';
  }

  private renderHumans(snapshot: RendezvousSnapshot): void {
    const list = this.$('#humans-list');
    this.$('#humans-count').textContent =
      snapshot.humans.length === 0
        ? 'none yet'
        : `${snapshot.humans.length} linked`;
    if (snapshot.humans.length === 0) {
      this.renderEmptyState();
      return;
    }
    list.replaceChildren();
    for (const human of snapshot.humans) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'human-chip';
      button.dataset.humanId = human.id;
      button.setAttribute(
        'aria-label',
        `Open ${escapePunctuation(human.name)}. ${human.online ? 'Online' : 'Offline'}. ${human.verifiedAt ? 'Verified' : 'Not verified'}.`,
      );
      const avatar = document.createElement('span');
      avatar.className = 'human-avatar';
      avatar.dataset.online = String(human.online);
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = initialFor(human.name);
      const copy = document.createElement('span');
      copy.className = 'human-copy';
      const name = document.createElement('span');
      name.className = 'human-name';
      name.textContent = displayName(human.name);
      if (human.verifiedAt) {
        const tick = document.createElement('span');
        tick.className = 'verified-tick';
        tick.setAttribute('aria-label', 'Verified');
        tick.textContent = '✓';
        name.append(' ', tick);
      } else {
        const tick = document.createElement('span');
        tick.className = 'unverified-tick';
        tick.setAttribute('aria-label', 'Not verified');
        name.append(' ', tick);
      }
      const state = document.createElement('span');
      state.className = 'human-state';
      state.dataset.online = String(human.online);
      const dot = document.createElement('span');
      dot.className = 'online-dot';
      dot.setAttribute('aria-hidden', 'true');
      const stateText = document.createElement('span');
      stateText.textContent = `${human.online ? 'here now' : 'away'} · ${human.verifiedAt ? 'verified' : 'not verified'}`;
      state.append(dot, stateText);
      copy.append(name, state);
      button.append(avatar, copy);
      list.append(button);
    }
  }

  private photoUrlFor(print: StoredPrint): string | null {
    if (!print.photo) return null;
    const key = `${print.id}:${print.deliveredAt}`;
    const existing = this.objectUrls.get(key);
    if (existing) return existing;
    const url = URL.createObjectURL(print.photo.blob);
    this.objectUrls.set(key, url);
    return url;
  }

  private pruneObjectUrls(liveKeys: Set<string>): void {
    for (const [key, url] of [...this.objectUrls.entries()]) {
      if (liveKeys.has(key)) continue;
      URL.revokeObjectURL(url);
      this.objectUrls.delete(key);
    }
  }

  private renderWall(snapshot: RendezvousSnapshot): void {
    const wrap = this.$('#wall-wrap');
    const board = this.$('#wall-board');
    const next = this.$('#wall-next');
    const delivered = snapshot.prints.slice().sort((a, b) => {
      const arrival = b.deliveredAt - a.deliveredAt;
      return arrival !== 0 ? arrival : a.id.localeCompare(b.id);
    });
    const pending = snapshot.rendezvous
      .filter((record) => record.status !== 'delivered')
      .sort((a, b) => a.scheduledFor - b.scheduledFor);
    const humans = new Map(snapshot.humans.map((human) => [human.id, human]));

    if (delivered.length === 0 && pending.length === 0) {
      wrap.hidden = true;
      board.replaceChildren();
      next.replaceChildren();
      next.hidden = true;
      this.pruneObjectUrls(new Set());
      return;
    }
    wrap.hidden = false;
    this.$('#wall-summary').textContent = [
      delivered.length > 0 ? `${delivered.length} photograph${delivered.length === 1 ? '' : 's'}` : null,
      pending.length > 0 ? `${pending.length} waiting` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    board.replaceChildren();
    next.replaceChildren();
    next.hidden = pending.length === 0;
    const liveKeys = new Set<string>();

    for (const record of pending) {
      const awaitingJoin = record.status === 'awaiting-join' || !record.peerId;
      const human = humans.get(record.peerId);
      const person = awaitingJoin
        ? 'someone new'
        : displayName(record.peerName || human?.name || '');
      const phase = handoffPhase(record.scheduledFor);
      const wrapRow = document.createElement('div');
      wrapRow.className = 'next-row';
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'next-card';
      card.dataset.rendezvousId = record.id;
      const time = document.createElement('span');
      time.className = 'next-card-time';
      time.textContent = formatClock(record.scheduledFor);
      const copy = document.createElement('span');
      copy.className = 'next-card-copy';
      const title = document.createElement('span');
      title.className = 'next-card-title';
      title.textContent = awaitingJoin
        ? 'for someone new'
        : `${record.direction === 'incoming' ? 'from' : 'to'} ${person}`;
      const state = document.createElement('span');
      state.className = 'next-card-state';
      const needsPerson = !human?.online;
      state.textContent =
        awaitingJoin
          ? 'waiting for them to join · link ready'
          : record.status === 'transferring'
          ? 'moving directly'
          : record.status === 'failed'
            ? 'retrying when both are here'
            : phase === 'scheduled'
              ? `set · ${formatShortDay(record.scheduledFor)}`
              : phase === 'open-early'
                ? needsPerson
                  ? `open early · waiting for ${person}`
                  : 'both here · connecting early'
                : phase === 'due'
                  ? needsPerson
                    ? `waiting for ${person}`
                    : 'both here · connecting'
                  : needsPerson
                    ? `still open · waiting for ${person}`
                    : 'still open · connecting';
      const confirmation = document.createElement('span');
      confirmation.className = 'next-card-confirmation';
      if (!awaitingJoin) {
        const mine = record.confirmedBy.includes(snapshot.identity.id);
        confirmation.textContent =
          record.confirmation === 'confirmed'
            ? 'confirmed by both'
            : mine
              ? `pending · waiting for ${person} to confirm`
              : 'pending · confirm or propose another time';
        if (record.confirmation === 'confirmed') confirmation.dataset.confirmed = 'true';
      }
      const contribution = document.createElement('span');
      contribution.className = 'next-card-contribution';
      if (awaitingJoin) {
        contribution.textContent = 'their link is ready to share';
      } else if (record.direction === 'incoming') {
        contribution.textContent = `your photo · ${record.contribution ? 'added' : 'not added'}`;
      } else if (record.reciprocal) {
        contribution.textContent = `${person}’s photo · received`;
      } else if (record.sessionStartedAt) {
        contribution.textContent = `${person}’s photo · not added`;
      }
      copy.append(title, state);
      if (confirmation.textContent) copy.append(confirmation);
      if (contribution.textContent) copy.append(contribution);
      const arrow = document.createElement('span');
      arrow.className = 'next-card-arrow';
      arrow.textContent = '↗';
      card.append(time, copy, arrow);
      card.setAttribute('aria-label', `Open rendezvous with ${person} · ${formatMoment(record.scheduledFor)} · ${state.textContent}`);
      card.addEventListener('click', () => this.openRendezvousDetail(record.id));
      wrapRow.append(card);
      next.append(wrapRow);
    }

    delivered.forEach((print, index) => {
      const human = humans.get(print.peerId);
      const person = displayName(print.peerName || human?.name || '');
      const rank = index + 1;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'wall-photo';
      button.dataset.wallId = print.id;
      button.dataset.wallRank = String(rank);
      button.style.width = '160px';
      button.setAttribute('aria-label', `Open photograph ranked ${rank} from ${person}`);
      const frame = document.createElement('span');
      frame.className = 'wall-photo-frame';
      const url = this.photoUrlFor(print);
      if (url) liveKeys.add(`${print.id}:${print.deliveredAt}`);
      if (url) {
        const image = document.createElement('img');
        image.className = 'wall-photo-image';
        image.src = url;
        image.alt = '';
        frame.append(image);
      }
      const caption = document.createElement('span');
      caption.className = 'wall-photo-caption';
      const rankLabel = document.createElement('span');
      rankLabel.className = 'wall-rank';
      rankLabel.textContent = String(rank).padStart(2, '0');
      const personLabel = document.createElement('span');
      personLabel.className = 'wall-person';
      personLabel.textContent = `${print.direction === 'incoming' ? 'from' : 'to'} ${person}`;
      const date = document.createElement('span');
      date.className = 'wall-date';
      date.textContent = formatShortDay(print.deliveredAt);
      caption.append(rankLabel, personLabel, date);
      if (print.photo.note) {
        const note = document.createElement('span');
        note.className = 'wall-note-badge';
        note.textContent = `◉ ${formatDuration(print.photo.note.durationMs)}`;
        caption.append(note);
      }
      button.append(frame, caption);
      button.addEventListener('click', () => this.openPhotoViewer(print));
      board.append(button);
    });

    if (delivered.length === 0) {
      board.hidden = true;
    } else {
      board.hidden = false;
      const note = document.createElement('p');
      note.className = 'wall-footnote';
      note.textContent = `rank 01 is freshest · each print steps down on a gentle curve`;
      board.append(note);
    }
    this.pruneObjectUrls(liveKeys);
    window.requestAnimationFrame(() => this.layoutWall());
  }

  private layoutWall(): void {
    const board = this.root.querySelector<HTMLElement>('#wall-board');
    if (!board) return;
    const width = board.clientWidth;
    if (width <= 0) return;
    for (const photo of board.querySelectorAll<HTMLElement>('.wall-photo')) {
      const rank = Number(photo.dataset.wallRank ?? '1');
      photo.style.width = `${wallPhotoWidth(rank, width)}px`;
    }
  }

  private notePrefix(mode: 'composer' | 'contribution'): string {
    return mode === 'composer' ? 'composer-note' : 'contribution-note';
  }

  private noteValue(mode: 'composer' | 'contribution'): VoiceNoteAttachment | null {
    return mode === 'composer' ? this.composerNote : this.contributionNote;
  }

  private noteUrl(mode: 'composer' | 'contribution'): string | null {
    return mode === 'composer' ? this.composerNoteUrl : this.contributionNoteUrl;
  }

  private setNoteUrl(
    mode: 'composer' | 'contribution',
    url: string | null,
  ): void {
    if (mode === 'composer') {
      if (this.composerNoteUrl) URL.revokeObjectURL(this.composerNoteUrl);
      this.composerNoteUrl = url;
    } else {
      if (this.contributionNoteUrl) URL.revokeObjectURL(this.contributionNoteUrl);
      this.contributionNoteUrl = url;
    }
  }

  private setComposerNote(note: VoiceNoteAttachment | null): void {
    this.composerNote = note;
    this.setNoteUrl('composer', note ? URL.createObjectURL(note.blob) : null);
    this.renderNote('composer');
  }

  private setContributionNote(note: VoiceNoteAttachment | null): void {
    this.contributionNote = note;
    this.setNoteUrl(
      'contribution',
      note ? URL.createObjectURL(note.blob) : null,
    );
    this.renderNote('contribution');
  }

  private renderNote(mode: 'composer' | 'contribution'): void {
    const prefix = this.notePrefix(mode);
    const note = this.noteValue(mode);
    const url = this.noteUrl(mode);
    const idle = this.$<HTMLElement>(`#${prefix}-idle`);
    const recording = this.$<HTMLElement>(`#${prefix}-recording`);
    const attached = this.$<HTMLElement>(`#${prefix}-attached`);
    const audio = this.$<HTMLAudioElement>(`#${prefix}-audio`);
    const duration = this.$<HTMLElement>(`#${prefix}-duration`);
    const add = this.$<HTMLButtonElement>(`#${prefix}-add`);
    idle.hidden = recording.hidden === false || Boolean(note);
    attached.hidden = !note;
    recording.hidden = this.recorderMode !== mode;
    add.disabled = mode === 'composer' ? !this.photo : !this.contributionPhoto;
    if (note && url) {
      if (audio.src !== url) audio.src = url;
      duration.textContent = formatDuration(note.durationMs);
    } else {
      audio.removeAttribute('src');
      duration.textContent = '';
    }
  }

  private async startRecorder(mode: 'composer' | 'contribution'): Promise<void> {
    if (this.recorder) return;
    const prefix = this.notePrefix(mode);
    const error = this.$<HTMLElement>(`#${prefix}-error`);
    error.hidden = true;
    if (
      typeof MediaRecorder === 'undefined' ||
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      error.textContent = 'This browser cannot record a voice note. The photo is unaffected.';
      error.hidden = false;
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
    } catch {
      error.textContent =
        'Microphone permission was denied. You can still send the photograph without a note.';
      error.hidden = false;
      return;
    }
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type));
    let recorder: MediaRecorder;
    try {
      recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      error.textContent = 'This browser cannot record a voice note. The photo is unaffected.';
      error.hidden = false;
      return;
    }
    this.recorder = recorder;
    this.recorderMode = mode;
    this.recorderChunks = [];
    this.recorderStartedAt = Date.now();
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.recorderChunks.push(event.data);
    };
    recorder.onstop = () => {
      this.finalizeRecorder(mode, stream, recorder.mimeType || mimeType || 'audio/webm');
    };
    recorder.start(250);
    this.recorderTimer = window.setInterval(() => {
      const elapsed = Math.min(MAX_VOICE_NOTE_MS, Date.now() - this.recorderStartedAt);
      this.$<HTMLElement>(`#${prefix}-time`).textContent = formatDuration(elapsed);
    }, 200);
    this.recorderLimit = window.setTimeout(() => this.stopRecorder(false), MAX_VOICE_NOTE_MS);
    this.renderNote(mode);
    this.$<HTMLButtonElement>(`#${prefix}-stop`).focus();
  }

  private finalizeRecorder(
    mode: 'composer' | 'contribution',
    stream: MediaStream,
    mimeType: string,
  ): void {
    const elapsed = Math.min(MAX_VOICE_NOTE_MS, Date.now() - this.recorderStartedAt);
    const discard = this.recorderDiscard;
    const chunks = this.recorderChunks;
    this.recorder = null;
    this.recorderMode = null;
    this.recorderChunks = [];
    this.recorderDiscard = false;
    if (this.recorderTimer !== null) {
      window.clearInterval(this.recorderTimer);
      this.recorderTimer = null;
    }
    if (this.recorderLimit !== null) {
      window.clearTimeout(this.recorderLimit);
      this.recorderLimit = null;
    }
    stream.getTracks().forEach((track) => track.stop());
    if (!discard && chunks.length > 0) {
      const blob = new Blob(chunks, { type: mimeType });
      const extension = mimeType.includes('ogg') ? 'ogg' : 'webm';
      const note: VoiceNoteAttachment = {
        blob,
        name: `voice-note.${extension}`,
        type: mimeType,
        size: blob.size,
        durationMs: Math.max(1, elapsed),
      };
      if (mode === 'composer') this.setComposerNote(note);
      else this.setContributionNote(note);
    } else {
      this.renderNote(mode);
    }
  }

  private recorderDiscard = false;

  private stopRecorder(discard: boolean): void {
    const recorder = this.recorder;
    if (!recorder) return;
    this.recorderDiscard = discard;
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {
      this.recorder = null;
      this.recorderMode = null;
    }
  }

  private openContribution(rendezvousId: string): void {
    const record = this.state?.rendezvous.find((entry) => entry.id === rendezvousId);
    if (!record || record.direction !== 'incoming') return;
    this.contributionRecordId = rendezvousId;
    this.contributionPhoto = null;
    if (this.contributionPhotoUrl) URL.revokeObjectURL(this.contributionPhotoUrl);
    this.contributionPhotoUrl = null;
    this.setContributionNote(null);
    const preview = this.$<HTMLImageElement>('#contribution-preview');
    preview.hidden = true;
    preview.removeAttribute('src');
    this.$('#contribution-empty').hidden = false;
    this.$('#contribution-reselect').hidden = true;
    this.$('#contribution-caption').hidden = true;
    this.$('#contribution-drop').classList.remove('has-photo');
    this.$('#contribution-error').hidden = true;
    this.$('#contribution-remove').hidden = !record.contribution;
    this.$('#contribution-copy').textContent =
      `${displayName(record.peerName)} set this rendezvous. Your photo is optional and stays in this browser until you are both here.`;
    const save = this.$<HTMLButtonElement>('#contribution-save');
    save.disabled = true;
    save.textContent = record.contribution ? 'Replace my photo' : 'Add to the rendezvous';
    if (record.contribution) {
      this.setContributionPhoto(
        new File([record.contribution.blob], record.contribution.name || 'photograph', {
          type: record.contribution.type,
        }),
      );
      if (record.contribution.note) this.setContributionNote(record.contribution.note);
      save.textContent = 'Replace my photo';
    }
    const dialog = this.$<HTMLDialogElement>('#contribution-dialog');
    if (!dialog.open) dialog.showModal();
    this.renderNote('contribution');
  }

  private closeContribution(): void {
    const dialog = this.$<HTMLDialogElement>('#contribution-dialog');
    if (dialog.open) dialog.close();
    this.stopRecorder(true);
    if (this.contributionPhotoUrl) URL.revokeObjectURL(this.contributionPhotoUrl);
    this.contributionPhotoUrl = null;
    this.contributionPhoto = null;
    this.contributionRecordId = null;
    this.setContributionNote(null);
  }

  private setContributionPhoto(file: File): void {
    const error = this.$<HTMLElement>('#contribution-error');
    if (!file.type.startsWith('image/')) {
      error.textContent = 'That file is not an image.';
      error.hidden = false;
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      error.textContent = 'That photograph is larger than 25 MB.';
      error.hidden = false;
      return;
    }
    error.hidden = true;
    if (this.contributionPhotoUrl) URL.revokeObjectURL(this.contributionPhotoUrl);
    this.contributionPhoto = file;
    this.contributionPhotoUrl = URL.createObjectURL(file);
    const preview = this.$<HTMLImageElement>('#contribution-preview');
    preview.src = this.contributionPhotoUrl;
    preview.hidden = false;
    this.$('#contribution-empty').hidden = true;
    this.$('#contribution-reselect').hidden = false;
    this.$('#contribution-drop').classList.add('has-photo');
    this.$('#contribution-caption').hidden = false;
    this.$('#contribution-name').textContent = file.name || 'photograph';
    this.$('#contribution-size').textContent = formatBytes(file.size);
    this.$<HTMLButtonElement>('#contribution-save').disabled = false;
    this.renderNote('contribution');
  }

  private async saveContribution(): Promise<void> {
    const id = this.contributionRecordId;
    const photo = this.contributionPhoto;
    const client = this.client;
    if (!id || !photo || !client) return;
    const button = this.$<HTMLButtonElement>('#contribution-save');
    button.disabled = true;
    button.textContent = 'Adding…';
    try {
      await client.setContribution({
        rendezvousId: id,
        photo,
        fileName: photo.name,
        note: this.contributionNote,
      });
      this.closeContribution();
      this.showToast({
        tone: 'success',
        title: 'Your photo is ready.',
        message: 'It stays here until you are both online for the handoff.',
      });
    } catch (error) {
      this.$<HTMLElement>('#contribution-error').textContent =
        error instanceof Error ? error.message : 'Your photo could not be added.';
      this.$<HTMLElement>('#contribution-error').hidden = false;
      button.disabled = false;
      button.textContent = 'Add to the rendezvous';
    }
  }

  private async removeContribution(): Promise<void> {
    const id = this.contributionRecordId;
    const client = this.client;
    if (!id || !client) return;
    try {
      await client.removeContribution(id);
      this.closeContribution();
      this.showToast({
        tone: 'info',
        title: 'Your photo was removed.',
        message: 'The rendezvous is still set.',
      });
    } catch (error) {
      this.$<HTMLElement>('#contribution-error').textContent =
        error instanceof Error ? error.message : 'Your photo could not be removed.';
      this.$<HTMLElement>('#contribution-error').hidden = false;
    }
  }

  private toggleDiagnostics(): void {
    if (this.diagnosticsOpen) {
      this.closeDiagnostics();
      return;
    }
    this.diagnosticsOpen = true;
    this.$('#diagnostics-panel').hidden = false;
    this.$('#signal-button').setAttribute('aria-expanded', 'true');
    if (this.state) this.renderDiagnostics(this.state);
  }

  private closeDiagnostics(): void {
    if (!this.diagnosticsOpen) return;
    this.diagnosticsOpen = false;
    this.$('#diagnostics-panel').hidden = true;
    this.$('#signal-button').setAttribute('aria-expanded', 'false');
  }

  private async commitCodeName(): Promise<void> {
    if (this.nameSaveTimer !== null) {
      window.clearTimeout(this.nameSaveTimer);
      this.nameSaveTimer = null;
    }
    if (!this.client) return;
    const input = this.$<HTMLInputElement>('#code-name');
    try {
      await this.client.setCodeName(input.value);
    } catch {
      this.showToast({
        tone: 'error',
        title: 'Your name did not save.',
        message: 'The local identity store is unavailable.',
      });
    }
  }

  private openRendezvous(print?: StoredPrint): void {
    if (!this.state?.ready) return;
    const dialog = this.$<HTMLDialogElement>('#rendezvous-dialog');
    this.resetRendezvousFlow();
    this.resharePrint = print ?? null;
    if (print) {
      const file = new File([print.photo.blob], print.photo.name || 'photograph', {
        type: print.photo.type,
      });
      this.setPhoto(file);
      if (print.photo.note) this.setComposerNote(print.photo.note);
      this.$('#rv-title').textContent = 'Share again';
      this.$('.modal-kicker').textContent = 'reusing this photograph from your wall';
    } else {
      this.$('#rv-title').textContent = 'Set a rendezvous';
      this.$('.modal-kicker').textContent = 'a photograph for later';
    }
    this.renderHumanOptions(this.state);
    this.$<HTMLInputElement>('#rv-time').value = nextDefaultTime();
    this.updateTimeReadout();
    this.$<HTMLInputElement>('#rv-date').value = '';
    this.$<HTMLInputElement>('#rv-date').min = toDateValue(new Date());
    this.setStep(1);
    this.updateScheduleResolution();
    if (!dialog.open) dialog.showModal();
    this.$<HTMLButtonElement>('#photo-drop').focus();
  }

  private resetRendezvousFlow(): void {
    this.rvStep = 1;
    this.selectedHumanId = null;
    this.resharePrint = null;
    this.stopRecorder(true);
    if (this.photoUrl) URL.revokeObjectURL(this.photoUrl);
    this.photoUrl = null;
    this.photo = null;
    this.setComposerNote(null);
    const photoPreview = this.$<HTMLImageElement>('#photo-preview');
    photoPreview.hidden = true;
    photoPreview.removeAttribute('src');
    this.$('#photo-empty').hidden = false;
    this.$('#photo-reselect').hidden = true;
    this.$('#photo-caption').hidden = true;
    this.$('#photo-error').hidden = true;
    this.$('#photo-drop').classList.remove('has-photo');
    this.$('#rv-error').hidden = true;
    this.$<HTMLInputElement>('#rv-audio-disabled').checked = false;
    this.$('#rv-next').setAttribute('disabled', '');
    this.$<HTMLButtonElement>('#rv-schedule').disabled = false;
    this.$('#rv-schedule').innerHTML = 'Set a rendezvous <span aria-hidden="true">↗</span>';
    this.updateStepUI(1);
  }

  private setStep(step: 1 | 2 | 3): void {
    this.rvStep = step;
    for (const value of [1, 2, 3]) {
      this.$(`#rv-step-${value}`).hidden = value !== step;
    }
    this.updateStepUI(step);
    if (step === 2) {
      this.updateScheduleResolution();
      window.setTimeout(() => this.$<HTMLInputElement>('#rv-time').focus(), 30);
    }
  }

  private updateStepUI(step: number): void {
    this.$('#rv-step-count').textContent = `0${step} / 03`;
    for (const value of [1, 2, 3]) {
      const marker = this.$(`#rv-marker-${value}`);
      marker.classList.toggle('is-done', value < step);
      marker.classList.toggle('is-active', value === step);
    }
  }

  private renderHumanOptions(snapshot: RendezvousSnapshot): void {
    const container = this.$('#human-options');
    container.replaceChildren();
    this.$('#human-note').textContent =
      snapshot.humans.length === 0
        ? 'Your first meeting starts here.'
        : 'Choose a linked human, or invite someone new.';

    const addOption = (
      value: string,
      nameText: string,
      stateText: string,
      online: boolean | null,
    ): void => {
      const label = document.createElement('label');
      label.className = `human-option${value === NEW_PERSON_ID ? ' is-new' : ''}`;
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'rv-human';
      input.value = value;
      input.checked = value === this.selectedHumanId;
      input.addEventListener('change', () => {
        this.selectedHumanId = value;
        this.$('#rv-error').hidden = true;
        this.updateStepOneState();
      });
      const avatar = document.createElement('span');
      avatar.className = 'human-avatar';
      avatar.dataset.online = online === null ? 'new' : String(online);
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = online === null ? '+' : initialFor(nameText);
      const copy = document.createElement('span');
      copy.className = 'human-option-copy';
      const name = document.createElement('span');
      name.className = 'human-option-name';
      name.textContent = nameText;
      const state = document.createElement('span');
      state.className = 'human-option-state';
      state.textContent = stateText;
      copy.append(name, state);
      const check = document.createElement('span');
      check.className = 'human-option-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      label.append(input, avatar, copy, check);
      container.append(label);
    };

    addOption(
      NEW_PERSON_ID,
      'someone new',
      'the join link appears after you set the rendezvous',
      null,
    );
    for (const human of snapshot.humans) {
      addOption(
        human.id,
        displayName(human.name),
        `${human.online ? 'here now' : 'away'} · ${human.verifiedAt ? 'verified' : 'not verified'}`,
        human.online,
      );
    }

    if (
      this.selectedHumanId !== NEW_PERSON_ID &&
      this.selectedHumanId &&
      !snapshot.humans.some((human) => human.id === this.selectedHumanId)
    ) {
      this.selectedHumanId = null;
    }
    if (!this.selectedHumanId && snapshot.humans.length === 0) {
      this.selectedHumanId = NEW_PERSON_ID;
    }
    this.updateStepOneState();
  }

  private updateStepOneState(): void {
    const next = this.$<HTMLButtonElement>('#rv-next');
    const ready = Boolean(this.photo && this.selectedHumanId);
    next.disabled = !ready;
    this.$('#rv-error').hidden = true;
  }

  private setPhoto(file: File): void {
    const error = this.$('#photo-error');
    if (!file.type.startsWith('image/')) {
      error.textContent = 'That file is not an image.';
      error.hidden = false;
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      error.textContent = 'That photograph is larger than 25 MB.';
      error.hidden = false;
      return;
    }
    error.hidden = true;
    if (this.photoUrl) URL.revokeObjectURL(this.photoUrl);
    this.photo = file;
    this.photoUrl = URL.createObjectURL(file);
    const preview = this.$<HTMLImageElement>('#photo-preview');
    preview.src = this.photoUrl;
    preview.hidden = false;
    this.$('#photo-empty').hidden = true;
    this.$('#photo-reselect').hidden = false;
    this.$('#photo-drop').classList.add('has-photo');
    this.$('#photo-caption').hidden = false;
    this.$('#photo-name').textContent = file.name || 'photograph';
    this.$('#photo-size').textContent = formatBytes(file.size);
    this.$<HTMLButtonElement>('#composer-note-add').disabled = false;
    this.updateStepOneState();
  }

  private goToStepTwo(): void {
    if (!this.photo || !this.selectedHumanId) return;
    if (this.selectedHumanId === NEW_PERSON_ID) {
      this.$('#pick-name').textContent = 'someone new';
    } else {
      const human = this.state?.humans.find((entry) => entry.id === this.selectedHumanId);
      if (!human) return;
      this.$('#pick-name').textContent = displayName(human.name);
    }
    const thumb = this.$<HTMLImageElement>('#pick-thumb');
    if (this.photoUrl) thumb.src = this.photoUrl;
    const timeInput = this.$<HTMLInputElement>('#rv-time');
    timeInput.value ||= nextDefaultTime();
    this.updateTimeReadout();
    this.setStep(2);
    this.updateScheduleResolution();
  }

  private resolveSchedule(): { timestamp: number; label: string } | { error: string } {
    const time = this.$<HTMLInputElement>('#rv-time').value;
    const dateValue = this.$<HTMLInputElement>('#rv-date').value;
    if (!time) return { error: 'Choose a time.' };
    const [hoursText, minutesText] = time.split(':');
    const hours = Number(hoursText);
    const minutes = Number(minutesText);
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
      return { error: 'Choose a valid time.' };
    }
    const now = Date.now();
    let target: Date;
    if (dateValue) {
      const [yearText, monthText, dayText] = dateValue.split('-');
      const year = Number(yearText);
      const month = Number(monthText);
      const day = Number(dayText);
      if (!year || !month || !day) return { error: 'Choose a valid date.' };
      target = new Date(year, month - 1, day, hours, minutes, 0, 0);
      if (target.getTime() <= now + 1_000) {
        return { error: 'That moment has passed. Pick a later time.' };
      }
    } else {
      const today = new Date();
      target = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
        hours,
        minutes,
        0,
        0,
      );
      if (target.getTime() <= now + 1_000) {
        target = new Date(target.getTime() + 86_400_000);
      }
    }
    return { timestamp: target.getTime(), label: formatMoment(target.getTime()) };
  }

  private updateTimeReadout(): void {
    const value = this.$<HTMLInputElement>('#rv-time').value;
    this.$('#rv-time-readout').textContent = value || '--:--';
  }

  private updateScheduleResolution(): void {
    if (!this.$('#rv-resolved')) return;
    this.updateTimeReadout();
    const resolved = this.resolveSchedule();
    const schedule = this.$<HTMLButtonElement>('#rv-schedule');
    const resolvedElement = this.$('#rv-resolved');
    const time = this.$<HTMLInputElement>('#rv-time').value;
    if ('error' in resolved) {
      resolvedElement.textContent = time ? resolved.error : 'Choose a time.';
      resolvedElement.style.color = time ? '#9d3c23' : '';
      schedule.disabled = true;
      return;
    }
    resolvedElement.textContent = `We’ll meet ${resolved.label}.`;
    resolvedElement.style.color = '';
    schedule.disabled = false;
  }

  private async scheduleRendezvous(): Promise<void> {
    if (!this.client || !this.photo || !this.selectedHumanId) return;
    const resolved = this.resolveSchedule();
    const error = this.$('#rv-error');
    if ('error' in resolved) {
      error.textContent = resolved.error;
      error.hidden = false;
      return;
    }
    const button = this.$<HTMLButtonElement>('#rv-schedule');
    button.disabled = true;
    button.textContent = 'Setting it…';
    error.hidden = true;
    const liveAudioDisabled = this.$<HTMLInputElement>('#rv-audio-disabled').checked;

    try {
      const record =
        this.selectedHumanId === NEW_PERSON_ID
          ? await this.client.scheduleRendezvousForNewPerson({
              photo: this.photo,
              fileName: this.photo.name,
              note: this.composerNote,
              scheduledFor: resolved.timestamp,
              liveAudioDisabled,
            })
          : await this.client.scheduleRendezvous({
              humanId: this.selectedHumanId,
              photo: this.photo,
              fileName: this.photo.name,
              photoId: this.resharePrint?.photoId,
              note: this.composerNote,
              scheduledFor: resolved.timestamp,
              liveAudioDisabled,
            });
      this.showDone(record);
    } catch (scheduleError) {
      error.textContent =
        scheduleError instanceof Error
          ? scheduleError.message
          : 'The rendezvous could not be saved.';
      error.hidden = false;
      button.disabled = false;
      button.innerHTML = 'Set a rendezvous <span aria-hidden="true">↗</span>';
    }
  }

  private showDone(record: StoredRendezvous): void {
    const human = this.state?.humans.find((entry) => entry.id === record.peerId);
    const isNewPerson = Boolean(record.inviteToken);
    const who = isNewPerson ? 'someone new' : displayName(record.peerName || human?.name || '');
    this.$('#done-summary').textContent = isNewPerson
      ? `For someone new. ${formatMoment(record.scheduledFor)}. Share their link below.`
      : `For ${who}. ${formatMoment(record.scheduledFor)}.`;
    this.$('#done-audio-off').hidden = !record.liveAudioDisabled;
    this.$('#done-human').textContent = who;
    this.$('#done-moment').textContent = formatMoment(record.scheduledFor);
    this.$('#done-photo').textContent = record.photo
      ? `${record.photo.name} · ${formatBytes(record.photo.size)}`
      : 'the photograph';
    const linkBlock = this.$<HTMLElement>('#done-link-block');
    const linkInput = this.$<HTMLInputElement>('#done-link');
    const copy = this.$<HTMLButtonElement>('#done-link-copy');
    if (isNewPerson && record.inviteToken) {
      linkBlock.hidden = false;
      linkInput.value = buildInviteUrl(record.inviteToken);
      copy.textContent = 'copy';
      this.$('#done-note').textContent =
        'Send this link to one person. The rendezvous is already saved here; opening the link puts it in their upcoming list and creates your human link.';
    } else {
      linkBlock.hidden = true;
      linkInput.value = '';
      this.$('#done-note').textContent =
        'The photo is still here. It will only travel when you are both present at the same time. We’ll tell them when they next arrive.';
    }
    this.setStep(3);
    window.setTimeout(
      () =>
        this.$<HTMLButtonElement>(isNewPerson ? '#done-link-copy' : '#rv-finish').focus(),
      40,
    );
  }

  private async copyText(
    text: string,
    button: HTMLButtonElement,
    resetLabel = 'copy',
  ): Promise<boolean> {
    if (!text.startsWith('http')) return false;
    button.textContent = 'copied';
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      const input = document.createElement('textarea');
      input.value = text;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.append(input);
      input.select();
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      }
      input.remove();
    }
    button.textContent = copied ? 'copied' : 'select';
    if (this.copyResetTimer !== null) window.clearTimeout(this.copyResetTimer);
    this.copyResetTimer = window.setTimeout(() => {
      button.textContent = resetLabel;
    }, 2200);
    return copied;
  }

  private async copyDoneLink(): Promise<void> {
    const input = this.$<HTMLInputElement>('#done-link');
    const copied = await this.copyText(input.value, this.$('#done-link-copy'));
    if (!copied) {
      input.focus();
      input.select();
      this.showToast({
        tone: 'info',
        title: 'The link is selected.',
        message: 'Copy it from the field above.',
      });
    }
  }

  private async shareRendezvousLink(record: StoredRendezvous): Promise<void> {
    if (!record.inviteToken) return;
    const link = buildInviteUrl(record.inviteToken);
    let copied = false;
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
    } catch {
      copied = false;
    }
    if (!copied) {
      window.prompt('Copy this rendezvous link', link);
      return;
    }
    this.showToast({
      tone: 'success',
      title: 'Link copied.',
      message: 'Send it to the person you want to meet.',
    });
  }

  private getActiveDetailRecord(): StoredRendezvous | null {
    if (!this.detailRecordId) return null;
    return this.state?.rendezvous.find((entry) => entry.id === this.detailRecordId) ?? null;
  }

  private openRendezvousDetail(rendezvousId: string): void {
    const record = this.state?.rendezvous.find((entry) => entry.id === rendezvousId);
    if (!record || record.status === 'delivered') return;
    this.detailRecordId = rendezvousId;
    this.detailVerificationRequest += 1;
    this.resetDetailVerification();
    this.refreshRendezvousDetail(record);
    const dialog = this.$<HTMLDialogElement>('#rendezvous-detail-dialog');
    if (!dialog.open) dialog.showModal();
  }

  private closeRendezvousDetail(): void {
    this.detailRecordId = null;
    this.detailVerificationRequest += 1;
    const dialog = this.$<HTMLDialogElement>('#rendezvous-detail-dialog');
    if (dialog.open) dialog.close();
    this.releaseDetailUrls();
    this.resetDetailVerification();
  }

  private refreshRendezvousDetail(record?: StoredRendezvous): void {
    const active = record ?? this.getActiveDetailRecord();
    if (!active) {
      this.closeRendezvousDetail();
      return;
    }
    const human = active.peerId
      ? this.state?.humans.find((entry) => entry.id === active.peerId)
      : undefined;
    const awaitingJoin = active.status === 'awaiting-join' || !active.peerId;
    const person = awaitingJoin
      ? 'someone new'
      : displayName(active.peerName || human?.name || '');
    const phase = handoffPhase(active.scheduledFor);
    const directionWord = active.direction === 'incoming' ? 'from' : 'to';

    const humanButton = this.$<HTMLButtonElement>('#rv-detail-human');
    this.$('#rv-detail-avatar').textContent = initialFor(person);
    this.$('#rv-detail-kicker').textContent = awaitingJoin
      ? 'a rendezvous waiting for its person'
      : 'a rendezvous with';
    this.$('#rv-detail-title').textContent = person;
    this.$('#rv-detail-sub').textContent = awaitingJoin
      ? 'their link is ready'
      : human?.online
        ? 'here now'
        : 'away';
    humanButton.disabled = !human;
    humanButton.setAttribute(
      'aria-label',
      human ? `Open ${person}’s human details` : `${person} is not linked yet`,
    );

    this.$('#rv-detail-moment').textContent = formatMoment(active.scheduledFor);
    this.$('#rv-detail-window').textContent =
      phase === 'scheduled'
        ? `opens ${formatClock(active.scheduledFor - 5 * 60_000)} · both browsers need to be here`
        : phase === 'still-open'
          ? 'still open · lateness never cancels it'
          : 'open now · both browsers connect automatically';
    const mineConfirmed = active.confirmedBy.includes(this.state?.identity.id ?? '');
    this.$('#rv-detail-confirmation').textContent = awaitingJoin
      ? 'pending · the other human has not joined yet'
      : active.confirmation === 'confirmed'
        ? 'confirmed by both'
        : mineConfirmed
          ? `pending · waiting for ${person} to confirm`
          : 'pending · both of you need to confirm';

    const needsPerson = !human?.online;
    this.$('#rv-detail-state').textContent = awaitingJoin
      ? 'waiting for them to join'
      : active.status === 'failed'
        ? 'couldn’t connect · retrying when both are here'
        : active.status === 'transferring'
          ? 'moving directly'
          : active.status === 'connecting'
            ? 'connecting directly…'
            : phase === 'scheduled'
              ? `set · ${formatShortDay(active.scheduledFor)}`
              : phase === 'open-early'
                ? needsPerson
                  ? `open early · waiting for ${person}`
                  : 'both here · connecting early'
                : phase === 'due'
                  ? needsPerson
                    ? `waiting for ${person}`
                    : 'both here · connecting'
                  : needsPerson
                    ? `still open · waiting for ${person}`
                    : 'still open · connecting';
    this.$('#rv-detail-direction').textContent = awaitingJoin
      ? `to ${person}`
      : `${directionWord} ${person}`;

    const attachment = active.direction === 'outgoing' ? active.photo : active.contribution;
    const missing = active.direction === 'outgoing' && !active.photo;
    this.$('#rv-detail-photo-state').textContent = attachment
      ? 'your photo · added'
      : missing
        ? 'your photo · missing'
        : 'your photo · not added yet';
    this.$('#rv-detail-photo-meta').textContent = attachment
      ? `${attachment.name || 'photograph'} · ${formatBytes(attachment.size)}`
      : missing
        ? 'This browser no longer has the file. Choose a new photograph to keep the rendezvous ready.'
        : 'Optional. It stays in this browser until you are both here.';
    this.syncDetailPhoto(attachment);
    this.syncDetailNote(attachment?.note ?? null);

    this.$('#rv-detail-peer-state').textContent =
      active.direction === 'outgoing'
        ? active.reciprocal
          ? `${person}’s photo · received`
          : active.sessionStartedAt
            ? `${person}’s photo · not added`
            : `${person}’s photo · waiting`
        : active.photo
          ? `${person}’s photo · delivered`
          : active.status === 'transferring'
            ? `${person}’s photo · moving now`
            : active.status === 'failed'
              ? `${person}’s photo · retrying`
              : `${person}’s photo · waiting`;

    const contributionEditable =
      active.direction === 'incoming' &&
      !active.sessionStartedAt &&
      active.status !== 'transferring';
    this.$('#rv-detail-share').hidden = !(awaitingJoin && active.inviteToken);
    this.$('#rv-detail-confirm').hidden = !(
      !awaitingJoin &&
      active.status !== 'delivered' &&
      active.confirmation !== 'confirmed' &&
      !mineConfirmed
    );
    this.$('#rv-detail-counter').hidden = !(
      !awaitingJoin &&
      active.status !== 'delivered' &&
      !active.sessionStartedAt
    );
    this.$('#rv-detail-add').hidden = !(contributionEditable && !active.contribution);
    this.$('#rv-detail-replace').hidden = !(contributionEditable && Boolean(active.contribution));
    this.$('#rv-detail-remove').hidden = !(contributionEditable && Boolean(active.contribution));
    this.$('#rv-detail-live').hidden = !(
      !awaitingJoin &&
      phase !== 'scheduled' &&
      Boolean(human?.online)
    );
    this.$('#rv-detail-audio-off').hidden = !active.liveAudioDisabled;

    this.$('#rv-detail-footnote').textContent = awaitingJoin
      ? 'The photo stays here. Opening their link puts this rendezvous in their upcoming list.'
      : active.direction === 'incoming' && !active.contribution
        ? 'Your photo is optional. The rendezvous is complete for you either way.'
        : 'The photo stays on this device until you are both here at the same time.';

    const verifySection = this.$('#rv-detail-verify-section');
    verifySection.hidden = !human;
    if (human) {
      this.$('#rv-detail-verify-badge').textContent = human.verifiedAt
        ? 'verified'
        : 'not verified';
      const mark = this.$<HTMLButtonElement>('#rv-detail-mark-verified');
      mark.disabled = Boolean(human.verifiedAt);
      mark.textContent = human.verifiedAt ? 'Verified' : 'Mark as verified';
    }
  }

  private syncDetailPhoto(attachment: PhotoAttachment | null): void {
    const key = attachment
      ? `${attachment.photoId}:${attachment.size}:${attachment.name}`
      : null;
    if (key === this.detailAttachmentKey) return;
    if (this.detailPhotoUrl) URL.revokeObjectURL(this.detailPhotoUrl);
    this.detailPhotoUrl = null;
    this.detailAttachmentKey = key;
    const image = this.$<HTMLImageElement>('#rv-detail-photo');
    const empty = this.$('#rv-detail-photo-empty');
    if (!attachment) {
      image.hidden = true;
      image.removeAttribute('src');
      empty.hidden = false;
      return;
    }
    this.detailPhotoUrl = URL.createObjectURL(attachment.blob);
    image.src = this.detailPhotoUrl;
    image.alt = 'Your photograph for this rendezvous';
    image.hidden = false;
    empty.hidden = true;
  }

  private syncDetailNote(note: VoiceNoteAttachment | null): void {
    const key = note ? `${note.name}:${note.size}:${note.durationMs}` : null;
    if (key === this.detailNoteKey) return;
    if (this.detailNoteUrl) URL.revokeObjectURL(this.detailNoteUrl);
    this.detailNoteUrl = null;
    this.detailNoteKey = key;
    const container = this.$('#rv-detail-note');
    const audio = this.$<HTMLAudioElement>('#rv-detail-note-audio');
    if (!note) {
      container.hidden = true;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      this.$('#rv-detail-note-duration').textContent = '';
      return;
    }
    this.detailNoteUrl = URL.createObjectURL(note.blob);
    audio.src = this.detailNoteUrl;
    container.hidden = false;
    this.$('#rv-detail-note-duration').textContent = formatDuration(note.durationMs);
  }

  private releaseDetailUrls(): void {
    if (this.detailPhotoUrl) URL.revokeObjectURL(this.detailPhotoUrl);
    if (this.detailNoteUrl) URL.revokeObjectURL(this.detailNoteUrl);
    this.detailPhotoUrl = null;
    this.detailNoteUrl = null;
    this.detailAttachmentKey = null;
    this.detailNoteKey = null;
  }

  private resetDetailVerification(): void {
    this.$('#rv-detail-verify-toggle').setAttribute('aria-expanded', 'false');
    this.$('#rv-detail-verify-panel').hidden = true;
    this.$('#rv-detail-verification-words').replaceChildren();
  }

  private toggleDetailVerification(): void {
    const toggle = this.$<HTMLButtonElement>('#rv-detail-verify-toggle');
    const panel = this.$('#rv-detail-verify-panel');
    const open = toggle.getAttribute('aria-expanded') === 'true';
    if (open) {
      toggle.setAttribute('aria-expanded', 'false');
      panel.hidden = true;
      this.detailVerificationRequest += 1;
      return;
    }
    toggle.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    void this.loadDetailVerification();
  }

  private async loadDetailVerification(): Promise<void> {
    const record = this.getActiveDetailRecord();
    const human = record
      ? this.state?.humans.find((entry) => entry.id === record.peerId)
      : undefined;
    if (!record || !human) return;
    const list = this.$('#rv-detail-verification-words');
    if (list.childElementCount > 0) return;
    const request = this.detailVerificationRequest;
    for (let index = 0; index < 8; index += 1) {
      const item = document.createElement('li');
      item.className = 'is-placeholder';
      item.textContent = '••••';
      list.append(item);
    }
    try {
      const words = await this.client?.verificationWordsFor(human.id);
      if (request !== this.detailVerificationRequest || this.detailRecordId !== record.id || !words) {
        return;
      }
      list.replaceChildren();
      for (const word of words) {
        const item = document.createElement('li');
        item.textContent = word;
        list.append(item);
      }
    } catch {
      if (request !== this.detailVerificationRequest) return;
      this.showToast({
        tone: 'error',
        title: 'The words are unavailable.',
        message: 'Rendezvous could not read both pinned keys.',
      });
    }
  }

  private async markDetailVerified(): Promise<void> {
    const record = this.getActiveDetailRecord();
    if (!record || !this.client) return;
    const mark = this.$<HTMLButtonElement>('#rv-detail-mark-verified');
    mark.disabled = true;
    mark.textContent = 'Saving…';
    try {
      await this.client.markHumanVerified(record.peerId);
    } catch {
      this.showToast({
        tone: 'error',
        title: 'Verification did not save.',
        message: 'The local identity store is unavailable.',
      });
      mark.disabled = false;
      mark.textContent = 'Mark as verified';
    }
  }

  private openHumanFromDetail(): void {
    const record = this.getActiveDetailRecord();
    if (!record) return;
    const human = this.state?.humans.find((entry) => entry.id === record.peerId);
    if (!human) return;
    this.closeRendezvousDetail();
    this.openHuman(record.peerId);
  }

  private shareLinkFromDetail(): void {
    const record = this.getActiveDetailRecord();
    if (!record) return;
    void this.shareRendezvousLink(record);
  }

  private async confirmRendezvous(rendezvousId: string): Promise<void> {
    if (!this.client) return;
    const button = this.$<HTMLButtonElement>('#rv-detail-confirm');
    button.disabled = true;
    try {
      const record = await this.client.confirmRendezvous(rendezvousId);
      this.showToast({
        tone: 'success',
        title: 'Time confirmed.',
        message:
          record.confirmation === 'confirmed'
            ? 'You both confirmed this rendezvous.'
            : 'Waiting for the other human to confirm.',
      });
    } catch (error) {
      this.showToast({
        tone: 'warning',
        title: 'Could not confirm the time.',
        message: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      button.disabled = false;
    }
  }

  private confirmActiveRendezvous(): void {
    if (this.detailRecordId) void this.confirmRendezvous(this.detailRecordId);
  }

  private dateTimeLocalValue(value: number): string {
    const date = new Date(value);
    const pad = (part: number): string => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  private openCounterDialog(recordId?: string): void {
    const id = recordId ?? this.detailRecordId;
    if (!id || !this.state) return;
    const record = this.state.rendezvous.find((entry) => entry.id === id);
    if (!record || record.status === 'delivered') return;
    this.counterRecordId = id;
    const human = this.state.humans.find((entry) => entry.id === record.peerId);
    const person = displayName(record.peerName || human?.name || '');
    this.$('#rv-counter-context').textContent =
      `Cancels ${formatMoment(record.scheduledFor)} with ${person}. The new time is pending until both of you confirm it.`;
    const input = this.$<HTMLInputElement>('#rv-counter-when');
    input.value = this.dateTimeLocalValue(
      Math.max(record.scheduledFor + 60 * 60_000, Date.now() + 5 * 60_000),
    );
    this.$('#rv-counter-error').hidden = true;
    this.$<HTMLButtonElement>('#rv-counter-submit').disabled = false;
    const dialog = this.$<HTMLDialogElement>('#rendezvous-counter-dialog');
    if (!dialog.open) dialog.showModal();
    input.focus();
  }

  private closeCounterDialog(): void {
    const dialog = this.$<HTMLDialogElement>('#rendezvous-counter-dialog');
    if (dialog.open) dialog.close();
    this.counterRecordId = null;
  }

  private async submitCounterProposal(): Promise<void> {
    const recordId = this.counterRecordId;
    if (!recordId || !this.client) return;
    const input = this.$<HTMLInputElement>('#rv-counter-when');
    const error = this.$('#rv-counter-error');
    const scheduledFor = new Date(input.value).getTime();
    if (!Number.isFinite(scheduledFor) || scheduledFor <= Date.now() + 500) {
      error.textContent = 'Choose a moment in the near future.';
      error.hidden = false;
      return;
    }
    const button = this.$<HTMLButtonElement>('#rv-counter-submit');
    button.disabled = true;
    try {
      const record = await this.client.counterProposeRendezvous({
        rendezvousId: recordId,
        scheduledFor,
      });
      this.closeCounterDialog();
      this.showToast({
        tone: 'info',
        title: 'Another time proposed.',
        message: `${formatMoment(record.scheduledFor)} is pending until both of you confirm it.`,
      });
    } catch (counterError) {
      error.textContent =
        counterError instanceof Error ? counterError.message : 'The time could not be proposed.';
      error.hidden = false;
      button.disabled = false;
    }
  }

  private openContributionFromDetail(): void {
    const record = this.getActiveDetailRecord();
    if (!record) return;
    this.closeRendezvousDetail();
    this.openContribution(record.id);
  }

  private async removeContributionFromDetail(): Promise<void> {
    const record = this.getActiveDetailRecord();
    if (!record || !this.client) return;
    const button = this.$<HTMLButtonElement>('#rv-detail-remove');
    button.disabled = true;
    try {
      await this.client.removeContribution(record.id);
      this.showToast({
        tone: 'info',
        title: 'Your photo was removed.',
        message: 'The rendezvous is still set.',
      });
      this.refreshRendezvousDetail();
    } catch (error) {
      this.showToast({
        tone: 'error',
        title: 'Your photo could not be removed.',
        message: error instanceof Error ? error.message : 'Try again while the app is open.',
      });
    } finally {
      button.disabled = false;
    }
  }

  private openLiveFromDetail(): void {
    const record = this.getActiveDetailRecord();
    if (!record) return;
    this.closeRendezvousDetail();
    this.openLive(record.id, true);
  }

  private resetDetailState(): void {
    this.detailRecordId = null;
    this.detailVerificationRequest += 1;
    this.releaseDetailUrls();
    this.resetDetailVerification();
  }

  private openHuman(humanId: string): void {
    const human = this.state?.humans.find((entry) => entry.id === humanId);
    if (!human) return;
    this.activeHumanId = humanId;
    this.verificationRequest += 1;
    const request = this.verificationRequest;
    this.resetHumanRemoval();
    this.$('#human-dialog-avatar').textContent = initialFor(human.name);
    this.$('#human-dialog-name').textContent = displayName(human.name);
    this.$('#human-dialog-sub').textContent = human.online ? 'here now' : 'away';
    this.updateHumanBadge(human);
    const words = this.$('#verification-words');
    words.replaceChildren();
    for (let index = 0; index < 8; index += 1) {
      const item = document.createElement('li');
      item.className = 'is-placeholder';
      item.textContent = '••••';
      words.append(item);
    }
    const mark = this.$<HTMLButtonElement>('#mark-verified');
    mark.disabled = Boolean(human.verifiedAt);
    mark.textContent = human.verifiedAt ? 'Verified' : 'Mark as verified';
    this.$<HTMLButtonElement>('#remove-human').disabled = false;
    const dialog = this.$<HTMLDialogElement>('#human-dialog');
    if (!dialog.open) dialog.showModal();
    void this.loadVerificationWords(human.id, request);
  }

  private async loadVerificationWords(humanId: string, request: number): Promise<void> {
    try {
      const words = await this.client?.verificationWordsFor(humanId);
      if (request !== this.verificationRequest || this.activeHumanId !== humanId || !words) return;
      const list = this.$('#verification-words');
      list.replaceChildren();
      for (const word of words) {
        const item = document.createElement('li');
        item.textContent = word;
        list.append(item);
      }
    } catch {
      if (request !== this.verificationRequest) return;
      this.showToast({
        tone: 'error',
        title: 'The words are unavailable.',
        message: 'Rendezvous could not read both pinned keys.',
      });
    }
  }

  private updateHumanBadge(human: Human): void {
    const badge = this.$('#human-dialog-badge');
    badge.className = `badge ${human.verifiedAt ? 'is-verified' : 'is-unverified'}`;
    badge.textContent = human.verifiedAt ? '✓ verified' : 'not verified';
  }

  private refreshHumanDialog(snapshot: RendezvousSnapshot): void {
    if (!this.activeHumanId) return;
    const human = snapshot.humans.find((entry) => entry.id === this.activeHumanId);
    if (!human) {
      this.$<HTMLDialogElement>('#human-dialog').close();
      return;
    }
    this.$('#human-dialog-sub').textContent = human.online ? 'here now' : 'away';
    this.updateHumanBadge(human);
    const mark = this.$<HTMLButtonElement>('#mark-verified');
    mark.disabled = Boolean(human.verifiedAt);
    mark.textContent = human.verifiedAt ? 'Verified' : 'Mark as verified';
  }

  private async markVerified(): Promise<void> {
    if (!this.client || !this.activeHumanId) return;
    try {
      await this.client.markHumanVerified(this.activeHumanId);
    } catch {
      this.showToast({
        tone: 'error',
        title: 'Verification did not save.',
        message: 'The local identity store is unavailable.',
      });
    }
  }

  private beginHumanRemoval(): void {
    this.$('#remove-confirm').hidden = false;
    this.$('#remove-human').hidden = true;
    this.$<HTMLButtonElement>('#confirm-remove').disabled = false;
  }

  private resetHumanRemoval(): void {
    this.$('#remove-confirm').hidden = true;
    this.$('#remove-human').hidden = false;
    this.$<HTMLButtonElement>('#confirm-remove').disabled = false;
  }

  private async confirmHumanRemoval(): Promise<void> {
    if (!this.client || !this.activeHumanId) return;
    this.$<HTMLButtonElement>('#confirm-remove').disabled = true;
    try {
      await this.client.removeHuman(this.activeHumanId);
      this.$<HTMLDialogElement>('#human-dialog').close();
    } catch {
      this.$<HTMLButtonElement>('#confirm-remove').disabled = false;
      this.showToast({
        tone: 'error',
        title: 'The human was not removed.',
        message: 'Rendezvous could not write the change locally.',
      });
    }
  }

  private openPhotoViewer(print: StoredPrint): void {
    if (!print.photo) return;
    this.releaseViewerUrl();
    this.viewerPrintId = print.id;
    this.viewerPhotoId = print.photoId;
    this.viewerUrl = URL.createObjectURL(print.photo.blob);
    this.$<HTMLImageElement>('#photo-viewer-image').src = this.viewerUrl;
    this.$('#photo-viewer-title').textContent =
      print.direction === 'incoming' ? `From ${escapePunctuation(print.peerName)}.` : `For ${escapePunctuation(print.peerName)}.`;
    this.$('#photo-viewer-sub').textContent =
      `${formatBytes(print.photo.size)} · ${formatMoment(print.deliveredAt)} · stays on this browser`;
    const download = this.$<HTMLAnchorElement>('#photo-download');
    download.href = this.viewerUrl;
    download.download = print.photo.name || 'photograph';
    const del = this.$<HTMLButtonElement>('#photo-delete');
    del.textContent = 'Delete locally';
    del.disabled = false;
    this.deleteArmed = false;
    const share = this.$<HTMLButtonElement>('#photo-share');
    share.hidden = print.direction !== 'outgoing';
    const note = this.$<HTMLElement>('#viewer-note');
    const noteAudio = this.$<HTMLAudioElement>('#viewer-note-audio');
    if (print.photo.note) {
      note.hidden = false;
      noteAudio.src = URL.createObjectURL(print.photo.note.blob);
      this.$('#viewer-note-duration').textContent = formatDuration(
        print.photo.note.durationMs,
      );
    } else {
      note.hidden = true;
      noteAudio.removeAttribute('src');
      this.$('#viewer-note-duration').textContent = '';
    }
    this.renderPossessionInventory(print.direction === 'outgoing' ? print.photoId : null);
    const dialog = this.$<HTMLDialogElement>('#photo-dialog');
    if (!dialog.open) dialog.showModal();
  }

  private renderPossessionInventory(photoId: string | null): void {
    const section = this.$<HTMLElement>('#viewer-possession');
    const list = this.$<HTMLElement>('#possession-list');
    const check = this.$<HTMLButtonElement>('#possession-check');
    list.replaceChildren();
    if (!photoId) {
      section.hidden = true;
      check.disabled = true;
      return;
    }
    section.hidden = false;
    const entries = (this.state?.possessions ?? []).filter(
      (entry) => entry.photoId === photoId,
    );
    if (entries.length === 0) {
      const item = document.createElement('li');
      item.className = 'possession-empty';
      item.textContent = 'No confirmed copies yet. A claim arrives after a recipient stores the photo.';
      list.append(item);
      check.disabled = true;
      return;
    }
    check.disabled = !entries.some((entry) => entry.online && entry.state === 'held');
    for (const entry of entries) {
      const human = this.state?.humans.find((candidate) => candidate.id === entry.holder);
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'possession-name';
      name.textContent = human ? displayName(human.name) : entry.holder.slice(0, 10);
      const state = document.createElement('span');
      state.className = 'possession-state';
      state.dataset.state = entry.connected ? entry.state : 'removed';
      if (!entry.connected) {
        state.textContent = `not connected · last known ${entry.state === 'held' ? 'copy' : 'deleted'}`;
      } else if (entry.state === 'released') {
        state.textContent = `${entry.copies} cop${entry.copies === 1 ? 'y' : 'ies'} · deleted ${formatMoment(entry.at)}`;
      } else if (entry.confirmedNow) {
        state.textContent = `${entry.copies} cop${entry.copies === 1 ? 'y' : 'ies'} · confirmed now`;
      } else {
        state.textContent = `${entry.copies} cop${entry.copies === 1 ? 'y' : 'ies'} · ${entry.online ? 'connected' : 'offline'} · last confirmed ${formatMoment(entry.updatedAt)}`;
      }
      item.append(name, state);
      list.append(item);
    }
  }

  private async checkPossession(): Promise<void> {
    const photoId = this.viewerPhotoId;
    if (!photoId || !this.client) return;
    const checked = await this.client.requestPossessionCheck(photoId);
    this.showToast({
      tone: checked > 0 ? 'info' : 'warning',
      title: checked > 0 ? 'Fresh check requested.' : 'No holder is connected.',
      message:
        checked > 0
          ? 'A signed answer updates the inventory when it arrives.'
          : 'An offline holder can only be shown as last confirmed.',
    });
  }

  private closePhotoViewer(): void {
    const dialog = this.$<HTMLDialogElement>('#photo-dialog');
    if (dialog.open) dialog.close();
    this.releaseViewerUrl();
  }

  private releaseViewerUrl(): void {
    if (this.viewerUrl) URL.revokeObjectURL(this.viewerUrl);
    this.viewerUrl = null;
    this.viewerRecordId = null;
    this.viewerPrintId = null;
    this.viewerPhotoId = null;
    const noteAudio = this.root.querySelector<HTMLAudioElement>('#viewer-note-audio');
    if (noteAudio) {
      noteAudio.pause();
      if (noteAudio.src) URL.revokeObjectURL(noteAudio.src);
      noteAudio.removeAttribute('src');
    }
    if (this.deleteTimer !== null) window.clearTimeout(this.deleteTimer);
    this.deleteTimer = null;
    this.deleteArmed = false;
  }

  private async deleteViewedPhoto(): Promise<void> {
    if (!this.client || !this.viewerPrintId) return;
    const button = this.$<HTMLButtonElement>('#photo-delete');
    if (!this.deleteArmed) {
      this.deleteArmed = true;
      button.textContent = 'Delete? tap again';
      if (this.deleteTimer !== null) window.clearTimeout(this.deleteTimer);
      this.deleteTimer = window.setTimeout(() => {
        this.deleteArmed = false;
        button.textContent = 'Delete locally';
      }, 4000);
      return;
    }
    const id = this.viewerPrintId;
    this.closePhotoViewer();
    try {
      await this.client.deletePrint(id);
    } catch {
      this.showToast({
        tone: 'error',
        title: 'The photograph was not deleted.',
        message: 'Rendezvous could not update local storage.',
      });
    }
  }

  private shareAgain(): void {
    const print = this.viewerPrintId && this.client?.getPrint(this.viewerPrintId);
    if (!print) return;
    this.closePhotoViewer();
    this.openRendezvous(print);
  }

  private renderAudio(audio: AudioSnapshot): void {
    const strip = this.$<HTMLElement>('#audio-strip');
    const dialog = this.$<HTMLDialogElement>('#live-dialog');
    const live = audio.phase === 'live';
    strip.hidden = !live || dialog.open;
    this.$('#audio-strip-name').textContent = audio.peerName
      ? `one minute with ${displayName(audio.peerName)}`
      : 'one live minute';
    this.$('#audio-strip-time').textContent = formatDuration(audio.remainingMs);
    this.$('#audio-strip-mute').textContent = audio.muted ? 'unmute' : 'mute';
    if (audio.phase === 'incoming' && audio.rendezvousId) {
      this.openLive(audio.rendezvousId, false);
    }
    if (dialog.open) this.renderLive();
  }

  private maybeOpenLive(snapshot: RendezvousSnapshot): void {
    const audioRecord = snapshot.audio.rendezvousId;
    if (
      audioRecord &&
      (snapshot.audio.phase === 'live' ||
        snapshot.audio.phase === 'connecting' ||
        snapshot.audio.phase === 'incoming' ||
        snapshot.audio.phase === 'requesting')
    ) {
      this.openLive(audioRecord, false);
      return;
    }
    const candidate = snapshot.rendezvous
      .filter((record) => {
        if (record.status === 'delivered') return false;
        const human = snapshot.humans.find((entry) => entry.id === record.peerId);
        return Boolean(human?.online) && handoffPhase(record.scheduledFor) !== 'scheduled';
      })
      .sort((a, b) => a.scheduledFor - b.scheduledFor)[0];
    if (!candidate) return;
    if (this.liveDismissed.has(candidate.id)) return;
    this.openLive(candidate.id, false);
  }

  private openLive(rendezvousId: string, userAction: boolean): void {
    if (userAction) this.liveDismissed.delete(rendezvousId);
    this.liveRecordId = rendezvousId;
    const dialog = this.$<HTMLDialogElement>('#live-dialog');
    this.renderLive();
    if (!dialog.open) {
      dialog.show();
      const record = this.state?.rendezvous.find((entry) => entry.id === rendezvousId);
      const focusTarget = record?.liveAudioDisabled ? '#live-close' : '#live-start-audio';
      window.setTimeout(() => this.$<HTMLButtonElement>(focusTarget).focus(), 30);
    }
  }

  private closeLive(): void {
    const dialog = this.$<HTMLDialogElement>('#live-dialog');
    if (this.liveRecordId) this.liveDismissed.add(this.liveRecordId);
    if (this.liveCloseTimer !== null) {
      window.clearTimeout(this.liveCloseTimer);
      this.liveCloseTimer = null;
    }
    if (dialog.open) dialog.close();
    this.renderAudio(this.state?.audio ?? {
      rendezvousId: null,
      peerId: null,
      peerName: '',
      phase: 'idle',
      muted: false,
      remoteMuted: false,
      remainingMs: 0,
      message: null,
    });
  }

  private renderLive(): void {
    const id = this.liveRecordId;
    const record = this.state?.rendezvous.find((entry) => entry.id === id);
    if (!record) {
      this.$('#live-close').click?.();
      return;
    }
    const human = this.state?.humans.find((entry) => entry.id === record.peerId);
    const audio = this.state?.audio;
    const person = displayName(record.peerName || human?.name || '');
    this.$('#live-self').textContent = displayName(this.state?.identity.name ?? '');
    this.$('#live-peer').textContent = person;
    this.$('#live-moment').textContent = formatMoment(record.scheduledFor);
    const phase = handoffPhase(record.scheduledFor);
    const state =
      record.status === 'delivered'
        ? 'delivered and stored locally'
        : record.status === 'transferring'
          ? 'moving directly'
          : record.status === 'connecting'
            ? 'connecting directly'
            : record.status === 'failed'
              ? 'the last attempt failed · retrying while you are both here'
              : !human?.online
                ? `waiting for ${person}`
                : phase === 'open-early'
                  ? 'both here · the handoff is open early'
                  : phase === 'due'
                    ? 'both here · the handoff is due'
                    : 'still open · both here';
    this.$('#live-state').textContent = state;

    const contributions = this.$('#live-contributions');
    contributions.replaceChildren();
    const own = document.createElement('p');
    own.className = 'live-contribution';
    own.textContent = `your photo · ${record.photo ? 'added' : record.contribution ? 'added' : 'waiting'}`;
    const theirs = document.createElement('p');
    theirs.className = 'live-contribution';
    theirs.textContent =
      `${person}’s photo · ${
        record.direction === 'incoming'
          ? record.photo
            ? 'received'
            : 'waiting'
          : record.reciprocal
            ? 'received'
            : 'not added'
      }`;
    contributions.append(own, theirs);

    const start = this.$<HTMLButtonElement>('#live-start-audio');
    const controls = this.$<HTMLElement>('#live-audio-controls');
    const consent = this.$<HTMLElement>('#live-consent');
    const message = this.$<HTMLElement>('#live-audio-message');
    const disabled = this.$<HTMLElement>('#live-audio-disabled');
    const isAudioForThis = audio?.rendezvousId === record.id;
    const live = isAudioForThis && audio?.phase === 'live';
    const incoming = isAudioForThis && audio?.phase === 'incoming';
    const busy =
      isAudioForThis &&
      (audio?.phase === 'requesting' || audio?.phase === 'connecting');
    const used = Boolean(record.audioWindowUsedAt);
    const audioOff = record.liveAudioDisabled;
    disabled.hidden = !audioOff;
    start.hidden = audioOff || live || incoming || busy;
    controls.hidden = !live;
    consent.hidden = audioOff || !incoming;
    start.disabled = audioOff || used || !human?.online || phase === 'scheduled';
    start.setAttribute(
      'aria-label',
      used ? 'the minute is over' : 'start audio 1min',
    );
    if (used && !live) {
      start.disabled = true;
      start.querySelector('span:nth-child(2)')!.textContent = 'the minute is over';
    } else if (!audioOff) {
      start.querySelector('span:nth-child(2)')!.textContent = 'start audio 1min';
    }
    this.$('#live-countdown').textContent = formatDuration(audio?.remainingMs ?? 60_000);
    this.$('#live-mute').textContent = audio?.muted ? 'unmute' : 'mute';
    this.$('#live-consent-name').textContent = person;
    const audioMessage = isAudioForThis ? audio?.message ?? '' : '';
    message.textContent = audioMessage;
    message.hidden = !audioMessage;

    if (this.liveCloseTimer !== null) {
      window.clearTimeout(this.liveCloseTimer);
      this.liveCloseTimer = null;
    }
    if (record.status === 'delivered' && !live) {
      this.liveCloseTimer = window.setTimeout(() => {
        this.liveCloseTimer = null;
        const current = this.state?.rendezvous.find((entry) => entry.id === record.id);
        if (current?.status === 'delivered' && this.state?.audio.phase !== 'live') {
          this.closeLive();
        }
      }, 1_500);
    }
  }

  private async startAudio(): Promise<void> {
    if (!this.liveRecordId || !this.client) return;
    try {
      await this.client.requestAudioMinute(this.liveRecordId);
    } catch (error) {
      this.showToast({
        tone: 'warning',
        title: 'The minute did not start.',
        message: error instanceof Error ? error.message : 'Try again when you are both here.',
      });
    }
  }

  private handleNotice(notice: ClientNotice): void {
    const titles: Partial<Record<ClientNotice['code'], string>> = {
      'human-added': 'The link opened.',
      'human-joined': 'The door opened.',
      'human-removed': 'Forgotten.',
      'human-removed-remotely': 'A door closed.',
      'invite-accepted': 'The link is confirmed.',
      'join-retry': 'The link is still arriving.',
      'invalid-invite': 'That link did not verify.',
      'own-invite': 'That is your own link.',
      'already-human': 'Already linked.',
      'key-mismatch': 'That identity did not match.',
      'invite-revoked': 'That link was revoked.',
      'transfer-failed': 'The handoff stopped.',
      'handshake-failed': 'The handshake did not verify.',
      'transfer-delivered': 'Delivered.',
      'rendezvous-confirmed': 'Confirmed together.',
      'rendezvous-countered': 'Another time proposed.',
      'audio-ended': 'The minute is over.',
      'audio-declined': 'A minute, asked.',
      'audio-error': 'The live minute did not start.',
      'possession-updated': 'The inventory changed.',
      'signal-replaced': 'Another window is here.',
      'server-error': 'Signal trouble.',
      'photo-too-large': 'That photo is too large.',
      'invalid-photo': 'That is not a photo.',
      'invalid-time': 'That moment does not work.',
      'no-human': 'Choose a human.',
      'storage-error': 'Local storage is unavailable.',
      'invite-queued': 'Invitation queued.',
      'signal-restored': 'Signal restored.',
      'signal-lost': 'Signal lost.',
    };
    if (
      notice.code === 'invite-queued' ||
      notice.code === 'signal-restored' ||
      notice.code === 'signal-lost' ||
      notice.code === 'transfer-delivered'
    ) {
      return;
    }
    const tone = notice.tone === 'warning' ? 'warning' : notice.tone;
    this.showToast({
      tone,
      title: titles[notice.code] ?? 'Rendezvous.',
      message: notice.message,
      duration: notice.tone === 'error' ? 11_000 : 8_000,
    });
  }

  private handleAppointment(event: AppointmentEvent): void {
    const record = event.rendezvous;
    const human = this.state?.humans.find((entry) => entry.id === record.peerId);
    const person = displayName(record.peerName || human?.name || '');
    if (event.phase === 'announced') {
      if (record.scheduledFor - Date.now() < 60_000) return;
      this.showToast({
        tone: 'info',
        title: 'A rendezvous, set.',
        message: `${person} chose ${formatMoment(record.scheduledFor)}. The photo stays with them.`,
      });
      return;
    }
    if (event.phase === 'open' || event.phase === 'due') {
      const directionNote =
        record.direction === 'incoming'
          ? human?.online
            ? `${person} is here. The photograph moves when the direct link is ready.`
            : `Waiting for ${person} to come online. The photograph is still with them.`
          : human?.online
            ? `${person} is here. Connecting directly now.`
            : `Waiting for ${person} to come online. The photograph is still with you.`;
      this.showToast({
        tone: event.phase === 'due' ? 'warning' : 'info',
        title:
          event.phase === 'due'
            ? `It’s time for ${person}.`
            : `The handoff with ${person} is open.`,
        message: directionNote,
        duration: event.phase === 'due' ? 10_000 : 8_000,
      });
      return;
    }
    if (event.phase === 'received') {
      const photoUrl = record.photo ? URL.createObjectURL(record.photo.blob) : undefined;
      this.showToast({
        tone: 'success',
        title: `A photograph from ${person}.`,
        message: `${record.photo ? formatBytes(record.photo.size) + ' · ' : ''}${formatMoment(record.deliveredAt ?? Date.now())}${record.photo?.note ? ` · voice note ${formatDuration(record.photo.note.durationMs)}` : ''}`,
        actionLabel: 'Open',
        action: () => {
          const print = this.state?.prints.find(
            (entry) => entry.appointmentId === record.id,
          );
          if (print) this.openPhotoViewer(print);
        },
        photoUrl,
        persistent: false,
        duration: 12_000,
        onClose: photoUrl ? () => URL.revokeObjectURL(photoUrl) : undefined,
      });
    }
  }

  private async recordCircleAttendance(rendezvousId: string): Promise<void> {
    const record = this.state?.rendezvous.find((entry) => entry.id === rendezvousId);
    const identity = this.circleIdentity;
    const store = this.circleStore;
    if (!record || !identity || !store) return;
    for (const circleId of await store.listCircles()) {
      try {
        const records = await store.load(circleId);
        const view = deriveMemberView(records, identity.selfKey, this.circleFriends, {}, {
          circleId,
        });
        if (!view.members.includes(identity.selfKey) || !view.members.includes(record.peerId)) {
          continue;
        }
        const plans = canonicalPlans(records, circleId, view.timezone, view.members)
          .flatMap((entry) => entry.plans)
          .filter((entry) => {
            const planRecord = entry.record;
            return (
              planRecord.type === 'Plan' &&
              Math.abs(planRecord.scheduledAt - record.scheduledFor) <= 5 * 60_000
            );
          })
          .sort((left, right) => {
            const a = left.record as PlanRecord;
            const b = right.record as PlanRecord;
            return a.scheduledAt - b.scheduledAt;
          });
        const plan = plans[0];
        if (!plan || plan.record.type !== 'Plan') continue;
        const planRecord = plan.record;
        const already = records.some(
          (entry) =>
            entry.record.type === 'Attendance' &&
            entry.record.attendee === identity.selfKey &&
            entry.record.rendezvousId === planRecord.rendezvousId,
        );
        if (already) continue;
        const promptId = activePrompts(Date.now(), view.timezone).day.id;
        const attendance = await createAttendanceRecord({
          identity,
          rendezvousId: planRecord.rendezvousId,
          scheduledAt: planRecord.scheduledAt,
          joinedAt: Date.now(),
          swappedWith: [record.peerId],
          promptId,
        });
        await store.append(circleId, [attendance]);
        void this.circleSync?.refresh();
        await this.reloadCircles();
        if (this.activeCircleId === circleId) await this.selectCircle(circleId);
      } catch (error) {
        console.warn('[circles] attendance was not recorded', error);
      }
    }
  }

  private handleTransfer(event: TransferEvent): void {
    if (event.phase === 'complete') {
      if (!this.celebrated.has(event.rendezvousId)) {
        this.celebrated.add(event.rendezvousId);
        this.celebrateDelivery();
      }
      void this.recordCircleAttendance(event.rendezvousId);
      const toastId = this.transferToastIds.get(event.rendezvousId);
      if (toastId) {
        const handle = this.toasts.get(toastId);
        if (handle) {
          const title = handle.element.querySelector<HTMLElement>('.toast-title');
          if (title) title.textContent = 'The photograph crossed.';
          const message = handle.element.querySelector<HTMLElement>('.toast-message');
          if (message) message.textContent = 'Stored locally on the receiving browser.';
          const bar = handle.element.querySelector<HTMLElement>('.toast-progress span');
          if (bar) bar.style.width = '100%';
          window.setTimeout(() => handle.close(), 900);
        }
        this.transferToastIds.delete(event.rendezvousId);
      }
      return;
    }
    if (event.phase === 'error') {
      const toastId = this.transferToastIds.get(event.rendezvousId);
      if (toastId) {
        this.toasts.get(toastId)?.close();
        this.transferToastIds.delete(event.rendezvousId);
      }
      return;
    }
    const record = this.state?.rendezvous.find((entry) => entry.id === event.rendezvousId);
    const human = this.state?.humans.find((entry) => entry.id === event.peerId);
    const person = displayName(record?.peerName || human?.name || '');
    const percent =
      event.total > 0 ? Math.min(100, Math.round((event.transferred / event.total) * 100)) : 0;
    let toastId = this.transferToastIds.get(event.rendezvousId);
    if (!toastId) {
      toastId = this.showToast({
        tone: 'info',
        title:
          event.phase === 'connecting'
            ? `Connecting with ${person}.`
            : event.direction === 'outgoing'
              ? `Sending to ${person}.`
              : `Receiving from ${person}.`,
        message:
          event.phase === 'connecting'
            ? 'Direct and encrypted. Both browsers are here.'
            : `${formatBytes(event.transferred)} of ${formatBytes(event.total)}`,
        progress: percent,
        persistent: true,
      });
      this.transferToastIds.set(event.rendezvousId, toastId);
    } else {
      const handle = this.toasts.get(toastId);
      if (handle) {
        const title = handle.element.querySelector<HTMLElement>('.toast-title');
        if (title)
          title.textContent =
            event.direction === 'outgoing' ? `Sending to ${person}.` : `Receiving from ${person}.`;
        const message = handle.element.querySelector<HTMLElement>('.toast-message');
        if (message)
          message.textContent = `${formatBytes(event.transferred)} of ${formatBytes(event.total)}`;
        const bar = handle.element.querySelector<HTMLElement>('.toast-progress span');
        if (bar) bar.style.width = `${percent}%`;
      }
    }
  }

  private celebrateDelivery(): void {
    if (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return;
    }
    const layer = document.createElement('div');
    layer.className = 'confetti-layer';
    layer.setAttribute('aria-hidden', 'true');
    const colors = ['var(--accent)', '#e0a458', '#7ea98a', '#f8f2e7', '#c9553d'];
    for (let index = 0; index < 44; index += 1) {
      const piece = document.createElement('span');
      piece.className = 'confetti-piece';
      piece.style.setProperty('--x', `${Math.random() * 100}%`);
      piece.style.setProperty('--delay', `${Math.random() * 180}ms`);
      piece.style.setProperty('--duration', `${1_600 + Math.random() * 900}ms`);
      piece.style.setProperty('--rotate', `${Math.random() * 360}deg`);
      piece.style.setProperty('--drift', `${(Math.random() - 0.5) * 240}px`);
      piece.style.setProperty('--size', `${6 + Math.random() * 8}px`);
      piece.style.setProperty('--color', colors[index % colors.length] ?? '#e0a458');
      layer.append(piece);
    }
    this.root.append(layer);
    window.setTimeout(() => layer.remove(), 3_000);
  }

  private showToast(content: ToastContent): string {
    this.toastSequence += 1;
    const id = `toast-${this.toastSequence}`;
    const element = document.createElement('div');
    element.className = 'toast';
    element.dataset.tone = content.tone;
    element.setAttribute('role', content.tone === 'error' ? 'alert' : 'status');

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';

    const title = document.createElement('p');
    title.className = 'toast-title';
    title.textContent = content.title;
    const message = document.createElement('p');
    message.className = 'toast-message';
    message.textContent = content.message;

    if (content.photoUrl) {
      const image = document.createElement('img');
      image.className = 'toast-thumb';
      image.src = content.photoUrl;
      image.alt = '';
      element.append(image);
    }

    element.append(close, title, message);

    if (content.progress !== undefined) {
      const progress = document.createElement('div');
      progress.className = 'toast-progress';
      const bar = document.createElement('span');
      bar.style.width = `${Math.max(0, Math.min(100, content.progress))}%`;
      progress.append(bar);
      element.append(progress);
    }

    if (content.actionLabel && content.action) {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'toast-action';
      action.textContent = content.actionLabel;
      action.addEventListener('click', () => {
        content.action?.();
        this.closeToast(id);
      });
      element.append(action);
    }

    const handle: ToastHandle = {
      element,
      timer: null,
      close: () => this.closeToast(id),
      cleanup: () => content.onClose?.(),
      cleaned: false,
    };
    if (!content.persistent) {
      handle.timer = window.setTimeout(
        () => this.closeToast(id),
        content.duration ?? 8_000,
      );
    }
    close.addEventListener('click', () => this.closeToast(id));

    this.toasts.set(id, handle);
    this.$('#toast-region').append(element);
    while (this.toasts.size > 3) {
      const oldest = this.toasts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.toasts.get(oldest)?.close();
    }
    return id;
  }

  private closeToast(id: string): void {
    const handle = this.toasts.get(id);
    if (!handle) return;
    if (handle.timer !== null) window.clearTimeout(handle.timer);
    handle.element.remove();
    if (!handle.cleaned) {
      handle.cleaned = true;
      handle.cleanup();
    }
    this.toasts.delete(id);
    for (const [rendezvousId, toastId] of this.transferToastIds) {
      if (toastId === id) this.transferToastIds.delete(rendezvousId);
    }
  }

  private revokeObjectUrls(): void {
    for (const url of this.objectUrls.values()) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    if (this.photoUrl) URL.revokeObjectURL(this.photoUrl);
    this.photoUrl = null;
  }
}

export function defineRendezvousApp(tagName = 'rendezvous-app'): void {
  if (typeof customElements === 'undefined') return;
  if (!customElements.get(tagName)) {
    customElements.define(tagName, RendezvousApp);
  }
}
