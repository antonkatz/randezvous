# Rendezvous — Product & Technical Specification

**Status:** v0.1 · initial build; reciprocal photo contributions, the live rendezvous screen, voice notes, re-sharing, and one-minute audio are specified for future work. The five-minute early/late handoff window and delivery celebration are implemented.
**Date:** 22 November 2026  
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

> **Implementation note:** v0.1 implements the private browser-to-browser photo handoff, invites, verification, revocation, ranked wall, diagnostics, the five-minute early/late handoff window, and the delivery confetti animation. The following are **specified future additions and are not in the v0.1 build**: reciprocal photo contributions from the non-creator, the live rendezvous screen, per-photo voice notes, re-sharing a locally held photo, the one-minute live voice window, and the future public-photo re-share layer. They are written here to lock the product behaviour before implementation. Circle records, membership, and stats also exist as a separate local module (`src/circles`); their daily canonical rule, auto-accept policy, expiring server-side rendezvous invite, and two-member auto-sync are specified in §3 but are not yet wired into the app.

Rendezvous is a tiny, private photo-sharing service that runs entirely in the browser. Two people link their browsers once, then leave photographs for each other at chosen times. Photos travel directly from browser to browser over WebRTC. There is no photo upload, no media server, and no account in the private path. (A future, separate opt-in public-photo layer is sketched in US-20 and explicitly deferred.)

A **live WebRTC connection is never permanent**. Closing the page ends it. What persists is each browser's keypair, the pinned public key of the other human, and the stored relationship. On the next visit both browsers re-authenticate to the signalling layer and rebuild a direct connection automatically when a handoff is needed. "Connected forever" is a product promise about the relationship, not a claim about an open socket.

The product is also a reusable base: the signalling client, the rendezvous engine, and the UI are exposed as a package that later Instant Hero components can embed or compose.

### The invariant that defines the product

> **A rendezvous is a scheduled meeting, not a timed delivery.**
>
> A photo can move only while both people have the app open and connected at the same time. The signalling server stores the appointment (who, what time, which notice), never a private photo. (A future public layer would be a separate, explicitly opted-in surface.) The normal handoff window runs from five minutes before to five minutes after the scheduled moment. If both browsers are online anywhere in that window — including both already being online beforehand — they connect automatically and exchange the photo. If only one person is present, nothing is delivered. The rendezvous remains “waiting” and completes at the next overlap when both browsers are open — lateness alone never discards it, even beyond the five-minute late tolerance.

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
| **Circle** | A named, private group of linked humans that shares at most one canonical rendezvous per local day. |
| **Active circle** | The circle currently shown on the main surface, selected from the bottom circle bar. |
| **Circle invitation** | A signed offer addressed to one public-key identity to join a circle. It is not a bearer link. |
| **Rendezvous** | A scheduled photo handoff between two humans at one moment. The creator contributes a photo; the other human may contribute one reciprocal photo. |
| **Creator** | The human who sets the rendezvous, chooses its moment, and attaches the first photo. |
| **Reciprocal contribution** | The optional one photo the non-creator attaches to an existing rendezvous, delivered to the creator at the same meeting. |
| **Circle rendezvous** | The one shared appointment for a circle on a local calendar day; metadata only. |
| **Canonical circle rendezvous** | The first valid signed circle rendezvous for that circle and day, by signed creation time and then record ID. |
| **Circle rendezvous invite** | A circle rendezvous notice delivered to members. The server stores only this circle invite, and only until the scheduled rendezvous time has passed. |
| **Rendezvous time** | The local date and time chosen by the creator. Stored as an absolute Unix timestamp. |
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

### Adding a human

#### US-3 — I can add a human with a link
As the owner of this browser, I want one obvious action that produces a join link, so that another person can link their browser to mine.

**Acceptance criteria**
- A single black button with white text reading **add human** is pinned to the top-left of the interface. It is the only top-left control.
- Clicking/tapping it opens a small panel that drops down beneath the button.
- The panel contains a shareable link and a copy action.
- The link is a signed invitation to my current peer identity. It can be generated while the signalling server is offline.
- The link opens the same app, verifies the invitation locally, and immediately creates the reciprocal relationship.
- The link embeds the inviter's public key. The invitee pins it, and the inviter pins the invitee's public key from the connection request. A later claim to the same peer ID without the matching private key is rejected.
- If the inviter is online, they receive the request immediately. If not, the signalling server queues the request until the inviter next connects.
- Both sides then retain each other’s identity permanently until either side deletes the relationship.
- The link is a bearer credential: anyone who has it can connect. There is no account, approval screen, or password in v1.
- Invitation token hashes are stored with the resulting relationship. Deleting the human revokes the token everywhere; an old copied link no longer works.
- Opening one’s own link does nothing except show a friendly message.
- Following an already-used link from the same browser is idempotent.
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
- The code is shown in a human-detail panel. A “Verified” / “Not verified” badge is always visible on the human.
- The panel instructs both people to compare the words **out loud or through another app**. It explicitly warns not to compare over the same link/channel that delivered the invitation.
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
- Invitation-token hashes associated with the relationship are revoked locally and recorded by the bootstrap server. Reopening the old link is rejected on both sides; re-adding requires a fresh invitation link.
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

### The rendezvous

#### US-6 — I can set a rendezvous
As a sender, I want to choose one photo, one human, and a time, so that we can meet for the handoff.

**Acceptance criteria**
- The central action reads **Set a rendezvous**.
- The flow has exactly three stages:
  1. **Photo + human.** Select an image from the device, optionally attach a voice note of up to 60 seconds, and select one of my linked humans.
  2. **Time + optional date.** Choose a time. If wanted, choose a date. If no date is chosen, the app resolves the next occurrence of that time (today if still ahead, otherwise tomorrow).
  3. **DONE.** A clear confirmation shows the chosen human and the resolved local moment.
- The photo is validated (image MIME type, maximum 25 MiB) and stored only in the sender’s IndexedDB.
- A photo may carry one optional voice note, recorded in the browser and no longer than 60 seconds. It travels in the same authenticated handoff and never passes through the server.
- The photo is not uploaded to, encoded into, or referenced by the signalling server.
- A unique appointment ID is generated locally.
- The appointment is saved locally before it is announced, so closing the tab directly after DONE does not lose it.
- The appointment metadata is sent to the signalling server for store-and-forward delivery to the recipient.
- The sender may schedule while the signalling server is offline; delivery is retried while the app remains open and on subsequent launches.
- The completed flow makes the meeting requirement explicit: both browsers must be present.
- A rendezvous carries at most one photo per participant: the creator’s photo plus an optional reciprocal contribution from the other human (US-10b). The creator’s three-stage flow never waits for a reply.
- Only one human is selected per direct rendezvous. A circle rendezvous is the group exception: it selects a circle and a shared moment, while each photo transfer remains a direct pairwise handoff.

