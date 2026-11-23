# Circles: membership, invitations and stats

A UI-independent, client-side module for named circles. Every member holds the same grow-only set of signed records; merging is union. There is no server, no authority, no photo content in this module, and no runtime dependency beyond Web Crypto and the host app's existing identity, storage and direct-connection layers.

The source lives in `src/circles`. The core entry point is `src/circles/index.ts` (package subpath `@instanthero/randevouz/circles`); the framework-free UI is `src/circles/ui/index.ts` (package subpath `@instanthero/randevouz/circles/ui`) and is deliberately not imported by the core. Tests sit beside each module and run with `npm test`.

## Quick start

```ts
import {
  CircleSync,
  createBrowserCircleIdentity,
  friendsFromHumans,
  computeCircleStats,
  deriveMemberView,
  IndexedDbCircleStore,
  rankCircles,
} from './circles';

const directory = new CircleKeyDirectory();
const identity = createBrowserCircleIdentity(storedIdentity, directory);
const friends = friendsFromHumans(humans);
const store = new IndexedDbCircleStore();

// Founding a circle (CircleCreated, signed by me):
const created = await createCircle({
  identity,
  name: 'Sunday table',
  timezone: 'Europe/Berlin',
  createdAt: Date.now(),
});
await store.append(created.circleId, [created.record]);
const circleId = created.circleId;

const records = await store.load(circleId);
const view = deriveMemberView(
  records,
  identity.selfKey,
  friends,
  localOverrides, // { [peerId]: 'keep' | 'ban' }
  { circleId },
);
const stats = computeCircleStats(records, view, Date.now());
const ranking = rankCircles([statsForEachCircle]);

const sync = new CircleSync({ identity, friends, store });
sync.addPeer(authenticatedPeerChannel);
await sync.start();
```

`Identity.verify(peerId, bytes, signature)` is responsible for resolving the peer's pinned public key. `CircleKeyDirectory` is a small helper for that; populate it with direct humans and members. `selfKey` is the existing `StoredIdentity.id`.

## How people join a circle

The stats brief defines the signed `Invite` and `Join` records and the membership chain, but it does not define delivery. This module adds a complete invitation bundle on top of the existing direct-human connection:

1. **Add the person as a human first.** Circle membership is not an identity link. The host app's existing add-human flow creates the persistent direct connection and pins the public key.
2. **A current member creates an invitation.**
   ```ts
   const bundle = await createCircleInvite({
     identity,
     records: await store.load(circleId),
     circleId,
     invitee: peerId,
     at: Date.now(),
     friends, // enforces that the invitee is a direct human
   });
   ```
   The bundle contains the circle creation, the membership history needed to prove the chain, and a new signed `Invite` addressed to that peer. It never contains `BanVote`, `Plan`, `Attendance`, photos or voice notes.
3. **Send it over the existing authenticated channel.**
   ```ts
   await sendCircleInvite(peerChannel, bundle); // { type: 'circle-invite/offer', bundle }
   ```
   A secure out-of-band file/QR link is also possible because the `Invite` is signed and addressed; the host owns that transport.
4. **The invitee verifies and accepts.**
   ```ts
   const acceptance = await acceptCircleInvite({
     identity: inviteeIdentity,
     bundle,
     at: Date.now(),
   });
   await inviteeStore.append(bundle.circleId, acceptance.records);
   await sendCircleInviteAcceptance(peerChannel, acceptance);
   ```
   Acceptance re-verifies every signature and id, proves that the inviter was a valid member when the invitation was issued, and signs the invitee's `Join`.
5. **The inviter merges the returning acceptance.**
   ```ts
   const merged = await mergeCircleInviteAcceptance(identity, existing, acceptance);
   await store.append(acceptance.circleId, merged.added);
   await sync.refresh(); // now the circle is shared and normal sync can run
   ```
   The `Join` passes the same chain rules as any other record. If it is not valid in the inviter's view, it is rejected.

`CircleSync` does not auto-accept invitations. The host should surface the offer and call `acceptCircleInvite` only after explicit user consent.

The circle page element can show direct friends who are not yet members: compute them with `availableInvitees(view, friends)`, set `inviteCandidates`, and listen for `circle-invite-request`. The element does not itself send or sign anything. `<circle-invite-card>` provides the accept/decline consent surface for a received bundle; call `acceptCircleInvite` only after the user accepts.

### Key availability is a host integration requirement

