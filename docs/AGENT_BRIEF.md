# RDZ — Autonomous Implementation Brief

This file is the compact handoff from the specification conversation. It is context for implementation, not a replacement for the canonical spec.

- **Canonical product spec:** `docs/SPEC.md`. If this brief and the spec conflict, the spec wins, and the spec should be corrected.
- **Deferred features:** `docs/FUTURE_SPEC.md`.
- **Old product spec:** `docs/SPEC_v0.md`, reference only.
- **Decisions made where the spec is silent:** `docs/IMPLEMENTATION_DECISIONS.md`. Append every new implementation decision there.

## Implementation status (27 Nov 2026)

- The new RDZ app, WebRTC mesh, headless WebRTC seed, multi-mask UI/store, protocol, and automated tests are implemented.
- `npm test` and `npm run test:e2e` pass.
- `PING`, `GOING`, and `SIGNAL` travel only over WebRTC data channels. WebSocket is bootstrap-only.
- Peer-assisted signalling, direct peer links, replay, dedup, the shared 100-connection budget, and 20% peer rotation are implemented.
- Multiple masks are implemented with one active identity, per-mask verification, and a mask switcher.
- `README.md` describes the new app.
- Remaining deviations: no TURN, no universal reachability, seedless first contact is out of scope, and the peer registry only helps when a signalling path exists.

## Mission

Build RDZ as a permissionless, peer-to-peer application:

> A peer-to-peer application for anyone to experience the internet the way it was intended to. No accounts, no servers, pure freedom. The system is permissionless.

The 24/7 peer is optional infrastructure and must behave as an ordinary peer. No account, invite, allowlist, or approval is required to appear online, announce `GOING`, or participate.

## Current repository state

- `docs/SPEC.md` is the new canonical spec and has no open questions.
- `docs/FUTURE_SPEC.md` records deferred features and the archive policy.
- `docs/SPEC_v0.md` is the previous spec, reference only.
- The new RDZ implementation is in `src/rdz/`, `src/ui/`, `src/main.ts`, and `server/index.ts`.
- The old implementation is archived under `archive/legacy/`.
- `README.md` describes the new app.
- `docs/SPEC.md` includes the multi-mask identity story and FR-19, and the implementation now follows it.
- `PING`/`GOING`/`SIGNAL` move only over WebRTC data channels. The seed is a headless WebRTC peer; WebSocket is bootstrap-only. Seedless first contact is explicitly out of scope.

## Non-negotiable product behavior

### Landing page and channels

- Landing page shows the full list of humans currently online and the rendezvous channels. The large hero heading is **The Internet is Here**.
- The landing hero keeps the subtle elliptical orbit animation from the previous RDZ look: one slow dot, decorative only, absent from channel screens, and disabled for reduced motion.
- The masthead reads `rendezvous ✳ by [InstantHero mark]`. The three intersecting lines are the RDZ mark and also appear in the top-bar brand button.
- The landing search field has a magnifying-glass icon.
- Rendezvous cards show a full distinguishing emoji prefix: minimum 3, maximum 11, computed against every known rendezvous before filtering and never clipped.
- The active mask appears in the landing online list and is marked as me.
- The active mask is never listed inside a rendezvous channel, even when it announced a `GOING` there.
- No `send photo` or `open voice` on the landing page, including on your own row.
- You cannot send a photo or open voice with yourself.
- Actions exist only inside a specific rendezvous channel screen.
- A channel screen lists humans grouped by announced `HH:mm`, ascending, with subtle separators.
- My own announcement is confirmed in a dedicated "your rendezvous" line above the groups. It is not listed as another participant.
- A human may appear multiple times if they announced multiple times.
- Each row shows online/offline state. Online rows offer `send photo` and `open voice`.
- Verified humans sort before unverified humans.
- Human rows show at least 6 distinguishing emoji, extended up to 11 and allowed to wrap; never a single ellipsized emoji.
- `T + 3` removes only that `GOING` announcement from the channel board. The human remains in the global online list and any other channel.
- There is no `T + 5` end. The channel screen closes only when the user explicitly leaves it.

### Identity and IDs