#### US-7 — The recipient is notified when they return
As a recipient, I want the appointment to be waiting for me even if I was offline when it was created, so that I know to meet my human.

**Acceptance criteria**
- The signalling server stores the appointment notice until the recipient acknowledges local persistence.
- If the recipient is online at creation, the notice is delivered immediately.
- If the recipient is offline, the notice is queued indefinitely within the retention policy and delivered on their next connection.
- The notice contains only: appointment ID, sender ID, sender display name, scheduled timestamp, and creation timestamp.
- The recipient’s client persists the notice locally.
- The persisted appointment appears in the recipient’s upcoming area and offers **add a photo** for an optional reciprocal contribution (US-10b).
- An upcoming appointment produces a quiet in-app notice. When the handoff window opens at five minutes before the scheduled time, an online recipient receives a prominent in-app notification; an overdue appointment that is still waiting also shows prominently.
- The server notice may arrive earlier; the local handoff alert is timed to the open window.
- If the recipient is online when the appointed time arrives, the client also raises a local “it is time” notification.
- Notifications are in-app only in v1. They are delivered on next launch through the server queue. There is no push notification while the app is closed.
- Unknown senders’ notices are rejected.

#### US-8 — We meet only when both are online
As a sender and recipient, we need to understand when a handoff can actually happen.

**Acceptance criteria**
- Before five minutes before the scheduled moment, either side sees the upcoming appointment and no transfer occurs.
- As soon as both humans are online anywhere in the `[T − 5 minutes, T + 5 minutes]` window, the sender automatically opens a direct WebRTC connection and hands off. If both are already online beforehand, the connection starts when the window opens at `T − 5`. No second confirmation is required.
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

#### US-9 — I receive a photograph
As a recipient, I want to know when a photo actually arrives and be able to view it later.

**Acceptance criteria**
- An incoming transfer shows a connected “receiving” state and progress.
- Completed photos are persisted to the recipient’s IndexedDB.
- A completed incoming photo raises a notification with an “Open” affordance.
- A completed handoff triggers a brief confetti celebration in both browsers. It must be non-blocking, must not obscure controls, must fire once per rendezvous, and must be skipped when the user prefers reduced motion.
- Every delivered photo appears on a persistent photo wall (“the wall”), starting from the first and ordered by arrival.
- The freshest delivered photo is rank 01; each later-ranked photo is progressively smaller according to a power-law distribution.
- The wall has generous whitespace below the top menu and is composed as a board, not a horizontal filmstrip.
- Each piece shows its rank, sender, arrival time, and a small audio badge if a voice note is attached. The image can be opened in a distraction-free viewer and downloaded to the device.
- A failed or interrupted transfer never leaves a corrupt photo in the archive.
- Duplicate appointment IDs and duplicate transfers are idempotent.

#### US-9b — We can speak for one minute during the rendezvous (planned)

As two people meeting for a photo handoff, we want a short live voice channel at the rendezvous, so that the moment can include a greeting, context, or goodbye without leaving Rendezvous.

**Status:** Specified for the next phase. **Not implemented in v0.1.**

**Acceptance criteria**
- Audio is offered only for a rendezvous whose handoff window is open, while both humans are online. It is attached to that appointment, not a general calling feature.
- Either human can request a one-minute audio window; both must explicitly accept and grant microphone permission before any audio flows.
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

#### US-9c — I can attach a voice note to a photograph (planned)

As a sender, I want to add a short spoken note to a photo, so that the recipient hears the story in my voice alongside the image.

**Status:** Specified for the next phase. **Not implemented in v0.1.**

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

#### US-9d — I can re-share a photo I already sent (planned)

As a sender, I want to share an existing photograph with another human without choosing and uploading the file again, so that a moment can travel to more than one person.

**Status:** Specified for the next phase. **Not implemented in v0.1.**

**Acceptance criteria**
- A delivered **outgoing** photograph in the photo viewer offers a **Share again** action.
- Share again opens the normal three-stage rendezvous composer with the photograph already attached from local storage. No file picker, new upload, or server media reference is required.
- The sender chooses one linked human and a time; a new appointment ID is created.
- The local photo bytes and any attached voice note are reused. The sender may review or replace the voice note before scheduling.
- Each share is an independent rendezvous and an independent wall print after delivery. Deleting the new appointment or its delivered print must not delete the source photograph, the old appointment, or another share.
- Delivery remains peer-to-peer; only appointment metadata goes to the signalling server. Nothing is uploaded to a media server.
- Private received photos are **not** eligible for local re-share in this phase. Re-sharing someone else's photo is only addressed by the future public-photo layer.
- Removing the recipient cancels that pending reshare in the normal way. Removing one human does not affect reshares with other humans.
- A photo may be re-shared to the same human or someone else; each appointment has its own timing, status, and notification.
- If all local source copies of the photo are deleted, Share again is unavailable.
- The simple three-stage composer remains three stages; a re-share is a preseeded normal appointment, not a new fourth flow.

#### US-10 — I can see what is next


As a user, I want to see my upcoming and waiting rendezvous without opening a separate inbox.

**Acceptance criteria**
- A compact “next/upcoming” area presents scheduled and waiting appointments.
- Each item identifies the human, local time, opening window, and state.
- Waiting items clearly say who needs to be online.
- Delivered photos move onto the ranked wall.
- Pending and waiting rendezvous are kept in a quiet strip above the wall, separate from the photo sequence.
- A user can delete a photo or pending appointment locally. Deleting a photo removes it from IndexedDB and re-ranks the remaining wall items.

### Circles

A circle is a named, private group of linked humans. Membership and each day's shared rendezvous are represented as signed records that every member can verify and merge. A circle has at most one canonical rendezvous per local day. A circle rendezvous is a shared appointment; photographs themselves still travel only in direct pairwise WebRTC handoffs, never through the server.

**Implementation status:** `src/circles` implements the signed record set, membership chain, addressed invitations, local peer sync, and stats. The daily canonical rule, auto-accept policy, expiring server-side rendezvous invite, and automatic two-member sync are specified here and are not yet wired into the app.

#### CIR-1 — A circle has one rendezvous per local day

As a circle member, I want the circle to have one shared rendezvous each day, so that the group converges on a single moment instead of competing plans.

