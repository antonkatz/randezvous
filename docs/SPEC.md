# Objective

A peer-to-peer application for anyone to experience the internet the way it was intended to. No accounts, no servers, pure freedom.

The system is permissionless: no invitation, allowlist, approval, or account is required to participate.

---

# Requirements

Deferred features are recorded separately in `docs/FUTURE_SPEC.md`.

## User Stories

### US-1 — I see the public board

As anyone arriving at RDZ, I want to see every rendezvous that has been set, so that I can find a meeting to join.

**Acceptance criteria**

- The landing page lists every unexpired rendezvous channel and the full list of humans currently online.
- Every rendezvous is public. There is no private or unlisted option.
- Each rendezvous entry shows the rendezvous's emoji ID, its scheduled time as `HH:mm`, and its participants.
- A rendezvous announcement disappears from its channel board at its scheduled time plus 3 minutes.
- The human remains in the landing page's online list independently of that announcement.
- No account, invitation, or approval is required.

### US-2 — I can filter the board

As anyone looking at the board, I want to type words to narrow the list, so that I can find a rendezvous quickly.

**Acceptance criteria**

- Typing in the filter narrows the visible rendezvous as I type.
- Clearing the filter restores the full board.
- The filter matches both the emoji and word representations of a rendezvous identifier.

### US-3 — I can set a rendezvous without an account

As anyone, I want to set a rendezvous without creating an account, so that I can meet people immediately.

**Acceptance criteria**

- I choose a time to the minute. Seconds are normalized to `00`.
- The rendezvous receives an emoji ID.
- Setting a rendezvous does not ask for or attach an image.
- Setting a rendezvous sends a signed `GOING` message.
- The rendezvous appears on my board immediately and propagates to other peers.
- The channel screen confirms the time I announced in a dedicated "your rendezvous" line. I am not listed as another participant.
- No account, registration, or approval is involved.

### US-4 — I see every human who is online

As anyone on the board, I want to see every human currently online, so that I know who is reachable.

**Acceptance criteria**

- The online list is derived from unexpired `PING` messages.
- The list includes the active mask, marked as me. It is not treated as another human.
- There is no cap or allowlist on the number of online humans.
- Presence is best effort and limited to the connected peer graph.
- Verified humans are shown before unverified humans.
- Verified humans remain visible when they are offline, marked as offline.
- The landing page list is informational. `send photo` and `open voice` are not available there.
- Those actions are available only inside a specific rendezvous channel screen.
- An unverified human cannot open a channel connection to me. Unverified humans remain visible for discovery and verification.
- No account is required.

### US-5 — I can find and verify a human

As anyone, I want to search humans who are online, select one, verify their identity, and save them as verified, so that I can recognize them later.

**Acceptance criteria**

- I can search the online humans by word or emoji.
- Selecting a human opens an optional verification step.
- After verifying, I can save that human as verified locally.
- Verified state persists in this browser with my identity.
- Verification is optional and does not gate presence, rendezvous, or media.
- The verification mechanism is listed under Open Questions.

### US-6 — I can verify a participant in a rendezvous

As a rendezvous participant, I want to check whether another participant is who I expect, so that I can decide whether to trust them.

**Acceptance criteria**

- Inside a rendezvous, I can open an optional verification check for any participant.
- The result is shown as verified or not verified.
- Verification is local to my browser and persists for that human.
- Verification is never required to join, attend, or exchange media.

### US-7 — I choose who receives my photograph

As a participant handing off a photograph, I want to choose exactly which humans in the rendezvous receive it, so that I stay in control of who gets a copy.

**Acceptance criteria**

- During a photo handoff, the participants are listed individually.
- By default, I must press send for each human explicitly.
- No participant receives the photo without my explicit action for that human.
- Each handoff direction completes and is acknowledged independently.
- A failure with one recipient does not block another recipient.

### US-8 — I can keep my verified humans

As anyone, I want to see the humans I have verified even when they are offline, so that my trusted people do not disappear when they disconnect.

**Acceptance criteria**

- Verified humans are stored locally with my persistent identity.
- A verified human who is offline remains visible with an offline state.
- A verified human returns to the online list when a fresh `PING` arrives.
- No account or central contact list is involved.