- Persistent P-256 keypair in IndexedDB; private key as a non-extractable `CryptoKey`.
- Identity is origin/profile scoped. Clearing site data creates a new identity. No recovery, no multi-device sync.
- Human ID = first 88 bits of `SHA-256(public key)`.
- Rendezvous ID = 88 random bits from a cryptographically secure generator.
- 88 bits render as 8 words from a fixed 2048-word list and 11 emoji from a fixed 256-emoji set.
- Both renderings encode the same canonical value.
- Display the shortest unambiguous prefix. On collision, extend the display. Canonical identity never changes.
- A short display is never used for verification. Verification uses the full 8 words / 11 emoji.
- Verification is per-human. There is no pairwise code. Compare the human's full 8-word sequence out of band and mark them verified locally.
- Verified state persists.

### Global presence

- `PING [human id] [created-at] [signature]`.
- Sent every 3 minutes by default, best effort. Send promptly when the page becomes visible.
- A valid `PING` marks the human online for 5 minutes from receipt.
- Presence expires locally after 5 minutes without a fresh `PING`.
- Bounded time rule: a message may be up to one minute ahead of the receiver's clock. Farther-future messages are invalid. This tolerates ordinary network and phone/desktop clock skew.
- `PING` uses flood-once relay.
- Local auto-ban for invalid `PING` creators is deferred. The current build rejects the message.

### Rendezvous announcements

- `GOING [rendezvous id] [scheduled time] [created-at] [signature]`.
- Setting a rendezvous sends `GOING`; a guest may send `GOING` to announce attendance.
- Anyone may send `GOING` for any rendezvous ID.
- The same ID may have multiple scheduled times from different humans, or from the same human.
- Scheduled time is coordination only. It does not gate images, audio, or connections.
- `GOING` uses flood-once relay.
- A `GOING` remains valid until its scheduled time plus 3 minutes.
- Clients display every valid claim. There is no canonical time election.
- Deduplicate display of the same human + rendezvous + minute.

### Relaying and replay

- Every peer caches every valid, unexpired `PING` and `GOING` it has seen.
- Each unique message is forwarded at most once by each peer to known peers, excluding the sender.
- Deduplication is by hash of canonical signed bytes.
- On a new authenticated peer connection, replay all valid held messages, then continue live relay.
- Expired messages are purged.
- Images and audio are never cached or replayed by the relay layer.

### Peer graph and transport

- **FR-0 is the primary invariant:** `PING`, `GOING`, and `SIGNAL` travel only over WebRTC data channels. Never over WebSocket or HTTP.
- WebSocket/HTTPS is bootstrap-only: discovery and the first SDP/ICE exchange. Bootstrap messages are not application messages. The default seed is same-origin `/signal`, so LAN and tunnel clients share one seed.
- Peer-assisted signalling: connected peers relay `SIGNAL` and peer introductions over WebRTC for other peers.
- STUN: Google free STUN servers by default, or self-hosted.
- TURN is optional; do not promise universal reachability.
- A browser maintains at most 100 simultaneous WebRTC peer connections; known humans are not limited.
- Verified peers are prioritized for retention but count toward the 100 live connections.
- Every 5 minutes, replace 20% of non-priority connections with random new peers when available.
- Jitter refresh timers. Never drop a connection during an active image or audio session.
- Random candidates come from the browser's internal peer registry, built from peers learned from other peers.
- Persist the peer registry in IndexedDB.
- The seed may be disconnected after the first mesh connection.

### Seed peer

- Default seed: `randezvous.instanthero.ca`.
- The seed is optional. Everything must work with zero configured seeds if at least one known peer exists.
- The seed is a long-running, in-memory-only headless WebRTC peer.
- It is not human: no human ID, no human `PING`, never in the human list.
- It may receive, cache, replay, and forward `PING`, `GOING`, and `SIGNAL` only over WebRTC data channels.
- It never accepts, stores, or relays images or audio.
- It has no durable state.
- It follows the same signature, dedup, expiry, and relay rules.
- The first connection to the seed may use one HTTPS/WebSocket SDP/ICE exchange, then WebRTC. Bootstrap messages are not application messages.
- When connected over WebRTC, the seed counts as one live peer connection.

### Connection authorization and SIGNAL

- `SIGNAL` carries WebRTC offer, answer, and ICE candidates.
- `SIGNAL` is target-addressed, signed by its creator, short-lived, carried flood-once, and never re-signed.
- `SIGNAL` is connection mechanics, not a user-visible message type.
- A client accepts a channel `SIGNAL` only from a human it has verified locally.
- The `SIGNAL` must name a channel the recipient is currently viewing or has an active `GOING` announcement in.
- A connection completes only when both humans have verified each other locally.
- Unverified `SIGNAL` requests are ignored.
- The seed bootstrap connection is exempt.
- Unverified peers may still relay messages; that does not grant them channel access.