**Acceptance criteria**
- The day is the calendar day of the scheduled timestamp in the circle's configured IANA timezone. A rendezvous scheduled at 23:58 belongs to that day.
- Any current member may set the circle rendezvous; there is no owner or admin privilege.
- At most one circle rendezvous is canonical for a circle and local day.
- Additional valid signed plans for the same day are retained as history but do not become canonical unless the rule in CIR-2 selects them.
- The limit applies to the circle's shared rendezvous. Ordinary one-to-one rendezvouses between members are unaffected.
- The record carries only circle ID, rendezvous ID, organizer, invitees, scheduled timestamp, signed creation timestamp, and signature. It never carries photo or voice bytes.
- A canonical circle rendezvous counts once in circle stats, however many members attend and however many plans were proposed. Non-canonical plans for the same day never count.

#### CIR-2 — The first rendezvous set becomes canonical

As a circle member, I want the first rendezvous set for a day to win, so that the group converges without voting, an owner, or a server decision.

**Acceptance criteria**
- Among valid signed circle rendezvous records for the same circle and local day, the record with the earliest signed creation timestamp is canonical. Ties are broken by the content-derived record ID, ascending.
- Canonicality is independent of local arrival order, peer sync order, and server receipt order; every member computes the same winner from the same signed records.
- A plan with a later signed creation timestamp cannot replace the canonical choice. If a valid record with an earlier signed creation timestamp arrives late, it replaces the previous choice and all synced members converge on it.
- Invalid, unsigned, wrong-circle, wrong-day, or non-member records never become canonical.
- The signalling server may relay the invite, but it must not store the circle record set, and it cannot create, alter, re-sign, choose, or promote a canonical record.
- Clients recompute canonicality locally; the server never stores a mutable “canonical” flag as authority.

#### CIR-3 — Circle membership is voluntary, auto-accepted for now

As a person invited to a circle, I want membership to be explicit and auditable, so that joining is recorded and I can leave.

**Acceptance criteria**
- A circle invitation is signed by a current member and addressed to one public-key identity. Unlike a human invitation link, it cannot be redeemed by whoever holds it.
- Accepting the invitation creates a signed Join record; declining creates no membership record.
- For the current build, the client auto-accepts a valid incoming circle invitation. This is a temporary client policy, not a weakening of the signed membership chain; an explicit accept/decline surface remains the later intent.
- Auto-accept verifies the invitation signature, circle ID, the inviter's current membership, and that the invitation is addressed to this browser's key. Invalid, mismatched, or forwarded invitations are ignored.
- The inviter still merges the signed Join. The server never adds a member on its own.
- Membership invitations and the resulting Join/Leave records never go to the signalling server; they travel only over authenticated RTC.
- A member can leave a circle at any time, including one joined by auto-accept.

#### CIR-4 — The server stores only the circle rendezvous invite

As a circle member, I want the day's invite delivered even when I was offline, without turning the signalling server into a store of circle history.

**Acceptance criteria**
- The member who sets a circle rendezvous submits a signed invite to the signalling server.
- The invite names its recipients, so the server can deliver it without storing or deriving the circle's membership. The recipient list is signed by the organizer and verified by recipients.
- The server stores only invites, and only until the scheduled rendezvous time has passed. It must not store the circle record log, membership history, Join/Leave records, attendance, stats, or any other signed circle record.
- An invite expires once the scheduled rendezvous time has passed, not at the end of the local day. Expired invites are deleted from the server; members keep their local copy.
- The server delivers each stored invite immediately to online members and on next connection to offline members. It may hold more than one invite for a circle and day, but it never decides which invite is canonical.
- Circle membership records, Join/Leave records, attendance, stats, and canonical history move only over authenticated RTC between members.
- The server relays the invite verbatim. It cannot create, alter, re-sign, choose, promote, or add members.
- Duplicate deliveries, reordered delivery, and reconnects are idempotent by invite ID.
- Clients verify every signature and recompute canonicality; a server-delivered invite has no extra authority over an RTC-delivered one.
- A rendezvous invite is not a membership invitation; receiving it never changes circle membership.
- Photos, voice notes, thumbnails, and media references are never part of an invite.
- For clarity: an invite may carry a signature, but storing the invite is not permission to store the circle's record set.

#### CIR-5 — Two online members sync automatically

As circle members, we want our browsers to exchange circle records whenever at least two of us are online, so that the circle stays current without a manual action.

**Acceptance criteria**
- When at least two members of a circle are online, their clients automatically exchange membership and rendezvous records over authenticated direct peer channels.
- The server is not part of this record sync.
- No manual sync, accept, or refresh action is required.
- Sync is idempotent and order-independent; duplicate, out-of-order, or replayed records converge on the same canonical rendezvous.
- A member coming online, reconnecting, or returning to the tab triggers sync.
- The server's invite delivery and RTC peer sync are complementary. Losing either one does not permanently fork the canonical choice.
- Only signed circle metadata moves over RTC. Photographs and voice notes remain in direct pairwise handoffs.

### Privacy, reliability, and errors

#### US-11 — Private photos never pass through the server
As a privacy-conscious person, I want confidence that only a direct transfer moves my photograph.

**Acceptance criteria**
- The private signalling protocol has no photo bytes, voice-note bytes, thumbnails, or photo-derived metadata field. The future public layer (US-20) is a separate, explicit surface with its own storage, consent, and moderation rules.
- Photos are sent only through an ordered WebRTC data channel after both browsers are present.
- WebRTC media/data is encrypted in transit by DTLS-SRTP / SCTP over DTLS.
- The server stores appointment metadata, expiring circle rendezvous invites, and relationship handshakes, but not image content or circle record history.
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

**Acceptance criteria**
- The top-right signal indicator opens a small diagnostics panel.
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
- It appears on the public landing/about surface and in single-tagline share cards; inside the app it must never displace **add human**, **Code Name**, or **Set a rendezvous**.
- Supporting copy may explain the meeting rule: photos move only while both people have the app open, and there is no upload or media server in the private path.
- It must not imply guaranteed delivery, background sync, permanent server storage, or availability after the tab is closed.
- “For free” applies to the private v1 service; a future public or paid layer must not retroactively change the claim.
- Tone is intimate and plain, with no exclamation marks, urgency, or growth-hack language.
- The line wraps without truncation on mobile and does not push the primary in-app actions below the fold.

---

## 5. Visual design user stories


The visual direction is an editorial, quiet private club: warm paper, black ink, one vermilion accent, and a single loud black invitation control. It should feel more like a printed appointment card than a social app.

