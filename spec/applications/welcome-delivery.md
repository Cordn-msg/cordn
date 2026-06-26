# Cordn Welcome Delivery

- Status: Draft

## Abstract

This document defines the `cordn` coordinator-mediated Welcome delivery model. Welcomes allow existing group members to invite new users into an MLS group through the coordinator. The coordinator stores Welcomes addressed to a specific invited member and serves them on fetch. This document specifies the delivery cursor hint carried by Welcomes, which marks the invited member's membership boundary within the group's delivery stream.

This document defines only the Welcome delivery surface and the cursor hint. Coordinator roles and cursor semantics are defined in [`spec/00.md`](../00.md). Sealed group payloads and the delivery group identifier are defined in [`spec/03.md`](../03.md). Client-side MLS processing and group membership are out of scope.

## Specification

### 1. Overview

`cordn` Welcomes are delivered through a coordinator-mediated queue.

- A group member stores a Welcome at the coordinator, addressed to a specific invited member.
- The invited member fetches pending Welcomes addressed to them.
- The coordinator is a delivery service for Welcomes; it does not manage group membership.

This document defines the Welcome delivery model and the delivery cursor hint. The join-request mechanism, which mirrors this queue pattern in the opposite direction, is defined in [`join-requests.md`](join-requests.md).

### 2. Delivery Cursor Hint

A Welcome stored at the coordinator MAY carry an `after` delivery cursor hint.

- `after` names the delivery cursor of the group-state change that admits the invited member.
- The invited member SHOULD begin group-message fetch progression, as defined in [`spec/03.md`](../03.md), immediately after that cursor.
- The hint marks the membership boundary of the invited member within the delivery stream.
- When `after` is absent, the invited member fetches from the start of the stream.

### 3. Rationale

- The delivery cursor hint lets an invited member skip group messages published before their membership boundary, which they cannot decrypt.
- Marking the boundary on the Welcome avoids requiring the invited member to fetch and discard undecryptable back-history.
- Making the hint optional keeps Welcomes valid without it, preserving compatibility with members that do not track it.