### US-9 — I can save a received photo before dismissing it

As a photo recipient, I want to save the photo while it is displayed, so that I keep a copy outside the app.

**Acceptance criteria**

- A received photo can be saved through the browser's download mechanism while it is displayed.
- Dismissing the photo removes the in-app copy.
- The app provides no photo wall or persistent gallery.
- Saving uses a locally generated filename and extension. The sender's filename is never transmitted, displayed, or used.
- A saved file remains on the device, subject to the operating system and browser download rules.

### US-10 — I can offer an image to another participant

As a participant, I want to choose an image and offer it to a specific human, so that only people who agree receive it.

**Acceptance criteria**

- The send action is available only for a human I have verified.
- During an active rendezvous, the participants are listed individually with a send action.
- Pressing send for one human lets me choose an image from my device or reuse the last image I sent.
- Each press sends one image to that human only.
- My local filename is never transmitted. The offer contains only a numeric size in megabytes.
- No image bytes are sent before that human accepts.
- I can have only one outgoing image transfer in progress at a time.
- The next send becomes available only after the current recipient accepts and the image is received, or the offer is declined or fails.
- If an image offer is declined, times out, or fails, I am told what happened instead of the transfer disappearing silently.
- I may send again to the same human or to a different human; each send has its own image choice and its own consent.
- Each transfer completes and is acknowledged independently.
- An accepted image is displayed in the browser.

### US-11 — I must agree before receiving an image

As a recipient, I want to accept or decline an incoming image before any bytes arrive, so that I control what enters my browser.

**Acceptance criteria**

- An incoming offer shows the sender and a numeric size in megabytes before any image bytes are sent.
- The offer carries no filename, path, MIME type, preview, or other sender-supplied metadata.
- No preview is shown. Accepting is at the user's own risk.
- Multiple incoming offers can be pending at once. All are listed.
- Offers from verified humans are listed before offers from unverified humans.
- Each offer can be accepted or declined independently.
- Accepting starts the transfer. Declining sends no image bytes.
- An accepted image is displayed in the live rendezvous surface.
- I can save it while it is displayed.
- Dismissing the image removes the in-app copy.

### US-12 — I can request a one-minute audio channel

As a participant, I want to request a live audio channel with another participant, so that we can speak briefly during the rendezvous.

**Acceptance criteria**

- An initiator can request an audio channel from one other participant. Audio is pairwise only.
- The request is available only for a human I have verified.
- The receiver must explicitly accept and grant microphone permission before any audio flows.
- Each conversation lasts one minute.
- The pair may start another conversation afterwards, with no limit on reconnections.
- A gentle pink progress bar shows the remaining time. It has no numbers.
- Either participant can mute or end the conversation early.
- Audio is live only. It is never recorded, transcribed, or uploaded.
- If the recipient declines, no audio starts and the rest of the rendezvous continues normally.
- The recipient signals that they chose accept before their microphone permission prompt opens, so the initiator knows the request was seen.
- If the request is declined, cancelled, times out, or microphone permission fails, I am told what happened instead of the voice panel disappearing silently.
- If either device's clock is too far ahead for its signals to be accepted, the request times out with a visible message instead of staying in requesting indefinitely.
- Audio ends at the one-minute cap or on disconnect.

### US-13 — I can keep multiple masks and activate one at a time

As a person with more than one online identity, I want my browser to hold several masks and choose which one is active, so that I can move between identities without creating accounts or exposing all of them at once.

**Acceptance criteria**

- A browser can store multiple masks. Each mask is a distinct human identity with its own P-256 keypair, public key, emoji and word human ID, verification word set, and verification records.
- Exactly one mask is active at any time.
- The active mask is the only identity that sends `PING`, signs new `GOING` and `SIGNAL` messages, appears online, and can send or receive images and audio.
- Inactive masks are offline. They do not send `PING`, receive `SIGNAL`, hold live peer connections, or appear as the sender of new messages.
- The identity surface lists every stored mask, marks the active one, and allows creating, switching, and removing a mask.
- Switching masks ends any active image transfer or audio conversation, closes the active relay identity, reconnects as the new mask, and sends a fresh `PING`.
- Verification words and verified-human state shown in the interface belong to the active mask. Verification records for inactive masks persist locally.
- Existing single-mask data is migrated into the first mask.
- Removing a mask deletes its private key and local verification state. Messages already signed by that mask remain valid and unchanged. There is no recovery.
- Clearing site data removes all masks. The next visit creates a new default mask.
- Pinned channels and local channel labels are browser-level UI preferences. They remain visible across masks and are not part of a mask's identity.
- Switching masks never rewrites, retracts, or reassigns a `GOING` announcement already signed by another mask. Existing announcements remain valid until `T + 3`.

