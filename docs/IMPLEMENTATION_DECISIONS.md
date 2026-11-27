# Implementation Decisions

Decisions made where `docs/SPEC.md` is silent or incomplete. Append new entries; do not rewrite history without a reason.

## 2026-11-26 — Initial handoff

1. **Public-key distribution.** Every signed message envelope carries the author's public key. The human ID is derived from that key. Receivers verify the signature, derive the ID, and cache the key. This avoids a separate key-discovery protocol.
2. **Word list.** Use the BIP-39 English 2048-word list already in the repository.
3. **Emoji alphabet.** Use a fixed, versioned set of 256 common Unicode emoji. Exclude skin tones, flags, and ZWJ sequences for rendering consistency.
4. **Short identifier display.** Start at 4 words or 6 emoji. Extend one symbol at a time until unique in the current view.
5. **Search matching.** Case-insensitive substring match over the word sequence; exact substring match over emoji. Human and rendezvous search use the same rule.
6. **Time storage.** Unix milliseconds UTC. Normalize seconds to `00`. Display `HH:mm` in the viewer's local timezone. Show a day marker only when the rendezvous is not today.
7. **GOING display deduplication.** Group by channel and local `HH:mm`; deduplicate by human + channel + minute. Keep the newest signed claim if duplicates conflict.
8. **Incoming offer order.** Verified senders first, then unverified senders, then receipt time ascending.
9. **Image limits.** One image per offer. Maximum 25 MiB. Reject non-image MIME types and oversized files before offering.
10. **Audio UI.** Gentle pink progress bar with no numeric countdown. Mute and end controls always visible.
11. **Dedup cache TTL.** `PING`: 10 minutes. `GOING`: until scheduled time + 3 minutes + 5-minute margin. `SIGNAL`: 2 minutes.
12. **Seed implementation.** Prefer a maintained Node WebRTC library. If unreliable, run the seed as a headless browser peer. Keep the HTTPS bootstrap handshake minimal.
13. **Peer registry persistence.** IndexedDB; prune peers unreachable for 24 hours.
14. **Retry policy.** Exponential backoff with jitter. Never retry an unverified channel `SIGNAL`.
15. **Tests.** Vitest for unit/integration; Playwright for E2E. Use fake timers for presence and expiry. Use multiple browser contexts for WebRTC.
16. **Archive path.** `archive/` at the repository root, with a README stating that it is not built or tested.
17. **Strict future timestamps.** All messages with `created-at` later than the receiver's clock are rejected. No clock-skew allowance.
18. **Connection authorization.** A channel `SIGNAL` is accepted only from a locally verified human, only when the recipient is viewing that channel or has an active `GOING` announcement in it. Both sides must have verified each other for a connection to complete. The seed bootstrap is exempt.
19. **Media persistence.** A received image is saveable only while displayed. Dismissing removes the in-app copy. Saved downloads remain outside the app.
20. **Channel lifetime.** No automatic close. The channel screen remains until the user explicitly leaves.

## 2026-11-27 — Reference transport and implementation status

