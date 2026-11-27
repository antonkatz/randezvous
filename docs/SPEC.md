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
- No account, registration, or approval is involved.

### US-4 — I see every human who is online

As anyone on the board, I want to see every human currently online, so that I know who is reachable.

**Acceptance criteria**

- The online list is derived from unexpired `PING` messages.
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

## Functional Requirements

### FR-0 — WebRTC-exclusive application messages and peer-assisted signalling

This is the primary transport invariant, ahead of every other functional requirement.

- `PING`, `GOING`, and `SIGNAL` are application messages. They MUST travel only over WebRTC data channels between peers.
- No `PING`, `GOING`, or `SIGNAL` may be sent, received, cached, replayed, or forwarded over WebSocket, HTTP, or any other non-WebRTC transport.
- WebSocket or HTTPS may be used only for bootstrap discovery and the SDP/ICE exchange required to establish the first WebRTC data channel. Bootstrap messages are not `PING`, `GOING`, or `SIGNAL`, and must not carry application content.
- The seed peer is not an application-message relay. It must not receive, store, replay, or forward `PING`, `GOING`, or `SIGNAL`.
- Peer-assisted signalling is a key design principle. Connected peers forward `SIGNAL` envelopes for other peers over WebRTC data channels. A new peer uses an existing peer as its introducer wherever possible.
- Flood-once relay, deduplication, replay to new peers, and expiry all happen over the WebRTC mesh.
- If no WebRTC data channel exists, a client must not fall back to a non-WebRTC transport for application messages. It reports the peer as unreachable.
- The 100 live peer connection cap applies to the WebRTC mesh. It does not limit how many humans the browser knows about.
- The seed may be disconnected after the first mesh connection. Existing peers continue without it.

### FR-1 — The seed peer is optional

The 24/7 RDZ peer is optional. No core function may depend on it. Presence, rendezvous discovery, message relay and replay, verification, and photo or voice handoff must all continue with zero configured seed peers, provided a browser has at least one known peer. The seed may be removed, offline, or absent from configuration without stopping the rest of the network.

### FR-2 — The seed peer is bootstrap-only

- The default seed peer is `randezvous.instanthero.ca`. A brand-new browser with no cached peers connects there first.
- The seed address is deployment configuration, not a protocol constant. A client may have no seed (FR-1) or a different one.
- The 24/7 peer is a long-running, in-memory-only bootstrap process.
- It is not a human. It has no human ID, sends no human `PING`, and never appears in the human list.
- It may help peers discover each other and may carry bootstrap SDP/ICE envelopes needed to establish the first WebRTC data channel.
- It must not receive, cache, replay, or forward `PING`, `GOING`, or `SIGNAL`. It is not an application-message relay.
- It never accepts, stores, or relays photographs or voice memos.
- It has no durable state. A restart loses its bootstrap state.
- It may be disconnected after the first mesh connection. Existing peers continue without it.
- Bootstrap envelopes are separate from application messages and must not carry application content.

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
- No message may carry a `created-at` later than the receiver's current time. Messages from the future are invalid.
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
- A `PING` whose `created-at` is later than the receiver's current time is invalid. There is no future tolerance.
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
- The seed peer never caches or replays application messages.
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
- Bootstrap SDP/ICE exchanges used to create the first WebRTC data channel are separate bootstrap messages, not `SIGNAL`, and may be carried by the seed.
- The seed never forwards `SIGNAL`.
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

## Visual User Stories

### VS-1 — The landing page

As anyone landing on RDZ, I see the full list of humans currently online and the rendezvous channels. Each channel shows its emoji ID and next `HH:mm` time.

### VS-2 — Rendezvous times

For a rendezvous channel, I see the humans grouped by the `HH:mm` time they announced, in ascending time order, with subtle separators between groups. A human appears once for each time they announced. Each row shows whether that human is online. Online rows offer `send photo` and `open voice`. An announcement leaves this channel board at its scheduled time plus 3 minutes, while the human remains on the landing page's online list.

### VS-3 — Online humans

When I see all humans online, verified humans are shown first. Verified humans who are offline remain visible with an offline state.

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

The identity chip opens a mask switcher. It lists every stored mask by its emoji and words, marks exactly one as active, and offers create, switch, and remove actions. Switching shows a brief connecting state and ends any active image or audio session. At no point are two masks shown as active.

---

# Open Questions

None. The spec is ready for implementation.
