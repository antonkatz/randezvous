# Rendezvous — Product & Technical Specification

**Status:** v0.1 · reciprocal photo contributions, the live rendezvous screen, one-minute live audio, photo voice notes, local re-sharing, and per-photo possession inventory are implemented. The five-minute early/late handoff window, delivery celebration, independent circle offers with per-offer joins, optional circle time windows, circle auto-accept, expiring circle offer invites, and online circle sync are implemented. Direct rendezvous start as pending until both humans confirm the current time; either human can counter-propose a new time, which cancels the prior time and keeps the same rendezvous. Circle offers are a free-for-all: members may join any independent offer, and a counter-proposal becomes another offer rather than replacing the others. The public-photo layer (US-20) remains explicitly deferred. The rendezvous-driven invitation flow that removes the standalone add-human action is implemented. The upcoming-rendezvous exchange detail (US-10c, VDS-10c), the right-hand circle dock with its 2.5-circle overflow cue (VDS-16), the top-corner `live` indicator (US-13b, VDS-15), hiding the large `Set a rendezvous` action while an upcoming rendezvous exists (US-6, VDS-5, VDS-9), and the per-rendezvous **I won’t be able to speak** live-audio flag (US-6, US-9b, VDS-7, VDS-10b) are implemented.

**Date:** 23 November 2026  
**Codename:** rendezvous  
**Package:** `@instanthero/rendezvous`

---

### Assumptions locked for v1

- **TURN is optional and untrusted.** The deployment may provide a self-hosted TURN server as a fallback for difficult NATs, but the service must not trust it. WebRTC DTLS encrypts private photos/voice notes end to end; signed identity handshakes authenticate the peers.
- **The signalling path is untrusted for authenticity.** It can see appointment metadata and route SDP/ICE, but it must not be able to impersonate a human or sit in the middle of a photo transfer unnoticed.
- **Verification uses a stable, independently derived code.** Both tabs derive an 8-word code from the two sorted raw identity public keys. No code is sent over the wire. The live session is bound to the pinned identity with a signature over the DTLS fingerprints.
- **A live RTC connection is disposable.** Only identity keys, pinned peer keys, relationships, verification state, circle records, appointments, and photos persist.

---

## 1. What this is

> **Implementation note:** v0.1 implements the private browser-to-browser photo handoff, invites, verification, revocation, ranked wall, diagnostics, the five-minute early/late handoff window, and the delivery confetti animation. It also implements reciprocal photo contributions, the live rendezvous screen, per-photo voice notes, local re-sharing, the one-minute live voice window with its per-rendezvous **I won’t be able to speak** flag, a per-photo possession inventory, pending/confirmed rendezvous labels, and cancel-and-replace counter-proposals. Circle records, membership, independent offers with per-offer joins, the optional signed time window, auto-accept, expiring server-side offer invites, and automatic online sync are wired into the app. The future public-photo re-share layer remains deferred. The rendezvous-driven invitation flow in US-3 is implemented: the composer can address an already-saved rendezvous to **someone new**, and opening that link stores the same appointment immediately before the join reaches the creator. The upcoming-rendezvous exchange detail (US-10c, VDS-10c), the right-hand circle dock with its 2.5-circle overflow cue (VDS-16), the very-top-corner `live` indicator (US-13b, VDS-15), and hiding the large `Set a rendezvous` action while a rendezvous is upcoming (US-6, VDS-5, VDS-9) are also implemented in this build.

Rendezvous is a tiny, private photo-sharing service that runs entirely in the browser. Two people link their browsers once, then leave photographs for each other at chosen times. Photos travel directly from browser to browser over WebRTC. There is no photo upload, no media server, and no account in the private path. (A future, separate opt-in public-photo layer is sketched in US-20 and explicitly deferred.)

A **live WebRTC connection is never permanent**. Closing the page ends it. What persists is each browser's keypair, the pinned public key of the other human, and the stored relationship. On the next visit both browsers re-authenticate to the signalling layer and rebuild a direct connection automatically when a handoff is needed. "Connected forever" is a product promise about the relationship, not a claim about an open socket.

The product is also a reusable base: the signalling client, the rendezvous engine, and the UI are exposed as a package that later Instant Hero components can embed or compose.

### The invariant that defines the product

> **A rendezvous is a scheduled meeting, not a timed delivery.**
>
> A photo can move only while both people have the app open and connected at the same time. The signalling server stores the appointment (who, what time, which notice), never a private photo. (A future public layer would be a separate, explicitly opted-in surface.) The normal handoff window runs from five minutes before to five minutes after the scheduled moment. If both browsers are online anywhere in that window — including both already being online beforehand — they connect automatically and exchange the photo(s). The creator’s photo is never withheld because the other person has not added a reciprocal photo. If only one person is present, nothing is delivered. The rendezvous remains “waiting” and completes at the next overlap when both browsers are open — lateness alone never discards it, even beyond the five-minute late tolerance.

This distinction drives every flow in this document:

- Selecting a photo does **not** upload it.
- Choosing a time does **not** schedule a server-side send.
- “DONE” means the appointment exists and the other person can be told about it.
- “Delivered” is only true after the photo has crossed an open WebRTC data channel.
- A closed tab cannot deliver or receive a photo. There is no background push in v1.

---

## 2. Vocabulary

| Word | Meaning |
| --- | --- |
| **Human** | A peer whose browser has been permanently linked to yours through an invitation. |
| **Code name** | The non-unique display name shown to your humans. You can change it at any time. |
| **Invitation** | A signed, shareable link that grants the bearer a permanent link to your browser identity. |
| **Circle** | A named, private group of linked humans that coordinates independent rendezvous offers. |
| **Active circle** | The circle currently shown on the main surface, selected from the right-hand circle dock. |
| **Circle invitation** | A signed offer addressed to one public-key identity to join a circle. It is not a bearer link. |
| **Rendezvous** | A scheduled photo handoff between two humans at one moment. The creator contributes a photo; the other human may contribute one reciprocal photo. |
| **Rendezvous detail** | The panel opened from an upcoming rendezvous row. It foregrounds the local attachment to be exchanged, shows the counterpart’s contribution only as state before handoff, and keeps the comparison words in a collapsed-by-default disclosure. |
| **Creator** | The human who sets the rendezvous, chooses its moment, and attaches the first photo. |
| **Reciprocal contribution** | The optional one photo the non-creator attaches to an existing rendezvous, delivered to the creator at the same meeting. |
| **Pending rendezvous** | A rendezvous whose current proposed time has not yet been confirmed by both direct humans. Pending is a label only; it never blocks the normal handoff. |
| **Confirmed rendezvous** | A rendezvous whose current proposed time has been confirmed by both direct humans. |
| **Counter-proposal** | A replacement time proposed by either direct human. It cancels the previous proposed time, keeps the same rendezvous and photo, and resets confirmations. |
| **Circle offer** | A signed circle record proposing one shared moment. Members may join any offer; several independent offers can run at different times. |
| **Circle offer invite** | A circle offer notice delivered to named members. The server stores only this notice, and only until the offered time has passed. |
| **Circle time window** | An optional signed interval, in the circle's IANA timezone, that limits the scheduled instant of new circle offers. It never shortens the handoff window or changes existing offers. |
| **Rendezvous time** | The local date and time chosen by the creator. Stored as an absolute Unix timestamp. |
| **Live audio disabled** | A per-rendezvous flag set by the creator through **I won’t be able to speak**. It removes the live one-minute voice option for that rendezvous on both sides, while leaving photo voice notes and the photo handoff unchanged. |
| **Online** | The browser app is open and connected to the signalling server. This is only a presence signal; the direct RTC link is established when the handoff begins. |
| **Waiting** | The handoff window is open but the handoff cannot happen because one or both browsers are not present. |
| **Handoff window** | The normal on-time window is `[T − 5 minutes, T + 5 minutes]`. If both humans are online anywhere inside it, they connect and exchange automatically, including when both are already online beforehand. Later arrival does not expire the saved photograph. |
| **Waiting for you / waiting for them** | Directional waiting states, so the UI never implies that a server is holding the photo. |

---

## 3. User stories

### Identity

#### US-1 — I can name myself
As a person using the service, I want to choose a code name, so that my humans recognise me.

**Acceptance criteria**
- A flat text input with the placeholder `Code Name` sits at the top centre of the page.
- The typed name is saved locally and survives reload.
- My name is sent to the signalling layer on connection and shown to linked humans.
- Changing my name updates my humans’ contact list while we are both online.
- Names are cosmetic, non-unique, whitespace-normalised, and capped at 32 characters.
- An empty name is displayed to others as “Anonymous human”. It does not prevent use.

#### US-2 — I remain the same browser
As a returning visitor, I want my identity and connections to persist, so that I do not have to re-add people after closing the tab.

**Acceptance criteria**
- On first use, the browser creates a persistent, self-certifying identity backed by a generated P-256 keypair stored in IndexedDB.
- Reloading or reopening the site restores my identity and relationships.
- The identity is local to this browser profile and origin.
- Clearing site data creates a new identity; old links cannot be used to reclaim it.
- The private key is held as a `CryptoKey` (non-extractable where the browser supports it) rather than as plain text in local storage.
- The public key is exposed in invitations; the peer ID is derived from that key and cannot be claimed without the matching private key.

### Meeting someone new

#### US-3 — A rendezvous can be addressed to someone who has not joined yet
As a sender, I want to set a rendezvous and generate its invitation link at the same time, so that the first thing a new person receives is the meeting, not an empty contact.

**Acceptance criteria**
- There is no standalone **add human** control, panel, empty-state action, or menu item anywhere in the interface.
- The only way to establish a new human relationship is to set a rendezvous and choose **someone new** in the human step.
- The human step lists linked humans and one **someone new** choice. It never asks the sender to leave the composer to add a person first.
- Choosing **someone new** signs an invitation for this rendezvous. It does not create a human or a second appointment.
- The creator’s rendezvous is saved locally immediately with the state **waiting for them to join**, and appears in the creator’s upcoming area.
- The DONE stage shows the join link and a copy action for a **someone new** rendezvous. There is no separate link screen or add-human flow.
- The link carries the signed invitation and the appointment metadata: appointment ID, inviter identity, scheduled timestamp, creation timestamp, and the live-audio-disabled flag. It never carries photo or voice-note bytes.
- The link can be generated while the signalling server is offline. Opening it verifies the inviter locally and stores the already-scheduled rendezvous without a second scheduling step.
- As soon as the invitee opens the link and completes the join, the rendezvous is already in their upcoming area. The recipient does not need to wait for a later server notice to learn the appointment.
- The inviter pins the invitee’s public key from the join request and attaches the saved rendezvous to that human. No duplicate appointment is created.
- If the inviter is online, they learn about the join immediately. If not, the signalling server queues the join until the inviter next connects; the invitee already has the appointment locally.
- If the link is opened by a browser that is already linked to the inviter, the rendezvous is attached to that existing human. No duplicate relationship is created.
- The first browser to redeem a link binds it to that browser identity. A later redemption from a different browser is refused once the invitation has been bound.
- Both sides retain each other’s identity permanently until either side deletes the relationship.
- The link is a bearer credential before it is bound: anyone who has it can join. There is no account, approval screen, or password in v1.
- Invitation token hashes are stored with the resulting relationship. Deleting the human revokes the token everywhere; an old copied link no longer works.
- Opening one’s own link does nothing except show a friendly message.
- Following an already-bound link from the same browser is idempotent.
- There is no discovery, search, contact list import, or central social graph.

#### US-3b — I can verify a human with a comparison code
As a person who wants to be sure the link really belongs to my friend, I want a short code shown identically in both browsers, so that we can confirm nobody substituted their keys.

**Acceptance criteria**
- A stable **8-word verification code** is deterministically derived from both humans' long-term identity public keys.
- The code is never transmitted. Each browser computes it locally from the two pinned public keys.
- The code derivation:
  - exports identity public keys in fixed raw format;
  - bytewise-sorts the two keys;
  - hashes a domain-separated, length-prefixed transcript with SHA-256;
  - uses 88 bits of output as eight 11-bit indices into a fixed 2048-word list.
- Both humans see the same eight words, in the same order, on every reconnection. It does not change when WebRTC DTLS certificates change.
- The code is shown in a human-detail panel. The same words remain available in the upcoming rendezvous detail (US-10c) inside a disclosure that is collapsed by default every time the detail opens. A “Verified” / “Not verified” badge is always visible on the human.
- The panel instructs both people to compare the words **out loud or through another app**. It explicitly warns not to compare over the same link/channel that carried the rendezvous invite.
- Either person can mark the human as verified locally after comparing; verification state persists in IndexedDB.
- Verification is optional and does not block scheduling. It changes the badge from “Not verified” to “Verified”.
- A pinned-key mismatch or an authentication failure is loud, fails closed, and never silently replaces the stored key or marks the human verified.
- The long code is deliberate: without a commitment round, an attacker can grind short codes. Eight words from 2048 provide 88 bits. A short 4–6 digit code with a commitment exchange is future work.

#### US-4 — I can get rid of a human forever
As a person in control of my connections, I want to delete a human, so that they can never reconnect to me through the old relationship.

**Acceptance criteria**
- Each human in the humans strip can be removed with a clearly labelled, accessible remove action.
- Removing locally immediately removes the human from my UI, revokes their presence subscription, and cancels any scheduled-but-not-completed rendezvous between us.
- A removal notice is sent through the signalling server. If the other browser is offline, the server queues the notice until it next connects.
- The other browser removes the human and all pending rendezvous on receipt. Both sides can no longer initiate a handoff.
- Invitation-token hashes associated with the relationship are revoked locally and recorded by the bootstrap server. Reopening the old link is rejected on both sides; meeting again requires a fresh rendezvous invitation.
- Revocation is durable on the bootstrap server, so a removed link cannot be reused while the inviter is offline.
- Photos already delivered remain in each recipient’s local archive until individually deleted; the connection itself is gone.
- Removing a human never requires deleting the local identity.

#### US-5 — Reconnection is automatic
As two linked humans, we want our browsers to find each other again whenever we both return, so that a permanent link feels permanent.

**Acceptance criteria**
- The app automatically reconnects to the signalling server after network drops, with exponential backoff.
- The app subscribes only to the presence of its own humans.
- No manually invoked “reconnect” action is required.
- Presence updates are live while both browsers are open.
- Every connection to the signalling layer proves possession of the identity's private key using a server challenge signature. A browser cannot register another human's peer ID without their key.
- The peer's pinned public key is checked during every reconnection. A key mismatch fails closed and never silently replaces the pinned identity.
- “Permanent” means the relationship and invitation grant persist; a WebRTC connection is not held open across sleep, shutdown, or browser suspension. A direct channel is established only for a handoff.

#### US-5b — I can tell when a rendezvous can actually reach my human

As a sender, I want the app to distinguish “linked and present” from “not yet connected” and “not verified”, so that I understand why a rendezvous appears in one browser and not the other.

**Acceptance criteria**
- A human relationship exists only after a rendezvous invitation has been redeemed: the inviter set a rendezvous for **someone new**, the invitee opened its link, both browsers list the other under **your humans**, and both have pinned the other's public key.
- A rendezvous may exist before that relationship exists. It is addressed to the invitation, not to a peer ID, and is held locally by the creator in the state **waiting for them to join**.
- The human row shows two independent facts:
  - **connection:** **here now** only while the other browser is connected to the same signalling server; otherwise **away**;
  - **key verification:** **verified** or **not verified**, based on the eight comparison words.
- Comparing the words and marking verified is the key-safety step. It confirms the pinned key. It does not create the connection, and it does not substitute for the relationship.
- For photo delivery, restate the prerequisites in plain language: both browsers open, the connection live, the human present on both sides, and the comparison words checked.
- The sender sees their own rendezvous immediately in their upcoming list, first as **waiting for them to join** and later as **waiting for [name] to come online**. That local row is not evidence that the other browser has it.
- The recipient sees the rendezvous immediately after opening the invitation link, before any later server notice. The appointment travels in the signed invite; the server notice is optional confirmation, not the first source of the appointment.
- If one browser does not show a rendezvous the other created, the expected checks are: the invitation link was opened in the intended browser profile, both browsers use the same public URL/signalling server, the top-right indicator reads **live**, both list each other under **your humans**, and the other human is shown as **here now**.
- The phrase **delivered** is reserved for the photo handoff. An appointment notice is **waiting for them to join**, **waiting**, **announced**, or **due**, never **delivered**.
- Mobile/desktop testing uses the same public URL for both devices when a tunnel is in use, so both profiles reach the same signalling server.

### The rendezvous

#### US-6 — I can set a rendezvous
As a sender, I want to choose one photo, one person, and a time, so that we can meet for the handoff even if that person has not joined yet.