### Images

- Images are chosen only during an active channel screen. Nothing is attached when setting a rendezvous.
- Each send targets one recipient and one image.
- The sender chooses an image or reuses the last image sent.
- A sender may have only one outgoing image transfer in flight at a time.
- The next send unlocks only after the previous image is acknowledged as received, declined, or failed.
- The receiver must explicitly accept before any bytes transfer.
- The offer shows the sender and file size in MB only. No preview. Accepting is at the user's own risk.
- Only image MIME types. Default maximum 25 MiB.
- Multiple incoming offers may be pending at once. List all of them, verified senders first. Each is accepted or declined independently.
- Accepted images display in the channel screen. They can be saved/downloaded while displayed. Dismissing removes the in-app copy.
- No wall, gallery, or persistent in-app collection.
- Transfer over the authenticated WebRTC connection. Acknowledge per direction.
- A failure for one recipient does not block another.

### Audio

- Pairwise only. A request is made to one human at a time.
- Only between humans who have verified each other locally.
- Receiver must accept and grant microphone permission.
- Each conversation lasts one minute.
- Unlimited reconnections.
- Gentle pink progress bar, no numbers.
- Mute and end controls. Either side can end early.
- Live only. Never record, transcribe, buffer, or upload.
- Ends at the one-minute cap or on disconnect.
- No audio bytes pass through relays.

### Circles

- A circle is only a pinned rendezvous ID with an optional local label.
- The label is local and never shared.
- No separate membership, sync, event type, stats, or authority.

### Verification

- Per-human 8-word sequence, derived from the public key.
- Compare out of band. Mark verified locally.
- No pairwise comparison code.
- Verified humans sort first in online and time-grouped lists.
- Offline verified humans remain visible with offline state.

### Scope and archive

- Archive the old photo wall, voice notes, possession inventory, circle stats, leaderboard, prompts, plans, and reusable-package surface.
- Move their source and tests to `archive/`. Remove them from `src/`, the build, and the active test suite.
- Do not delete them. `archive/` is reference only.
- Keep reusable visual assets, fonts, and design language. Reuse the current visual style.
- Update `README.md` so it describes only the new RDZ app.

## Best-guess implementation decisions

These are decisions the spec does not fully answer. Implement them, keep them in `docs/IMPLEMENTATION_DECISIONS.md`, and revise only if they break the spec or tests.

1. **Public-key distribution:** every signed envelope includes the author's public key. The human ID is derived from it. Receivers verify the signature, derive the ID, and cache the key. This avoids a separate key-discovery protocol.
2. **Word list:** reuse the BIP-39 English 2048-word list already present in the repository. Remove any old pairwise-code usage.
3. **Emoji list:** a fixed, versioned list of 256 common Unicode emoji with stable codepoints. Avoid skin tones, flags, and ZWJ sequences for rendering consistency.
4. **Short display:** start at 4 words or 6 emoji; extend one symbol at a time until unique in the current view.
5. **Search:** case-insensitive substring match over the word sequence; exact substring match over emoji; both human and rendezvous search use the same rule.
6. **Time:** store Unix milliseconds UTC. Normalize seconds to `00`. Display `HH:mm` in the viewer's local timezone. Show a day marker only when not today.
7. **GOING display grouping:** group by channel + local `HH:mm`; dedupe identical human + channel + minute. Keep the newest signed claim if duplicates conflict.
8. **Incoming offer order:** verified senders first, then unverified, then by receipt time ascending.
9. **Image limits:** one image per offer; 25 MiB maximum; reject non-image MIME types and oversized files before offering.
10. **Audio UI:** progress bar only, gentle pink, no numeric countdown. End button and mute button always visible.
11. **Dedup cache TTL:** `PING` 10 minutes; `GOING` until scheduled + 3 minutes + 5-minute margin; `SIGNAL` 2 minutes.
12. **Seed implementation:** implemented with the maintained `werift` Node WebRTC library. The WebSocket carries only the bootstrap SDP/ICE exchange and a signed data-channel identity challenge.
13. **Peer registry persistence:** IndexedDB, pruned when peers have been unreachable for 24 hours.
14. **Connection retries:** exponential backoff with jitter; do not retry an unverified channel `SIGNAL`.
15. **Tests:** Vitest for unit/integration, Playwright for E2E. Use fake timers for presence, `T + 3`, and relay expiry. Use multiple browser contexts for WebRTC.
16. **Archive path:** `archive/` at the repository root, with a short README explaining that it is not built or tested.