Records name their authors by public-key id. They do not embed public keys, and this module does not invent a key-transparency protocol. `Identity.verify(peerId, bytes, sig)` must already be able to resolve that id to a key.

- Direct humans are normally pinned by the existing add-human flow.
- An invitation offer is delivered over an authenticated direct channel, so the inviter/invitee keys are already known.
- A **transitive member** (someone listed in `unconnectedToYou`) may be unknown to this browser. Their records cannot be verified until the host learns their public key. The current app's peer id is a hash of the public key, not the key itself, so the key must be delivered out of band.

Before relying on multi-member circles, choose one of these host-level solutions:

1. include signed public-key claims in invitation offers and sync batches, and teach the host identity adapter to validate the peer-id↔key binding before registering them; or
2. make peer ids self-certifying raw public keys; or
3. require every circle member to become a direct human before their records are accepted.

This is the main remaining integration gap, not a stats bug. The included `CircleKeyDirectory` intentionally accepts only keys the host has already decided to trust. Do not register unverified keys from an untrusted relay, because that would let a peer bind an attacker-controlled key to someone else's id.

## Record model

Every stored record is:

```ts
interface StoredCircleRecord {
  id: string;      // hash(canonicalBytes(record))
  record: CircleRecord;
}
```

- `canonicalBytes`: JSON with object keys sorted recursively, UTF-8, no whitespace, `sig` excluded. Record arrays preserve order, and `invitees` / `swappedWith` must be strictly ascending with no duplicates.
- `signRecord(identity, unsigned)` signs the canonical bytes and returns `{ id, record }`.
- `verifyStoredRecord` rejects a bad shape, bad signature, unsorted list, or an id that does not match the content.
- A signature is outside the id, so the same content signed twice has one id. Merge keeps the lexicographically smaller signature for deterministic output.

| Record | Signed by | Notes |
| --- | --- | --- |
| `CircleCreated { circleId, name, timezone, creator, createdAt }` | creator | IANA timezone; one canonical creation per circle id |
| `Invite { circleId, invitee, inviter, at }` | inviter | addressed to one public-key id |
| `Join { circleId, member, at }` | member | needs an Invite from a valid member |
| `Leave { circleId, member, at }` | member | removes the member from that point |
| `BanVote { circleId, voter, target, vote, at }` | voter | `ban` or `unban`; local opinion, not a command |
| `Plan { rendezvousId, scheduledAt, organizer, invitees[] }` | organizer | no circleId by design |
| `Attendance { rendezvousId, scheduledAt, attendee, joinedAt, swappedWith[], promptId }` | attendee | no photo bytes; `promptId` is `string \| null` |

`Plan` and `Attendance` deliberately have no `circleId`. A rendezvous belongs to every circle where the relevant pair are current members. This is how one rendezvous can count in two shared circles without duplicating records.

### Merge

`mergeRecords` returns the union keyed by id. It is commutative, associative and idempotent. It re-verifies existing and incoming records, rejects invalid records, rejects circle-scoped records that belong to another circle when a `circleId` option is given, and reports deterministic rejections. `mergeRecordSets` merges any number of sets.

## Membership view

`deriveMemberView(records, selfKey, friends, overrides, config)` is synchronous and pure. Inputs must already have passed merge verification.

- Valid membership starts with the creator. A `Join` is admitted only when there is an `Invite` for that member with `at <= join.at`, the inviter was valid at the invite time and is still valid at the join time, and there is no later `Leave`.
- A later `Leave` removes the member. Membership is objective; bans are subjective.
- `members` is the current valid set minus locally banned members.
- `unconnectedToYou` is `members` minus my direct friends (excluding myself).
- `shouldAcceptConnection(circleId, peerKey)` is false for banned or non-members, and for another circle id.

### Bans

With `f` = my direct friends who are current valid members and not override-banned:

```text
banned(target) =
  overrides[target] === 'ban'
  OR (overrides[target] !== 'keep'
      AND count(eligible voters whose latest vote on target is 'ban')
          >= max(2, floor(f / 2) + 1))
```

If `f < 2`, only overrides apply. Overrides are local and never synced. The latest vote per `(voter, target)` wins; equal `at` times break by the larger record id. An `unban` replaces an earlier `ban`. Only override-banned voters are removed from `f` and the vote count; this follows the brief's exact wording ("whom I have not banned via override"). Threshold-banned members' prior votes still count toward other targets, but they are absent from the resulting `members` list. A banned member's authored records are ignored in every stat from that moment, their circle is not synced to them, and connections are refused.