**Acceptance criteria**
- The central action reads **Set a rendezvous**.
- The large central action is present only when no rendezvous is still upcoming. It is hidden as soon as at least one locally known appointment is pending — including **waiting**, **waiting for them to join**, failed, or overdue meetings — and returns automatically only when no such appointment remains. “Upcoming” here means any appointment whose status is not **delivered** and that has not been deleted.
- The flow has exactly three stages:
  1. **Photo + person.** Select an image from the device, optionally attach a voice note of up to 60 seconds, and choose one linked human or **someone new**.
  2. **Time + optional date + live audio.** Choose a time. If wanted, choose a date. If no date is chosen, the app resolves the next occurrence of that time (today if still ahead, otherwise tomorrow). The step also offers the optional **I won’t be able to speak** flag.
  3. **DONE.** A clear confirmation shows the chosen human or **someone new** and the resolved local moment. For **someone new**, it also shows the join link for this rendezvous and a copy action. If live audio is disabled, the confirmation says so.
- The photo is validated (image MIME type, maximum 25 MiB) and stored only in the sender’s IndexedDB.
- A photo may carry one optional voice note, recorded in the browser and no longer than 60 seconds. It travels in the same authenticated handoff and never passes through the server.
- The photo is not uploaded to, encoded into, or referenced by the signalling server.
- A unique appointment ID is generated locally.
- The appointment is saved locally before it is announced or its link is shown, so closing the tab directly after DONE does not lose it.
- For a linked human, the appointment metadata is sent to the signalling server for store-and-forward delivery to the recipient.
- For **someone new**, the appointment is not addressed to a peer ID yet. It remains **waiting for them to join**, and the signed invitation link carries its metadata. Redeeming the link attaches the existing appointment to the new human; no second appointment is created.
- Choosing **someone new** never opens a separate add-human screen and never creates an empty human record.
- The sender may schedule while the signalling server is offline; delivery is retried while the app remains open and on subsequent launches.
- The completed flow makes the meeting requirement explicit: both browsers must be present.
- The time step includes an off-by-default option labelled exactly **I won’t be able to speak**, with the helper **Live audio will be off for this rendezvous.** Checking it sets a per-rendezvous `liveAudioDisabled` flag.
- The flag disables only the one-minute live voice option (US-9b) for that rendezvous. It does not disable photo voice notes, change the human relationship, affect any other rendezvous, or alter photo delivery.
- The flag is part of the appointment metadata and is delivered to both humans through the invitation link or server notice. Both sides must honor the creator’s flag; neither can clear it locally.
- The flag is fixed when the rendezvous is scheduled. To enable live audio, the creator schedules a new rendezvous without the flag. The earlier rendezvous remains in history under the normal deletion rules.
- When the flag is set, neither human is offered **start audio 1min** for that rendezvous and no audio consent request is sent.
- A rendezvous carries at most one photo per participant: the creator’s photo plus an optional reciprocal contribution from the other human (US-10b). The creator’s three-stage flow never waits for a reply.
- Only one linked human or one **someone new** invitation is selected per direct rendezvous. A circle offer is the group exception: it proposes a shared moment, and members join independently, while each photo transfer remains a direct pairwise handoff.

#### US-7 — The recipient is notified when they return
As a recipient, I want the appointment to be waiting for me even if I was offline when it was created, so that I know to meet my human.

**Acceptance criteria**
- For a rendezvous addressed to **someone new**, the redeemable invitation link is the first delivery path: the recipient already has the appointment as soon as the link is opened, before the inviter is online or any server notice is sent.
- For a rendezvous addressed to a linked human, the signalling server stores the appointment notice until the recipient acknowledges local persistence.
- If the recipient is online at creation, the notice is delivered immediately.
- If the recipient is offline, the notice is queued indefinitely within the retention policy and delivered on their next connection.
- The notice contains only: appointment ID, sender ID, sender display name, scheduled timestamp, creation timestamp, live-audio-disabled flag, proposer ID, confirmer IDs, and revision.
- The recipient’s client persists the notice locally.
- The recipient sees the live-audio flag as read-only. It cannot be cleared in the recipient’s browser.
- The persisted appointment appears in the recipient’s upcoming area and offers **add a photo** for an optional reciprocal contribution (US-10b).
- An upcoming appointment produces a quiet in-app notice. When the handoff window opens at five minutes before the scheduled time, an online recipient receives a prominent in-app notification; an overdue appointment that is still waiting also shows prominently.
- The server notice may arrive earlier; the local handoff alert is timed to the open window.
- If the recipient is online when the appointed time arrives, the client also raises a local “it is time” notification.
- Notifications are in-app only in v1. They are delivered on next launch through the server queue. There is no push notification while the app is closed.
- Unknown senders’ notices are rejected.

#### US-7b — We confirm or counter-propose the time
As either human in a direct rendezvous, I want to confirm the proposed time or propose another one, so that we both agree before the meeting and neither side is stuck with a time that does not work.

**Acceptance criteria**
- A new direct rendezvous starts with confirmation **pending**. The renderer exposes both humans' confirmation state in the upcoming row and the rendezvous detail.
- Both humans must confirm the current proposed time. Confirmation is a label only: a pending rendezvous still appears, still raises the normal handoff alerts, and still hands off under US-8. No extra handoff confirmation is introduced.
- Each human has one **confirm** action and one **propose another time** action while the rendezvous is not delivered and the handoff has not begun.
- A counter-proposal cancels the previous proposed time, keeps the same rendezvous ID, photo, contribution, and voice note, replaces the scheduled instant, and resets both confirmations to pending.
- The counter-proposal is sent through the signalling server as appointment metadata, using the same storage and delivery rules as the original notice. If the other human is offline, the server holds the update until their next connection.
- The other human is notified of the counter-proposal and can confirm the new time or counter-propose again. There is no limit on the number of rounds beyond ordinary server retention.
- A confirmation or counter-proposal never changes the photo bytes, relationship, circle membership, or another rendezvous. The server stores metadata only.
- The state converges from the signed/current update: clients retain the highest revision, merge confirmations for the same proposed time, and display the latest proposed moment.
- A counter-proposal after the handoff session starts is refused. A completed rendezvous cannot be reopened.

#### US-8 — We meet only when both are online
As a sender and recipient, we need to understand when a handoff can actually happen.

**Acceptance criteria**
- Before five minutes before the scheduled moment, either side sees the upcoming appointment and no transfer occurs.
- As soon as both humans are online anywhere in the `[T − 5 minutes, T + 5 minutes]` window, the sender automatically opens a direct WebRTC connection and hands off. If both are already online beforehand, the connection starts when the window opens at `T − 5`. No photo-level confirmation is required; the pending/confirmed label from US-7b never gates the handoff.
- Both early and late presence count: both online at `T − 4`, at `T`, or at `T + 4` all exchange automatically. Five minutes late is still on time.
- The handoff eligibility is not withdrawn at `T + 5`: if both are still waiting or return later, the photograph transfers at the next overlap.
- Lateness never expires or deletes a pending rendezvous. Once both humans are online together at/after the opening, the handoff happens.
- If only the sender is online, the sender sees “Waiting for [name] to come online.”
- If only the recipient is online, the recipient sees “Waiting for [name] to come online. Your photo is still with them.”
- If neither is online, nothing happens. On the next overlap of both browsers after the handoff window opens, the transfer begins.
- If the transfer is interrupted, it is retried automatically while both remain online. The photo remains on the sender.
- Success is shown in both UIs only after the recipient has received the complete file and acknowledged it.
- When both humans are connected, the app presents the live rendezvous screen (US-8b). Dismissing it never pauses or cancels the handoff.
- If the recipient attached a reciprocal photo (US-10b), the same authenticated session carries both directions; each direction is acknowledged independently.
- The system never claims a photo was delivered because a time passed or because the server stored a notice.
- The ±5-minute window is computed locally from the scheduled timestamp; no extra server state or appointment is created.
- At 5 minutes before the time, if the recipient is online, a “the handoff is open” alert is raised. At the scheduled time, the appointment is labelled as due; it remains labelled “still open” through `T + 5` without blocking a later completion.

#### US-8b — The live rendezvous screen

As a participant in a happening rendezvous, I want a focused screen when both of us are connected, with a clear **start audio 1min** action, so that the meeting feels present and the one-minute voice moment is one tap away.

**Status:** Implemented in v0.1.

**Acceptance criteria**
- The live rendezvous screen appears when the appointment’s handoff window is open and both humans are online. It is the appointment’s live surface; the compact upcoming row and its **live** action remain a persistent way back if the screen is dismissed. Selecting the row itself opens the rendezvous detail (US-10c), whose live action opens this screen.
- The screen shows both code names, the scheduled moment, the handoff state (waiting, connecting, transferring, delivered, or retrying), and the state of each photo contribution. It does not auto-open a photo full-screen.
- It presents one primary action, labelled exactly **start audio 1min**, unless live audio is disabled for the rendezvous. The action is enabled when both humans are online, the window is open, the rendezvous does not carry the **I won’t be able to speak** flag, and the single audio window for this rendezvous is unused. Pressing it starts the consent flow; the audio peer session must then authenticate both pinned identities before any microphone audio flows. It is never started automatically.
- When the rendezvous carries the **I won’t be able to speak** flag, the primary audio action is replaced by a quiet read-only line: **Live audio is off for this rendezvous.** The reason is available as **I won’t be able to speak.** No consent request is sent or accepted, and no audio window exists to consume.
- Pressing **start audio 1min** sends the consent request from US-9b. If the other person declines or microphone permission is denied, the screen stays usable, explains why audio did not start, and does not block the photo handoff.
- While audio is live, the screen shows the one-minute countdown, mute, and end controls. Minimising the screen collapses it to the persistent audio strip (VDS-10b) without ending the audio.
- If a live audio window ends at 60 seconds, on explicit end, or through disconnection, the screen shows “the minute is over” and disables **start audio 1min** for that rendezvous. A live audio window is not cut short merely because a photo finished transferring; it still ends at the 60-second cap or on disconnection.
- If one human disconnects, the screen changes to a waiting state and audio ends if it was live. The screen returns to the live state when both are present again; **start audio 1min** becomes available again only if live audio is not disabled and the single audio window was not consumed (US-9b).
- The screen can be dismissed or minimised at any time without cancelling the appointment, closing the peer connection, or stopping an in-progress photo transfer.
- When the appointment completes, the screen shows an honest delivered state and offers a return to the wall. It never claims delivery before the recipient’s ACK.
- The screen is not a general call surface. It exists only for an appointment that is currently live and leaves the main surface when the meeting ends.
- Keyboard focus moves into the screen on open, focus is visibly indicated, state changes are announced with `aria-live`, and reduced-motion preferences are respected.

#### US-9 — I receive a photograph
As a recipient, I want to know when a photo actually arrives and be able to view it later.

**Acceptance criteria**
- An incoming transfer shows a connected “receiving” state and progress.
- Completed photos are persisted to the recipient’s IndexedDB.
- If both participants attached photos, each receives the other’s. The two directions are verified, stored, and acknowledged independently; a missing or failed direction never blocks the other.
- A completed incoming photo raises a notification with an “Open” affordance.
- A completed handoff triggers a brief confetti celebration in both browsers. It must be non-blocking, must not obscure controls, must fire once per rendezvous, and must be skipped when the user prefers reduced motion.
- Every delivered photo appears on a persistent photo wall (“the wall”), starting from the first and ordered by arrival.
- The freshest delivered photo is rank 01; each later-ranked photo is progressively smaller according to a power-law distribution.
- The wall has generous whitespace below the top menu and is composed as a board, not a horizontal filmstrip.
- Each piece shows its rank, sender, arrival time, and a small audio badge if a voice note is attached. The image can be opened in a distraction-free viewer and downloaded to the device.
- A failed or interrupted transfer never leaves a corrupt photo in the archive.
- Duplicate appointment IDs and duplicate transfers are idempotent.

#### US-9b — We can speak for one minute during the rendezvous

As two people meeting for a photo handoff, we want a short live voice channel at the rendezvous, so that the moment can include a greeting, context, or goodbye without leaving Rendezvous.

**Status:** Implemented in v0.1, including the **I won’t be able to speak** disable flag.

**Acceptance criteria**
- Audio is offered only for a rendezvous whose handoff window is open, whose creator did not set **I won’t be able to speak**, and while both humans are online. It is attached to that appointment, not a general calling feature.
- The request is made from the live rendezvous screen (US-8b) through the control labelled exactly **start audio 1min**. Consent, countdown, mute, and end states live on that screen.
- When the appointment carries the live-audio-disabled flag, neither human can request, accept, or restart live audio for that rendezvous. The control is replaced by the read-only line **Live audio is off for this rendezvous.** No consent message is sent, and no audio window is consumed because none exists.
- The flag affects only live audio. Photo voice notes, the photo handoff, notifications, and the wall are unchanged.
- Unless live audio is disabled, either human can request a one-minute audio window; both must explicitly accept and grant microphone permission before any audio flows.
- The window is one minute of **connected airtime**, maximum. Only one successful audio window exists per rendezvous.
- Both sides show a visible and screen-reader-announced countdown. At 60 seconds, both clients stop microphone tracks, close the audio peer connection, show an unambiguous “the minute is over” state, and disable the audio action for that rendezvous.
- Either person can mute locally or end the window early. Mute state is visible to both. Ending early consumes the window.
- If either person disconnects, closes the page, revokes microphone permission, or backgrounds/suspends the browser long enough to break the audio session, the call ends. The window is consumed; it cannot be restarted for that rendezvous.
- If one person declines a request or microphone permission is denied, the photograph handoff remains unaffected and well-behaved. A declined request does not itself consume the window.
- The audio is live only. The app never records, buffers for later, transcribes, or uploads audio. The signalling server never carries audio bytes.
- Audio is camera-off and one-to-one. There is no video, group audio, hold music, or voicemail.
- The audio peer connection is authenticated by the same pinned long-term identities and signed DTLS-fingerprint handshake used for photographs before any microphone audio is transmitted.
- Works alongside a waiting, connecting, or transferring photo handoff without breaking or duplicating it.
- A failed audio attempt never blocks the photo transfer.
- Browser microphone permission and the secure-context requirement are handled with clear recovery copy.

#### US-9c — I can attach a voice note to a photograph

As a sender, I want to add a short spoken note to a photo, so that the recipient hears the story in my voice alongside the image.

**Status:** Implemented in v0.1.

**Acceptance criteria**
- Each share may include one optional voice note, recorded in the browser, with a hard maximum of 60 seconds.
- Recording is started only by an explicit action and is stopped automatically at 60 seconds. The sender can preview, replace, or delete the note before scheduling.
- No recording begins when a photo is selected or when the rendezvous composer opens.
- The note is stored locally with the photo attachment, never uploaded to or transcribed by the server, and transferred only over the same authenticated peer-to-peer handoff as the photo.
- The handoff is atomic at the user level: a delivered photo shows with its note if present. A failed transfer retains both on the sender and retries together.
- The recipient can play and pause a received note, sees its duration, and playback never autoplays.
- The recipient may download or delete the local photo + voice note together; deleting one removes the local note.
- On the wall and in the photo viewer, a small audio indicator marks prints with a voice note.
- A voice note does not make a photo public and cannot be addressed to anyone other than the chosen human.
- The note uses browser microphone permission. A denied permission simply leaves the share without a note.
- Live one-minute voice (US-9b) is a separate feature: a voice note is asynchronous and attached to a photo, not a call.
- No transcription, captions, or speech-to-text in the first release.
- If a photo is re-shared locally, its voice note travels with it by default, unless explicitly replaced or removed.

#### US-9d — I can re-share a photo I already sent

As a sender, I want to share an existing photograph with another human without choosing and uploading the file again, so that a moment can travel to more than one person.

**Status:** Implemented in v0.1.

**Acceptance criteria**
- A delivered **outgoing** photograph in the photo viewer offers a **Share again** action.
- Share again opens the normal three-stage rendezvous composer with the photograph already attached from local storage. No file picker, new upload, or server media reference is required.
- The sender chooses one person — a linked human or **someone new** — and a time; a new appointment ID is created.
- The local photo bytes and any attached voice note are reused. The sender may review or replace the voice note before scheduling.
- Each share is an independent rendezvous and an independent wall print after delivery. Deleting the new appointment or its delivered print must not delete the source photograph, the old appointment, or another share.
- Delivery remains peer-to-peer; only appointment metadata goes to the signalling server. Nothing is uploaded to a media server.
- Private received photos are **not** eligible for local re-share in this phase. Re-sharing someone else's photo is only addressed by the future public-photo layer.
- Removing the recipient cancels that pending reshare in the normal way. Removing one human does not affect reshares with other humans.
- A photo may be re-shared to the same human or someone else; each appointment has its own timing, status, and notification.
- If all local source copies of the photo are deleted, Share again is unavailable.
- The simple three-stage composer remains three stages; a re-share is a preseeded normal appointment, not a new fourth flow.

#### US-9e — I can see who holds a copy of my photograph

As the owner of a photograph, I want a per-photo possession inventory, so that I can see who received a copy through Rendezvous and whether they have since reported deleting it.

**Status:** Implemented in v0.1.

