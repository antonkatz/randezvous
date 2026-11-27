# Future Spec

Features explicitly deferred from the canonical product specification. Nothing in this file is a current requirement.

## Photo wall

Delivered photographs eventually accumulate on a persistent ranked wall, with a viewer, download, and local deletion. Deferred until the core peer-to-peer rendezvous protocol is stable.

## Voice notes

An optional voice note, recorded in the browser and attached to a photograph, eventually travels with the photo over the same peer-to-peer handoff. Deferred.

## Possession inventory

The owner of a photograph eventually sees which humans received a copy through Rendezvous, based on signed possession claims and releases, with honest confirmed / last-confirmed / deleted states. Deferred.

## Other deferred items from current discussion

- Per-message-type sharing scopes, for example sharing `GOING` only with humans I am connected to.
- Shareable links.
- Local automatic banning of peers that send invalid `PING` messages. Bans are not gossiped or network-wide.
- Richer circle behavior beyond pinning a rendezvous ID.

## Legacy code archive

The previous implementations of these deferred features are moved to `archive/` rather than deleted. They are kept for reference and are not part of the build or test suite.

## Reference

The previous product and technical design, including earlier treatments of these features, is in `docs/SPEC_v0.md`. It is reference only and is not canonical.