### US-14 — I can see myself online

As an active mask, I want to see myself in the list of humans currently online, so that I can confirm which identity this browser is presenting.

**Acceptance criteria**

- The landing page's online-human list includes the active mask.
- The active mask is marked as me, so it is not mistaken for another human.
- The active mask is shown as online while it is active, including when no other peer is reachable.
- Opening my own entry opens the mask switcher.
- The active mask is not listed in any rendezvous channel's participant list, even when it has a `GOING` announcement there.
- I cannot send a photo or open voice with myself.
- After switching masks, the new active mask appears in the landing list and the previous local mask is no longer shown as online.
- Filtering hides my entry when it does not match, like any other human row.

### US-15 — I can tell every rendezvous apart at a glance

As someone scanning the landing page, I want each rendezvous emoji string to be long enough to be unique, so that I can distinguish all known rendezvous without opening them.

**Acceptance criteria**

- Each rendezvous card on the landing page shows an emoji prefix of at least 3 emoji.
- The prefix extends one emoji at a time until it differs from every other known rendezvous.
- The comparison set is every known rendezvous on the landing page, including pinned rendezvous with no live announcement and rendezvous hidden by the current filter.
- Filtering the landing page never shortens or lengthens a displayed prefix.
- The prefix never exceeds the full 11-emoji canonical rendezvous ID. An 88-bit ID has exactly 11 emoji of 8 bits each, so 11 emoji always distinguish two different IDs.
- The rendered prefix is never visually truncated with an ellipsis or clipped by the layout.
- Extending the displayed prefix does not change the canonical rendezvous ID.

### US-16 — I am told when something fails

As anyone using RDZ, I want a visible explanation whenever an action or a live session fails or is dropped, so that I am never left guessing what happened.

**Acceptance criteria**

- Every user-initiated action that fails produces a visible, plain-language message.
- Every pending offer, request, transfer, or live session that is removed because it failed, was declined, timed out, was cancelled, or was ended by the other person is accompanied by a message at the moment it disappears.
- A failure never looks like success or like a silent disappearance.
- Microphone permission denial, a missing or busy microphone, blocked audio playback, connection timeout, declined or cancelled requests, failed transfers, a full connection budget, and storage failures that prevent a user action are all reported.
- The message says what happened and, where possible, what the user can do next.
- A failed action leaves the user able to retry without reloading the page.
- Invalid, duplicate, malformed, or unauthorized inbound network traffic is ignored without a user-facing message. It is not a user action and must not produce error spam.
- A notice never blocks the page and never interrupts an ongoing live session.

## Functional Requirements

### FR-0 — WebRTC-exclusive application messages and peer-assisted signalling

This is the primary transport invariant, ahead of every other functional requirement.

- `PING`, `GOING`, and `SIGNAL` are application messages. They MUST travel only over WebRTC data channels between peers.
- No `PING`, `GOING`, or `SIGNAL` may be sent, received, cached, replayed, or forwarded over WebSocket, HTTP, or any other non-WebRTC transport.
- WebSocket or HTTPS may be used only for bootstrap discovery and the SDP/ICE exchange required to establish the first WebRTC data channel. Bootstrap messages are not `PING`, `GOING`, or `SIGNAL`, and must not carry application content.
- The seed peer is a real headless WebRTC peer. It may receive, cache, replay, and forward `PING`, `GOING`, and `SIGNAL` only over WebRTC data channels.
- The seed cannot be an image or audio endpoint. It never accepts, stores, or relays photographs or voice memos.
- Peer-assisted signalling is a key design principle. Connected peers forward `SIGNAL` envelopes for other peers over WebRTC data channels. A new peer uses an existing peer as its introducer wherever possible.
- Flood-once relay, deduplication, replay to new peers, and expiry all happen over the WebRTC mesh.
- If no WebRTC data channel exists, a client must not fall back to a non-WebRTC transport for application messages. It reports the peer as unreachable.
- The 100 live peer connection cap applies to the WebRTC mesh. It does not limit how many humans the browser knows about.
- The seed may be disconnected after the first mesh connection. Existing peers continue without it.