**Acceptance criteria**
- Each locally originated photograph has a stable content-derived `photoId` that survives local re-shares. Possession is tracked per `photoId`, not per appointment ID.
- The owner can open an outgoing delivered print and see a **held by** inventory: every human who received a copy through Rendezvous, the number of copies delivered, and the latest confirmed state/time. The owner’s own local copy is implicit and need not be listed.
- After storing and ACKing a delivery, the recipient sends a signed possession claim: `{ photoId, holder, appointmentId, at, sig }`. The owner verifies and merges claims idempotently by holder and photo.
- When the recipient deletes its local copy, its client creates a signed possession release: `{ photoId, holder, at, sig }`. A later release supersedes an earlier claim; a later claim supersedes a release when a new copy is delivered.
- The owner can request a fresh possession check while the holder is connected. The holder responds with a new signed claim or release. The inventory shows the time of the last check.
- The inventory uses honest states:
  - **deleted** — the latest signed release has been received;
  - **confirmed now** — the holder is connected and has returned a fresh claim during this session;
  - **last confirmed [time]** — a claim exists but the holder is offline or has not answered a fresh check;
  - **not connected** — the human relationship was removed; the last known copy state remains.
- The UI must never claim that an offline holder **currently** holds a copy. “Last confirmed” is the strongest statement available without a live response.
- Tracking is best effort by design. A device lost, wiped, or permanently offline cannot be distinguished from a device that still holds the copy. Copies exported outside Rendezvous — downloads, screenshots, sends through other apps — are outside the inventory. The UI must say **known copies delivered by Rendezvous**, not “every copy in existence.”
- Possession claims and releases travel only over authenticated channels between the owner and the holder. They contain no photo bytes, thumbnail, or preview. The signalling server may deliver or briefly queue a signed notice like other appointment metadata, but it must not keep a possession ledger or disclose the holder list to anyone else.
- Removing a human does not delete their copy, erase the historical claim, or permit remote recall. The inventory retains the last known state.
- Only the photo owner sees the full holder inventory. Recipients do not learn who else holds the photo, and third parties cannot query it.
- If the owner deletes all local copies of the photo, the photo viewer and its possession inventory are deleted with it.
- Public re-shares (`US-20`) use the separate public provenance layer and are not counted as private holders until that layer exists.
- Possession tracking never gates delivery, never makes a handoff conditional on a holder response, and never creates a server-side record of private media.

#### US-10 — I can see what is next


As a user, I want to see my upcoming and waiting rendezvous without opening a separate inbox.

**Acceptance criteria**
- A compact “next/upcoming” area presents scheduled and waiting appointments.
- While at least one rendezvous is pending, this area and the hero countdown are the primary surface; the large **Set a rendezvous** action is hidden (US-6, VDS-5) until no pending appointment remains.
- Each item identifies the human, local time, opening window, and state.
- Selecting an upcoming item opens that rendezvous’s detail (US-10c), not the human-detail or verification panel. The detail leads with the attachment this browser will exchange and keeps the eight comparison words available in a collapsed-by-default disclosure.
- Waiting items clearly say who needs to be online, or that the other person has not joined yet.
- Delivered photos move onto the ranked wall.
- Pending and waiting rendezvous are kept in a quiet strip above the wall, separate from the photo sequence.
- A row and the rendezvous detail for a rendezvous I did not create offer **add a photo** until I contribute or the handoff session begins (US-10b).
- A user can delete a photo or pending appointment locally. Deleting a photo removes it from IndexedDB and re-ranks the remaining wall items.

#### US-10b — I can add my photo to a rendezvous I did not create

As a recipient, I want to see an upcoming rendezvous and attach a photo of my own to it, even though I did not create it, so that the meeting can be a mutual exchange.

**Status:** Implemented in v0.1.

**Acceptance criteria**
- The rendezvous appears in my upcoming area (US-10) as soon as my client persists it — from the invitation link when I am the **someone new** recipient, or from the server notice when I was already linked — whether I was online when it was created or saw it on my next launch.
- The row and its detail identify the creator, the local moment, the handoff window, and the current state. The creator’s photo is never previewed, downloaded, or referenced before the handoff.
- A rendezvous I did not create offers **add a photo** until I attach one or the handoff session begins. The action attaches the photo to the existing appointment ID as my reciprocal contribution. It does not create a second appointment, change the time, or replace the creator’s photo.
- I can add my photo while the creator is offline; it stays local and is not announced to the signalling server.
- I may preview, replace, or remove my contribution before the handoff session begins. Once the session begins, contributions are locked for that meeting.
- A rendezvous carries at most one photo per participant. My contribution is optional; the creator’s photo still transfers if I add none.
- My photo is validated (image MIME type, maximum 25 MiB) and stored only in my IndexedDB. It is never uploaded, encoded into, or referenced by the signalling server. If voice notes are available (US-9c), my contribution may carry one under the same rules.
- When both of us are online and the handoff runs, each side sends the photo it holds. The two directions use the same authenticated session but are verified, stored, and acknowledged independently. A missing or failed direction never blocks the other, and a retry never duplicates a completed delivery.
- A contribution cannot be added after the creator’s photo has been delivered; the completed appointment does not reopen.
- My contribution state is visible in my upcoming row. The other participant learns whether I contributed only over the authenticated peer session; contribution metadata is not added to the server notice and carries no image bytes.
- Delivered photos follow US-9: each is persisted on its recipient’s wall, and the sender’s existing outgoing print remains under the normal direction labels. Deleting one local print never deletes the other participant’s print or the source on another device.
- Deleting the appointment or removing the human follows existing rules; delivered prints remain until individually deleted, and the server never holds either photo.

#### US-10c — An upcoming rendezvous opens on what I have attached

As a participant checking a meeting, I want selecting an upcoming rendezvous to show the photograph and voice note I am bringing, so that I can confirm the exchange without landing in a key-verification panel.

**Status:** Implemented in v0.1.

**Acceptance criteria**
- Selecting an upcoming rendezvous row opens that rendezvous’s detail panel. It does not open the human-detail or verification panel.
- The detail leads with the exchange. It shows the photograph this browser has attached for this meeting, its optional voice note with duration and explicit play/pause (never autoplay), and a plain state such as **your photo · added** or **your photo · not added yet**.
- For a rendezvous I did not create, the detail offers **add a photo** when I have no reciprocal contribution and the handoff session has not begun. After attachment it offers preview, replace, and remove under US-10b rules.
- The counterpart’s contribution is shown only as state — for example **Ana’s photo · waiting**, **added**, or **delivered**. It is never shown as a thumbnail, blurred preview, placeholder image, filename, size, voice-note player, or object URL before the handoff.
- The panel repeats the local moment, the handoff window, the direction (**from** or **to** the human), and the honest handoff state under US-10 and US-12. The live action appears only under the existing US-8b conditions.
- If the rendezvous was marked **I won’t be able to speak**, the detail shows the quiet read-only line **Live audio off for this rendezvous.** It never offers an audio action.
- The eight comparison words remain available in a disclosure inside the detail, labelled with the human’s verification state. The disclosure is **collapsed by default every time the detail opens**; the words are not rendered, focused, or announced until the person expands it.
- Expanding verification shows the same eight words, comparison instruction, and **Mark as verified** action as the human panel (US-3b, VDS-11b). Collapsing it does not discard or change verification.
- The human’s name and avatar remain a separate path to the full human panel (verify, forget) without competing with the exchange content.
- If my own attached photo or voice note is missing locally, the detail says so plainly and offers to choose a replacement. It never presents the meeting as ready when the attachment is gone.
- Selecting a delivered photograph opens the photo viewer, not this detail.
- Closing the detail with Escape, the close control, or an outside click never cancels the appointment, unlocks a locked contribution, or changes any attachment.
- Keyboard focus moves into the detail on open. The verification disclosure is a button with `aria-expanded`; focus never lands inside collapsed content. Handoff-state changes use `aria-live`.
- The detail adds no preview of the counterpart’s media and no new server message. Everything shown comes from local IndexedDB and existing appointment metadata.

### Circles

A circle is a named, private group of linked humans. Membership and each offered moment are represented as signed records that every member can verify and merge. A circle does not have one canonical group meeting. Any member may offer a moment, any member may join any offer, and a single invitation can become several independent parts of the group meeting at different times. A circle may optionally define a time window that limits when offers may be scheduled. A circle offer is metadata; photographs still travel only in direct pairwise WebRTC handoffs, never through the server.

**Implementation status:** `src/circles` implements the signed record set, membership chain, addressed invitations, independent offers and per-offer joins, optional signed time windows, stats, auto-accept, the expiring store-and-forward circle offer invite, and an online relay-backed invitation/sync path between connected mutual humans. The reference app uses the existing authenticated signalling server as an opaque relay while both humans are online; the server stores no circle record history and never verifies, alters, or chooses records. Offline membership and attendance sync waits for the next online overlap; only the circle offer invite is stored for an offline member, until its scheduled time.

#### CIR-1 — Circle rendezvous are independent offers

As a circle member, I want to offer a moment without forcing the whole group into one canonical meeting, so that the people who can come at that time can meet.

**Acceptance criteria**
- Any current member may create a signed circle offer for a scheduled moment; there is no owner or admin privilege.
- Every valid signed offer is retained and visible as its own offer. There is no canonical winner per local day and no rule that a later offer replaces an earlier one.
- Several offers may exist for the same circle and local day, at different times. They may run independently and are not alternatives that must collapse into one choice.
- The offer record carries only circle ID, rendezvous ID, organizer, invitees, scheduled timestamp, signed creation timestamp, and signature. It never carries photo or voice bytes.
- An offer is metadata. Actual meetings remain direct pairwise handoffs under the normal online and five-minute-window rules. Each member decides whether to join or attend an offer.
- A member joining an offer creates a signed PlanJoin record naming that offer. Joining is per member and per offer; a member may join more than one offer if they choose.
- An offer with no joiner is **pending**. An offer with at least one other participant is **confirmed** for those participants. Confirmation is a label only and never blocks a pairwise handoff.
- No member is expected to join every offer, and no offer requires the whole circle to attend.
- Attendance counts a kept pair regardless of which offer brought the pair together. An attendance pair is not discarded because another offer exists for the same day.

#### CIR-2 — A counter-proposal becomes another offer

As a circle member, I want to counter-propose a different time without cancelling what others already arranged, so that a single invitation can grow into several parts of the group meeting.

**Acceptance criteria**
- A counter-proposal is a new signed offer with its own scheduled timestamp and organizer. It does not mutate, cancel, or hide the offer it responds to.
- The original offer remains available and joinable. Members may join the original, the counter-offer, both, or neither.
- A counter-offer is delivered through the server under the same rules as the original circle offer invite, because it carries the same signed metadata shape.
- Every offer is independent for confirmation: joins attach to one offer ID and never confirm a different offer.
- Offer identity is the content-derived record ID; the offer's rendezvous ID identifies the moment used by attendance and stats.
- Invalid, unsigned, wrong-circle, non-member, or out-of-window offers never become visible offers and never count.
- The signalling server may relay or store the offer invite, but it cannot create, alter, re-sign, choose, rank, or promote offers.

#### CIR-3 — Circle membership is voluntary, auto-accepted for now

As a person invited to a circle, I want membership to be explicit and auditable, so that joining is recorded and I can leave.

**Acceptance criteria**
- A circle invitation is signed by a current member and addressed to one public-key identity. Unlike a rendezvous invitation link, it cannot be redeemed by whoever holds it.
- Accepting the invitation creates a signed Join record; declining creates no membership record.
- For the current build, the client auto-accepts a valid incoming circle invitation. This is a temporary client policy, not a weakening of the signed membership chain; an explicit accept/decline surface remains the later intent.
- Auto-accept verifies the invitation signature, circle ID, the inviter's current membership, and that the invitation is addressed to this browser's key. Invalid, mismatched, or forwarded invitations are ignored.
- The inviter still merges the signed Join. The server never adds a member on its own.
- The signalling server may relay the signed invitation, Join, and Leave records as opaque metadata between connected mutual humans. It stores none of them, verifies no signature, and adds no member on its own. Offline membership records wait for the next online overlap; they are not queued.
- The reference client auto-accepts a valid invitation. The explicit consent card remains available as a fallback when automatic verification fails.
- A member can leave a circle at any time, including one joined by auto-accept.

#### CIR-4 — The server stores only circle offer invites

As a circle member, I want an offer delivered even when I was offline, without turning the signalling server into a store of circle history.

**Acceptance criteria**
- The member who creates a circle offer submits a signed invite to the signalling server. A counter-proposal is a new offer with its own signed invite and follows the same path.
- The invite names its recipients, so the server can deliver it without storing or deriving the circle's membership. The recipient list is signed by the organizer and verified by recipients.
- The server stores only offer invites, and only until the offered time has passed. It must not store the circle record log, membership history, Join/Leave records, attendance, stats, or any other signed circle record.
- An invite expires once the offered time has passed, not at the end of the local day. Expired invites are deleted from the server; members keep their local copy.
- The server delivers each stored invite immediately to online members and on next connection to offline members. It may hold many invites for a circle and day. It never chooses, ranks, or promotes an offer.
- Circle membership records, Join/Leave records, offer joins, attendance, stats, and offer history are never stored by the server. While both humans are online they may be relayed as opaque signed metadata between mutual direct humans; the server is not authoritative.
- The server relays the invite verbatim. It cannot create, alter, re-sign, choose, promote, or add members.
- Duplicate deliveries, reordered delivery, and reconnects are idempotent by invite ID.
- Clients verify every signature and merge offers and joins locally; a server-delivered invite has no extra authority over an RTC-delivered one.
- A circle offer invite is not a membership invitation; receiving it never changes circle membership.
- Photos, voice notes, thumbnails, and media references are never part of an invite.
- For clarity: an invite may carry a signature, but storing the invite is not permission to store the circle's record set.

#### CIR-5 — Two online members sync automatically

As circle members, we want our browsers to exchange circle records whenever at least two of us are online, so that the circle stays current without a manual action.

**Acceptance criteria**
- When at least two members of a circle are online, their clients automatically exchange membership, offer, and join records over authenticated direct peer channels.
- The server may relay opaque signed records while both members are online, but it stores none and never chooses, ranks, or promotes an offer.
- No manual sync, accept, or refresh action is required.
- Sync is idempotent and order-independent; duplicate, out-of-order, or replayed records converge on the same offer and join set.
- A member coming online, reconnecting, or returning to the tab triggers sync.
- The server's invite delivery and RTC peer sync are complementary. Losing either one does not permanently fork the offer set.
- Only signed circle metadata moves over RTC. Photographs and voice notes remain in direct pairwise handoffs.

#### CIR-6 — A circle can limit offers to a gathering period

As a member of a full-moon gathering circle, I want offers to be set only during our gathering period, so that the group's moments fall on the night we come together rather than on an arbitrary day.

**Acceptance criteria**
- A circle time window is optional. When a circle has none, any scheduled offer instant is allowed, subject to CIR-1.
- The window applies only to circle offers. Ordinary one-to-one rendezvouses between members are unaffected.
- Any current member may set, replace, or clear the circle's time window; there is no owner or admin privilege. A window record is signed, circle-scoped, and synced like other circle records over authenticated RTC. The signalling server never stores it.
- An active window is one bounded interval with an inclusive start and an inclusive end, chosen in the circle's IANA timezone and stored as absolute instants. It may cover a single evening, a weekend, or a longer season. The start must precede the end.
- The window limits an offer's scheduled instant, not the moment the offer is signed: a member may offer a moment months ahead as long as the moment itself falls inside the window.
- An offer is validated against the window record with the latest signed creation timestamp that is not later than the offer's signed creation timestamp; ties break by record ID ascending. A clear record at that position removes the restriction. If no window record precedes the offer, the offer is unconstrained. This selection is local and deterministic; a late-arriving earlier window record can change it for affected offers.
- A later window or clear record never retroactively invalidates an offer that was valid when signed.
- A signed offer whose scheduled instant is outside the active window is rejected by merge. It never appears as an offer, counts in circle stats, or produces a circle offer invite. The client refuses to sign such an offer in the first place.
- The offer surface shows the active window in the circle's timezone and refuses an out-of-window scheduled instant before signing. A circle without a window shows no extra restriction.
- The window does not change the five-minute handoff window, cancel an already-valid offer, or alter attendance or stats. An offer inside the window still meets under the normal direct-handoff rules.
- Several offers may fall inside the same window on the same day. Each remains independent.
- Window records carry only circle ID, start and end (or a clear marker), author, signed creation timestamp, and signature. They never carry photos, voice notes, thumbnails, or media references.

**Example — full moon gathering**

Ana belongs to the circle **Moon Garden** in `Europe/Berlin`. The November full moon peaks on 24 November 2026, so a member sets the circle's time window to **24 November 2026, 19:00–23:00 local time**. Ana offers **21:30**; Baz joins it. Bo cannot make 21:30 and offers **22:15** instead; Ana joins Bo's offer too. Both offers run as independent parts of the gathering, each with its own participants.

- An offer for **18:30** or **23:30** on 24 November is refused as outside the window.
- An offer for **21:30 on 25 November** is refused because the window has ended.
- At 21:30 the normal pairwise handoffs for Ana and Baz run under the usual `[T − 5 minutes, T + 5 minutes]` window. The circle window adds no meeting time and carries no photo.
- Later, the circle sets a new window for December's full moon. The November offers stay valid and counted.

### Privacy, reliability, and errors

#### US-11 — Private photos never pass through the server
As a privacy-conscious person, I want confidence that only a direct transfer moves my photograph.