## Rendezvous and clock

A pair `(A,B)` is kept for a rendezvous when both `Attendance` records:

- have the same `rendezvousId` **and** the same `scheduledAt`;
- list the other person in `swappedWith`;
- satisfy `abs(joinedAt - scheduledAt) <= windowMs + skewMs`.

Defaults: `windowMs = 300_000` (5 min), `skewMs = 30_000` (30 s), so the effective signed tolerance is 5 min 30 s on either side. A one-sided attendance is never a kept pair. Duplicate attendance records contribute at most one pair per rendezvous/person-pair. A five-person swap produces ten pairs but one kept rendezvous.

`shouldSign(attendance, localNow)` returns true only when `abs(localNow - joinedAt) <= skewMs`. Apply an NTP-corrected clock first:

```text
offset = ((t2 - t1) + (t3 - t4)) / 2
delay  = (t4 - t1) - (t3 - t2)
```

`estimateClockOffset(samples)` uses the lowest-delay valid sample and returns `0` for no valid samples.

## Time

`time.ts` is pure: `now`/timestamps are always arguments. Day, week, month and quarter boundaries use `Intl.DateTimeFormat` in the circle's IANA timezone. Weeks start Monday. Keys are:

- day: `YYYY-MM-DD`
- week: the Monday date, `YYYY-MM-DD`
- month: `YYYY-MM`
- season: `YYYY-Qn` (calendar quarter)

Day arithmetic is done on calendar date components, so it crosses DST without adding or losing days. A rendezvous scheduled at 23:58 and joined at 00:02 belongs to the scheduled day.

## Stats

`computeCircleStats(records, view, now, config)` returns six stats, each `{ value, target, ratio }` with `ratio` clamped to `[0,1]`, plus `asOf` (latest considered record timestamp, or `null`). Fewer than two members makes every ratio `0`.

| Stat | Scope | Target / denominator |
| --- | --- | --- |
| `monthlyKept` | Counted rendezvous scheduled in the current month | fixed `20` |
| `weeklyParticipation` | Distinct members in a kept in-circle pair this week | current member count |
| `seasonPairs` | In-circle pairs with at least one kept rendezvous this season | `C(memberCount, 2)` |
| `dailyRun` | Consecutive days with at least one counted rendezvous, ending today or yesterday (today does not break a run until it ends); also `longestRun` | fixed `14` |
| `promptStats` | Attendance tagged with the active daily/weekly prompt; ratio = distinct members on the active weekly prompt / members | current member count |
| `allTime` | Kept rendezvous with no pair cap | next milestone |

**Pair cap and counted rendezvous.** Process all kept rendezvous in `scheduledAt` order, id tie-break. A rendezvous counts once if it has at least one in-circle kept pair whose per-pair weekly count is below `pairCapPerWeek` (default 3). When it counts, every in-circle pair in that rendezvous is incremented. The cap is one global cap per ISO-style week in the circle timezone, so a week that spans a month boundary does **not** get a fresh cap in the new month. `monthlyKept` filters the counted set to the current month; `dailyRun` uses the counted set across all history. A pair cannot carry the circle alone. `allTime` and the pair-level stats (`weeklyParticipation`, `seasonPairs`) use every kept rendezvous with no volume cap.

**Prompt selection.** `activePrompts(now, timezone)` chooses `DAILY_PROMPTS[days-since-epoch mod length]` and `WEEKLY_PROMPTS[week-index mod length]`, Monday-aligned, in the circle timezone. Lists are plain data in `prompts.ts` (7 daily, 4 weekly placeholders). Attendance carries one `promptId` or `null`. Prompt counts are all-time occurrences of the currently active prompt ids, restricted to current members and to rendezvous that involve at least two current members. Change the lists without changing ids to preserve interpretation; replacing wording is fine.

**asOf.** `asOf` is the latest `createdAt`/`at`/`joinedAt`/scheduled timestamp among considered records, not the time stats were computed. The UI shows it as “as of last sync”.

## Cross-circle leaderboard

`rankCircles(statsList)` computes `mean(six ratios)` for each circle locally, sorts descending, and breaks ties by `circleId`. It never transmits scores. A small circle can beat a large one. `circleScore` exposes the mean alone.

## Sync protocol