### FR-1 — The seed peer is optional

The 24/7 RDZ peer is optional. No core function may depend on it. Presence, rendezvous discovery, message relay and replay, verification, and photo or voice handoff must all continue with zero configured seed peers, provided a browser has at least one known peer. The seed may be removed, offline, or absent from configuration without stopping the rest of the network.

### FR-2 — The seed peer is a headless WebRTC peer

- The default seed peer is `randezvous.instanthero.ca`. A brand-new browser with no cached peers connects there first.
- The seed address is deployment configuration, not a protocol constant. A client may have no seed (FR-1) or a different one.
- The 24/7 peer is a long-running, in-memory-only WebRTC peer.
- It is not a human. It has no human ID, sends no human `PING`, and never appears in the human list.
- It is otherwise a real peer. Over WebRTC, it may receive, cache, replay, and forward `PING`, `GOING`, and `SIGNAL`.
- It may replay every valid, unexpired `PING` and `GOING` it holds to a newly connected peer.
- It may act as an introducer and relay `SIGNAL` envelopes between peers over WebRTC.
- It cannot be an image or audio endpoint. It never accepts, stores, or relays photographs or voice memos.
- Bootstrap discovery and the first SDP/ICE exchange may use WebSocket or HTTPS. All application messages use WebRTC.
- It has no durable state. A restart loses its in-memory message set.
- It may be disconnected after the first mesh connection. Existing peers continue without it.

### FR-3 — Transport

- Application traffic (`PING`, `GOING`, `SIGNAL`) uses WebRTC data channels exclusively.
- Bootstrap discovery and the first SDP/ICE exchange may use the seed over WebSocket or HTTPS. Bootstrap is not application traffic.
- Connected peers relay `SIGNAL` envelopes and peer introductions for other peers over WebRTC data channels.
- STUN uses Google's free STUN servers by default, or a self-hosted STUN endpoint.
- TURN is optional. There is no universal reachability guarantee.
- There is no non-WebRTC fallback for application messages. If a WebRTC path cannot be established, the peer is reported unreachable.

### FR-4 — Messages are signed

- The user-visible application message types are exactly `PING` and `GOING`.
- `SIGNAL` is a peer connection-mechanics message, defined in FR-18. It is not user-visible.
- Every peer message is cryptographically signed by its creator.
- Every signed envelope carries the creator's public key. The human ID is derived from that key, so a receiver can verify the author without a separate key-discovery service.
- A message may carry a `created-at` up to one minute later than the receiver's current time, to tolerate ordinary network and device clock-skew effects. Messages dated farther in the future are invalid.
- A rejected message must never leave a user action hanging. If clock skew prevents a request or session message from being accepted, the affected request or session times out with a visible message.
- Relays preserve the original signature and never re-sign a message.
- A message with an invalid signature is rejected.

### FR-5 — PING

```text
PING [human id] [created-at] [signature]
```

- A human's system sends a `PING` every 3 minutes by default.
- Delivery is best effort. A page that becomes visible sends a fresh `PING` promptly.
- Receiving a valid `PING` marks that human online for 5 minutes.
- Presence expires locally after 5 minutes without a fresh `PING`.
- `PING` uses flood-once relay.
- A `PING` whose `created-at` is more than one minute later than the receiver's current time is invalid.
- A local, non-gossiped auto-ban for invalid `PING` creators is recorded in `docs/FUTURE_SPEC.md`.

### FR-6 — GOING

```text
GOING [rendezvous id] [scheduled time] [created-at] [signature]
```