### VDS-1 — First impression
As a first-time visitor, I see a calm, confident surface with three clear anchors: **add human** at top-left, **Code Name** at top-centre, and **Set a rendezvous** in the middle. I understand the service without reading instructions.

Acceptance:
- Page background is a warm off-white paper tone, not pure white.
- Typography pairs a large editorial serif with compact sans/monospaced utility labels.
- One accent (vermilion) is used sparingly for live/attention dots and notification marks.
- No stock photography, avatars farms, or dashboard chrome.
- A quiet centred masthead (“rendezvous by InstantHero”) may sit above the header. It is a wordmark, not a control, and must never compete with add human.
- The first screen fits without scrolling at 1280×800; secondary collections sit below or at the bottom edge.

### VDS-2 — The add human button
As a visitor, my eye is caught by the top-left control.

Acceptance:
- Solid black background, white text, exact visible label **add human** (lowercase), high contrast.
- Compact horizontal pill/rectangle, large enough for touch (minimum 44 px height).
- Distinct from the flat canvas via a subtle offset shadow or movement on hover.
- A small pulsing vermilion dot or plus glyph signals “add”.
- No second button competes beside it in the top-left corner.
- On press: one-pixel depression/scale; visible keyboard focus ring.

### VDS-3 — The join link panel
As an inviter, the link appears exactly where I asked for it.

Acceptance:
- Panel drops down from beneath the add human button, aligned with its left edge, with a short transform-origin animation.
- Small panel (max width ~390 px), dark ink surface with light text, like the back of an invitation.
- Contains: a short heading, one-line explanation that the link permanently links the two browser identities (a connection itself is rebuilt only while both are open), a read-only join link, and a copy button.
- Close affordance and Escape/outside-click dismissal.
- A copied state changes text to “Copied” and announces it accessibly.
- On small screens the panel becomes a sheet that stays within the viewport.

### VDS-4 — Code Name
As a returning user, I can see and edit how I appear without the name field feeling like a form.

Acceptance:
- Horizontally centred at the top of the page.
- Borderless/flat until focused; placeholder is exactly **Code Name**.
- Comfortable text size (at least 16 px on mobile), centred text, generous hit area.
- A quiet helper label (“this is how you appear”) may sit below in small caps.
- Focus reveals a thin ink underline and accent caret; no glowing box.
- Max length and empty state do not break the layout.

### VDS-5 — Set a rendezvous
As a sender, the central action is the calm focal point.

Acceptance:
- Centred in the primary scene, clearly interactive, labelled exactly **Set a rendezvous**.
- More expressive than a standard rounded rectangle: a large circular stamp/portal or similarly distinctive action, in the black/ink language, with a precise arrow.
- Hover/focus causes a restrained fill or orbit movement; nothing bounces or loops distractingly.
- The action remains obviously tappable on mobile.
- The surrounding hero copy explains the meeting condition in one sentence.

### VDS-6 — Photo and human step
As a sender, choosing the content feels personal.

Acceptance:
- Modal is a warm paper card, visually consistent with the page.
- Photo dropzone supports click and drag/drop; shows a preview immediately after selection.
- Selected human choices appear as simple rows with initials/avatar discs, names, and online badges. Only linked humans appear.
- The primary next action is disabled until both a photo and a human are chosen, with a clear explanation.
- If there are no humans, the step explains that a human must be added first and offers a way back to add one.
- An optional **add a voice note · up to 1:00** control sits beneath the photo preview. It does not compete with choose/continue.
- A photo with a note shows a small audio badge in the composer and later on the wall print.

### VDS-6b — Voice note (planned)

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
- Back and Schedule actions are visually distinct.

### VDS-8 — DONE
As a sender, I get a satisfying, honest confirmation.

Acceptance:
- Stage three says **DONE** or **Rendezvous set** prominently.
- Shows recipient code name and resolved moment.
- If a voice note is attached, the summary says so with its duration; it does not auto-play.
- Shows a status line: “We’ll tell [name] when they next arrive.”
- Contains the caveat: “The photo stays here until you’re both online.”
- Provides one clear close/finish action.
- The modal can be dismissed with Escape or outside click after completion, and the appointment is already saved.

### VDS-9 — Waiting states
As a sender or recipient, I immediately know why nothing is transferring.

Acceptance:
- Never show a generic “delivered” when waiting.
- Show the handoff as **open** from five minutes before the scheduled moment; label it “early” before the nominal time, “due” at the time, and “still open” through the five-minute late tolerance. Both early and late presence trigger the connection automatically. Lateness beyond five minutes must never look like failure or expiry.
- If only I am online: “Waiting for [name] to come online.”
- If only they are online: “[Name] is here. Your photo is with them and will move when they are online too.” (for the recipient, “with them” = with the sender; for the sender, “Waiting for [name]”.)
- If both are online, the state changes to connecting/transferring automatically.
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

### VDS-10b — One minute of voice (planned)

As a participant, the audio moment feels like a small, deliberate window rather than a permanent call bar.

Acceptance:
- The audio action is quiet and contextual: it appears on the open-handoff appointment card and/or as a small “speak for a minute” line when both humans are present. It is never a global always-on call control.
- Request/accept uses a small card with the counterpart’s name, a microphone explanation, and **Allow a minute** / **Not now** actions. Copy states plainly: “Nothing is recorded. Your microphone is live for at most sixty seconds.”
- During the window, a slim ink strip sits above the footer/bottom safe area (never covering the photo wall): counterpart name, circular or linear 60-second countdown, mute toggle, and end action.
- The countdown is typographic and calm, not a panic siren. Final ten seconds may gain a subtle accent; there is an audible/announced cue at 10 seconds and at the end.
- Both tabs show the same remaining window as measured locally; states announce “waiting for microphone,” “live,” “muted,” “reconnecting,” and “the minute is over.”
- Microphone permission is requested only after the person presses an explicit action. A denial produces inline recovery copy, not a dead call UI.
- On mobile, the strip respects the safe area and stays compact; toasts stack above it.
- End state is clearly recorded for this rendezvous: “The minute with Ana is over.” The action cannot be restarted.
- Accessibility includes a non-colour countdown label, focusable mute/end controls, and `aria-live` announcements without announcing every second.
- No recording indicator should appear because nothing is recorded; the microphone indicator and copy should say “live voice, not recorded.”

### VDS-11 — Humans

As a returning user, I can see my private circle.