`CircleSync` runs over an already authenticated `PeerChannel` (the host app's direct connection). Message types are in `CircleSyncMessage`:

- `circle-sync/hello { circles }`: circles where the sender is a member and believes the recipient is a current, non-banned member.
- `circle-sync/have { circleId, ids }`: ids the sender is willing to share with this peer.
- `circle-sync/records { circleId, records }`: missing records.
- `circle-sync/request { circleId, ids }`: optional targeted fetch.
- `circle-sync/done { circleId }`: informational.

Both sides send `hello`; the intersection is the shared set (both views agree). For each shared circle they exchange `have`, then send only records absent from the other side. Messages may arrive out of order; messages for a not-yet-shared circle are buffered until `hello`, and duplicate ids are absorbed by merge/storage.

Delivery restrictions:

- **BanVote** is sent only by its author, only to the author's direct friends, never to the target, and never relayed. Incoming votes must have `voter === channel.peerKey` and come from a direct friend; relays are ignored even with a valid signature.
- **Plan/Attendance** are gossiped only to direct friends, and only for a circle where at least two current attendees are members. Incoming gossip is accepted only from a direct friend with the same condition.
- Membership records (`CircleCreated`, `Invite`, `Join`, `Leave`) sync normally for shared circles.
- `have` advertises only records the sender is allowed to send, so privacy restrictions do not leak ids.

Stores implement `{ load, append, listCircles }`. `MemoryCircleStore` is for tests/small hosts; `IndexedDbCircleStore` is a separate database (`randevouz-circles`) with an immutable `(circleId, id)` key, so the existing photo/identity store is untouched. Appending is idempotent.

## Configuration

`resolveCircleConfig` supplies these defaults; all are injectable through `CircleConfigInput`:

| Value | Default | Meaning |
| --- | --- | --- |
| `windowMs` | `300000` | normal ±5-minute rendezvous window |
| `skewMs` | `30000` | clock allowance; signing guard |
| `pairCapPerWeek` | `3` | counted rendezvous per pair per week |
| `targets.monthlyKept` | `20` | fixed monthly goal |
| `targets.dailyRun` | `14` | fixed daily-run goal |
| `milestones` | `[100, 250, 500, 1000]` | all-time ladder |
| `banThreshold(f)` | `max(2, floor(f/2)+1)` | votes needed |
| `circleId` | inferred | restrict records to one circle |

Weekly participation, season pairs and prompt ratios use current member-derived denominators; those are not absolute targets. `resolveCircleConfig` rejects negative/zero caps, empty or unsorted milestones, and non-positive ban thresholds.

## Assumptions

- **Season-pairs denominator** uses the current members in *my* view, not historical or maximum membership.
- **Targets are fixed numbers**: 20 monthly and 14 daily, plus the all-time milestone ladder. Only participation/denominator ratios change with member count.
- **A banned member's past records are ignored immediately** in all stats, including prompt counts and `asOf`. There is no historical “before the ban” reconstruction.
- **Circle ids are globally unique random identifiers.** If duplicate `CircleCreated` records exist, the earliest by `(createdAt, creator, name, timezone, id)` is the canonical creation.
- **Plan/Attendance have no circleId.** Circle association is derived from current membership; one rendezvous can count in multiple circles.
- **Duplicate `Attendance` records** for the same rendezvous/person contribute at most one pair. Any duplicate that satisfies the window can establish the pair.
- **Prompt counts are all-time** occurrences of the active recurring prompt ids, not only today's/this week's photographs.
- **Invitations are addressed** to a public-key id. The bundle is not a bearer capability to join without that identity's private key. Delivery is the host's responsibility; direct `PeerChannel` is the default. Invitations do not expire or get revoked by this module; a later `Leave`/ban is the available remedy.
- **Invitation consent is explicit.** `CircleSync` never auto-accepts an invitation.
- **Public-key resolution for transitive members is host-provided.** See the key-availability section above.
- **Circle names and timezones are immutable** in this grow-only model. A future record type would be required to rename a circle.
- **Prompt/time ambiguities chosen here:** prompt counts are lifetime counts of the active ids; duplicate attendance records are deduplicated per rendezvous/person pair. `dailyRun` uses the same counted/pair-capped set as `monthlyKept`, not merely any kept rendezvous.
- **A Join requires the inviter to be valid at both Invite time and Join time.** If an inviter leaves before a pending Join lands, the Join is not admitted.

## UI

Import the UI separately: `import { defineCircleStatsElements } from '@instanthero/randevouz/circles/ui'`. `src/circles/ui` contains framework-free custom elements with a flat dark theme (white on black) and CSS custom properties for restyling:

- `<circle-dashboard>`: the composition shell with “Your circles”, the create screen, the circle page and a pending invitation. It owns presentation state only.
- `<circle-create-form>`: name + IANA timezone; validates locally and emits `circle-create` with `{ name, timezone }`.
- `<circle-stats-page>`: six progress bars, value/target, “as you see this circle”, “as of last sync”, `unconnectedToYou` list, and optional `inviteCandidates` with an invite action.
- `<circle-stats-list>`: circles ordered by local score with progress rings and light rank numbers. Rows emit `circle-select`.
- `<circle-invite-card>`: a consent surface for a received `CircleInviteBundle`; it never signs by itself.
- `presentation.ts`: pure formatting and draft-validation helpers.

Call `defineCircleStatsElements()` once, then mount and wire the dashboard. The UI intentionally does not create records, read IndexedDB, or send peer messages by itself:

```ts
import {
  createCircle,
  createCircleInvite,
  computeCircleStats,
  deriveMemberView,
  rankCircles,
} from '@instanthero/randevouz/circles';
import {
  defineCircleStatsElements,
  type CircleDashboard,
} from '@instanthero/randevouz/circles/ui';

defineCircleStatsElements();
const dashboard = document.createElement('circle-dashboard') as CircleDashboard;
document.body.append(dashboard);

const reload = async () => {
  const stats = [];
  for (const circleId of await store.listCircles()) {
    const records = await store.load(circleId);
    const view = deriveMemberView(records, identity.selfKey, friends, overrides, {
      circleId,
    });
    stats.push(computeCircleStats(records, view, Date.now()));
  }
  dashboard.entries = rankCircles(stats);
};

dashboard.addEventListener('circle-create', async (event) => {
  const { name, timezone } = (event as CustomEvent).detail;
  dashboard.busy = true;
  try {
    const created = await createCircle({
      identity,
      name,
      timezone,
      createdAt: Date.now(),
    });
    await store.append(created.circleId, [created.record]);
    dashboard.error = '';
    await reload();
    dashboard.showList();
  } catch (error) {
    dashboard.error = error instanceof Error ? error.message : 'Could not create the circle.';
  } finally {
    dashboard.busy = false;
  }
});
```

For `circle-select`, load that circle, set `dashboard.stats`, `dashboard.view` and `dashboard.inviteCandidates`. For `circle-invite-request`, call `createCircleInvite` and send the bundle. For `circle-invite-accept`, call `acceptCircleInvite`, append the returned records and send the acceptance back.

The components are **not mounted inside `<randevouz-app>`**. The current app does not expose a direct `PeerChannel`, and this task explicitly excluded changing WebRTC/signalling/TURN, so mounting a live circles tab and wiring invitations is host work. The dashboard is ready for that host.

## Tests

```bash
npm test
```

The suite covers canonical encoding, merge laws and rejections, window edges with and without skew, one-sided and five-person swaps, timezone/DST/day rollover, the pair cap, membership chains, leave/ban/override edge cases, cross-circle counting, sync with out-of-order/duplicate delivery, BanVote delivery restrictions, prompt determinism, invitations, adapters, stores and leaderboard determinism.

## File map

| File | Responsibility |
| --- | --- |
| `types.ts` | records, interfaces, config, stats/member/sync types |
| `canonical.ts` | deterministic encoding, signing, id and shape verification |
| `merge.ts` | verified grow-only union |
| `membership.ts` | chain, leaves, bans, view, connection policy |
| `invitations.ts` | signed invite bundles, acceptance, message helpers |
| `lifecycle.ts` | create circle, leave, cast ban vote |
| `rendezvous.ts` | kept pairs, window, signing guard, NTP |
| `time.ts` | pure timezone day/week/month/season keys |
| `prompts.ts` | replaceable daily/weekly prompt data |
| `stats.ts` | six ratios, pair cap, daily run, milestones |
| `sync.ts` | shared-circle handshake, id exchange, delivery rules |
| `store.ts` | in-memory and IndexedDB stores |
| `leaderboard.ts` | local mean-of-ratios ranking |
| `adapters.ts` | existing P-256 identity, human friends, key directory |
| `testing.ts` | Web-Crypto test identities and peer/store fakes |
| `ui/` | framework-free page, list and invitation card |

## Non-goals

Hub-level daily streak and freezes, admin roles, peer-as-signaller, TURN, any server, photo/voice transfer, scaling targets by circle size, public discovery, and automatic invitation acceptance.
