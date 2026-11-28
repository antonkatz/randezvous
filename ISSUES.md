# RDZ — Security & Correctness Review Issues

Review date: 2026-11-28
Scope: full working tree on branch `fix/h1-m1-m2-m3`, ~7k lines of protocol/UI/server code. Legacy `archive/` excluded.

## Fix verification (H1, M1, M2, M3)

- `npm run typecheck` and `npm run build` — clean
- `npm test` — 77/77 unit tests pass
- `npx playwright test` — 27/27 e2e tests pass (24 existing + 3 hostile-input regressions)
- All 3 `tests/e2e/hostile.spec.ts` regressions **fail against the pre-fix build** and pass against the fix
- Original attack probes: malformed `GOING` rejected and not cached; +100-year `GOING` rejected by `isValidGoing`; injected `__proto__` invalidates the signature; mid-call disconnect now shows `The voice connection was lost.`

## Verification performed

- `npm run typecheck` — clean
- `npm test` — 56/56 unit tests pass
- `npx playwright test` (bundled Chromium) — 22/23 pass; the 1 failure is a Playwright trace-artifact `ENOENT` at teardown, not an app assertion
- 4 custom attack probes (kept in `/tmp/opencode/`, repo untouched): malicious werift peer through the real seed, raw-HTTP server probe, and a mid-call disconnect probe. **3 of 4 suspected vulnerabilities confirmed empirically.**

## What's solid

The core design is genuinely well-built:

- Non-extractable P-256 keys in IndexedDB; ECDSA P-256/SHA-256 signatures.
- Author↔public-key hash binding on every envelope; domain-separated seed challenge (`rdz-mesh-hello:`).
- Signed SDP authenticates mesh peers end-to-end; canonical-hash dedup + flood-once relay; bounded clock skew.
- Mutual verification gating with key pinning (`record.publicKey === human.publicKey`).
- Raster-only image allowlist enforced on both ends; 25 MiB cap both sides; no filename transmission; locally generated download names; blob URLs revoked on dismiss.
- Consent before any media bytes; bounded timeouts on every media state; ICE buffering for out-of-order arrival; SCTP buffer-aware chunking; ack flush before close.
- Escaped rendering almost everywhere (`escapeHtml`/`escapeAttr`/`CSS.escape`).
- Traffic view matches FR-21: metadata only, 250-event cap, session-only, never uploaded.

---

## 🔴 High severity

### H1. One signed message permanently bricks every browser that sees it — **FIXED in `fix/h1-m1-m2-m3`**

`verifyEnvelope` (`src/rdz/crypto.ts:90-98`) validates `rendezvousId` only as `typeof string`. Rendering then calls `idToWords`/`idToEmoji` **unguarded** (`src/rdz/ids.ts:27` throws on any non-11-byte ID) via:

- `uniqueWordDisplay` in `renderChannelCard` (`src/rdz/app.ts:1409`)
- `filterChannels` (`src/rdz/state.ts:146`)
- `renderChannel` (`src/rdz/app.ts:1492`)

**Probe result:** a permissionless peer (fresh key, no verification needed) sends one `GOING` with `rendezvousId: 'not-a-valid-id'` through the seed:

- Victim page throws `Identifier must be 88 bits.` on **every render** — humans list freezes, toasts/modals/channel navigation all stop working (render dies before those regions patch).
- The seed **caches and replays it to every new visitor** (second victim bricked on arrival).
- The victim **persists it to IndexedDB** (`src/rdz/app.ts:334-336`) — reload bricks it again with no network involved.
- The victim's mesh also relays it onward, so it propagates without the seed.

With `scheduledAt` far in the future (see M1), this is permanent until site data is cleared.

**Fix:**
- Validate `rendezvousId` (and `channelId`/`target`/`transferId`) in `verifyEnvelope`: decode must yield exactly 11 bytes, canonical base64url charset/length.
- Defense-in-depth: try/catch in the ID-display helpers (the traffic page already does this correctly — `trafficIdFull` etc.).
- The seed should reject malformed IDs too, so one peer can't poison shared infrastructure.

**Resolution:** `isCanonicalId` validates the 15-character/11-byte canonical form at the `verifyEnvelope` boundary for GOING rendezvous IDs and SIGNAL target/channel IDs. `isValidGoing` also checks it so poisoned IndexedDB rows are purged on startup. Display helpers (`uniqueWordDisplay`, `uniqueEmojiDisplay`, `filterChannels`, channel header, dock) now tolerate invalid IDs instead of throwing. Regressions in `tests/e2e/hostile.spec.ts` fail against the pre-fix build and pass against this branch.

