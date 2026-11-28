# RDZ

A permissionless, peer-to-peer rendezvous board.

- No accounts.
- No stored media.
- Presence is announced with signed `PING` messages.
- A rendezvous is just beings announcing `GOING` to a channel at a time.
- Images and one-minute voice travel directly between browsers over WebRTC.
- Local audio cues distinguish incoming media requests, voice start, and voice end.
- The seed is a headless WebRTC peer. It can replay `PING`/`GOING` and relay `SIGNAL` over WebRTC, but has no being identity and cannot receive images or audio.

The canonical specification is [`docs/SPEC.md`](docs/SPEC.md). Deferred features are in [`docs/FUTURE_SPEC.md`](docs/FUTURE_SPEC.md). The old spec is reference only in [`docs/SPEC_v0.md`](docs/SPEC_v0.md). Archived legacy code lives in [`archive/`](archive/README.md).

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/signal` to the local seed peer on `:8787`.

Production-style preview:

```bash
npm run build
npm start
# open http://localhost:8787
```

## Scripts

```bash
npm run dev          # Vite + seed peer
npm run dev:web      # UI only
npm run dev:seed     # seed peer only
npm run build        # typecheck, app build, server build
npm start            # serve dist/ + headless WebRTC seed on :8787
npm test             # unit tests
npm run test:e2e     # build + Playwright end-to-end tests
```

For E2E, install Chromium once:

```bash
npx playwright install chromium
# or:
PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```

### Testing with a phone

Phones require a secure context for Web Crypto and WebRTC. Open the same HTTPS URL on both devices. A plain `http://192.168.x.x:5173` page cannot use Web Crypto or WebRTC; RDZ now shows an **HTTPS required** screen instead of failing silently.

For local phone testing, expose the Vite port through an HTTPS tunnel and open the tunnel URL on both the phone and the desktop. Both devices then use the same same-origin seed. Alternatively use the production TLS deployment.

If both devices are online but a photo or voice request does not arrive, verify **both directions**. Each side only accepts media requests from a being it has marked as verified.

## How it works

```text
Browser A ◄════ WebRTC data channel: PING / GOING / SIGNAL ════► Browser B
     ▲                                                                ▲
     └──────────── WebRTC mesh ── headless seed peer ─────────────────┘
```

The seed only carries the bootstrap SDP/ICE exchange over WebSocket. The first
WebRTC data channel is then used for application messages and for
peer-assisted signalling; connected peers relay `SIGNAL` for other peers.

1. Each mask creates a persistent P-256 keypair in IndexedDB.
2. A browser can hold several masks, but exactly one is active. The active mask is the only identity that sends `PING`, signs new `GOING` and `SIGNAL`, or holds media sessions. It appears in the landing page's online list marked as me, but is not listed inside a rendezvous channel.
3. The being ID is the first 88 bits of `SHA-256(public key)`. It renders as 8 words and 11 emoji.
4. Every message is canonicalised, signed, and carries the author's public key.
5. `PING` announces presence every 3 minutes; a being stays online for 5 minutes after the last valid `PING`.
6. `GOING` announces a rendezvous channel and a time. The same channel can have many beings and many times.
7. The landing page shows the full online being list and live channels. Channel cards show a distinguishing emoji prefix of 3–11 emoji. A channel screen groups beings by `HH:mm`.
8. `T + 3` removes the announcement from the channel. The being remains online and reachable.
9. Images and voice are requested only inside a channel and only between beings who have verified each other.
10. An image offer shows the sender and a numeric size in MB only. The recipient must accept before any bytes move.
11. Audio is pairwise, lasts one minute, can be restarted, and never records or uploads.

## Network traffic

The landing hero shows a faded live feed of recent mesh activity on the right side of the orbit. It is a limited view of inbound, outbound, and relayed envelopes. Selecting it opens the full network traffic page.

The full page is a session-only, 250-event log with direction filters. Collapsed rows show the short author and route; selecting a row reveals full identifiers, timestamps, sizes, rendezvous or signal metadata, and the peer count. The page never displays signatures, public keys, SDP/ICE bodies, or media bytes. `SIGNAL` appears only as transport metadata; it is not a user-visible application message.

## Verification

Each being has eight words derived from their public key. Compare those words out loud or through another app, then mark the being verified. There is no pairwise code. Verification is local and persists in IndexedDB.

Only verified beings can open a channel connection. Unverified beings remain visible for discovery and verification. Media requests only appear when both beings have verified each other.

## Signalling privacy

The **verified only** switch beneath the landing network traffic feed limits direct WebRTC mesh links and `SIGNAL` traffic to beings verified by the active mask. It is also available in the mask switcher, where the privacy card explains the policy. Enabling it closes existing unverified direct links; verifying a being makes that being eligible immediately. Turning it off restores the permissionless mesh.

The preference is off by default and persists separately for each mask. The headless seed remains available for bootstrap, and public `PING`/`GOING` discovery stays open, so unverified beings remain visible and can still be verified.

## Images

- Images only, maximum 25 MiB.
- One outgoing image at a time per sender.
- Choose an image per send, or reuse the last one.
- The recipient explicitly accepts or declines.
- Either side can cancel from the transfer progress row before completion; the other side receives the cancellation reason.
- Accepted images are displayed in the channel and can be saved while displayed.
- Dismissing removes the in-app copy. There is no wall or gallery.

## Voice

- Pairwise only.
- One minute per conversation, unlimited reconnections.
- Both sides consent and grant microphone permission.
- Gentle pink progress bar, no numeric countdown.
- Live only: no recording, transcription, or upload.

## Seed peer

The seed is a long-running, in-memory, headless WebRTC peer. It stores no media and has no being identity. A new browser connects to the same-origin `/signal` endpoint by default to bootstrap a WebRTC connection.

The seed behaves like any other peer over WebRTC: it caches and replays unexpired `PING`/`GOING` and forwards `SIGNAL`. It cannot accept images or audio because it is headless. `PING`, `GOING`, and `SIGNAL` travel only over WebRTC data channels; WebSocket is used only for bootstrap discovery and the first SDP/ICE exchange. The seed uses a signed challenge to bind each data channel to the being identity it claims.

`?seed=off` starts the app offline with cached state. Seedless first contact remains out of scope.

The production seed host is `randezvous.instanthero.ca`.

## Deployment

```bash
npm ci
npm run build
HOST=:: PORT=8787 npm start
```

Put the server behind TLS. The public origin must be HTTPS because Web Crypto and WebRTC require a secure context. The server serves `dist/` and WebSocket upgrades at `/signal`.

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP + WebSocket port |
| `HOST` / `RENDEZVOUS_HOST` | `::` | Listen address |
| `VITE_SEED_URL` | same-origin `/signal` | Build-time seed override |

## Limitations

- No TURN is configured; some NAT pairs will not connect.
- No universal reachability is promised.
- Seedless first contact requires an existing signalling path. A cached peer registry helps reconnect, but a browser cannot receive inbound sockets on its own.
- The app stores masks, verification, the peer registry, pins, and recent signed messages locally. Images are not kept after dismissal.
- Clearing site data removes every mask. There is no recovery or multi-device sync.
- Messages dated more than one minute in the future are rejected. Ordinary phone/desktop clock skew up to one minute is tolerated; larger skew makes the affected request time out with a visible notice instead of hanging.
- Auto-banning peers that send invalid `PING` timestamps is deferred.

## Third-party notices

- BIP-39 English word list (MIT) — 2048-word identifier and verification vocabulary.
- werift (MIT) — headless WebRTC peer used by the seed server.
- Instrument Serif and DM Sans (SIL Open Font License) — see `public/fonts/`.