**Acceptance criteria**
- The private signalling protocol has no photo bytes, voice-note bytes, thumbnails, or photo-derived metadata field. The future public layer (US-20) is a separate, explicit surface with its own storage, consent, and moderation rules.
- Photos are sent only through an ordered WebRTC data channel after both browsers are present.
- WebRTC media/data is encrypted in transit by DTLS-SRTP / SCTP over DTLS.
- The server stores appointment metadata, expiring circle offer invites, and relationship handshakes, but not image content or circle record history.
- If a peer is unreachable (for example, symmetric NAT without TURN), the UI reports that the direct connection could not be made and keeps the photo on the sender.
- The default ICE configuration uses a public STUN server; deployments can supply TURN for hard networks.

#### US-12 — I understand failures
As a user, I want honest state, not a silent spinner.

**Acceptance criteria**
- Signal connection, peer presence, appointment sync, and transfer progress are distinct states.
- The UI reports: invite queued, recipient online/offline, waiting for the other human, connecting, transferring, received, and failed.
- Retries happen automatically with backoff.
- In-app errors are plain language and do not destroy the photograph.
- The app keeps working for already-stored photos while the signalling server is down.

### Reuse

#### US-13 — Another component can reuse the service
As a future Instant Hero component, I want to import the Rendezvous service without inheriting this exact page, so that I can build another surface on the same network.

**Acceptance criteria**
- A headless `RendezvousClient` exposes identity, humans, presence, scheduling, invitation, removal, transfer events, and snapshots.
- The shipped page is a thin custom element (`<rendezvous-app>`) built on that client.
- The package exposes ESM output and TypeScript declarations.
- UI styles are encapsulated in a shadow root and do not leak into the host page.
- The client supports configuration of the signalling URL and ICE servers.
- The base does not assume React, a router, a database, or a backend beyond the included reference signalling server.

#### US-13b — I can see what kind of connection I have
As a curious or troubleshooting user, I want honest network diagnostics, so that I can tell whether the bootstrap path and the direct path are using IPv4 or IPv6.

**Status:** Diagnostics, the very-top-right placement, and the exact **live** label are implemented in v0.1.

**Acceptance criteria**
- The live indicator sits in the very top-right corner of the page, in the safe area on mobile. It opens a small diagnostics panel.
- When the signalling connection is live, the indicator’s visible text is exactly **live**. It is not prefixed with, or accompanied by, the word “signal”; other states read **connecting**, **off**, or **another window** without that prefix. Its accessible name may explain that it reports the signalling status.
- The indicator is a quiet text-and-dot trigger, not another loud button. The dot and word together carry the state, never colour alone.
- The panel shows the signalling status and how many linked humans are online.
- It shows the bootstrap connection's observed address family (IPv4 or IPv6), the server's advertised dual-stack capability, and any single-stack warning.
- It shows the most recent direct connection's selected local and remote candidate families, candidate types, and transport protocol.
- It shows IPv4/IPv6/hidden counts for gathered local and remote ICE candidates.
- It explains that address families belong to the network and that Rendezvous cannot assign an IPv6 address to a device.
- If mDNS host candidates hide the family, the panel says so rather than pretending no IPv6 exists.
- The app never filters out IPv6 candidates. It requests both families from the browser automatically.
- The bootstrap server listens dual-stack by default (`::`) and logs a prominent startup warning if configured single-stack. It advertises its capability to clients.
- Deployment documentation requires a dual-stack reverse proxy/load balancer and dual-stack STUN/TURN endpoints for IPv6-only peers.

#### US-14 — Future peers can act as signalling relays
As the network matures, we want connected peers to help relay signalling traffic.

**Acceptance criteria (future, not v1)**
- The client’s signalling transport is an interface, so a WebSocket server can be replaced or supplemented by a peer relay.
- No v1 feature is blocked by designing for this later.
- The limitations in §14 are documented before implementation.

#### US-20 — I can re-share a photo another user made public (later)

As a viewer, I want to re-share a photograph that its owner has explicitly made public, so that a public moment can enter my own private rendezvous.

**Status:** Explicitly deferred beyond v1. Public photos are **not** part of the private no-server-media architecture and are not implemented or promised in the initial service.

**Acceptance criteria for the eventual public layer**
- Private remains the default. A photo becomes public only through an explicit, revocable choice by the person who owns that local photo.
- Public photos may be re-shared without downloading and uploading the original file again; the public media layer provides a stable reference.
- Public re-shares preserve attribution to the original owner and cannot remove provenance.
- The original owner can stop new public access and disable further re-shares. Copies already delivered to a private rendezvous cannot be remotely recalled; this is disclosed before publishing.
- The owner chooses separately whether a voice note is public or stays private.
- Public content requires moderation, reporting, takedown, retention, caching, and storage rules that do not apply to private photos. These must be designed before launch.
- Public media requires a separate storage/CDN or peer-hosting design; it must never silently route private photos through it.
- A public photo cannot be used to infer or expose the owner's other private rendezvous or connections.
- Public discovery/feed/browse is out of scope; a public link/asset is the minimal future primitive.

---

## 4. Marketing user stories

These stories govern the public promise of the product. They do not add features; they constrain the claims made on landing pages, share cards, and empty states so marketing never contradicts the private, peer-to-peer invariants.

#### MKT-1 — I understand the promise in one line

As someone deciding whether to trust Rendezvous with a photograph, I want the product’s promise stated plainly, so that I understand what it offers and what it does not.

**Acceptance criteria**
- The headline promise is exactly: **“Your photos, kept alive by the people who love you, for free.”**
- It describes the relationship, not server storage: photographs persist because the people who care keep them, not because a cloud account does.
- It appears on the public landing/about surface and in single-tagline share cards; inside the app it must never displace **Code Name** or **Set a rendezvous**.
- Supporting copy may explain the meeting rule: photos move only while both people have the app open, and there is no upload or media server in the private path.
- It must not imply guaranteed delivery, background sync, permanent server storage, or availability after the tab is closed.
- “For free” applies to the private v1 service; a future public or paid layer must not retroactively change the claim.
- Tone is intimate and plain, with no exclamation marks, urgency, or growth-hack language.
- The line wraps without truncation on mobile and does not push the primary in-app actions below the fold.

---

## 5. Visual design user stories


The visual direction is an editorial, quiet private club: warm paper, black ink, one vermilion accent, and a single loud black invitation control. It should feel more like a printed appointment card than a social app.

### VDS-1 — First impression
As a first-time visitor, I see a calm, confident surface with two clear anchors: **Code Name** at top-centre and **Set a rendezvous** in the middle. I understand that the first meeting begins by setting a rendezvous, not by adding a contact.

Acceptance:
- Page background is a warm off-white paper tone, not pure white.
- Typography pairs a large editorial serif with compact sans/monospaced utility labels.
- One accent (vermilion) is used sparingly for live/attention dots and notification marks.
- No stock photography, avatar farms, or dashboard chrome.
- A quiet centred masthead (“rendezvous by InstantHero”) may sit above the header. It is a wordmark, not a control.
- There is no **add human** control, link button, or empty-state action in the header or humans area.
- With no humans, the humans area reads as an invitation to set a rendezvous for **someone new**, not as a missing-contact warning.
- The first screen fits without scrolling at 1280×800; secondary collections sit below or at the bottom edge.

### VDS-2 — The someone-new choice
As a sender with no linked humans, I can start a real relationship from inside the rendezvous flow.

Acceptance:
- The **Photo + person** step always lists linked humans and one **someone new** row.
- With no linked humans, **someone new** is selected by default and is the only available person choice.
- The row is visually a peer choice, not an admin action: same avatar-disc language, name **someone new**, and a quiet line explaining that the link will be shown after scheduling.
- Choosing it never opens a second dialog, link panel, or contact form.
- The composer remains three stages; **someone new** is not a fourth flow.
- The primary next action stays **Continue** and is disabled only until both a photo and a person choice exist.

### VDS-3 — The rendezvous invite link
As a sender who chose **someone new**, I see the link in the completion step, where the meeting is already defined.

Acceptance:
- The link appears only in the DONE stage of a rendezvous created for **someone new**. It is never available from a standalone header action.
- The panel is part of the DONE card, visually like the back of an invitation: dark ink surface or a paper inset, with a short heading, the resolved moment, a one-line explanation that opening it creates the human link and delivers this rendezvous, a read-only join link, and a copy action.
- Copy says plainly that the person can open it at any time; the photo still moves only when both browsers are open at the handoff.
- A copied state changes text to “Copied” and announces it accessibly.
- Close/finish dismissal leaves the rendezvous saved and the link available again from the upcoming row’s **share link** action.
- On small screens the DONE card becomes a sheet that stays within the viewport.

### VDS-4 — Code Name
As a returning user, I can see and edit how I appear without the name field feeling like a form.

Acceptance:
- Horizontally centred at the top of the page.
- Borderless/flat until focused; placeholder is exactly **Code Name**.
- Comfortable text size (at least 16 px on mobile), centred text, generous hit area.
- A quiet helper label (“this is how you appear to others”) may sit below in small caps.
- Focus reveals a thin ink underline and accent caret; no glowing box.
- Max length and empty state do not break the layout.

### VDS-5 — Set a rendezvous
As a sender, the central action is the calm focal point.

Acceptance:
- Centred in the primary scene, clearly interactive, labelled exactly **Set a rendezvous**.
- Present only when no rendezvous is upcoming or pending. While one exists, the large stamp is removed entirely — not disabled, faded, or replaced by another large CTA in the hero — and the hero gives its space to the next meeting countdown and moment.
- The large stamp returns automatically when the last pending rendezvous is delivered or deleted.
- More expressive than a standard rounded rectangle: a large circular stamp/portal or similarly distinctive action, in the black/ink language, with a precise arrow.
- Hover/focus causes a restrained fill or orbit movement; nothing bounces or loops distractingly.
- The action remains obviously tappable on mobile.
- The surrounding hero copy explains the meeting condition in one sentence.

### VDS-6 — Photo and human step
As a sender, choosing the content feels personal.

Acceptance:
- Modal is a warm paper card, visually consistent with the page.
- Photo dropzone supports click and drag/drop; shows a preview immediately after selection.
- Person choices appear as simple rows with initials/avatar discs, names, and online badges for linked humans. A final **someone new** row uses the same language and explains that the join link appears after scheduling.
- The primary next action is disabled until both a photo and a person choice are chosen, with a clear explanation.
- If there are no linked humans, **someone new** is selected by default. The step never sends the sender to a separate add-human flow.
- An optional **add a voice note · up to 1:00** control sits beneath the photo preview. It does not compete with choose/continue.
- A photo with a note shows a small audio badge in the composer and later on the wall print.

### VDS-6b — Voice note

As a sender, I can add a spoken minute to my photograph without turning the page into a recording studio.

Acceptance:
- The voice-note control is a quiet text action beneath the photo: microphone glyph, “add a voice note”, and “up to 1:00”.
- Recording state replaces it with a compact player: elapsed time, a live waveform or fine tick marks, Stop, Discard, and Re-record. There is no auto-record.
- The counter is legible and stops exactly at 60 seconds. The last seconds use a subtle accent, not alarm red.
- After recording, the sender can play, replace, or remove the note. The photo remains selected throughout.
- Copy states clearly: “A private voice note. It travels with the photo and is not recorded by Rendezvous.”
- The note never auto-plays after attachment.
- On the wall and in the photo viewer, the audio indicator is a small, quiet badge with a duration; it must not compete with rank or sender.
- A voice note player uses an ink-and-paper control, explicit play/pause, elapsed/total time, and no autoplay.
- If microphone permission is denied, the UI returns to the no-note state with a short recovery line; the photo flow continues.
- Keyboard and screen-reader support: record/stop are clearly named, the elapsed time is exposed without reading every fractional second, and pressing Escape cancels recording only after confirmation if audio has been captured.

### VDS-7 — Time step

As a sender, I can understand the appointment at a glance.

Acceptance:
- The time is the hero: a large, borderless time control plus a quiet optional date control.
- Empty date means “next occurrence”, and the UI shows the fully resolved local moment in plain language (for example, “Tomorrow at 09:30”).
- Past dates/times are rejected with an inline, non-destructive message.
- The meeting requirement is restated in small print: **Both browsers need to be open at the same time. The handoff opens five minutes early; arriving up to five minutes late is fine.**
- The resolved copy explains that the handoff remains open after the nominal moment if you are both late, rather than implying a hard expiry.
- Below the date control sits a quiet, off-by-default option labelled exactly **I won’t be able to speak**, with the helper **Live audio will be off for this rendezvous.** It is part of the time step, not a fourth stage.
- Selecting the option does not change the time, date, photo, or voice note. The DONE summary repeats that live audio is off.
- Back and Schedule actions are visually distinct.

### VDS-8 — DONE
As a sender, I get a satisfying, honest confirmation.

Acceptance:
- Stage three says **DONE** or **Rendezvous set** prominently.
- Shows the recipient code name, or **someone new**, and the resolved moment.
- If a voice note is attached, the summary says so with its duration; it does not auto-play.
- If live audio was disabled, the summary includes a quiet line: **Live audio off · I won’t be able to speak.** It does not imply that photo voice notes are blocked.
- For a linked human, shows the status line: “We’ll tell [name] when they next arrive.”
- For **someone new**, shows the join link and says that opening it gives them this rendezvous immediately, linking the two browsers.
- Contains the caveat: “The photo stays here until you’re both online.”
- Provides one clear close/finish action.
- The modal can be dismissed with Escape or outside click after completion, and the appointment is already saved.

### VDS-8b — The live rendezvous screen

As two people meeting, the screen feels like a shared room, not a call app.

Acceptance:
- The live screen is a warm paper scene over a quiet scrim on desktop, and a full-height sheet above the circle dock and safe area on mobile.
- Both code names are set large, with the moment in small caps and the current state in plain language. The largest control is **start audio 1min** with a microphone glyph and a small 1:00 mark; it is the only loud element.
- If the rendezvous carries **I won’t be able to speak**, the audio control is replaced by the quiet read-only line **Live audio is off for this rendezvous.** There is no request card, countdown, mute, end, or audio strip.
- At most two contribution lines appear, for example “your photo · added” and “Ana’s photo · waiting”; there are no thumbnails or early photo previews.
- Connecting, transferring, delivered, and retrying states reuse the calm vocabulary of VDS-9 and never show a bare spinner.
- While audio is live, the button is replaced in place by the countdown, mute, and end controls. A minimised screen leaves the VDS-10b strip visible.
- Dismiss/minimise is a quiet, always-available control. It does not end the meeting, the transfer, or live audio, and focus is not trapped after dismissal.
- The end state says “the minute is over” and keeps the photo state visible. The screen never implies the photo was delivered before the recipient ACK.
- No global call bar, ringing loop, or always-on calling control is introduced.

### VDS-9 — Waiting states
As a sender or recipient, I immediately know why nothing is transferring.

Acceptance:
- Never show a generic “delivered” when waiting.
- Show the handoff as **open** from five minutes before the scheduled moment; label it “early” before the nominal time, “due” at the time, and “still open” through the five-minute late tolerance. Both early and late presence trigger the connection automatically. Lateness beyond five minutes must never look like failure or expiry.
- While a rendezvous is pending, the main hero shows a live countdown to the scheduled moment as its primary text, with the resolved date/time as subtext, and the large **Set a rendezvous** action is hidden (US-6, VDS-5). After the moment passes it reads “now” or “still open”. The ticking value is not announced every second by assistive technology.
- If only I am online: “Waiting for [name] to come online.”
- If only they are online: “[Name] is here. Your photo is with them and will move when they are online too.” (for the recipient, “with them” = with the sender; for the sender, “Waiting for [name]”.)
- If both are online, the state changes to connecting/transferring automatically and the live rendezvous screen (VDS-8b) becomes available.
- Status is visible both in the upcoming row and, if relevant, in a quiet notification.
- Motion is limited to a small live pulse while actually working.

### VDS-10 — Incoming notification
As a recipient, a real arrival feels like a note slid under the door.

Acceptance:
- In-app toast/card appears at lower-right (desktop) and above the bottom safe-area (mobile).
- Shows sender name, state, and time. When complete, shows a photo thumbnail, an audio badge if a voice note is attached, “Open”, and “Dismiss”.
- The opening of the five-minute-early window is announced locally, without pretending the photograph has been delivered.
- When the transfer completes, a short confetti animation plays once in both browsers; it is visual-only, respects reduced motion, and never blocks the toast or the wall.
- Does not auto-open a full-screen photo without user action.
- Multiple notices stack to a small limit and are also retained in the upcoming/archive areas.
- `aria-live` announces the arrival once.

### VDS-10b — One minute of voice

As a participant, the audio moment feels like a small, deliberate window rather than a permanent call bar.