Acceptance:
- A quiet horizontal list (or wrapped row) beneath the central scene labelled “your humans”.
- Each human shows a small avatar/initial, code name, and a live dot when online.
- Online status is indicated by both dot and text/accessibility label, not colour alone.
- Remove action is available on the item without hover-only dependence, ideally in a small menu or labelled × with confirmation affordance.
- Empty state is an invitation-like line, not a blank area.

### VDS-11b — Verification panel
As a human with a new connection, I can comfortably verify without the interface becoming a security console.

Acceptance:
- Each human item shows a small, honest status: **Verified** or **Not verified** (with a shield/check mark; never colour alone).
- Opening a human’s small detail panel shows their name, the eight-word code, the comparison instruction, and a “Mark as verified” action.
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
- There is generous breathing room between the top menu (add human / Code Name / signal) and the board. The board can live below the hero and human strip.
- Each item is a framed print with a tiny rank marker, direction/sender caption, date, and a voice-note badge when applicable. Slight rotations may be used sparingly; the layout must still read as one composition.
- Outgoing prints expose a **Share again** action in the viewer; it is not drawn on top of the print itself.
- Pending, waiting, and failed rendezvous are shown in a separate compact strip above the wall. They do not occupy rank positions reserved for delivered photographs.
- Clicking a print opens the full-bleed photo viewer. The viewer has download and local-delete controls.
- Deleting a print removes it and re-ranks all older prints. The layout smoothly recalculates on resize. Re-shares are separate prints and deleting one never deletes the source or another print.
- On mobile, the wall becomes a narrower flowing column set; the rank-01 photograph still leads at the largest size and two smaller prints may share a row.
- The wall is cumulative personal history: it includes delivered photos shared in either direction, captioned “from” or “to” the human.

### VDS-12b — Re-sharing a local photograph (planned)

As a sender, I can move an existing photo into another private rendezvous without the file-picking ceremony again.

Acceptance:
- The full-screen photo viewer for an outgoing delivered print includes **Share again** alongside download and delete.
- It opens the normal rendezvous card with the photograph (and existing voice note) already in place, clearly labelled “reusing this photograph from your wall”.
- No file chooser appears unless the sender explicitly chooses to replace the photo.
- The sender still chooses one human and a moment, confirming the same meeting rule. The primary action remains **Set a rendezvous**.
- DONE identifies that this is another share of an existing photograph and shows the new recipient/moment; the original remains untouched.
- The wall shows the new delivery as its own print with its own rank when it arrives.
- If voice-note replacement is offered, it uses the VDS-6b recording surface and never auto-records.
- The UI never suggests a cloud upload happened; copy can say “from this browser’s copy”.

### VDS-13 — Responsive behaviour

As a phone user, I get the same calm hierarchy.

Acceptance:
- Header keeps add human left, code name centred; signal status hides on narrow screens.
- Hero type and central action scale below 600 px.
- Modals become bottom sheets with large touch targets and safe-area padding.
- The circle bar stays pinned to the bottom above the safe area; its icons remain at least 44 px and scroll horizontally.
- Photo preview, date/time controls, and human selection are usable without horizontal scrolling.
- Reduced-motion preference removes non-essential animation.

### VDS-14 — Accessibility & tone
Acceptance:
- All controls reachable and operable by keyboard.
- Visible focus indicators; no focus traps outside open dialogs.
- Text/background contrast meets WCAG AA for body and controls.
- Inputs have labels (visually hidden where the design is deliberately flat).
- States are announced with `aria-live` and not encoded by colour alone.
- Copy is intimate and plain: “add human”, “Set a rendezvous”, “Waiting for Ana to come online.” No growth-hack language, no exclamation marks.

### VDS-15 — Connection diagnostics
As a user, I can open a calm technical footnote without leaving the page.

Acceptance:
- The top-right signal text/dot is a quiet, text-sized trigger — not another loud button.
- The panel is paper-coloured, compact, and uses monospaced labels with readable values.
- Rows cover signal, this socket's family/address, bootstrap dual-stack state, the last direct route, and candidate-family counts.
- Single-stack warnings use the accent bar and plain language, not alarm styling.
- Unknown/mDNS-hidden families are labelled “hidden”, not misreported as IPv4.
- Copy reminds the user that the app can use IPv6 only when the operating network provides it; the app cannot create an address.
- No IPv6 toggles or fake controls are added.

### VDS-16 — The circle bar

As a member of several circles, I can switch circles from a persistent bottom bar, so that every circle is one tap away without competing with the main actions.

Acceptance:
- A persistent bottom bar spans the bottom of the main app on desktop and mobile.
- The **`+ circle`** button is the leftmost item, pinned to the left edge of the bar. Its visible label is exactly `+ circle`.
- The `+ circle` button must always be an actual circle: equal width and height with a fully circular outline, at least 44 px in both dimensions. It is never a pill, rounded rectangle, or rectangular tab, at any viewport size.
- Every circle the person belongs to appears exactly once to the right of the button as a perfectly circular icon, never as a rectangular tab or pill.
- Each icon is at least 44 px in both dimensions, shows the circle’s initial or a quiet mark, and has an accessible name equal to the circle’s name.
- The active circle has a clear selected treatment (a ring or filled mark, plus a text or accessibility state), not colour alone.
- Selecting a circle icon makes it the active circle and updates the main surface. Selecting `+ circle` opens the create/join circle flow.
- The circle icons sit in a single horizontally scrollable row. The `+ circle` button stays at the left edge while the row scrolls; icons never shrink below 44 px.
- With no circles, the bar shows only `+ circle`; there are no empty placeholders.
- The bar respects the mobile safe area and never covers `Set a rendezvous`, the photo wall, or a modal’s primary actions. Toasts stack above it.
- Every item is keyboard reachable with a visible focus ring and is operable by keyboard and screen reader.
- The bar is quiet paper-and-ink navigation, not a photo filmstrip; the wall remains the only photo surface.

---

## 6. End-to-end flows

### 6.1 Invite and link

```text
A: click add human
A: local signed invite link generated (works without signalling)
A: shares link

B: opens link
B: verifies A's signature locally
B: adds A to humans immediately
B: sends signed connection request to server
   ├─ A online  → server relays now → A adds B
   └─ A offline → server queues    → A adds B on next connection
A: acknowledges server queue entry
Both: presence subscription includes the other; live dots appear when both online.
Both: pin each other's public key in IndexedDB. No live connection is retained.

A future visit re-authenticates the same keypair and re-establishes presence; a direct WebRTC connection is created only when a handoff is due and both are present.
```

The relationship is now two-sided and persists in both browsers. No server-side contact graph is required for future operation; the server only relays presence and queues pending appointment notices.

### 6.2 Setting a rendezvous