### H2. Single unauthenticated request crashes the seed server — CONFIRMED

`server/index.ts:450` and `server/index.ts:472`: `new URL(request.url, 'http://' + request.headers.host)` is unguarded. A malformed `Host` header throws `ERR_INVALID_URL` inside the request handler → uncaught exception → process exit.

**Probe result:** `GET / HTTP/1.1` + `Host: bad host` → server dead, exit code 1. One curl takes the seed down for everyone; same vector on the WebSocket upgrade path.

**Fix:** wrap URL parsing in try/catch in both handlers, respond 400 and destroy the socket.

---

## 🟠 Medium severity

### M1. Unbounded cache growth via far-future `GOING` — **FIXED in `fix/h1-m1-m2-m3` (1-week horizon)**

`isValidGoing` (`src/rdz/crypto.ts:158`) bounds `createdAt` but **not `scheduledAt`**. A `GOING` scheduled +100 years is valid, cached until `scheduledAt + 3min`, and replayed to every new peer. Neither the client cache (`src/rdz/mesh.ts:82`) nor the seed cache (`server/index.ts:56`) has any size cap — `prune()` only removes expired entries.

**Probe result:** 150 far-future `GOING`s from one peer → seed `/health.cached` grew 5 → 157, no eviction. Memory DoS + replay amplification against shared infrastructure; on clients it also grows `announcements`/`seen` maps and the IDB `messages` store.