21. **Metadata/signalling transport.** The reference build uses a signed WebSocket relay for `PING`, `GOING`, and `SIGNAL`. Images and audio are direct WebRTC. A browser WebRTC mesh needs an out-of-band signalling substrate; the seed relay is that substrate. This is a deliberate reference-implementation compromise, not the final pure-peer topology in the spec.
22. **Peer connection cap.** A per-browser hard cap of 100 live WebRTC connections is implemented in `src/rdz/connection-budget.ts` and enforced by `RtcManager`. It does not limit the registry of known humans. The 20% refresh loop and WebRTC relay mesh are still not implemented because the reference transport has no mesh to rotate.
23. **Seed optionality.** `?seed=off` starts the app without a seed and uses cached state. Seedless first contact is explicitly out of scope per the 27 Nov 2026 decision.
24. **Seed bootstrap.** The first seed connection is a WebSocket upgrade, not a WebRTC offer/answer exchange. The seed is in-memory, has no human identity, and relays only signed metadata.
25. **Server-side signature verification.** The seed verifies every envelope before caching or routing it. This is stricter than the spec's untrusted-relay model; it protects the relay from malformed traffic and does not give it authority to create or alter messages.
26. **Archive.** Old circles, wall, voice notes, possession, package build, and their tests are under `archive/legacy/`. They are not built or tested.
27. **Public-key distribution.** Every envelope includes the author's public key. The seed and clients derive the human ID from it before accepting the message.
28. **No media persistence.** Incoming images live only in the browser while displayed. Dismissing revokes the object URL and removes the in-app copy. No wall or gallery exists.
29. **Test strategy.** Vitest covers IDs, signatures, expiry, relay-state aggregation, search, and timing. Playwright covers presence, channels, verification gates, image consent/save/dismiss/reuse/decline, audio consent/end, pinning, persistence, multiple simultaneous offers, `T + 3` expiry, and seed-off operation.

30. **Why a signed WebSocket relay.** WebRTC cannot begin without an out-of-band signalling exchange. A browser cannot accept an inbound socket, so a reachable bootstrap peer is required. WebSocket is used because it is reliable through proxies, available in browsers and Node, and needs no native WebRTC stack on the seed. Every relayed message is signed by its creator and verified by clients; the relay cannot forge or alter content.
31. **Why the first seed connection is not literally WebRTC.** WebRTC needs offer/answer/ICE before a peer connection exists. A seed can be a WebRTC data peer, but the browser still needs an HTTP/WebSocket signalling exchange to deliver the first offer and answer. The current reference build uses WebSocket for that exchange and for relayed messages. A WebRTC seed data channel is possible later with a Node WebRTC stack.

## 2026-11-27 — Multi-mask identity (spec requirement, implementation pending)

32. **Multiple masks, one active.** `docs/SPEC.md` now requires multiple masks per browser. Each mask owns its keypair, human ID, verification words, verified-human records, and pinned peer keys. Exactly one mask is active and online. Switching masks stops PING, closes the relay identity, tears down active image/audio sessions, reconnects as the new mask, and sends a fresh PING.
33. **Mask-local versus browser-level state.** Verification and pinned peers are mask-local. Pinned channels and local channel labels are browser-level preferences shared across masks. Existing `GOING` announcements are not retracted when the active mask changes.
34. **Migration.** Existing single-mask identity data migrates into the first mask. Removing a mask deletes its private key and verification state; signed messages already published remain valid.
35. **Implementation status.** The multi-mask story and functional requirements are in the spec, but the UI/store implementation is not yet updated for multiple masks.

## 2026-11-27 — FR-0 made primary

36. **WebRTC-exclusive application messages are now the primary transport invariant.** `PING`, `GOING`, and `SIGNAL` must travel only over WebRTC data channels. WebSocket/HTTPS is bootstrap-only: discovery and the first SDP/ICE exchange. The seed is a headless WebRTC peer: it may receive, cache, replay, and forward application messages only over WebRTC data channels, and it never accepts media.
37. **Peer-assisted signalling is mandatory.** Connected peers relay `SIGNAL` and peer introductions over WebRTC data channels. New peers use existing peers as introducers wherever possible.
38. **Current build non-compliance.** The committed reference build still relays `PING`, `GOING`, and `SIGNAL` over the seed WebSocket. This must be refactored before the transport can be called complete. The 100 live connection cap and direct WebRTC media path remain useful pieces of that refactor.

39. **Seed peer correction (27 Nov 2026).** The seed is a real headless WebRTC peer, not bootstrap-only. It may replay unexpired `PING`/`GOING` and forward `SIGNAL` over WebRTC data channels. It has no human identity and cannot receive images or audio. It still must never carry application messages over WebSocket or HTTP.