```text
1. Sender taps "Set a rendezvous".
2. Selects local photo, optionally records one voice note (≤60s), and selects one linked human.
3. Picks time (+ optional date).
4. App resolves local timestamp, saves appointment + photo + optional voice note to IndexedDB.
5. App sends ONLY appointment metadata to the signalling server.
6. Server stores notice until recipient acknowledges; delivers immediately if recipient online.
7. Confirmation: DONE. "Both browsers need to be open at the same time. The handoff opens five minutes early, and lateness does not cancel it."
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

### 6.3b One-minute voice during a rendezvous (planned)

```text
Both online, handoff window open, appointment still active
        │
        ├─ Either person taps "speak for a minute"
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

The audio offer exists only while both humans are present for the due appointment. It is not a mailbox, a wake-up call, a recording, or a general voice service. A missed call cannot be replayed.

### 6.3c Photo voice notes (planned)

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

### 6.3d Re-sharing a locally held photo (planned)

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


| State | Sender sees | Recipient sees |
| --- | --- | --- |
| `scheduled` | “Ana · Tomorrow, 09:30” | same |
| `open-early` | “Open early · waiting for Ana” | “Open early · waiting for Ana” |
| `waiting` (recipient absent) | “Waiting for Ana to come online” | n/a |
| `waiting` (sender absent) | n/a | “Waiting for Ana to come online. The photo is still with her.” |
| `connecting` | “Connecting directly…” | “Connecting directly…” |
| `transferring` | progress | progress |
| `delivered` | “Delivered · 09:31” | photo on the wall + notification |
| `failed` | “Couldn’t connect. Retrying while you’re both here.” | similar |

### 6.5 Circle rendezvous

```text
Any current member sets a circle rendezvous for local day D
        │
        ├─ sign the circle record locally (circle, plan, creation time)
        ├─ submit only the signed rendezvous invite (with recipients) to the server
        │     └─ server stores it until the scheduled time passes, then deletes it
        │        and delivers it to members online or on next connection
        └─ all other circle records stay local
                │
        when ≥2 members are online:
          automatic RTC peer sync of membership, attendance, stats,
          and full circle records (idempotent; no manual refresh)
                │
        each member verifies signatures and merges:
          canonical = earliest signed creation time for (circle, D)
          ties by content-derived record ID
                │
        if a valid earlier record arrives late over RTC:
          it replaces the previous canonical choice
                │
        all synced members converge on the same canonical rendezvous
```

The server holds only the expiring invite. Membership, Join/Leave, attendance, stats, and the record log never leave the browsers except over authenticated RTC. The canonical record is metadata only. A member still meets each other member in a direct pairwise handoff under the normal online and five-minute-window rules; the circle record only fixes the shared day and moment.

---

## 7. Functional requirements summary

- **FR-1** One persistent, IndexedDB-backed keypair identity per browser profile + origin.
- **FR-2** Signed invitation links, two-sided linking, store-and-forward link requests.
- **FR-3** Live presence only for linked humans.
- **FR-4** Three-stage rendezvous creation: photo + human → time (+ optional date) → DONE.
- **FR-5** Photos stored only in IndexedDB on the sender until handed off.
- **FR-6** Server stores only appointment metadata, expiring circle rendezvous invites, and short-lived delivery queues; circle records and history are never server-stored.
- **FR-7** Automatic direct transfer whenever both peers are online inside the `[T − 5 minutes, T + 5 minutes]` window, including when both are already online beforehand; a later overlap still completes, and lateness never discards the saved photograph.
- **FR-8** Reliable chunked file transfer with CRC-free size check, ACK, retry, and idempotency by appointment ID.
- **FR-9** Recipient notification on next connection after server notice, plus local handoff-window/due notification.
- **FR-9a** Cumulative ranked photo wall: newest-first arrival rank, power-law scale, pending rendezvous separated, responsive reflow, deletion re-ranks.
- **FR-10** Stable 8-word local verification code from sorted identity keys, persistent verified badge.
- **FR-11** Signed live-session handshake binding both DTLS fingerprints before photo bytes.
- **FR-12** Human removal propagates both ways and cancels pending meetings.
- **FR-13** Reusable headless client + custom-element UI, ESM, no framework requirement.
- **FR-14** Dual-stack bootstrap server by default, with startup and in-app warnings for single-stack deployments.
- **FR-15** Connection diagnostics for signalling family, dual-stack capability, ICE candidate families, and selected direct route.
- **FR-16** Revoked invite-token hashes, enforced locally and by the bootstrap server.
- **FR-17 (planned)** One optional voice note of up to 60 seconds attached to a photograph, stored and transferred with it over the authenticated P2P handoff, never server-stored.
- **FR-18 (planned)** One authenticated, one-to-one, camera-off live voice window of at most 60 seconds while a rendezvous's handoff window is open; explicit mutual consent; no recording; no server media.
- **FR-19 (planned)** Re-share an outgoing delivered photograph (and its note) from local storage to a new rendezvous without re-upload or file picker; all shares independent.
- **FR-20 (later)** Opt-in public-photo layer with re-sharing, attribution, revocation, moderation, and separate storage — not part of the private photo path.
- **FR-21** Responsive, keyboard-accessible interface matching §5.
- **FR-22** Circles are signed, content-addressed record sets with at most one canonical circle rendezvous per local calendar day.
- **FR-23** The first valid signed circle rendezvous for a circle and day is canonical, ordered by signed creation timestamp and then record ID; later plans cannot replace it, and members recompute the winner locally.
- **FR-24** Circle invitations are signed and addressed to one public-key identity; the current build auto-accepts valid invitations and still records a signed Join.
- **FR-25** The signalling server stores only the circle rendezvous invite, until the scheduled rendezvous time has passed, and delivers it to current members; all other circle records move over authenticated RTC, and the server cannot create, alter, re-sign, choose, or promote them.
- **FR-26** When at least two circle members are online, their clients automatically sync signed circle records over authenticated peer channels.
- **FR-27** A persistent bottom circle bar lists every circle as a circular icon, with `+ circle` pinned at the left as an actual circle; selecting an icon switches the active circle.

## 8. Non-functional requirements

