# RDZ

A permissionless, peer-to-peer rendezvous board.

- No accounts.
- No stored media.
- Presence is announced with signed `PING` messages.
- A rendezvous is just people announcing `GOING` to a channel at a time.
- Images and one-minute voice travel directly between browsers over WebRTC.
- The seed is a headless WebRTC peer. It can replay `PING`/`GOING` and relay `SIGNAL` over WebRTC, but has no human identity and cannot receive images or audio.

> **Transport status:** the canonical spec now requires `PING`, `GOING`, and `SIGNAL` to travel exclusively over WebRTC data channels, with peer-assisted signalling. The current reference build still uses the seed WebSocket as an application relay for those messages. That is a known non-compliance and the next required refactor. Images and audio are already direct WebRTC.

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
npm start            # serve dist/ + WebSocket relay on :8787
npm test             # unit tests
npm run test:e2e     # build + Playwright end-to-end tests
```

For E2E, install Chromium once:

```bash
npx playwright install chromium
# or:
PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```

## How it works

Target transport:

```text
Browser A ◄════ WebRTC data channel: PING / GOING / SIGNAL ════► Browser B
     │                                                              │
     └──────── bootstrap SDP/ICE through the seed, first connection only ────────┘
```

Current reference transport:

```text
Browser A ── signed PING / GOING / SIGNAL over WebSocket ──► seed peer ──► Browser B
Browser A ◄════════════ direct WebRTC image/audio ════════════► Browser B
```

1. Each browser creates a persistent P-256 keypair in IndexedDB.
2. The human ID is the first 88 bits of `SHA-256(public key)`. It renders as 8 words and 11 emoji.
3. Every message is canonicalised, signed, and carries the author's public key.
4. `PING` announces presence every 3 minutes; a human stays online for 5 minutes after the last valid `PING`.
5. `GOING` announces a rendezvous channel and a time. The same channel can have many humans and many times.
6. The landing page shows the full online human list and live channels. A channel screen groups humans by `HH:mm`.
7. `T + 3` removes the announcement from the channel. The human remains online and reachable.
8. Images and voice are requested only inside a channel and only between humans who have verified each other.
9. An image offer shows the sender and a numeric size in MB only. The recipient must accept before any bytes move.
10. Audio is pairwise, lasts one minute, can be restarted, and never records or uploads.

## Verification

Each human has eight words derived from their public key. Compare those words out loud or through another app, then mark the human verified. There is no pairwise code. Verification is local and persists in IndexedDB.

Only verified humans can open a channel connection. Unverified humans remain visible for discovery and verification.

## Images

- Images only, maximum 25 MiB.
- One outgoing image at a time per sender.
- Choose an image per send, or reuse the last one.
- The recipient explicitly accepts or declines.
- Accepted images are displayed in the channel and can be saved while displayed.
- Dismissing removes the in-app copy. There is no wall or gallery.

## Voice

- Pairwise only.
- One minute per conversation, unlimited reconnections.
- Both sides consent and grant microphone permission.
- Gentle pink progress bar, no numeric countdown.
- Live only: no recording, transcription, or upload.

## Seed peer

The seed is a long-running, in-memory, headless WebRTC peer. It stores no media and has no human identity. A new browser connects to the same-origin `/signal` endpoint by default to bootstrap a WebRTC connection.

The target design is that the seed behaves like any other peer over WebRTC: it can replay unexpired `PING`/`GOING` messages and forward `SIGNAL`. It cannot accept images or audio because it is headless. `PING`, `GOING`, and `SIGNAL` still travel only over WebRTC data channels; WebSocket/HTTPS is only for bootstrap discovery and the first SDP/ICE exchange.

The current reference build still relays `PING`, `GOING`, and `SIGNAL` over WebSocket. This is a known non-compliance with FR-0 and is documented in [`docs/IMPLEMENTATION_DECISIONS.md`](docs/IMPLEMENTATION_DECISIONS.md). `?seed=off` starts the app offline with cached state.

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

- **FR-0 is not yet met.** The current reference build still sends `PING`, `GOING`, and `SIGNAL` over the seed WebSocket. The required refactor is to move them to WebRTC data channels and add peer-assisted signalling.
- The WebRTC relay mesh and 20% peer rotation are not implemented. The 100 live connection cap currently applies to direct WebRTC media connections.
- No TURN is configured; some NAT pairs will not connect.
- No universal reachability is promised.
- The app stores identity, verification, pins, and recent signed messages locally. Images are not kept after dismissal.
- Clearing site data creates a new identity. There is no recovery or multi-device sync.
- Auto-banning peers that send future `PING` timestamps is deferred; invalid messages are rejected.

## Third-party notices

- BIP-39 English word list (MIT) — 2048-word identifier and verification vocabulary.
- Instrument Serif and DM Sans (SIL Open Font License) — see `public/fonts/`.