## Execution plan

Work in this order and keep the build green as often as practical:

1. **Archive**
   - Move old deferred-feature code and tests to `archive/`.
   - Remove archived code from `src/`, `package.json` exports, `vite.lib.config.ts`, `tsconfig.lib.json`, and the active test graph.
   - Keep the visual assets, fonts, and current design language.
   - Update imports so the app still builds after each move.

2. **Core protocol and identity**
   - P-256 identity, IndexedDB store, human ID derivation.
   - 88-bit IDs, word/emoji encoding, display disambiguation.
   - Signed envelope format, canonical encoding, dedup hash.
   - `PING`, `GOING`, `SIGNAL` types and validation.
   - Floors: bounded clock-skew `created-at`, expiry, signature verification.

3. **Relay, presence, and rendezvous state**
   - Flood-once relay, replay on new peer, dedup cache, purge.
   - Online list, verified-first ordering.
   - Channel aggregation by `HH:mm`, `T + 3` announcement expiry.
   - Search/filter.

4. **Seed peer**
   - In-memory peer with no human identity and no media.
   - Relay and replay `PING`, `GOING`, `SIGNAL`.
   - HTTPS bootstrap SDP/ICE exchange, then WebRTC.
   - Optional seed configuration and default seed address.
   - Tests proving the network works with the seed removed.

5. **Peer graph**
   - WebRTC data channels, offer/answer/ICE routing.
   - 100 unverified connection cap, verified exceptions.
   - 20% refresh every 5 minutes with jitter and transfer-safe deferral.
   - Peer registry and random candidate selection.
   - Google STUN; no TURN requirement; honest unreachability.

6. **Verification and authorization**
   - Per-human 8-word verification, local persistence.
   - Verified-first sorting.
   - Channel `SIGNAL` authorization: verified creator, recipient in channel or with active `GOING`, mutual verification.
   - Ignore unverified requests; seed exempt.

7. **UI**
   - Reuse current visual language.
   - Landing: online humans + channels; no actions.
   - Channel: time-grouped humans, presence, `send photo`, `open voice`, incoming offer list, audio bar, verification.
   - Image flow: file pick, reuse last, one outgoing at a time, receiver consent, size-only offer, display, save, dismiss deletes.
   - Audio flow: request, consent, one-minute pink bar, mute/end, unlimited restarts.
   - Circles: pinned IDs and local labels.
   - No wall, gallery, or persistent image surface.

8. **Tests**
   - Unit: crypto, IDs, encoding, display collisions, signatures, message validation, expiry, dedup, relay, aggregation, search, authorization.
   - Integration: multi-peer relay, seed replay, presence expiry, `GOING` expiry, verification gate, image consent/ACK, audio request/consent.
   - E2E: landing, set channel, join, verify, send image, accept/decline, save/dismiss, audio accept/decline, seed-offline operation, `T + 3` announcement removal, channel screen persistence.
   - Archive old tests instead of leaving them failing.

9. **Docs and deployment**
   - Update `README.md` to the new product.
   - Update `package.json`, scripts, metadata, and deployment notes.
   - Document the default seed and how to run with no seed.
   - Keep `docs/SPEC.md` canonical; update it when a decision changes behavior.

## Definition of done

- `npm run build` passes.
- `npm test` passes.
- `npm run test:e2e` passes, with the required browser installed.
- The app runs against the default seed and with the seed disabled.
- All current spec scenarios have automated coverage.
- No archived feature is part of the build or active tests.
- `docs/IMPLEMENTATION_DECISIONS.md` reflects every decision made where the spec was silent.
- `README.md` no longer promises old or deferred behavior.

## Autonomy rules

- Do not stop to ask the user for decisions the spec or this brief can answer. Make the best guess and log it.
- Never delete old code or tests. Archive them.
- Keep the canonical spec authoritative. If implementation requires a behavior change, update the spec and log the reason.
- Prefer small, verifiable steps. Run the relevant tests after each phase.
- Use `/tmp/opencode` for temporary files.
- Do not rewrite git history or force-push.
- Continue through failures and fix them until the definition of done is met.