**Fix:** cap the scheduling horizon (e.g. `scheduledAt <= createdAt + 24h` — the UI's own `parseTime`/`nextOccurrence` never produces more than ~24h), plus an LRU/size cap on both caches and per-session rate limits on the seed.

**Resolution:** `MAX_SCHEDULE_HORIZON_MS` is one week relative to the signed `createdAt`, enforced by `isValidGoing` on every browser and by `processEnvelopeData` on the seed. Cache-size caps and seed rate limits remain open under M5.

### M2. Live voice call drops silently on connection failure — **FIXED in `fix/h1-m1-m2-m3`**

> Confirmed FR-20/US-16 violation; both connection-loss handlers now emit
> `The voice connection was lost.` before tearing down the panel.

- Incoming-audio `connectionstatechange` → `dropIncomingAudio` with no notice (`src/rdz/rtc.ts:783-790`).
- Outgoing-audio → `closeAudio(false)` (`src/rdz/rtc.ts:1064-1071`).

FR-20 explicitly: *"Losing a peer connection … MUST NOT remove a media panel without a notice."*

**Probe result:** live call, remote browser closed → local panel disappeared, `toast = null`.

**Fix:** emit `onAudioNotice('The voice connection was lost.')` in both handlers (image transfers already do this correctly via `failIncomingImage`).

### M3. `__proto__` keys escape the signature — **FIXED in `fix/h1-m1-m2-m3`**

> Canonicalisation now builds records with a null prototype, so `__proto__` is
> an ordinary signed key; injected content invalidates the envelope signature.

`canonicalJson`'s `sortValue` (`src/rdz/bytes.ts:49-53`) assigns into a plain `{}` — `sorted['__proto__'] = …` hits the prototype setter instead of creating an own property, so **`__proto__` keys are silently dropped from the signed canonical form**.

**Probe result:** took a valid signed envelope, injected `payload.__proto__ = {"injected": "unsigned data"}` → `verifyEnvelope` still returns it, injected content intact. Any relay can modify that content in transit without breaking the signature; it also makes distinct envelopes share a dedup hash. No prototype-pollution gadget found in current consuming code (everything reads named fields or spreads), so impact today is an integrity-invariant break rather than RCE — but it's a loaded gun for future code.

**Fix:** build `sorted` with `Object.create(null)`, or reject any object containing `__proto__` keys during verification.

### M4. `mesh-peers` accepted from any peer, uncapped, with per-entry IDB writes

`src/rdz/mesh.ts:454-459` handles `mesh-peers` without checking `peer.isSeed`; `isPeerInfo` only checks string types (no humanId↔publicKey binding); no cap on array length. The app then calls `considerPeer` + `savePeerRegistryEntry` **per entry** (`src/rdz/app.ts:231-238`). Any connected peer can pollute the registry, direct unsolicited connection attempts at arbitrary humans, and amplify one 200KB message into thousands of IndexedDB writes.

**Fix:** accept `mesh-peers` only from the seed (the only legitimate source in this design), validate the ID↔key binding, cap list length, batch the IDB writes.

### M5. Seed has no resource bounds

Unlimited WS sessions, one werift `RTCPeerConnection` per `bootstrap-offer` with no auth or rate limit (`server/index.ts:282-319`), no per-session envelope rate limit. Combined with M1 this makes the shared seed cheaply exhaustible. Some exposure is inherent to a permissionless design, but connection caps, per-IP limits, and offer rate limits are standard and missing.

---

## 🟡 Low severity / hardening

| # | Issue | Location |
|---|-------|----------|
| L1 | `startImageOffer`/`startAudioOffer` have no re-entry guard — a replayed `image-accept`/`audio-accept` (new `createdAt`, same `transferId`, within 2-min TTL) from a malicious *verified* peer leaks the first PC and double-calls `getUserMedia` | `src/rdz/rtc.ts:561`, `src/rdz/rtc.ts:1028` |
| L2 | Pending image offers / audio requests never expire proactively and are uncapped (expiry only checked on accept); `audio-request` with an existing `transferId` overwrites the map entry, leaking its timers | `src/rdz/rtc.ts:482`, `src/rdz/app.ts:453` |
| L3 | Mesh `pendingIce` is unbounded (rtc's is capped at 100); short window, but a delaying answerer can grow it | `src/rdz/mesh.ts:626` |
| L4 | `audio-mute` doesn't check `transferId` against the current session — any verified peer can spoof the muted indicator (display only) | `src/rdz/rtc.ts:553-558` |
| L5 | Fatal-start error message interpolated unescaped into `innerHTML`; `modalShell` title unescaped (both currently fed constants/local errors — latent, but breaks the otherwise-consistent escaping discipline) | `src/main.ts:20`, `src/rdz/app.ts:1797` |
| L6 | No CSP or security headers (`X-Content-Type-Options`, etc.) on served responses — cheap defense-in-depth for an `innerHTML`-rendered app | `server/index.ts:433` |
| L7 | `?seed=<url>` points the client at an arbitrary seed with no warning — a phishing link gives an attacker full gossip visibility + injection position. Documented feature, but consider a visible indicator when the seed is non-default | `src/rdz/mesh.ts:858-871` |
| L8 | Seed broadcasts gossip to sessions that haven't completed the challenge yet (dc open ≠ authenticated); also `byHuman.set` on re-auth leaves the stale session receiving broadcasts | `server/index.ts:119-124`, `server/index.ts:221` |

---

## Spec compliance notes

- **Internal spec contradiction:** US-5/US-6/FR-13 say verification *"does not gate media"*, while FR-16/17/18 and the README require mutual verification for media. The implementation gates (correctly, per the more specific requirements) — the spec should be reconciled.
- **FR-18 channel-naming rule** (*"accepted only when it names a channel the recipient is viewing or has announced in"*) is enforced only for `image-offer`/`audio-request`, not for follow-up `offer`/`answer`/`ice`/`accept` signals. The `transferId` binding makes this largely equivalent in practice, but it's a literal deviation.
- Everything else checked matches: PING 3min/presence 5min, `T+3` expiry, 100-connection budget shared mesh+media, 20% jittered rotation sparing verified/busy/seed peers, one-outgoing-image rule, 1-min audio cap, mask lifecycle, traffic-view constraints.

## Test infrastructure observations

- **Orphaned servers:** `webServer.command: npm start` leaves the node child alive after Playwright teardown (three orphans had to be killed between runs; one run failed with `EADDRINUSE`). Use `node dist-server/index.js` directly in `playwright.config.ts:27`.
- **Browser sensitivity:** with system Chromium 156 (`PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium`), 4 tests fail (CSS computed-style and timing assertions); all pass with the bundled browser. Pin the browser in CI.
- **Coverage gaps worth adding:** malformed-ID envelopes (H1), far-future `GOING` (M1), `__proto__` payloads (M3), connection-drop notices (M2), and seed input-validation tests. The existing suite covers happy paths and many failure paths well, but none of the adversarial-input cases above.

---

## Bottom line

The cryptographic and consent architecture is sound, but the system currently trusts *structurally* valid-looking input too much. **H1 and H2 are both trivially exploitable by anonymous outsiders and should be fixed before any public deployment** — each is a few lines of validation. M1–M3 are the next tier.

### Suggested fix order

1. H2 — try/catch URL parsing in server request + upgrade handlers (smallest, kills a one-request DoS).
2. H1 — ID format validation in `verifyEnvelope` + seed-side rejection + guarded display helpers.
3. M1 — `scheduledAt` horizon cap + cache size caps.
4. M3 — null-prototype canonicalization (or `__proto__` rejection).
5. M2 — connection-drop notices for voice.
6. M4/M5 — seed-only `mesh-peers`, validation, caps, rate limits.
7. L-tier hardening + regression tests for each confirmed finding.