- `GOING` announces a rendezvous time and the sender's attendance.
- The scheduled time is coordination only. It does not gate sending images, opening audio, or connecting.
- A human may appear multiple times on a rendezvous screen if they announced more than one time.
- Setting a rendezvous always sends a `GOING` message.
- Anyone may send `GOING` for any rendezvous ID.
- Sending `GOING` as a guest is a courtesy announcement: it puts the guest on the board and lets others initiate a connection.
- A guest who does not send `GOING` may still initiate a direct WebRTC connection to a participant learned from that participant's `GOING`. The guest is not listed as a participant on the board.
- Either side that knows the other can initiate the WebRTC offer through relayed signalling. Mutual prior knowledge is not required.
- Two humans may send `GOING` for the same ID with different scheduled times.
- `GOING` uses flood-once relay.
- A `GOING` is valid until its scheduled time plus 3 minutes.
- Clients display all valid claims for a rendezvous ID. They do not elect a canonical time.

### FR-7 — Relay, replay, and deduplication

- Each peer caches every valid, unexpired `PING` and `GOING` message it has seen.
- Each unique message is forwarded at most once by each peer to its known peers over WebRTC data channels, excluding the sender.
- Deduplication is keyed by a hash of the canonical signed bytes.
- On a new authenticated WebRTC peer connection, a peer replays all valid messages it holds, then continues live relay.
- Both sides replay to each other. Duplicates are absorbed by deduplication.
- Expired messages are purged and never replayed.
- The seed peer may also cache and replay `PING` and `GOING`, but only over WebRTC data channels. It never replays them over WebSocket or HTTP.
- Photographs and voice memos are never cached or replayed by the relay layer.

### FR-8 — Announcement expiry and channel lifetime

- A `GOING` announcement is removed from its rendezvous channel board at its scheduled time plus 3 minutes.
- Expiry is computed locally from the signed scheduled time.
- Late-arriving `GOING` messages for an expired announcement are ignored.
- The human remains on the landing page's global online list and in any other channel.
- No server decision or global deletion message is required.
- The scheduled time is coordination only. It does not gate images, audio, or connections.
- The rendezvous screen closes only when the user explicitly leaves it. There is no automatic timer close.
- The protocol cannot force a peer to stop using WebRTC. A peer may continue a session outside the good-faith policy.

### FR-9 — Peer connections

- A browser maintains at most 100 simultaneous WebRTC peer connections.
- The cap applies only to live connections. It does not limit how many humans the browser knows about.
- The seed, when connected over WebRTC, counts as one live peer connection.
- Verified peers are prioritized for retention but still count toward the 100 live connections.
- Every 5 minutes, 20% of the non-priority connections are replaced with random new peers when more peers are available.
- Random candidates are drawn from the browser's internal peer registry, which is built from peers it learns about from other peers.
- Refresh timers are jittered.
- A connection is not dropped during an active photo or voice session; refresh waits until it finishes.
- If fewer than 100 peers are available, the browser connects to all of them and does not rotate until more appear.

### FR-10 — Identity

- Each mask creates a persistent P-256 keypair.
- The private key is stored in IndexedDB as a non-extractable `CryptoKey`.
- The public key, emoji human ID, verification state, and pinned keys are stored with that mask in IndexedDB.
- Masks are scoped to the browser profile and origin.
- Clearing site data removes all masks. The next use creates a new default mask.
- The human ID is derived from the public key.

### FR-11 — Emoji and word identifiers

- A canonical identifier is 88 bits.
- A human ID is the first 88 bits of `SHA-256(public key)`.
- A rendezvous ID is 88 bits from a cryptographically secure random generator.
- The word representation is 8 words from a fixed 2048-word list, 11 bits per word.
- The emoji representation is 11 emoji from a fixed 256-emoji set, 8 bits per emoji.
- Both representations encode the same 88-bit value.
- A human's full word sequence is their verification set.
- A rendezvous's full word sequence identifies it.
- The board filter and human search match either representation.
- An identifier is displayed at the shortest length that is unambiguous in the current view.
- On the landing page, a rendezvous emoji prefix uses a minimum of 3 emoji and is extended against every known rendezvous, including pinned-only and filtered-out rendezvous. It never exceeds the 11-emoji canonical ID.
- Human rows use a minimum of 6 emoji and may wrap; they are never reduced to a single truncated emoji. The full 11-emoji sequence remains the canonical ID.
- On collision, the displayed emoji or word string is extended until the entries differ.
- Extending the display does not change the underlying identity.
- The full sequence is used for verification, never the shortened display.
- A canonical rendezvous collision is resolved by generating a new identifier. A canonical human collision is computationally negligible.