Acceptance:
- The audio action is quiet and contextual: it appears on the live rendezvous screen (VDS-8b) as the control **start audio 1min**, only when both humans are present and the rendezvous was not marked **I won’t be able to speak**. It is never a global always-on call control.
- When the rendezvous carries the flag, the screen shows only **Live audio is off for this rendezvous.** None of the request, countdown, mute, end, or audio-strip states appear, and no consent message is sent.
- Request/accept uses a small card with the counterpart’s name, a microphone explanation, and **Allow a minute** / **Not now** actions. Copy states plainly: “Nothing is recorded. Your microphone is live for at most sixty seconds.”
- During the window, a slim ink strip sits above the footer/bottom safe area (never covering the photo wall): counterpart name, circular or linear 60-second countdown, mute toggle, and end action.
- The countdown is typographic and calm, not a panic siren. Final ten seconds may gain a subtle accent; there is an audible/announced cue at 10 seconds and at the end.
- Both tabs show the same remaining window as measured locally; states announce “waiting for microphone,” “live,” “muted,” “reconnecting,” and “the minute is over.”
- Microphone permission is requested only after the person presses an explicit action. A denial produces inline recovery copy, not a dead call UI.
- On mobile, the strip respects the safe area and stays compact; toasts stack above it.
- End state is clearly recorded for this rendezvous: “The minute with Ana is over.” The action cannot be restarted.
- Accessibility includes a non-colour countdown label, focusable mute/end controls, and `aria-live` announcements without announcing every second.
- No recording indicator should appear because nothing is recorded; the microphone indicator and copy should say “live voice, not recorded.”

### VDS-10c — Upcoming rendezvous detail

As a participant checking a meeting, I see what I am bringing first, and the security footnote only when I ask for it.

Acceptance:
- Selecting an upcoming row opens a warm paper detail card in the same modal/sheet language as the composer. It replaces the current behaviour of opening the human verification panel.
- The top of the card is the exchange: my attached photograph as a calm print preview from local storage only, the line **your photo · added**, and the voice-note player or its duration when present. For an incoming appointment without a contribution, the quiet **add a photo** action takes that place.
- The other side is one line of honest state — **Ana’s photo · waiting**, **added**, or **delivered** — not an image. No blurred preview, thumbnail skeleton, filename, size, or duration hints at media this browser does not hold yet.
- The human’s name and avatar, the local moment, the window, and the handoff state sit above or beside the exchange. The live action appears only when the live rules allow it and opens the live rendezvous screen.
- If the rendezvous was marked **I won’t be able to speak**, the detail shows **Live audio off for this rendezvous.** in place of any audio action.
- The comparison words live near the bottom as a collapsed row: **comparison words · not verified** (or **· verified**), with a chevron. It opens in place to the same two-by-four poem on demand, and is collapsed again the next time the detail is opened.
- The disclosure is a real button with `aria-expanded`; its content is not rendered while collapsed. Reduced-motion preferences remove any reveal animation.
- On mobile the detail is a sheet above the circle dock and safe area, with the local attachment and **add a photo** action above the fold.
- Hierarchy is exchange first, meeting details second, verification last. Verification must not look like the main content of an upcoming rendezvous.

### VDS-11 — Humans

As a returning user, I can see my private circle.

Acceptance:
- A quiet horizontal list (or wrapped row) beneath the central scene labelled “your humans”. With none, the empty state invites setting a rendezvous for **someone new** rather than offering a separate add action.
- Each human shows a small avatar/initial, code name, and a live dot when online.
- Online status is indicated by both dot and text/accessibility label, not colour alone.
- Selecting a human opens the human detail panel (verification and removal). Selecting an upcoming rendezvous opens the rendezvous detail instead (VDS-10c). The two paths never open the same panel.
- Remove action is available on the item without hover-only dependence, ideally in a small menu or labelled × with confirmation affordance.
- Empty state is an invitation-like line, not a blank area.

### VDS-11b — Verification panel
As a human with a new connection, I can comfortably verify without the interface becoming a security console.

Acceptance:
- Each human item shows a small, honest status: **Verified** or **Not verified** (with a shield/check mark; never colour alone).
- Opening a human’s small detail panel shows their name, the eight-word code, the comparison instruction, and a “Mark as verified” action.
- In the upcoming rendezvous detail (VDS-10c), the same words are a collapsed disclosure beneath the exchange content, closed by default each time; they are not rendered or announced until expanded. The human panel remains the direct verification path.
- The eight words are typeset as a calm poem-like sequence (two lines of four), at a comfortable reading size, selectable but not presented as a copyable secret.
- Copy reads: “Say these words out loud, or compare them in another app. Don’t send them through this one.”
- A verified human’s badge has a quiet filled treatment; unverified is an outlined mark.
- Optional “Later” leaves the badge visible without nagging modals.
- Authentication failure uses a clear, non-alarmist but unmistakable alert: “Couldn’t verify [name]. No photo was sent.”

### VDS-12 — The wall
As a viewer, my photographs accumulate as a living board rather than an inbox.

Acceptance:
- Every delivered photograph is present, from the first onward. Nothing falls off the wall.
- Ordering is by arrival, freshest first. The freshest is rank **01** at the largest scale. The ranking algorithm is deliberately isolated so a richer relevance/recency algorithm can replace arrival order later.
- Scale follows a power law: `width = clamp(min, base × rank^-α, max)` where α is a gentle positive exponent (currently 0.24). Each subsequent photograph is a little smaller; a practical minimum keeps old photos usable on small screens.
- The board is a wrapped wall with whitespace between photos, not a single-row shelf. The largest/freshest photograph anchors the top-left of the board, and every subsequent print clusters toward that same top-left corner; whitespace is allowed to grow to the right and below.
- There is generous breathing room between the top menu (Code Name / live indicator) and the board. The board can live below the hero and human strip.
- Each item is a framed print with a tiny rank marker, direction/sender caption, date, and a voice-note badge when applicable. Slight rotations may be used sparingly; the layout must still read as one composition.
- Outgoing prints expose a **Share again** action in the viewer; it is not drawn on top of the print itself.
- Pending, waiting, and failed rendezvous are shown in a separate compact strip above the wall. They do not occupy rank positions reserved for delivered photographs.
- Clicking a print opens the full-bleed photo viewer. The viewer has download and local-delete controls.
- Deleting a print removes it and re-ranks all older prints. The layout smoothly recalculates on resize. Re-shares are separate prints and deleting one never deletes the source or another print.
- On mobile, the wall becomes a narrower flowing column set; the rank-01 photograph still leads at the largest size and two smaller prints may share a row.
- The wall is cumulative personal history: it includes delivered photos shared in either direction, captioned “from” or “to” the human.

### VDS-12b — Re-sharing a local photograph

As a sender, I can move an existing photo into another private rendezvous without the file-picking ceremony again.

Acceptance:
- The full-screen photo viewer for an outgoing delivered print includes **Share again** alongside download and delete.
- It opens the normal rendezvous card with the photograph (and existing voice note) already in place, clearly labelled “reusing this photograph from your wall”.
- No file chooser appears unless the sender explicitly chooses to replace the photo.
- The sender still chooses one person — a linked human or **someone new** — and a moment, confirming the same meeting rule. The primary action remains **Set a rendezvous**.
- DONE identifies that this is another share of an existing photograph and shows the new recipient/moment; the original remains untouched.
- The wall shows the new delivery as its own print with its own rank when it arrives.
- If voice-note replacement is offered, it uses the VDS-6b recording surface and never auto-records.
- The UI never suggests a cloud upload happened; copy can say “from this browser’s copy”.

### VDS-13 — Responsive behaviour

As a phone user, I get the same calm hierarchy.

Acceptance:
- Header keeps code name centred; there is no add-human control. The live indicator stays in the very top-right corner and remains compact rather than disappearing on narrow screens.
- Hero type and central action scale below 600 px.
- Modals become bottom sheets with large touch targets and safe-area padding.
- The circle dock stays pinned to the bottom-right above the safe area. When its row overflows, its visible lane always shows at least 2.5 circular items; icons remain at least 44 px and scroll horizontally.
- Photo preview, date/time controls, and human selection are usable without horizontal scrolling.
- Reduced-motion preference removes non-essential animation.

### VDS-14 — Accessibility & tone
Acceptance:
- All controls reachable and operable by keyboard.
- Visible focus indicators; no focus traps outside open dialogs.
- Text/background contrast meets WCAG AA for body and controls.
- Inputs have labels (visually hidden where the design is deliberately flat).
- States are announced with `aria-live` and not encoded by colour alone.
- Copy is intimate and plain: “Set a rendezvous”, “someone new”, “Waiting for Ana to come online.” No growth-hack language, no exclamation marks.

### VDS-15 — Connection diagnostics
As a user, I can open a calm technical footnote without leaving the page.

Acceptance:
- The live indicator is pinned to the very top-right corner of the page, inside the safe area on mobile. It is a quiet, text-sized text-and-dot trigger — not another loud button.
- When connected, the visible label is exactly **live**, without a **signal** prefix or companion word. Other states use **connecting**, **off**, or **another window** with the same restraint. The word **signal** belongs inside the diagnostics panel, not in the page chrome.
- The panel is paper-coloured, compact, and uses monospaced labels with readable values.
- Rows cover signal, this socket's family/address, bootstrap dual-stack state, the last direct route, and candidate-family counts.
- Single-stack warnings use the accent bar and plain language, not alarm styling.
- Unknown/mDNS-hidden families are labelled “hidden”, not misreported as IPv4.
- Copy reminds the user that the app can use IPv6 only when the operating network provides it; the app cannot create an address.
- No IPv6 toggles or fake controls are added.

### VDS-16 — The circle dock

As a member of several circles, I can switch circles from a persistent right-hand dock, so that every circle is one tap away without competing with the main actions.

Acceptance:
- A persistent circle dock is anchored to the bottom-right corner of the main app on desktop and mobile. Its right edge aligns to the page’s right safe margin; it does not span the viewport, sit at the centre, or grow from the left.
- It reads and appears from the right-hand edge of the page. Any entry or width-change motion comes in from the right, never from the left or out of the centre; reduced-motion preferences remove the movement.
- The **`+ circle`** button is the leading item, pinned to the bar’s left edge. Its visible label is exactly `+ circle`.
- The `+ circle` button must always be an actual circle: equal width and height with a fully circular outline, at least 44 px in both dimensions. It is never a pill, rounded rectangle, or rectangular tab, at any viewport size.
- Every circle the person belongs to appears exactly once to the right of the button as a perfectly circular icon, never as a rectangular tab or pill.
- Each icon is at least 44 px in both dimensions, shows the circle’s initial or a quiet mark, and has an accessible name equal to the circle’s name.
- The active circle has a clear selected treatment (a ring or filled mark, plus a text or accessibility state), not colour alone.
- Selecting a circle icon makes it the active circle and updates the main surface. Selecting `+ circle` opens the create/join circle flow.
- The circle icons sit in a single horizontally scrollable row. The `+ circle` button stays at the left edge while the row scrolls; icons never shrink below 44 px.
- Whenever the row has more items than fit, the visible lane always shows at least 2.5 circular items — two complete circles plus half of the next — even on the narrowest viewport. The half-clipped circle is the overflow cue: it is cut by the dock, never compressed below its 44 px geometry, and becomes fully visible when the row is scrolled. The page itself never gains horizontal overflow.
- With no circles, the bar shows only `+ circle`; there are no empty placeholders.
- The bar respects the mobile safe area and never covers `Set a rendezvous`, the photo wall, or a modal’s primary actions. Toasts stack above it.
- Every item is keyboard reachable with a visible focus ring and is operable by keyboard and screen reader.
- The bar is quiet paper-and-ink navigation, not a photo filmstrip; the wall remains the only photo surface.

---

## 6. End-to-end flows

### 6.1 Rendezvous invite and link

```text
A: taps "Set a rendezvous"
A: selects a photo (+ optional voice note), "someone new", and a moment
A: saves the appointment locally as "waiting for them to join"
A: signs an invitation bound to that appointment
A: DONE shows the join link (works without signalling)
A: shares the link

B: opens the link
B: verifies A's signature and the appointment metadata locally
B: creates or resumes this browser's identity and Code Name
B: stores the appointment immediately
B: sees the rendezvous in the upcoming area and A under "your humans"
B: sends a signed join to the server
   ├─ A online  → A pins B and attaches the already-saved appointment
   └─ A offline → server queues the join; A attaches it on next connection

Both: pin each other's public key in IndexedDB.
Both: subscribe to each other's presence; live dots appear when both are online.
```

The relationship is two-sided and persists in both browsers. The appointment is not created again when the link is opened: it already exists under the creator’s appointment ID, and the invitee receives that same ID. No server-side contact graph is required for future operation; the server only relays presence, queues joins, and queues appointment notices for later changes.

As soon as the invitee opens the link, the rendezvous is in their upcoming area — they do not need to wait for the creator to be online. The creator sees the same rendezvous as **waiting for them to join** until the join arrives, then as **waiting for [name] to come online**.

For photo delivery, confirm:

```text
[ ] the invitation link was opened in the intended browser profile
[ ] both browsers list the other under "your humans"
[ ] both show live
[ ] both show the other human as "here now"
[ ] the eight comparison words match and are marked verified
```

If one of the first four lines is missing, the relationship is not ready for delivery. The rendezvous can still exist in one or both upcoming lists; it does not become a photo until both browsers are present. Verification should be completed before the first photo; it confirms the key, but it is not what creates presence.

### 6.2 Setting a rendezvous

```text
1. Sender taps "Set a rendezvous".
2. Selects a local photo, optionally records one voice note (≤60s), and chooses either a linked human or "someone new".
3. Picks time (+ optional date) and may mark "I won't be able to speak" to disable live audio for this rendezvous.
4. App resolves the local timestamp and saves the appointment + photo + optional voice note + live-audio flag to IndexedDB.
5. If the person is already linked, the app sends ONLY appointment metadata to the signalling server.
   If the person is "someone new", the same metadata is bound into the signed invitation link instead.
6. Linked human: server stores the notice until the recipient acknowledges, or delivers it immediately if they are online.
   Someone new: opening the signed link stores the same appointment immediately in the invitee's browser.
7. The rendezvous starts with confirmation **pending** for both humans. Each side can **confirm** or **propose another time** in the upcoming row or the rendezvous detail.
8. A counter-proposal cancels the previous time on the same rendezvous, keeps the photo and contribution, and is sent through the server as appointment metadata. The other human is notified and can confirm or counter again.
9. The label becomes **confirmed** only after both humans confirm the current time. Pending is a label only; the normal handoff window and photo transfer are unchanged.
10. Confirmation: DONE. Both cases repeat: "Both browsers need to be open at the same time. The handoff opens five minutes early, and lateness does not cancel it."
   Someone new also receives the join link here, with no separate add-human step.
   If live audio was disabled, the confirmation also says "Live audio off · I won't be able to speak."
```

A pending label is not a second meeting confirmation. The clock, the five-minute window, and the automatic handoff work exactly as before. A counter-proposal is the only action that moves the time, and it moves the same rendezvous rather than creating a duplicate.

The large **Set a rendezvous** action is only on screen while no appointment is pending. Once step 4 saves the first pending rendezvous, the hero countdown takes its place; the button returns when the last pending rendezvous is delivered or deleted.

### 6.2b Adding a reciprocal photo to someone else’s rendezvous

```text
Recipient sees the appointment in the upcoming area
        │
        ├─ taps the upcoming row
        │     └─ rendezvous detail opens: my photo/note and contribution state first;
        │        the counterpart's media is state only; comparison words are collapsed
        │
        ├─ taps "add a photo" in the row or detail
        ├─ selects/validates one local image (+ optional voice note)
        ├─ photo stays in the recipient’s IndexedDB, attached to the existing appointment ID
        │     (no second appointment, no server upload)
        └─ contribution locks when the handoff session begins

At the meeting (both online):
  creator’s photo   → recipient
  recipient’s photo → creator     (only if attached)
  same authenticated session; each direction ACKed independently
```

The creator’s appointment and photo are unchanged. The reciprocal contribution is optional and never makes the creator’s handoff conditional on a reply. No contribution bytes or contribution metadata are sent to the signalling server.

### 6.2c Opening an upcoming rendezvous

```text
Participant taps an upcoming rendezvous row
        │
        ├─ the rendezvous detail opens (not the human verification panel)
        ├─ top: my local photo (+ optional voice note) and its state
        │       counterpart state only: waiting / added / delivered
        ├─ middle: human, local moment, window, honest handoff state
        └─ bottom: comparison words disclosure, collapsed every time
                │
                └─ expand → same eight words + "Mark as verified"

Closing the detail never cancels the appointment or unlocks a contribution.
```

### 6.3 The meeting

```text
Before the opening (T−5 min): both may see the upcoming appointment. No bytes move.

From T−5 onward, on every presence/timer update:

  Is the sender online? ── no ──► recipient sees "Waiting for sender."
        │                              sender's photo remains in sender's IndexedDB.
       yes
        │
  Is the recipient online? ─ no ──► sender sees "Waiting for recipient."
        │
       yes
        ▼
  Sender opens RTCPeerConnection + ordered data channel.
  Server relays offer / answer / ICE (signalling only).
        │
     connected?
      ├─ no  → retry while both online
      └─ yes → stream photo in chunks with backpressure
                  │
              recipient verifies whole blob, stores in IndexedDB, sends ACK
                  │
              both show DELIVERED
```

If the recipient attached a reciprocal photo (US-10b), the same authenticated session carries both directions. Each direction has its own completion ACK; one failing does not roll back the other. The live rendezvous screen (US-8b) is shown once both humans are connected; dismissing it does not pause the handoff.

