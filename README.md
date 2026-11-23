# Randevouz

A private photo handoff between two browsers. Pick a photograph, pick a human, pick a moment. The photo stays on the sender's device until both people are present; then it crosses directly over WebRTC. Delivered photographs accumulate on a ranked wall — freshest first, each next print stepping down on a gentle power-law curve, clustered toward the top left.

> **A randevouz is a scheduled meeting, not a timed delivery.**
> The signalling server holds only the appointment metadata. The photo moves only while both browsers are open and connected. If one person is missing at the appointed time, the randevouz waits and completes at the next overlap.

This repository contains the reference app, the reusable package, and a small store-and-forward signalling server.

- **Spec:** [`docs/SPEC.md`](docs/SPEC.md) — user stories, visual design stories, architecture, protocol, threat model, IPv6/TURN assumptions, and the future peer-as-signaller path.
- **Circles:** [`src/circles/README.md`](src/circles/README.md) — client-side group membership, signed invitations, sync, and the six circle-stats ratios.
- **UI:** encapsulated `<randevouz-app>` custom element with a cumulative, ranked photo wall.
- **Client:** headless `RandevouzClient` with snapshots and typed events.
- **Server:** WebSocket bootstrap for authenticated presence, appointment notices, invite relay, revocation, and WebRTC signalling. It never stores photo bytes.

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The Vite dev server proxies `/signal` to the bootstrap server on `:8787`.

To use a different frontend port, pass Vite's `--port` flag through `npm run dev`:

```bash
npm run dev -- --port 5174
```

To try the actual link flow, open a second **isolated browser profile or incognito window**, click **add human**, and open the generated link there. Two normal tabs in the same profile share an identity and are treated as the same browser.

### Scripts

```bash
npm run dev          # Vite + signalling server
npm run dev:web      # UI only
npm run dev:signal   # signalling server only
npm run build        # typecheck, app, library, and server builds
npm start            # serve dist/ + WebSocket signalling on :8787
npm test             # crypto/invite unit tests
npm run test:e2e     # production build + Playwright end-to-end tests
```

For the E2E suite, install a Playwright browser or point at an existing Chromium:

```bash
npx playwright install chromium
# or:
PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
```

## Try it on your phone

Browsers require HTTPS for Web Crypto, so a plain `http://192.168.x.x:5173` URL on your Wi-Fi will not work. The quickest safe setup is a temporary HTTPS tunnel:

```bash
# terminal 1
npm run dev

# terminal 2
cloudflared tunnel --url http://localhost:5173
```

Open the generated `https://….trycloudflare.com` URL **on both devices**. Use that same URL for the `add human` link: if the desktop stays on `localhost:5173`, the link it generates will point at localhost and your phone will not be able to open it.

1. On the desktop tunnel tab, set **Code Name** and click **add human**.
2. Send/copy the link to the phone and open it in the phone browser.
3. Set a different **Code Name** on the phone. Both devices should show each other as online and “not verified”.
4. Open the human on each device, compare the eight words out loud, then mark them verified.
5. Schedule a randevouz a few minutes ahead, keep both pages open and awake at that time, and the photo will move directly browser-to-browser.

If you prefer a single-port production-style preview:

```bash
npm run build
npm start
# in another terminal:
cloudflared tunnel --url http://localhost:8787
```

Notes:
- Quick-tunnel URLs are temporary and change when the tunnel restarts. Since identity and relationships are origin-scoped, use a stable domain for anything you want to keep.
- The public tunnel exposes your local dev app. Keep the tunnel open only while testing.
- Being on the same Wi-Fi improves the chance of a direct WebRTC path. The tunnel carries signalling and metadata only; the photo still goes device-to-device.

## Production

```bash
npm ci
npm run build
HOST=:: PORT=8787 npm start
```

The built server serves `dist/` and handles WebSocket upgrades at `/signal`. Put it behind TLS. The public URL must be an `https://` origin (or `http://localhost` during development) because Web Crypto and WebRTC require a secure context.

### Configuration