### FR-12 — Time representation

- Every scheduled time is stored as an absolute UTC instant.
- The interface displays it in the viewer's local timezone as `HH:mm`.
- Seconds are never displayed.
- A day marker is shown only when the rendezvous is not today in the viewer's local timezone.

### FR-13 — Verification

- Verification is optional and local.
- Every human has an 8-word verification sequence derived from their identity.
- Verification compares that human's full 8-word sequence out of band.
- There is no pairwise comparison code.
- A verified human is marked locally and the mark persists with the browser identity.
- Verification does not gate presence, attendance, or media transfer.

### FR-14 — No universal reachability

The specification does not promise that every peer can reach every other peer. NAT traversal, churn, relay availability, and local policy may prevent a connection. The interface must report failures honestly rather than claim delivery.

### FR-15 — Photo persistence

- A received image is available for saving through the browser's download mechanism while it is displayed.
- Dismissing the image removes the in-app copy.
- The app keeps no photo wall, gallery, or persistent in-app collection.
- A file already saved to the device remains outside the app.

### FR-16 — Image offers and receiver consent

- Image transfer is pairwise and consensual.
- A sender can offer an image only to a human they have verified.
- Each send action targets one recipient and one image.
- Pressing send for a participant opens image selection or reuses the last image sent.
- A sender has at most one outgoing image transfer in flight at a time.
- The next send is enabled only after the current transfer is acknowledged as received, or the offer is declined or fails.
- An offer carries only a numeric size in megabytes, plus routing and consent fields.
- The sender's filename, path, MIME type, and preview are never transmitted in the offer.
- The exact byte length and safe image type are sent only after consent, inside the transfer channel.
- The receiver generates a safe local filename when saving. A sender-supplied filename is never displayed or used.
- The recipient explicitly accepts or declines.
- No image bytes are sent before the recipient accepts. Accepting is at the user's own risk.
- Multiple sends to the same or different recipients are independent, each with its own image choice and consent.
- Only raster image formats are accepted. SVG and other active-content image types are rejected.
- The default maximum size is 25 MiB. A transfer that exceeds the actual byte limit is aborted.
- An accepted transfer uses the authenticated WebRTC connection and is acknowledged per direction.
- A pending offer, an accepted connection, and an active transfer are all bounded. When one fails or times out, both humans are told what happened instead of seeing a permanently stuck transfer.
- An accepted image is displayed in the live rendezvous surface.
- An accepted image can be saved through the browser while it is displayed. Dismissing it removes the in-app copy.
- No wall or persistent in-app gallery is created.

### FR-17 — One-minute audio channel

- Audio is pairwise only.
- An initiator can request a live audio channel only from a human they have verified.
- No audio flows until the receiver accepts and grants microphone permission.
- Each conversation lasts one minute.
- The pair may start another conversation afterwards, with no limit on reconnections.
- A gentle pink progress bar shows the remaining time. It has no numbers.
- Either participant can mute or end the conversation early.
- Audio is live only. It is never recorded, transcribed, or uploaded.
- A declined request does not consume the channel and does not affect image transfer.
- Audio ends at the one-minute cap or on disconnect.
- Audio uses WebRTC media over the authenticated peer connection. No audio bytes pass through any relay.
- Audio requests and consent are connection mechanics, not `PING` or `GOING` messages.
- Audio control signals are `audio-request`, `audio-accepting`, `audio-accept`, `audio-decline`, `audio-end`, and `audio-mute`.
- `audio-accepting` means the recipient chose accept and is granting microphone permission. It is not consent for audio to flow.
- `audio-accept` is sent only after the recipient's microphone stream is ready.
- Waiting for an answer, for the recipient's microphone, and for the connection is bounded. Every timeout closes the pending voice session and is reported visibly.

### FR-18 — SIGNAL envelopes