### Privacy
- Photo and voice-note bytes never enter server memory in the private protocol.
- Appointment metadata is not end-to-end encrypted from the signalling operator in v1; the operator can see who scheduled with whom and when. The photo remains opaque.
- Circle rendezvous invites are visible to the signalling operator until they expire. Circle membership, attendance, stats, and record history are never sent to the server. Invites contain no photo or voice bytes, and clients never accept server-selected canonicality in place of signed records.
- The app should not log photo bytes, voice-note bytes, audio content, SDP bodies, or private keys.
- Identity private keys are held in IndexedDB as Web Crypto `CryptoKey` objects (non-extractable where possible), not as plaintext elsewhere. Any XSS on the origin can still ask the browser to use the key; isolation and CSP remain necessary.
- Human invitation links are bearer capabilities. Sharing a link shares access. Circle invitations are addressed to one identity and are not bearer links.
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
4. **Storage (`src/lib/store.ts`)** — IndexedDB identity keypair, pinned humans/queues, and rendezvous + private photo/voice-note blobs (planned media additions).
5. **UI (`src/lib/ui/`)** — encapsulated custom element built only on the public client API.
6. **Circles (`src/circles/`)** — signed membership, addressed invitations, canonical daily rendezvous, local stats, and authenticated peer sync.
7. **Reference server (`server/`)** — replaceable signalling + metadata store, including expiring circle rendezvous invites but no circle record history.

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
| `rendezvous:ack` | Confirm the recipient persisted the notice. |
| `circle:rendezvous:invite` | Store and deliver the signed circle rendezvous invite to members until the scheduled rendezvous time has passed. Circle records are never uploaded. |
| `rtc` | Relay offer/answer/ICE for a named transfer. Ephemeral; not queued. |

### Server → client

| Type | Purpose |
| --- | --- |
| `challenge` | One-time nonce issued immediately after the socket opens, before registration. |
| `hello:ok` | Server accepted authenticated registration; returns ICE config and server time. |
| `presence` | Online/name change for a subscribed human. |
| `invite:queued` | Server accepted a join request for delivery. |
| `invite:request` | An invitation request for this peer to add a new human. |
| `rendezvous:created` | Sender’s appointment metadata is durable. |
| `rendezvous:notice` | Appointment notice for the recipient. |
| `circle:rendezvous:invite` | The stored circle rendezvous invite for a circle this client belongs to; idempotent until the scheduled rendezvous time has passed. |
| `contact:removed` | A human ended the relationship. |
| `invite:rejected` | A join using a revoked invitation token was refused. |
| `rtc` | Relay from the other peer. |
| `error` | Protocol/validation error. |

### Planned audio control messages (not in v0.1)

The audio feature would add explicit consent/control messages alongside the existing signalling channel, for example:
- `audio:request` — attach a microphone request to an open-handoff appointment;
- `audio:accept` / `audio:decline` — mutual consent;
- `audio:end` — one side ends early;
- a dedicated authenticated audio RTC session with its own offer/answer/ICE and the same signed DTLS-fingerprint transcript used for photo sessions.

No audio byte, recording, transcript, or audio-derived feature is ever stored by the server. New message types must be versioned and must not weaken the photo path when audio is unavailable.

### Persistence / queues


- `joins`: delivered until inviter acknowledges.
- `rendezvous`: delivered until recipient acknowledges local persistence.
- `removals`: delivered until target acknowledges; each carries revoked invitation-token hashes.
- `revokedInvites`: durable hashes used to refuse old invitation links.
- `circleInvites`: only circle rendezvous invites, including their signed recipient routing list, delivered until the scheduled rendezvous time has passed. No membership, Join/Leave, attendance, stats, or circle record log is stored.
- Presence and RTC signals are ephemeral.
- Records involving a removed relationship are purged.
- Retention: 30 days for joins, removals, and appointment notices. Circle rendezvous invites expire once their scheduled rendezvous time has passed. Revoked invitation-token hashes are retained until the store is intentionally reset, so removed links stay revoked.
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

- Only appointment IDs, circle rendezvous invites, and RTC signalling cross the server. The selected image — and any attached voice note — never becomes a URL hosted by the server.
- A sender initiates a fresh `RTCPeerConnection` for each appointment once the handoff window is open at `T − 5 minutes` and both peers are present. One ordered `RTCDataChannel` carries the photo and optional voice note.
- Chunk size 64 KiB. Sender waits when `bufferedAmount` exceeds a high-water mark (4 MiB) before queuing more.
- Recipient assembles chunks into a typed Blob, verifies total size, stores it in IndexedDB, then ACKs. The sender marks delivered only after the ACK.
- Planned voice notes travel in the same manifest/channel as the photo; the receiver verifies both attachments before presenting success.
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

### One-minute voice channel (planned)

This feature is a deliberate exception to the otherwise photo-only surface. It must not compromise the privacy or reliability invariants of the handoff.

**Availability**
- The request action is visible only on a rendezvous whose handoff window is open and where both humans are online.
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
- The server learns only that a request/accept/end happened for an appointment if control messages are added; it never learns audio content.
- Logs must not include microphone labels, device IDs, IPs beyond existing diagnostics, audio stats, or transcripts.
- No captions/transcription in the first audio release. If added later, they must be opt-in, local, and clearly disclosed.

### Handoff timing

- `T` is the scheduled timestamp (epoch ms) resolved from the sender's local date/time.
- The normal handoff window is `[T − 5 minutes, T + 5 minutes]`. Before `T − 5`, both sides show the upcoming appointment and no photo bytes move.
- If both browsers are online anywhere inside the window, they connect automatically and exchange the photo. Both peers being online beforehand is enough: the connection starts when the window opens at `T − 5`, not at `T`.
- Both early and late presence count. Both online at `T − 4`, at `T`, or at `T + 4` all exchange automatically; five minutes late is still on time. The UI may use “early”, “due”, and “still open” labels but does not block transfer at either boundary.
- The scheduled time is the centre of the meeting window, not a start gate. A pair that is already online may complete the handoff before `T`.
- After `T + 5`, an uncompleted appointment remains pending indefinitely. If both humans become online later, the handoff runs at the next presence/timer evaluation. Lateness never discards, expires, or auto-cancels the photograph.
- An online recipient sees a local “handoff is open” alert at `T − 5`. The remote server notice may have arrived earlier.
- Timing is computed locally from the stored timestamp. No extra server timer is required; clock-skew affects labels, not the existence or eventual delivery of the appointment.
- If both peers are already online before `T − 5`, the sender's timer initiates automatically when the window opens. No second confirmation is required.
- This timing rule applies only to private photo handoffs; the optional one-minute live voice window has its own duration rules.

### Photo voice notes (planned)