### 6.3b One-minute voice during a rendezvous

```text
Both online, handoff window open, appointment still active
        │
        ├─ appointment carries liveAudioDisabled?
        │       └─ yes → no audio action or consent request; show
        │                "Live audio is off for this rendezvous."
        │                the photo handoff continues normally
        │
        ├─ Either person taps "start audio 1min" on the live rendezvous screen
        │       │
        │       └─ other person must accept + both grant microphone
        │
        ├─ authenticated DTLS-SRTP audio session (pinned identities)
        │
        ├─ countdown starts only when both microphone tracks are live
        │
        ├─ at 60s / either person ends / either disconnects
        │       └─ tracks stopped, peer connection closed, window consumed
        │
        └─ photo handoff is independent and continues normally
```

The audio offer exists only while both humans are present for the due appointment and the creator has not marked **I won’t be able to speak**. It is not a mailbox, a wake-up call, a recording, or a general voice service. A missed call cannot be replayed. The live-audio flag is appointment metadata, not media; it is visible to the signalling server and to both humans, and it never disables photo voice notes.

### 6.3c Photo voice notes

```text
Sender selects a photo
        │
        ├─ optionally records ≤60s voice note in-browser
        │     (explicit start, preview, replace/delete; never auto-records)
        │
        ├─ photo + note stored together locally
        │
At handoff:
  same authenticated data channel carries photo bytes + optional note
        │
  recipient verifies complete photo + complete note, stores both, ACKs
        │
  wall print + viewer expose a small audio badge/player (no autoplay)
```

### 6.3d Re-sharing a locally held photo

```text
Sender opens an outgoing delivered photo
        │
        ├─ taps "Share again"
        │
        ├─ normal composer opens with local photo + existing voice note attached
        │     (no file picker, no new upload)
        │
        ├─ choose another/same human + a new moment
        │
        ├─ new independent rendezvous + new metadata to server
        │
        └─ delivery creates a new print; source and old shares are untouched
```

Re-sharing a private incoming photo is deliberately unavailable. The future public layer (US-20) is a separate opt-in path with storage, attribution, moderation, and revocation rules.

### 6.4 Appointment states

Confirmation is a label on the appointment, separate from the handoff state. It never prevents a row from moving through the states below.

| State | Sender sees | Recipient sees |
| --- | --- | --- |
| `pending` | “Ana · Tomorrow, 09:30 · pending” | “pending · confirm or propose another time” |
| `confirmed` | “confirmed · Tomorrow, 09:30” | same |
| `scheduled` | “Ana · Tomorrow, 09:30” | same |
| `open-early` | “Open early · waiting for Ana” | “Open early · waiting for Ana” |
| `waiting` (recipient absent) | “Waiting for Ana to come online” | n/a |
| `waiting` (sender absent) | n/a | “Waiting for Ana to come online. The photo is still with her.” |
| `connecting` | “Connecting directly…” | “Connecting directly…” |
| `transferring` | progress | progress |
| `delivered` | “Delivered · 09:31” | photo on the wall + notification |
| `failed` | “Couldn’t connect. Retrying while you’re both here.” | similar |

### 6.5 Circle offers

```text
Any current member offers a circle moment for local day D
        │
        ├─ if a circle time window is active, the offered instant must be
        │  inside it; otherwise the client refuses to sign
        ├─ sign the circle offer locally (circle, offer, creation time)
        ├─ submit only the signed offer invite (with recipients) to the server
        │     └─ server stores it until the offered time passes, then deletes it
        │        and delivers it to members online or on next connection
        └─ all other circle records stay local
                │
        members choose independently:
          ├─ join any offer with a signed PlanJoin record
          └─ counter-propose a different time as a new, independent offer
                │
        when ≥2 members are online:
          automatic authenticated peer sync of membership, offers, joins,
          attendance, and stats, relayed opaquely by the server while both
          are online (idempotent; no manual refresh)
                │
        each member verifies signatures and merges:
          reject offers outside the window active when they were signed
          keep every valid offer; there is no canonical winner
          attach each PlanJoin to exactly one offer
                │
        offer state:
          pending  = organizer has no other participant yet
          confirmed = at least one other member joined
          (label only; a pairwise handoff is never blocked by this label)
```

The server holds only expiring offer invites. Membership, Join/Leave, per-offer joins, attendance, stats, and the record log are never stored by the server; they may be relayed opaquely between connected mutual humans. Offers are metadata only. Members meet in direct pairwise handoffs under the normal online and five-minute-window rules; one invitation can therefore become several independent parts of the group meeting at different times. No one is expected to attend every offer or for the whole circle to appear at once.

A circle may also set an optional signed time window. It constrains only the scheduled instant of offers signed while it is active; it never shortens the five-minute handoff window, invalidates an earlier valid offer, or changes attendance and stats.

---

## 7. Functional requirements summary

- **FR-1** One persistent, IndexedDB-backed keypair identity per browser profile + origin.
- **FR-2** Rendezvous-bound signed invitation links: setting a rendezvous for **someone new** creates the only path to a new two-sided human relationship, with store-and-forward join requests.
- **FR-3** Live presence only for linked humans.
- **FR-4** Three-stage rendezvous creation: photo + person (a linked human or **someone new**) → time (+ optional date) → DONE. A **someone new** rendezvous shows its join link in DONE.
- **FR-5** Photos stored only in IndexedDB on the sender until handed off.
- **FR-6** Server stores only appointment metadata, expiring circle offer invites, and short-lived delivery queues; circle records and history are never server-stored.
- **FR-7** Automatic direct transfer whenever both peers are online inside the `[T − 5 minutes, T + 5 minutes]` window, including when both are already online beforehand; a later overlap still completes, and lateness never discards the saved photograph.
- **FR-8** Reliable chunked file transfer with CRC-free size check, ACK, retry, and idempotency by appointment ID.
- **FR-9** Recipient notification on next connection after a server notice for a linked human, or immediately from the rendezvous invite link for **someone new**, plus local handoff-window/due notification.
- **FR-9a** Cumulative ranked photo wall: newest-first arrival rank, power-law scale, pending rendezvous separated, responsive reflow, deletion re-ranks.
- **FR-9b** A direct rendezvous exposes a pending/confirmed label; both humans must confirm the current proposed time. Pending never gates the normal handoff. Either human may counter-propose, which cancels the previous time, keeps the same rendezvous and photo, resets both confirmations, and is delivered through the server as appointment metadata.
- **FR-10** Stable 8-word local verification code from sorted identity keys, persistent verified badge.
- **FR-11** Signed live-session handshake binding both DTLS fingerprints before photo bytes.
- **FR-12** Human removal propagates both ways and cancels pending meetings.
- **FR-13** Reusable headless client + custom-element UI, ESM, no framework requirement.
- **FR-14** Dual-stack bootstrap server by default, with startup and in-app warnings for single-stack deployments.
- **FR-15** Connection diagnostics for signalling family, dual-stack capability, ICE candidate families, and selected direct route, opened from a very-top-right live indicator.
- **FR-16** Revoked invite-token hashes, enforced locally and by the bootstrap server.
- **FR-17** One optional voice note of up to 60 seconds attached to a photograph, stored and transferred with it over the authenticated P2P handoff, never server-stored.
- **FR-18** One authenticated, one-to-one, camera-off live voice window of at most 60 seconds while a rendezvous's handoff window is open, unless the creator set **I won’t be able to speak**; explicit mutual consent; no recording; no server media.
- **FR-19** Re-share an outgoing delivered photograph (and its note) from local storage to a new rendezvous without re-upload or file picker; all shares independent.
- **FR-20 (later)** Opt-in public-photo layer with re-sharing, attribution, revocation, moderation, and separate storage — not part of the private photo path.
- **FR-21** Responsive, keyboard-accessible interface matching §5.
- **FR-22** Circles are signed, content-addressed record sets of independent rendezvous offers, per-offer joins, attendance, and membership.
- **FR-23** Any current member may create an offer; members may join any offer; multiple offers may run independently at different times. There is no canonical circle rendezvous, and a counter-proposal branches into another offer rather than cancelling existing offers.
- **FR-24** Circle invitations are signed and addressed to one public-key identity; the current build auto-accepts valid invitations and still records a signed Join.
- **FR-25** The signalling server stores only circle offer invites, until the offered time has passed, and delivers them to current members; all other circle records may be relayed only between connected mutual humans but are never stored, and the server cannot create, alter, re-sign, choose, rank, or promote them.
- **FR-26** When at least two circle members are online, their clients automatically sync signed circle records over authenticated peer channels, relayed opaquely by the signalling server while both are online.
- **FR-27** A persistent circle dock anchored to the bottom-right lists every circle as a circular icon, with `+ circle` as the circular leading item; whenever the row overflows, at least 2.5 circular items remain visible as the scroll cue; selecting an icon switches the active circle.
- **FR-28** A non-creator may attach at most one reciprocal photo to an existing rendezvous; it stays local, locks when the handoff session begins, and travels over the same authenticated P2P session with independent per-direction ACKs.
- **FR-29** A live rendezvous screen appears while an appointment is active and both participants are connected, with the exact **start audio 1min** action; it never gates or blocks the photo handoff.
- **FR-30** A circle may define an optional signed time window. A circle offer is valid only when its scheduled instant falls inside the window active at the offer's signed creation time. The window constrains scheduling only: it never shortens the handoff window, invalidates an earlier valid offer, or changes attendance, stats, or media transfer, and it is never server-stored.
- **FR-31** The owner of a photograph can see a per-`photoId` inventory of humans who received a private copy through Rendezvous, based on signed possession claims and releases, with honest confirmed/last-confirmed/deleted states. The inventory is local to the owner, uses no server-side possession ledger, does not track copies exported outside Rendezvous, and never enables remote recall.
- **FR-32** Selecting an upcoming rendezvous opens its exchange detail, leading with the local photo and voice note to be exchanged and the counterpart’s contribution state; the eight comparison words remain available there in a disclosure that is collapsed by default. No counterpart media is fetched or previewed before the handoff.
- **FR-33** The live connection indicator sits in the very top-right corner and reads exactly **live** when connected, without the word **signal** in the page chrome; it opens the diagnostics panel.
- **FR-34** The large central **Set a rendezvous** action is hidden while any rendezvous is pending or upcoming and returns when no such appointment remains; the hero countdown and upcoming area take its place.
- **FR-35** The rendezvous time step offers **I won’t be able to speak**, stored as a per-rendezvous `liveAudioDisabled` flag in the appointment metadata. The flag is delivered to both humans and disables live one-minute voice for that rendezvous only; it does not affect photo voice notes, photos, notifications, or any other rendezvous.
- **FR-36** A circle offer is independent and joinable by any current member through a signed PlanJoin. An offer is pending until at least one other member joins it, then confirmed for its participants. No offer requires the whole circle, and several offers may run at different times. All kept attendance pairs count, regardless of which offer brought them together.

## 8. Non-functional requirements

### Privacy
- Photo and voice-note bytes never enter server memory in the private protocol.
- Appointment metadata is not end-to-end encrypted from the signalling operator in v1; the operator can see who scheduled with whom and when. The photo remains opaque.
- Circle offer invites are visible to the signalling operator until they expire. Circle membership, attendance, stats, and record history are never sent to the server. Invites contain no photo or voice bytes, and clients never accept server-selected offer rankings in place of signed records.
- The app should not log photo bytes, voice-note bytes, audio content, SDP bodies, or private keys.
- Identity private keys are held in IndexedDB as Web Crypto `CryptoKey` objects (non-extractable where possible), not as plaintext elsewhere. Any XSS on the origin can still ask the browser to use the key; isolation and CSP remain necessary.
- Rendezvous invitation links are bearer capabilities until the first successful join binds one. Sharing an unredeemed link shares access. Circle invitations are addressed to one identity and are not bearer links.
- Voice notes are private media with the same no-server guarantee as photos; microphone access is explicit and never backgrounded.
- Re-sharing a private photo stays local and peer-to-peer. Public publication, when introduced later, is a separate opt-in surface with its own storage and moderation policies.
- Presence connections are authenticated with a signed server challenge, and linked peers pin each other's public keys.
- A malicious signalling operator could still withhold or alter traffic; authenticated signalling and pinned keys do not make the reference server a trusted anonymity network.

### Reliability
- All local writes complete before success UI.
- Transfers are retried; stale partial chunks never surface as complete images.
- Photo + optional voice note are treated as one handoff unit; both must be complete before success.
- Re-shared appointments reference locally held media; deleting one share or the original appointment must not break another share or the local source until all copies are gone.
- App restart normalizes in-flight states to waiting.
- Signalling reconnects with exponential backoff.
- Server data is atomically persisted in a JSON file for the reference implementation. A production deployment should replace it with a durable database + TURN.
- Server queue retention: 30 days or until acknowledged.
- Max photo file size 25 MiB. Larger photos should be rejected before scheduling.
- A voice note is capped at 60 seconds. Media bytes (photo + note) count against local IndexedDB quota; the bootstrap server's metadata limit is unaffected.
- One active tab per identity per signalling connection. Opening a second tab supersedes the first; the superseded tab stops reconnecting.

### Compatibility
- Current evergreen Chromium, Firefox, and Safari with WebRTC data channels, IndexedDB, Web Crypto, and ES2022 modules.
- Secure context required (`https://` or `localhost`) for Web Crypto and WebRTC.
- No IE, no server-side rendering, no native apps.

### Network reachability & diagnostics
- The reference bootstrap server binds `::` (dual-stack) by default and warns at startup if `HOST`/IPv6-only settings prevent IPv4+IPv6 reachability.
- `/health` and the authenticated `hello:ok` response advertise `dualStack`, listener host, the client's observed family/address, and a warning when single-stack.
- The browser UI surfaces this information plus ICE candidate-family counts and the selected candidate pair from the last handoff.
- Deployments must terminate TLS on a dual-stack endpoint and front any IPv6-only network with a dual-stack signal server. STUN/TURN should also be reachable over both families.
- The app never sets `iceTransportPolicy` to filter families and never drops IPv6 candidates.
- TURN is optional, self-hostable, and untrusted: it forwards DTLS ciphertext. TURN does not see plaintext photos. Running without TURN is allowed; some NAT pairs will fail and retry.
- The app cannot assign IPv6. IPv6 availability is a property of the user's network/ISP/router; diagnostics must say this plainly.

### Performance
- First meaningful paint under 1.5 s on a local dev server.
- No more than one signalling socket per tab.
- Transfers use 32–64 KiB ordered chunks and pause when the data channel’s send buffer is large.
- UI stays responsive while a 25 MiB photo transfers.

---

## 9. Architecture

```text
┌──────────────────────────┐          ┌──────────────────────────┐
│ Browser A                │          │ Browser B                │
│                          │          │                          │
│  <rendezvous-app>         │          │  <rendezvous-app>         │
│    RendezvousClient       │          │    RendezvousClient       │
│    ├─ identity (WebCrypto)          │    ├─ identity           │
│    ├─ IndexedDB media    │          │    ├─ IndexedDB media    │
│    ├─ RTC sessions       │          │    ├─ RTC sessions       │
│    └─ SignalTransport    │          │    └─ SignalTransport    │
└────────────┬─────────────┘          └─────────────┬────────────┘
             │  WebSocket (metadata only)           │
             │                                      │
             ▼                                      ▼
        ┌─────────────────────────────────────────────┐
        │ Reference signalling server                 │
        │  · presence                                 │
        │  · signed-invite delivery + queue           │
        │  · appointment notices + queue              │
        │  · rendezvous invite queue (expires)         │
        │  · removal propagation                      │
        │  · WebRTC offer/answer/ICE relay            │
        │  · NO private media or circle records       │
        └─────────────────────────────────────────────┘

             Browser A ◄════ WebRTC data channel ════► Browser B
              (photo + optional voice note, P2P; DTLS)
```

### Network stance

The signalling server is dual-stack by default. The browser gathers whatever ICE candidates the OS/network offers and sends both IPv4 and IPv6; no candidate family is filtered. STUN helps with NAT; TURN is an optional self-hosted relay for difficult NATs and is treated as untrusted because DTLS encryption and identity signatures protect the photo. If the server is deliberately configured single-stack, it warns at startup and in diagnostics.

### Layers

1. **Domain/service (`src/lib/client.ts`)** — identity, humans, appointment state machine, events, persistence orchestration.
2. **Transport (`src/lib/signal.ts`)** — WebSocket connection and reconnect. Shaped as an interface for future relays.
3. **RTC (`src/lib/rtc.ts`)** — direct offer/answer/ICE, chunking, backpressure, integrity via size/completion, ACK.
4. **Storage (`src/lib/store.ts`)** — IndexedDB identity keypair, pinned humans/queues, rendezvous records, private photo and voice-note blobs, delivered wall prints, and local possession statements.
5. **UI (`src/lib/ui/`)** — encapsulated custom element built only on the public client API.
6. **Circles (`src/circles/`)** — signed membership, addressed invitations, independent rendezvous offers with per-offer joins, local stats, and authenticated peer sync.
7. **Reference server (`server/`)** — replaceable signalling + metadata store, including expiring circle offer invites but no circle record history.

---

## 10. Signalling protocol (v1)