- `SIGNAL` carries WebRTC offers, answers, and ICE candidates between peers.
- `SIGNAL` travels only inside WebRTC data channels. It is never sent over the seed WebSocket.
- Every `SIGNAL` envelope is addressed to a target human ID.
- Every `SIGNAL` envelope is signed by its creator.
- A client accepts a channel `SIGNAL` only when its creator is a human that client has verified locally.
- A verified `SIGNAL` is accepted only when it names a channel the recipient is currently viewing or has an active `GOING` announcement in.
- A channel connection completes only when both humans have verified each other locally.
- A `SIGNAL` from an unverified human is ignored.
- Connected peers forward `SIGNAL` for other peers over WebRTC data channels. This is peer-assisted signalling.
- Bootstrap SDP/ICE exchanges used to create the first WebRTC data channel are separate bootstrap messages, not `SIGNAL`, and may be carried by the seed over WebSocket or HTTPS.
- The seed is a headless WebRTC peer. It may forward `SIGNAL` over WebRTC data channels like any other peer, but it never forwards `SIGNAL` over WebSocket and never accepts media.
- Peers forward `SIGNAL` flood-once, preserving the original signature.
- Relays never modify or re-sign a `SIGNAL` envelope.
- `SIGNAL` envelopes are short-lived. Stale envelopes are discarded.
- `SIGNAL` carries no image, audio, or file bytes.
- `SIGNAL` is never displayed as a human or rendezvous message.

### FR-19 — Multiple masks, one active identity

- The identity store supports multiple masks per browser.
- Each mask has its own P-256 keypair, public key, human ID, verification word sequence, verified-human records, and pinned peer keys.
- Exactly one mask is active for a browser profile and origin at any time.
- Only the active mask sends `PING`, signs new `GOING` and `SIGNAL` messages, appears online, and can hold image or audio connections.
- Inactive masks never send, receive, or hold live peer connections.
- Switching masks stops the active `PING` loop, closes the relay identity, tears down active image transfers and audio, reconnects using the new mask, and sends a fresh `PING`.
- Verification state and pinned peer keys are per mask. Pinned channels and local channel labels are browser-level preferences shared across masks.
- Existing single-mask data is migrated into the first mask.
- Removing a mask deletes its private key and local verification state. Messages already signed by that mask remain valid. There is no recovery.
- `GOING` announcements already signed by a mask are not retracted or reassigned when the active mask changes. They remain valid until `T + 3`.

### FR-20 — No silent failures

- Every failure of a locally initiated action MUST be reported visibly in the interface.
- A pending request, offer, transfer, or live session that is removed because of failure, decline, cancellation, timeout, or a remote end MUST be accompanied by a user-visible message.
- Error messages MUST use plain language. Raw exception names, stack traces, and protocol codes MUST NOT be shown.
- Notices MUST be announced to assistive technology and remain visible long enough to read.
- A failed action MUST release its pending UI state so the user can retry without reloading.
- A request that receives no response MUST time out and notify instead of waiting indefinitely.
- A local user's own explicit cancel, decline, dismiss, or end action does not require an error message.
- Malformed, duplicate, expired, or unauthorized inbound messages MUST be dropped silently for safety. They are not failures of a user action.
- Blocked media playback MUST be reported and MUST be retryable through a user gesture.
- Losing a peer connection, timing out a request, or leaving a channel while media is pending MUST NOT remove a media panel without a notice.

### FR-21 — Network traffic observability

- The app exposes a local, session-only network traffic view for debugging the WebRTC mesh.
- The view records routing metadata only: sequence, direction (`coming`, `going`, `relaying`), envelope type, author, peer, byte size, created and observed times, `SIGNAL` kind, target, destination count, replay flag, rendezvous ID, and scheduled time where applicable.
- The view MUST NOT display, store, or retain payload bodies or sensitive envelope fields. This includes image chunks, audio, SDP, ICE candidates, signatures, public keys, and any other envelope content.
- Media privacy: photographs and voice are live-only and never recorded or uploaded. A payload viewer would turn the diagnostics page into a recorder.
- Network privacy: SDP and ICE candidates can reveal local and remote IP addresses, hostnames, and NAT details. The traffic view is not a place to expose them.
- Identity hygiene: public keys and signatures are not needed to debug routing and add correlation and copy/paste risk.
- Untrusted content: rendering arbitrary payloads in the UI adds an XSS and accidental-leak surface. The view renders escaped metadata only.
- Memory bounds: the log is capped at 250 events. SDP and media bodies are far larger than metadata and would break the bounded, session-only design.
- Message-surface integrity: `SIGNAL` is connection mechanics and is never a user-visible message. `PING` and `GOING` remain the only user-visible application messages; the traffic view is diagnostics, not a second message reader.
- The traffic view MUST remain local and in-memory. It clears on reload, never uploads, and never becomes a stored log.
- Invalid, duplicate, expired, or unauthorized traffic remains silently discarded per FR-20.

