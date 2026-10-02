---
"@cordn/cli": minor
---

feat(cli): multi-device relay hints + last-resort publish markers (spec §4.1/§4.2/§9)

The group document's `coordinator` named who serves `gid` but not where to
reach them, so a device seeding a self-hosted coordinator fell back to
session-default relays and the delivery stream never opened.

- `GroupDocument` gains the OPTIONAL `coordinatorRelays` hint (locator-only,
  group-ref §4.3 semantics). `publishGroupDocument` populates it from the
  session's registered relay configuration for that coordinator.
- Seeding and fast-forwarding adopt hints fill-if-empty: a device with no
  relay configuration of its own for the coordinator records them as its
  connection relays; locally configured relays or a relay handler always win
  (spec §9).
- `LastResortKeyPackageEntry` gains the OPTIONAL `coordinators` list (spec
  §4.2): the per-coordinator publish markers recorded at
  `publishKeyPackage`, carried in the meta document, and restored on a
  linked device (spec §11.5).