JSON over WebSocket at `/signal`. All messages are server-agnostic; no photo data. On socket open the server issues a one-time nonce. The client's `hello` must include its public key and a signature over the nonce; the server derives the peer ID from the canonical public key and rejects mismatches or invalid signatures. Presence therefore cannot be claimed without the private key.

### Client → server

| Type | Purpose |
| --- | --- |
| `hello` | Prove identity (`peerId`, public key, signed server nonce), register a code name, and list presence subscriptions. |
| `identity:update` | Change code name. |
| `presence:subscribe` | Replace the set of humans whose presence I watch. |
| `invite:join` | Deliver a verified invitation connection request to a peer. |
| `invite:ack` | Acknowledge/drop a queued join request after handling it. |
| `contact:remove` | Propagate deletion to a human and revoke the associated invitation-token hashes. |
| `contact:remove:ack` | Acknowledge a received deletion. |
| `invite:reject` | Refuse a join whose invitation token was revoked; also records the revocation server-side. |
| `rendezvous:create` | Store and deliver an appointment notice (metadata only). |
| `rendezvous:update` | Store and deliver a confirmation or counter-proposal for an existing appointment. The counter action replaces the time and resets confirmations; the confirm action adds one confirmer. Uses the same retention and delivery rules as `rendezvous:create`. |
| `rendezvous:ack` | Confirm the recipient persisted the notice. |
| `circle:relay` | Relay one opaque, already-signed circle membership or sync message between connected mutual humans. Never stored. |
| `circle:rendezvous:create` | Store and deliver a signed circle offer invite to its named recipients until the offered time has passed. A counter-offer uses a new invite. Circle record history is never uploaded. |
| `app:relay` | Relay one already-signed app notice (possession claim/release/check or audio consent). `queue: true` waits for an offline human; ephemeral consent uses `queue: false`. |
| `app:ack` | Acknowledge a queued app notice. |
| `rtc` | Relay offer/answer/ICE for a named transfer. Ephemeral; not queued. |

### Server → client

| Type | Purpose |
| --- | --- |
| `challenge` | One-time nonce issued immediately after the socket opens, before registration. |
| `hello:ok` | Server accepted authenticated registration; returns ICE config and server time. |
| `presence` | Online/name change for a subscribed human. |
| `invite:queued` | Server accepted a join request for delivery. |
| `invite:request` | A signed join for a rendezvous invitation; it binds the invited browser as a new human. |
| `rendezvous:created` | Sender’s appointment metadata is durable. |
| `rendezvous:updated` | Sender’s confirmation or counter-proposal was accepted and stored for delivery to the other human. |
| `rendezvous:notice` | Appointment notice for the recipient, including proposer, confirmer IDs, and revision. |
| `circle:relay` | One opaque signed circle message from a connected mutual human. |
| `circle:rendezvous:created` | The organiser’s circle offer invite is stored until its offered time. |
| `circle:rendezvous:notice` | A stored circle offer invite for a named recipient; idempotent until the offered time has passed. |
| `app:relay` | One signed app notice, optionally with a `queuedId` the recipient acknowledges. |
| `contact:removed` | A human ended the relationship. |
| `invite:rejected` | A join using a revoked invitation token was refused. |
| `rtc` | Relay from the other peer. |
| `error` | Protocol/validation error. |

### Audio control messages

The audio feature adds explicit consent/control messages alongside the existing signalling channel:
- `audio/request` — attach a microphone request to an open-handoff appointment;
- `audio/accept` / `audio/decline` / `audio/failed` — mutual consent and recovery;
- the signed data channel carries mute, live, and end controls inside the audio session;
- a dedicated authenticated audio RTC session with its own offer/answer/ICE and the same signed DTLS-fingerprint transcript used for photo sessions.

No audio byte, recording, transcript, or audio-derived feature is ever stored by the server. New message types must be versioned and must not weaken the photo path when audio is unavailable.

### Persistence / queues


- `joins`: delivered until inviter acknowledges.
- `rendezvous`: the latest appointment metadata, pending or confirmed, delivered to whichever human still needs the update until they acknowledge local persistence.
- `removals`: delivered until target acknowledges; each carries revoked invitation-token hashes.
- `revokedInvites`: durable hashes used to refuse old invitation links.
- `circleInvites`: only circle offer invites, including their signed recipient routing list, delivered until the offered time has passed. No membership, Join/Leave, offer joins, attendance, stats, or circle record log is stored.
- `appMessages`: short-lived signed app notices (possession claims/releases/checks and audio consent) between linked humans. They contain no photo, voice-note, thumbnail, or audio bytes and are removed when acknowledged or after 30 days. They are not a possession ledger.
- Presence and RTC signals are ephemeral.
- Records involving a removed relationship are purged.
- Retention: 30 days for joins, removals, and appointment notices. Circle offer invites expire once their offered time has passed. Revoked invitation-token hashes are retained until the store is intentionally reset, so removed links stay revoked.
- v1 reference uses `data/signal-store.json`; do not treat this as production infrastructure.

---

## 11. Verification and connection authentication

### 11.1 Stable comparison code

The code is a relationship fingerprint, not a session fingerprint. It is derived independently in both browsers with no network exchange:

```text
transcript =
  "rendezvous/sas/v1"
  || u32be(len(publicKeyA_raw)) || publicKeyA_raw
  || u32be(len(publicKeyB_raw)) || publicKeyB_raw

where publicKeyA_raw and publicKeyB_raw are the fixed 65-byte uncompressed
P-256 public keys, sorted bytewise before length-prefixing.

digest = SHA-256(transcript)
code   = 8 words, each index = next 11 bits of digest into a 2048-word list
```

This yields an 88-bit code. It is stable across reconnections because it covers only long-term identity keys. It is shown identically on both tabs. The UI recommends comparing it out loud or via a different app. Verification is local, optional, and persisted; it is a memory aid over the underlying pinned-key security, not a substitute for it.

A short numeric code without a commitment round would be forgeable by grinding keys. The long word code avoids that cost; adding a commitment round for a shorter code is future work.

**Rejected pattern:** “each side invents a word, encrypts it with keys from the signalling exchange, sends it, and displays the word it receives.” A malicious signalling path can terminate both sides, read both words, substitute two chosen words, and users comparing them out of band will see a match. The code must be a locally computed function of the actual keys and/or handshake transcript each side sees, checked against pinned identities. Out-of-band comparison is the check; the code itself must not be transmitted.

### 11.2 Signed live-session handshake

Once the RTC data channel opens, before a single photo byte is sent:

1. Each side parses its local and remote DTLS `a=fingerprint:sha-256` values from the SDP.
2. Each side signs a canonical transcript with its long-term private key:
   ```text
   rendezvous/handshake/v1
   transfer:<appointment id>
   from:<my peer id>
   to:<their peer id>
   local:<my DTLS fingerprint>
   remote:<their DTLS fingerprint>
   ```
3. Each side sends its signed statement over the newly opened data channel.
4. Each verifies the other's signature against the **pinned** public key and checks:
   - transfer id and both peer IDs;
   - the other's `local` fingerprint equals this side's `remote`;
   - the other's `remote` fingerprint equals this side's `local`.
5. Only after both sides accept does the sender begin transmitting photo metadata/chunks. A failed or absent check aborts before any image bytes leave the sender.

Because the DTLS fingerprints are bound into signatures made with the pinned identity keys, a malicious signalling server cannot terminate DTLS twice and relay plaintext: its substituted fingerprints produce signatures it cannot forge. The same reasoning applies to TURN, which only forwards encrypted packets. The server can still deny service or observe appointment metadata.

---

## 12. Photo & RTC details

- Only appointment IDs, circle offer invites, and RTC signalling cross the server. The selected image — and any attached voice note — never becomes a URL hosted by the server.
- A sender initiates a fresh `RTCPeerConnection` for each appointment once the handoff window is open at `T − 5 minutes` and both peers are present. One ordered `RTCDataChannel` carries the photo and optional voice note.
- Chunk size 64 KiB. Sender waits when `bufferedAmount` exceeds a high-water mark (4 MiB) before queuing more.
- Recipient assembles chunks into a typed Blob, verifies total size, stores it in IndexedDB, then ACKs. The sender marks delivered only after the ACK.
- Voice notes travel in the same manifest/channel as the photo; the receiver verifies both attachments before presenting success.
- Reciprocal contributions: the creator and the recipient may each hold one photo for the same appointment. The same authenticated session carries the creator’s photo to the recipient and, if attached, the recipient’s photo to the creator. Each direction is chunked, verified, stored, and ACKed independently; a missing direction is normal. Contribution state is exchanged only over RTC; the server notice is unchanged.
- Duplicate offers/ACKs are idempotent; a recipient that already has the appointment data (or photo) acknowledges without duplicating.
- If ICE/DTLS or the channel fails, the sender retries after a backoff while both peers remain online. The partial transfer is discarded.
- STUN is required for many home NATs; TURN is required for symmetric NATs where direct failures are common. The reference server can advertise ICE servers via environment configuration.
- Both browsers must remain open for the duration. Mobile OS suspension may pause the transfer; the retry model handles resumption while the app returns to the foreground.

---

### Photo wall layout
The wall is a client-side presentation of delivered photos, never a server feature.

- Rank: delivered records sorted by `deliveredAt` descending; ties by appointment ID. Rank 01 is freshest.
- Scale: `width = clamp(112px, base × rank^-0.24, 560px)`.
- Base width: ~46% of the wall's content width on desktop, capped at 560px; on narrow screens, ~84% of the available width, capped at 320px, so rank 01 leads the composition.
- Layout: a top-left-clustered flex-wrap board with generous gaps and top whitespace; items are packed from the left and top, leaving whitespace to the right and below. The board reflows on resize.
- A practical minimum of 112px is the only break in strict monotonicity for very long histories.
- Pending/waiting records render in a separate strip above the board and do not receive a rank.
- Ranking is a presentation seam; a future relevance algorithm can replace arrival order without changing photo storage or delivery.

### One-minute voice channel

This feature is a deliberate exception to the otherwise photo-only surface. It must not compromise the privacy or reliability invariants of the handoff.

**Availability**
- The request action is the **start audio 1min** control on the live rendezvous screen (US-8b). It is visible only on a rendezvous whose handoff window is open, where both humans are online, and where the creator did not set **I won’t be able to speak**.
- If the appointment carries the live-audio-disabled flag, no request action appears and no request is accepted on either side. No audio window exists or is consumed; the photo handoff and photo voice notes remain unchanged.
- The action can be used while the photograph is waiting, connecting, or transferring. The photo path never depends on audio succeeding.
- One successful audio window per rendezvous. After it ends, no restart is offered for that appointment.
- Microphone permission is per request, explicit, and revocable in the browser.

**Transport**
- A separate camera-off WebRTC peer connection carries audio via DTLS-SRTP. No audio is routed through the bootstrap server.
- Before tracks are unmuted/transmitted, both endpoints verify each other's pinned public key and sign the audio session's DTLS fingerprints, binding the voice channel to the already-linked identities.
- A self-hosted TURN may relay the encrypted audio for difficult NATs, but TURN must not be trusted with plaintext.
- Codec, echo cancellation, noise suppression, and automatic gain control use browser defaults (Opus where available).
- The app never records locally, creates a downloadable audio file, or sends audio to a transcription service.

**Timing**
- The countdown starts only when both microphone tracks are live on an authenticated connection.
- Enforce with a monotonic clock, not wall time. Stop tracks and close the peer connection at 60 seconds even if the tab is backgrounded; on resume, show the correct ended state.
- Any disconnect, explicit end, microphone revocation, or fatal media failure ends the window and consumes it.
- Client-enforced duration is a product/consent limit, not DRM. A modified peer could keep its own microphone open; the honest client closes its track and the app makes no claim to control another device. The important guarantees are mutual consent, no recording by Rendezvous, and no server media.

**Failure & privacy**
- A denied permission, unavailable microphone, or failed audio session shows a plain error and leaves the photo handoff untouched.
- The server relays only signed control metadata for requests, consent, and endings; it never learns audio content.
- Logs must not include microphone labels, device IDs, IPs beyond existing diagnostics, audio stats, or transcripts.
- No captions/transcription in the first audio release. If added later, they must be opt-in, local, and clearly disclosed.

### Handoff timing

- `T` is the scheduled timestamp (epoch ms) resolved from the creator's local date/time.
- The normal handoff window is `[T − 5 minutes, T + 5 minutes]`. Before `T − 5`, both sides show the upcoming appointment and no photo bytes move.
- If both browsers are online anywhere inside the window, they connect automatically and exchange the photo(s). Both peers being online beforehand is enough: the connection starts when the window opens at `T − 5`, not at `T`.
- Both early and late presence count. Both online at `T − 4`, at `T`, or at `T + 4` all exchange automatically; five minutes late is still on time. The UI may use “early”, “due”, and “still open” labels but does not block transfer at either boundary.
- The scheduled time is the centre of the meeting window, not a start gate. A pair that is already online may complete the handoff before `T`.
- After `T + 5`, an uncompleted appointment remains pending indefinitely. If both humans become online later, the handoff runs at the next presence/timer evaluation. Lateness never discards, expires, or auto-cancels the photograph.
- An online recipient sees a local “handoff is open” alert at `T − 5`. The remote server notice may have arrived earlier.
- Timing is computed locally from the stored timestamp. No extra server timer is required; clock-skew affects labels, not the existence or eventual delivery of the appointment.
- If both peers are already online before `T − 5`, the creator's timer initiates automatically when the window opens. No second confirmation is required.
- This timing rule applies only to private photo handoffs; the optional one-minute live voice window has its own duration rules.

### Photo voice notes

- One optional voice note per share, maximum 60 seconds. It is an attachment to that delivery, not a separate message thread.
- Recording uses an explicit user action, browser microphone permission, and `MediaRecorder`/equivalent. A local timer stops capture automatically at 60 seconds. No auto-record and no background recording.
- Local preview/replace/delete before scheduling. The note lives in IndexedDB next to its photo attachment.
- During handoff, a manifest describes the note (duration, MIME, size) and its bytes follow the photo on the same authenticated RTC data channel. The receiver verifies completion before storing it and ACKing the handoff.
- If the transfer retries, both photo and note retry together; a partial note is never exposed as playable. If the handoff fails, both remain on the sender.
- Playback requires a user action, shows duration and progress, and never autoplays. No server-side transcoding, transcription, or captions in the first release.
- Deletion of a local photo deletes its note. No public visibility is implied.
- Voice notes count toward local storage, not the signalling server's metadata store.
- The 60-second voice note and the one-minute live call are separate audio features with separate consent surfaces.

### Local photo re-sharing

- A locally held, delivered **outgoing** photo can seed a new rendezvous. The composer receives the existing photo blob and optional voice note from IndexedDB; there is no new file picker or upload.
- The new appointment gets its own ID, recipient, time, status, notification, and wall rank. The source appointment and every other share remain independent.
- Recommended storage model: content-addressed media assets plus per-share references, so re-sharing does not duplicate large blobs and deleting one share cannot orphan another. A simpler cloning implementation is acceptable only if lifecycle independence is preserved.
- Only linked humans can be chosen. Re-sharing private incoming photos is deliberately not offered.
- The original local photo bytes remain subject to local deletion: if all local copies are removed, the re-share action disappears.
- The same voice note can be reused or replaced/removed before the new share. Its 60-second limit still applies.
- Only new appointment metadata is sent to the bootstrap server. Private media remains peer-to-peer.
- A re-share's removal/cancellation follows the same human/appointment rules and never modifies the source.

### Future public-photo re-share (later)

This is a separate product surface, not an extension of the private no-media-server invariant. Before implementing it, the service needs:

- explicit per-photo publication and unpublishing by the owner;
- a public media store/CDN or peer-hosting design with stable references;
- access, moderation, reporting, takedown, caching, and retention policy;
- attribution and provenance that survives re-sharing;
- clear rules for existing delivered copies after unpublishing (they cannot be recalled);
- separate voice-note visibility control;
- isolation so a public photo cannot expose private relationships, private voice notes, identities, or locations;
- testing that publishing one photo never makes any other local photo public.

Until those are designed, all photos are private and re-sharing is limited to local outgoing photos owned by the user.

## 13. Package surface

```ts
import {
  RendezvousClient,
  buildInviteUrl,
  createRendezvousClient,
  defineRendezvousApp,
} from '@instanthero/rendezvous';

const client = createRendezvousClient({
  signalUrl: 'wss://example.com/signal',
  iceServers: [{ urls: 'stun:stun.example.com:3478' }],
});

await client.start();
client.on('state', render);

await client.setCodeName('Ana');
const record = await client.scheduleRendezvousForNewPerson({
  photo,
  scheduledFor: timestamp,
});
const link = buildInviteUrl(record.inviteToken!);
const code = await client.verificationWordsFor(humanId); // 8 words, local
await client.markHumanVerified(humanId);
await client.scheduleRendezvous({
  humanId,
  photo,
  scheduledFor: timestamp,
});
```

`<rendezvous-app>` uses the same client and accepts `signal-url` and (optionally) `ice-servers` configuration. Hosts may listen for `rendezvous:notice` and `rendezvous:transfer` DOM events for integration.