## Visual User Stories

### VS-1 — The landing page

As anyone landing on RDZ, I see the full list of humans currently online and the rendezvous channels. The hero says **The Internet is Here** in large type. Each channel shows its emoji ID and next `HH:mm` time.

### VS-2 — Rendezvous times

For a rendezvous channel, I see the humans grouped by the `HH:mm` time they announced, in ascending time order, with subtle separators between groups. My own announcement is confirmed above the groups in a dedicated "your rendezvous" line and is not counted as another participant. A human appears once for each time they announced. Each row shows whether that human is online. Online rows offer `send photo` and `open voice`. An announcement leaves this channel board at its scheduled time plus 3 minutes, while the human remains on the landing page's online list.

### VS-3 — Online humans

When I see all humans online, verified humans are shown first. Verified humans who are offline remain visible with an offline state. Every human row shows a distinguishing emoji prefix of at least 6 emoji, extended to 11 if needed, never collapsed to a single ellipsized emoji.

### VS-4 — Emoji IDs

Human and rendezvous IDs are rendered as emoji strings. When two visible IDs collide, the strings lengthen until they are distinguishable.

### VS-5 — Circles

A circle is displayed as a pinned rendezvous ID with an optional local label. Selecting it opens that rendezvous ID. The label is local only and never shared. There is no separate circle membership or event surface.

### VS-6 — Time format

Every time in the interface is shown as `HH:mm`, never with seconds.

### VS-7 — Channel lifetime

The rendezvous screen has no automatic close. It stays open until I explicitly leave it.

### VS-8 — Photo offer

An incoming photo offer shows the sender and a numeric size in megabytes. It shows no filename, path, MIME type, or preview.

### VS-9 — Audio progress

During a one-minute audio conversation, a gentle pink progress bar shows the remaining time without numbers.

### VS-10 — Mask switcher

The identity chip opens a mask switcher. It lists every stored mask by its emoji and words, marks exactly one as active, and offers create, switch, and remove actions. Switching shows a brief connecting state and ends any active image or audio session. At no point are two masks shown as active. The active mask's full 8-word verification sequence wraps inside the dialog and is never truncated with an ellipsis.

### VS-11 — Landing rendezvous emoji prefixes

Every rendezvous card on the landing page shows its full distinguishing emoji prefix, never a clipped or ellipsized fragment. The prefix starts at 3 emoji and grows only when another known rendezvous shares it. The maximum is the canonical 11 emoji.

### VS-12 — Landing orbit

The landing hero carries a subtle elliptical orbit with one slow-moving dot behind the content. The motion is decorative, takes about 26 seconds per revolution, does not intercept input, and does not appear inside a rendezvous channel. Reduced-motion preferences stop the animation.

### VS-13 — Masthead and marks

The app shows a centered, low-contrast masthead reading `rendezvous ✳ by [InstantHero mark]` above the top bar. The three intersecting lines are the RDZ mark and also appear in the top-bar brand button. The masthead is a single link to `https://instanthero.ca` that opens in a new tab, leaving the current session in place. Empty space around the masthead does not intercept input.

### VS-14 — Failure notices

Failures appear as a short, plain-language notice fixed at the bottom center of the screen. The notice is announced with `role="status"`, stays visible for at least four seconds, does not block interaction, and disappears on its own. Removing a failed or declined panel is always paired with a notice that explains why it went away.

---

# Open Questions

None. The spec is ready for implementation.