- One optional voice note per share, maximum 60 seconds. It is an attachment to that delivery, not a separate message thread.
- Recording uses an explicit user action, browser microphone permission, and `MediaRecorder`/equivalent. A local timer stops capture automatically at 60 seconds. No auto-record and no background recording.
- Local preview/replace/delete before scheduling. The note lives in IndexedDB next to its photo attachment.
- During handoff, a manifest describes the note (duration, MIME, size) and its bytes follow the photo on the same authenticated RTC data channel. The receiver verifies completion before storing it and ACKing the handoff.
- If the transfer retries, both photo and note retry together; a partial note is never exposed as playable. If the handoff fails, both remain on the sender.
- Playback requires a user action, shows duration and progress, and never autoplays. No server-side transcoding, transcription, or captions in the first release.
- Deletion of a local photo deletes its note. No public visibility is implied.
- Voice notes count toward local storage, not the signalling server's metadata store.
- The 60-second voice note and the one-minute live call are separate audio features with separate consent surfaces.

### Local photo re-sharing (planned)

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
const link = await client.createInviteLink();
const code = await client.verificationCodeFor(humanId); // 8 words, local
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
- **Planned audio:** DTLS-SRTP encryption, identity-pinned audio handshake, explicit microphone consent, browser-owned microphone indicator, and no recording by Rendezvous.
- **Planned voice notes:** recorded by explicit action, capped at 60 seconds, stored and transferred with the private photo over the authenticated data channel, never server-stored.
- **Planned local re-share:** reuses local media, no upload, independent appointment lifecycle.

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
- Group photo broadcast. A circle rendezvous coordinates a shared daily moment, but every photograph still moves in a direct pairwise handoff.
- Server-side thumbnails, cloud storage, or media URLs.
- Offline background transfer.
- Automatic photo compression/transcoding.
- Mobile native apps.
- End-to-end encrypted text chat.
- General-purpose calling, group calls, unsolicited recordings, voicemail, or audio transcription. (Voice notes up to one minute and the one-minute live voice window are scoped exceptions, specified for future releases.)
- Public photo feeds, public discovery, and public media storage in the private v1 surface. (US-20 is explicitly later.)
- Read receipts beyond the one transfer ACK.
- Resharing other people's private photos.
- A public feed, public profiles, or a public media store in this release.

---

## 17. Acceptance test scenarios

1. **Invite while both online:** A opens add human; B opens link; both see each other and live presence; reloads preserve the relationship.
2. **Invite while A offline:** B opens link; linked locally; server queues; A connects later; A gains B and sees presence.
3. **Scheduling + immediate server sync:** photo + human + next occurrence saved; B receives the appointment notice; A sees `rendezvous:created`.
4. **Waiting as recipient:** at due, A is offline; B sees “waiting for A”; no success claim.
5. **Waiting as sender:** at due, B is offline; A sees “waiting for B”; A's photo remains in IndexedDB across reload.
6. **Meeting:** both online after due; auto handshake; recipient receives complete image; sender only sees delivered after ACK; reload shows photo in recipient archive.
7. **Failure/retry:** kill recipient mid-transfer; sender shows retry/waiting; when recipient returns, transfer repeats and succeeds without duplicate archive items.
8. **Delete human:** A removes B; B receives removal (online or next connection); B can no longer initiate or see presence; old pending appointment is cancelled.
9. **Server restart:** queued appointment notice survives in JSON store and is delivered after reconnect.
10. **Identity pinning:** a second browser cannot register a friend's peer ID without the friend's private key; a changed key for a pinned peer is rejected rather than overwriting the stored public key.
11. **Stable verification code:** both tabs independently show the same eight words after linking; reloading or a new DTLS session keeps them identical; marking verified persists. An intentionally altered pinned key produces different words and fails the live handshake.
12. **Signed handshake:** an offer/answer with altered DTLS fingerprints (simulated in test) is rejected before any photo bytes are sent.
13. **Ephemeral RTC:** closing a tab terminates the direct connection; reopening and both being online re-establishes signalling and can complete a pending handoff without re-adding the human.
14. **Accessibility:** keyboard-only invite, verify, schedule, dismiss, and remove flows; visible focus; correct live announcements.
15. **Responsive:** 390×844 and 1280×800 viewports; no horizontal overflow; modals usable.
16. **Photo wall ranking:** deliver at least three photographs; the newest is rank 01 and largest, every subsequent width is smaller until the practical minimum, all remain present, and clicking any one opens the viewer.
17. **Server contains no photos:** test with two browsers; inspect all server messages/storage for image data; none present.
18. **One-minute voice (planned):** with both present at an open-handoff rendezvous, request/accept microphone consent, verify audio flows only after the authenticated handshake, countdown ends at 60 seconds, tracks stop, the action cannot be reused, and a microphone denial leaves the photo path functional.
19. **Early/late handoff:** no transfer at T−6; both present at T−4 → automatic transfer; both present at T+4 → automatic transfer; both only present at T+20 → still waits and later completes rather than expiring.
20. **Photo voice note (planned):** record ≤60 seconds, stop at the cap, verify it is stored/transferred with the photo and plays only on user action; failure of the audio attachment keeps the complete handoff pending.
21. **Local re-share (planned):** re-share an outgoing delivered photo without a file chooser or media upload; new share has independent timing and wall rank; deleting one share leaves the source and other share intact.
22. **Public re-share (later):** verify photos default private, publication is explicit and revocable, attribution survives, and a public asset cannot expose private photos, voice notes, relationships, or locations.
23. **Circle daily canonical:** two members set circle rendezvouses for the same circle and local day; the earlier signed creation wins in both views; a later plan cannot replace it; a late-arriving earlier plan does replace it and all synced members converge.
24. **Circle invite auto-accept:** a valid addressed invitation is auto-accepted and produces a signed Join; a bundle forwarded to another key is rejected; leaving still works.
25. **Circle invite, not circle storage:** an offline member receives the expiring invite on next connection; the server contains no circle membership, attendance, stats, or record log and no photo bytes; the invite is deleted once its scheduled rendezvous time has passed; duplicate delivery is idempotent. All other circle records sync only over authenticated RTC.
26. **Circle auto-sync:** two online members with different arrival orders converge without manual action; when one reconnects, sync resumes.
27. **Circle bar:** with zero, one, and many circles, every circle appears exactly once as a circular icon, `+ circle` is leftmost, pinned, and an actual circle, the active state is accessible, the row scrolls without shrinking icons, and the bar covers neither the wall nor primary controls at 390×844 and 1280×800.

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
- Circle canonical ordering currently trusts the organizer's signed creation time. Should a server receipt timestamp or NTP-checked clock also be required to stop backdating?
- Should a late-arriving earlier circle rendezvous be allowed to replace the canonical choice after the day's window has opened or attendance has been recorded?
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