---

## 14. Can RTC peers act as signalling servers in the future?

**Yes, partially — and it is worth designing for, but it does not remove the need for a bootstrap and a rendezvous point.**

WebRTC peers can carry arbitrary data over their data channels, including SDP offers/answers and ICE candidates. An already-connected peer can therefore relay signalling between two peers (for example, A knows B and C, and helps B and C establish a direct connection). This is used in some peer-assisted and mesh WebRTC designs. The client transport can abstract this as a signalling relay.

Constraints that remain true:

1. **Nothing happens without a first connection.** A browser that has never met a peer needs a signalling channel to exchange SDP/ICE. That first channel is currently the WebSocket server.
2. **Offline delivery needs a host that is online.** A rendezvous notice for an offline recipient cannot be delivered by another browser that is also offline. Peer relays can reduce server dependency only while at least one relay peer is online and knows where to deliver. A durable store-and-forward mailbox still wants a server (or a replicated peer store with availability assumptions).
3. **Presence discovery needs a meeting place.** The current server provides a stable meeting point where browsers discover each other's current connection. A peer-only design requires a durable rendezvous network and bootstrapping mechanism.
4. **Connectivity is not transitive.** Being connected through B does not mean B can make A↔C routable; B can relay control signals, and could even relay photo bytes, but that turns B into a data relay and reintroduces availability/privacy/bandwidth costs.
5. **TURN remains a server.** Some NATs cannot establish direct paths. A TURN server relays encrypted traffic and is a separate infrastructure need from signalling.
6. **Security and trust become more complex.** Relayed offers can be tampered with unless authenticated. Signed identities/capabilities help, but peer relay operators can drop, delay, or observe metadata.
7. **Availability and consistency.** A peer mailbox is only available when the peer is online. Store-and-forward across offline windows normally uses a server or replicated storage.

A realistic evolution:

- **Phase 1 (this build):** WebSocket signalling + STUN; direct photo transfer; server queues appointment metadata.
- **Phase 2:** Multiple signalling servers; authenticated relay identity; TURN for connectivity.
- **Phase 3:** Existing peers can relay signalling and appointment notices for other humans while online, with the WebSocket server as bootstrap/fallback. Offline notices still use the server (or a durable peer mesh).
- **Phase 4:** Fully serverless mode between already-connected peers, explicitly best-effort and only while a relay peer is online.

The v1 code isolates the signalling channel behind a transport seam so this can be introduced without changing the UI or appointment model.

---

## 15. Security & threat model

### Included
- Self-certifying peer identities derived from P-256 public keys.
- Signed, short-lived server challenge on every signalling connection, proving control of the private key.
- Signed invitation links that cannot be trivially forged.
- Public-key pinning of linked humans; key mismatch fails closed.
- A stable 88-bit, 8-word SAS derived independently from both sorted public keys.
- Signed live-session handshake over DTLS fingerprints, checked before any photo bytes are sent.
- Web Crypto keypair stored in IndexedDB as `CryptoKey` objects.
- Presence subscriptions reveal only chosen humans.
- Photo transfer encrypted by WebRTC DTLS.
- Server-side size caps and message-type validation; no photo fields.
- TURN is optional and sees only encrypted WebRTC packets.
- **Audio:** DTLS-SRTP encryption, identity-pinned audio handshake, explicit microphone consent, browser-owned microphone indicator, and no recording by Rendezvous.
- **Voice notes:** recorded by explicit action, capped at 60 seconds, stored and transferred with the private photo over the authenticated data channel, never server-stored.
- **Local re-share:** reuses local media, no upload, independent appointment lifecycle.
- **Reciprocal contribution:** the non-creator’s photo stays local until the same authenticated P2P handoff, with independent per-direction ACKs; no server bytes or contribution metadata in the notice.
- **Live rendezvous screen:** a UI surface over the existing session; it adds no new trust and never gates the photo path.

### Not included in v1
- Server authentication/authorisation or abuse moderation.
- Application-layer encryption of appointment metadata.
- Push notifications to closed apps.
- Multi-device identity, account recovery, contact verification inherited from mutual friends, or key rotation.
- Anti-spam/rate limiting beyond basic caps.
- Short numeric SAS with a commitment round.
- A production TURN deployment.
- A public-photo data plane, public media storage, public discovery, or re-sharing third-party private photos. US-20 is explicitly deferred.

The signalling server can still deny service, drop traffic, or observe appointment metadata. It cannot silently substitute a peer identity or DTLS endpoint because the client fails closed on the signed handshake and pinned keys.

These are explicit follow-ups, not accidental omissions.

---

## 16. Non-goals for v0.1

- Albums, captions, reactions, comments, or video.
- Group photo broadcast. A circle offer proposes a moment, but every photograph still moves in a direct pairwise handoff and members join offers independently.
- Server-side thumbnails, cloud storage, or media URLs.
- Offline background transfer.
- Automatic photo compression/transcoding.
- Mobile native apps.
- End-to-end encrypted text chat.
- General-purpose calling, group calls, unsolicited recordings, voicemail, or audio transcription. (Voice notes up to one minute and the one-minute live voice window are the scoped exceptions, implemented in v0.1.)
- Public photo feeds, public discovery, and public media storage in the private v1 surface. (US-20 is explicitly later.)
- Read receipts beyond the one transfer ACK.
- Resharing other people's private photos.
- A public feed, public profiles, or a public media store in this release.

---

## 17. Acceptance test scenarios

1. **Rendezvous invite while both online:** A sets a rendezvous for **someone new**; DONE shows its link; B opens the link and immediately sees the same appointment in the upcoming area and A under humans; both see live presence; reloads preserve the relationship and appointment.
2. **Rendezvous invite while A offline:** A sets a rendezvous for **someone new** and shares the link; B opens it and already has the appointment; the server queues B's join; A connects later, pins B, and attaches the same appointment without creating a second one.
3. **Scheduling for an existing human:** photo + linked human + next occurrence saved; B receives the appointment notice; A sees `rendezvous:created`.
3b. **No separate add-human flow:** no header, empty-state, menu, or composer escape hatch offers a standalone human invitation; the only human-invite surface is the DONE link for a **someone new** rendezvous.
4. **Waiting as recipient:** at due, A is offline; B sees “waiting for A”; no success claim.
5. **Waiting as sender:** at due, B is offline; A sees “waiting for B”; A's photo remains in IndexedDB across reload.
6. **Meeting:** both online after due; auto handshake; recipient receives complete image; sender only sees delivered after ACK; reload shows photo in recipient archive.
7. **Failure/retry:** kill recipient mid-transfer; sender shows retry/waiting; when recipient returns, transfer repeats and succeeds without duplicate archive items.
8. **Delete human:** A removes B; B receives removal (online or next connection); B can no longer initiate or see presence; old pending appointment is cancelled.
9. **Server restart:** queued appointment notice survives in JSON store and is delivered after reconnect.
10. **Identity pinning:** a second browser cannot register a friend's peer ID without the friend's private key; a changed key for a pinned peer is rejected rather than overwriting the stored public key.
11. **Stable verification code:** both tabs independently show the same eight words after linking; reloading or a new DTLS session keeps them identical; marking verified persists. An intentionally altered pinned key produces different words and fails the live handshake.
12. **Signed handshake:** an offer/answer with altered DTLS fingerprints (simulated in test) is rejected before any photo bytes are sent.
13. **Ephemeral RTC:** closing a tab terminates the direct connection; reopening and both being online re-establishes signalling and can complete a pending handoff without another invitation.
14. **Accessibility:** keyboard-only invite, verify, schedule, dismiss, remove, open an upcoming rendezvous detail, and expand its comparison words; visible focus; correct live announcements.
15. **Responsive:** 390×844, 320×568, and 1280×800 viewports; no horizontal overflow; modals usable; the `live` indicator stays in the very top-right corner; the circle dock still exposes at least 2.5 circular items when its row overflows.
16. **Photo wall ranking:** deliver at least three photographs; the newest is rank 01 and largest, every subsequent width is smaller until the practical minimum, all remain present, and clicking any one opens the viewer.
17. **Server contains no photos:** test with two browsers; inspect all server messages/storage for image data; none present.
18. **One-minute voice:** with both present at an open-handoff rendezvous, open the live rendezvous screen, press **start audio 1min**, request/accept microphone consent, verify audio flows only after the authenticated handshake, countdown ends at 60 seconds, tracks stop, the action cannot be reused, and a microphone denial leaves the photo path functional.
19. **Early/late handoff:** no transfer at T−6; both present at T−4 → automatic transfer; both present at T+4 → automatic transfer; both only present at T+20 → still waits and later completes rather than expiring.
20. **Photo voice note:** record ≤60 seconds, stop at the cap, verify it is stored/transferred with the photo and plays only on user action; failure of the audio attachment keeps the complete handoff pending.
21. **Local re-share:** re-share an outgoing delivered photo without a file chooser or media upload; new share has independent timing and wall rank; deleting one share leaves the source and other share intact.
22. **Public re-share (later):** verify photos default private, publication is explicit and revocable, attribution survives, and a public asset cannot expose private photos, voice notes, relationships, or locations.
23. **Circle independent offers:** two members offer different moments on the same local day. Both offers remain visible and joinable. A member joins one, the other stays pending; joining never cancels the other offer. A counter-proposal creates a third independent offer. No canonical winner is computed.
24. **Circle invite auto-accept:** a valid addressed invitation is auto-accepted and produces a signed Join; a bundle forwarded to another key is rejected; leaving still works.
25. **Circle invite, not circle storage:** an offline member receives the expiring offer invite on next connection; the server contains no circle membership, offer joins, attendance, stats, or record log and no photo bytes; the invite is deleted once its offered time has passed; duplicate delivery is idempotent. All other circle records sync only over authenticated RTC.
26. **Circle auto-sync:** two online members with different arrival orders converge on the same offer and join sets without manual action; when one reconnects, sync resumes.
27. **Circle dock:** with zero, one, and many circles, every circle appears exactly once as a circular icon, `+ circle` is the leading item and an actual circle, the dock is anchored to the bottom-right and enters from the right, the active state is accessible, the row scrolls without shrinking icons, and whenever it overflows at 390×844, 320×568, and 1280×800 it exposes at least two complete circles plus half of the next without page-level horizontal overflow; the dock covers neither the wall nor primary controls.
28. **Reciprocal photo:** B opens an appointment A created, attaches a photo while A is offline, and sees it in the upcoming row; no photo bytes or contribution metadata reach the server; when both are online, A's photo reaches B and B's photo reaches A, each with its own ACK; a missing contribution on one side still completes the other direction.
29. **Live rendezvous screen:** when both are online inside the window, the live screen appears; **start audio 1min** is disabled after the single window is consumed, and audio cannot flow before both peers authenticate; dismissing or minimising it does not pause the transfer; audio consent/countdown works; microphone denial leaves the photo path functional.
30. **Circle time window:** a circle sets a single-evening window; an offer at 21:30 is accepted, offers exactly at either boundary are accepted, and offers before the start, after the end, and on the next day are rejected; a later window does not invalidate an accepted offer; several offers may exist inside the same window on the same day; an offline member merges the same window records and reaches the same verdicts without the server storing the window.
31. **Photo possession inventory:** a recipient receives, ACKs and claims a photo; the owner's inventory shows **confirmed recently/last confirmed** with the correct time. The recipient deletes the local copy and a signed release reaches the owner; the state becomes **deleted**, but not before. An offline recipient is shown as **last confirmed**, never as currently holding. A re-share to a second human adds a holder under the same `photoId`. Removing a human leaves the last known state without remote recall. A copy downloaded and sent outside Rendezvous never appears. The server contains no possession ledger.
32. **Upcoming rendezvous detail:** selecting an upcoming rendezvous opens the exchange detail, not the human verification panel. The local photo and voice note (if any) are shown from IndexedDB; the counterpart’s photo appears only as state. The comparison words are collapsed by default and absent from the accessibility tree until expanded. No incoming object URL, thumbnail, filename, size, or voice-note metadata is created before delivery. The human chip still opens the human panel; a delivered print still opens the viewer.
33. **Live indicator:** at the top-right corner, the connected state shows exactly **live** with no **signal** prefix in the page chrome, has an accessible name that says what state it reports, and opens the diagnostics panel; narrow screens keep it compact in the corner rather than removing it.
34. **Upcoming hides the large action:** with no pending rendezvous, the large **Set a rendezvous** action is visible. After one is set, it disappears completely while the appointment is scheduled, waiting, failed, or overdue, and the hero countdown/upcoming area takes its place. Delivering or deleting the last pending appointment brings the action back. It is never shown disabled or faded in this state.
35. **Live audio disabled:** set a rendezvous with **I won’t be able to speak** checked. Both browsers receive the flag; the live rendezvous screen shows **Live audio is off for this rendezvous.** on both sides; no **start audio 1min** control or consent request appears; the photo handoff and any photo voice note still work; other rendezvous remain unaffected; a later rendezvous without the flag can use live audio normally.
36. **Pending, confirm, and counter-propose:** a new direct rendezvous is pending on both sides. One human confirms; it stays pending until both confirm. One human proposes another time; the original time is cancelled, the same rendezvous and photo remain, both confirmations reset, and the update reaches the other human through the server even if they were offline. The other human confirms or counters again. The pending label does not prevent the five-minute handoff or photo transfer.
37. **Circle free-for-all:** one invite spawns three independent offers at different times. Different members join different offers; the offers remain independent and several parts of the group meeting happen at different times. Nobody joins one offer, and it stays pending. A counter-proposal creates another offer without cancelling any existing offer. Confirmed offers show their participants; pending ones do not block anything. The server stores only the expiring offer invites and no join, attendance, or stats records.

---

## 18. Open questions / future work

- Should appointments support cancellation and rescheduling with a peer notification? (v1: delete locally; scheduled entries can be removed by deleting the human or item.)
- Should the recipient get an explicit “I’m here” RSVP, or is presence alone enough? v1 uses presence to honour the three-step flow.
- TURN hosting and provider configuration.
- Native/push notifications for closed browsers.
- Multi-device identity.
- Authenticated presence and end-to-end encrypted appointment metadata.
- Peer-assisted signalling per §14.
- Compression/thumbnail choice for very large or HEIC photos.
- One-minute voice channel implementation and consent UI.
- Photo voice-note recording/player and media reference storage.
- Local re-share from the photo wall.
- Public-photo layer, public storage, moderation, attribution, and revocation (US-20).
- Should circle invitations return to explicit accept/decline after the auto-accept phase?
- Should a circle member be able to withdraw a PlanJoin, or is joining permanent history like other signed records?
- Should circle offers archive automatically after their time passes, or remain visible as history until manually hidden?
- Should a direct counter-proposal have a cooldown or a maximum number of rounds to prevent churn?
- Should confirmation be a hard gate in a future release, or remain the label-only agreement state specified here?
- Should circle time windows support recurrence (daily, weekly, monthly) or more than one upcoming window, rather than a single bounded interval that members replace for each gathering?
- Should changing a circle time window require a quorum, or does the latest valid signed window always win as CIR-6 specifies?
- Optional local-only captions or transcripts for voice notes/live voice, with explicit consent and no server upload.


---

## 19. Infrastructure addendum: IPv6, dual-stack, diagnostics, TURN

### IPv6 reality
A browser cannot assign itself an IPv6 address. The address is supplied by the device's network (ISP, router, or mobile carrier). The app's job is to support it when it exists:

- Read both address families from the browser's ICE gathering; do not filter either.
- Run the signalling server dual-stack by default.
- Warn loudly at server startup if the bound address is not dual-stack.
- Surface the client's observed signalling family and dual-stack capability in the UI.
- Document that a dual-stack reverse proxy/load balancer is the deployment boundary.
- Document that STUN/TURN endpoints must also be reachable over both families.
- Never present an in-app switch that claims to “enable IPv6”; explain that the network owns it.

### Dual-stack bootstrap server
The reference server binds `::` by default. Node's dual-stack listener accepts IPv4-mapped connections on the same socket. `HOST`, `RENDEZVOUS_HOST`, and `RENDEZVOUS_IPV6_ONLY` can override this for special environments. On startup:

- dual-stack: log `dual-stack listener enabled (IPv4 + IPv6)`;
- single-stack: log a prominent warning naming the single family and the fix.

`/health` and the signed `hello:ok` response carry the listener host, dual-stack boolean, client-observed address family/address, and a warning string. The UI repeats the warning in diagnostics and never hides it behind a tooltip.

### Diagnostics content
- signalling status and online-human count;
- observed socket address family and address as seen by the bootstrap server;
- bootstrap listening host and dual-stack boolean;
- last direct connection: selected local/remote families, candidate types, and UDP/TCP;
- gathered candidate counts by IPv4 / IPv6 / hidden (mDNS);
- interpretation note about network-assigned addresses, mDNS privacy, and no candidate filtering.

### TURN assumption
TURN is optional, self-hosted, and untrusted. It relays encrypted WebRTC packets only. Running without TURN is acceptable for the initial build: some network pairs will fail direct connection and show an honest retry/waiting state. Identity signatures and pinned keys still prevent a TURN operator from impersonating either human. Appointment metadata visibility and availability remain the signalling server's domain.