Environment variables are read from `.env` (see `.env.example`) and from the process environment.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP + WebSocket port. |
| `HOST` / `RANDEZVOUS_HOST` | `::` | Listen address. `::` is dual-stack. |
| `RANDEZVOUS_IPV6_ONLY` | `false` | Set `true` only for an intentionally IPv6-only listener. |
| `RANDEZVOUS_DATA_FILE` | `./data/signal-store.json` | Durable queue of joins, removals, and appointment notices. No photo data. |
| `RANDEZVOUS_ICE_SERVERS` / `ICE_SERVERS` | Google STUN | JSON array of `RTCIceServer` objects. Add a TURN fallback here if needed. |
| `VITE_SIGNAL_URL` | same origin `/signal` | Build-time client override when the UI is hosted separately from the signal server. |

The reference server defaults to a **dual-stack** listener and prints a prominent warning at startup if it is configured single-stack. It also advertises its listener host and dual-stack capability in `hello:ok` and `/health`, which the UI's diagnostics panel surfaces.

For IPv6-only peers, the reverse proxy/load balancer and any STUN/TURN endpoints need to be dual-stack too. See §19 of the spec.

### Deploy on Railway

Railway runs the built Node server, which serves both `dist/` and the `/signal` WebSocket endpoint on one origin. Deploy a single service; do not deploy Vite separately.

1. Push the repository to GitHub, then create a Railway project from the repo. Railpack detects the app automatically:
   - Build command: `npm run build`
   - Start command: `npm start`
2. Set the healthcheck path to `/health` in the service settings.
3. Add a volume mounted at `/data`, then set the service variables:
   - `RANDEZVOUS_HOST=0.0.0.0` — Railway's proxy reaches the container over IPv4.
   - `RANDEZVOUS_DATA_FILE=/data/signal-store.json` — keeps queued joins, appointment notices, and invite revocations across restarts and redeploys.
   - Optional: `RANDEZVOUS_ICE_SERVERS` with a JSON array, including a TURN server if you need one.
4. Leave `PORT` unset; Railway injects it.
5. Generate a public domain. Railway terminates HTTPS, so the browser automatically uses `wss://…/signal`; no `VITE_SIGNAL_URL` is needed for same-origin hosting.

Keep the service at **one replica**. Presence and active WebSockets live in memory, so multiple instances would not see each other's clients (and the JSON store is not shared). A Railway volume is also attached to a single service.

Without the volume the app still runs, but a redeploy or restart loses the durable queue and revoked-invite hashes. Photos are unaffected: they never reach the server.

### TURN

TURN is optional and self-hostable. The photo remains protected by WebRTC DTLS and the signed identity handshake, so a TURN operator only forwards encrypted packets. The app allows direct connection to be attempted without TURN; if the network path fails, it retries honestly while both are present.

Example:

```bash
RANDEZVOUS_ICE_SERVERS='[
  {"urls":"stun:stun.example.com:3478"},
  {"urls":"turn:turn.example.com:3478","username":"user","credential":"secret"}
]' npm start
```

## Embedding the reusable package

```ts
import { defineRandevouzApp } from '@instanthero/randevouz';

defineRandevouzApp();
```

```html
<randevouz-app signal-url="wss://signal.example.com/signal"></randevouz-app>
```

Attributes:

| Attribute | Meaning |
| --- | --- |
| `signal-url` | WebSocket URL. Defaults to same-origin `/signal`. |
| `ice-servers` | JSON array of `RTCIceServer` objects; overrides the server-advertised set. |
| `storage-name` | IndexedDB database name, useful when embedding multiple isolated instances. Defaults to `randevouz`. |

The element exposes `getClient()` / `clientInstance`, and dispatches composed DOM events:

```ts
element.addEventListener('randevouz:state', (event) => {});
element.addEventListener('randevouz:notice', (event) => {});
element.addEventListener('randevouz:appointment', (event) => {});
element.addEventListener('randevouz:transfer', (event) => {});
```

The host is intentionally light: identity, persistence, handshakes, and transfer logic are in the headless client.

### Headless client

```ts
import { createRandevouzClient } from '@instanthero/randevouz';

const client = createRandevouzClient({
  signalUrl: 'wss://signal.example.com/signal',
  iceServers: [{ urls: 'stun:stun.example.com:3478' }],
});

client.on('state', (snapshot) => {
  // ready, signal, network, humans, rendezvous, diagnostics
});
client.on('notice', (notice) => {});
client.on('appointment', (event) => {});
client.on('transfer', (event) => {});

await client.start();
await client.setCodeName('Ana');

const link = await client.createInviteLink();
const words = await client.verificationWordsFor(humanId);
await client.markHumanVerified(humanId);

const record = await client.scheduleRendezvous({
  humanId,
  photo: file, // stays local until both peers are online
  scheduledFor: Date.now() + 60 * 60 * 1000,
});
```

Useful methods: `start`, `stop`, `getSnapshot`, `setCodeName`, `createInviteLink`, `verificationWordsFor`, `markHumanVerified`, `removeHuman`, `scheduleRendezvous`, `deleteRendezvous`.

### Fonts when packaging the UI

The custom element's CSS expects the bundled fonts at `/fonts/dm-sans.woff2`, `/fonts/instrument-serif.woff2`, and `/fonts/instrument-serif-italic.woff2`. They ship in `public/fonts` and `dist-lib/fonts`. If the host cannot serve that path, the UI falls back to system serif/sans fonts. Font licences are in `public/fonts/OFL-*.txt`.

## How it works

```text
Browser A ── signed invite link ──► Browser B
     │                                  │
     │    WebSocket: presence,          │
     │    appointment metadata,         │
     │    offer/answer/ICE relay        │
     ▼                                  ▼
            bootstrap / signal server
              (no photo bytes)

Browser A ◄══════ WebRTC data channel ══════► Browser B
        (signed DTLS fingerprints, photo chunks)
```

1. Each browser creates a persistent P-256 identity keypair in IndexedDB.
2. The invitation link embeds the inviter's public identity, name, and a signature. The invitee pins it.
3. Both browsers authenticate to the signalling server with a signed nonce challenge.
4. The server stores appointment metadata and delivers it to the recipient whenever they next connect. It does not deliver the photo.
5. At/after the rendezvous time, if both humans are online, the sender opens a direct RTC session.
6. Before sending photo bytes, both peers sign both DTLS fingerprints with their long-term keys and verify against the pinned keys.
7. The photo is chunked over an ordered data channel; the recipient stores the completed Blob and ACKs. Only then does the sender mark it delivered.

Deleting a human sends a removal through the server and revokes the invitation-token hash. The server retains revocations durably, so an old copied link cannot re-add the removed person, even from a fresh browser or while the inviter is offline.

### Verification code

The human detail panel shows an **8-word code derived locally from both sorted raw identity public keys** (domain-separated, length-prefixed, SHA-256, 88 bits, BIP-39 vocabulary). It is never sent over the wire. Both browsers compute the same words. Compare them out loud or through another app, then mark the human verified. Verification is local and optional; the live handshake is separately authenticated.

Verification does not depend on DTLS certificates, so the code is stable across reconnections. Do not build a scheme where each side invents a word and sends it over the signalling path: a malicious server can substitute matching words.

## Storage and privacy

- Photos: sender's IndexedDB until successful ACK; recipient's IndexedDB after receipt; all delivered prints appear on the wall.
- Identity keypair: IndexedDB (`CryptoKey` for the private key, public raw key).
- Humans, verification state, pending joins/removals, revoked invites: IndexedDB.
- The app asks the browser for persistent storage (`navigator.storage.persist()`) when it opens IndexedDB. Browsers may still deny the request or evict data in private browsing, so export or back up anything you cannot lose.
- Server: join/removal/rendezvous metadata, invite-token hashes, presence. No photos, no thumbnails, no photo file names.
- Live WebRTC connections are disposable. A page close ends them. The relationship and pinned keys persist and re-handshake on the next visit.
- “Connected forever” means the relationship, not a socket.

## Limitations (v1)

- Both browsers must be open and online for the photo to move.
- No push notifications while the app is closed; appointment notices are delivered on next launch via the server queue.
- No server-side storage or timed delivery.
- No group randevouz, albums, captions, reactions, or video.
- The wall currently ranks by arrival (freshest = rank 01) and scales with a power law; richer ranking is explicitly future work.
- Single active tab per identity; opening another tab supersedes the first connection.
- TURN is optional; some NAT pairs will fail without it.
- Metadata is visible to the signalling server. Photos are not.
- No account recovery or multi-device identity.

## Further work

Peer-assisted signalling, authenticated relay identities, TURN deployment, push notifications, short codes with a commitment round, and key-rotation handling are discussed in the spec. The signalling transport is isolated so the UI and appointment model do not need to change for a peer relay.

## Third-party notices

- BIP-39 English word list (MIT) — used for comparison-code vocabulary.
- Instrument Serif and DM Sans (SIL Open Font License) — see `public/fonts/`.
