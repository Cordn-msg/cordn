# Cordn Group Calendar Events

- Status: Draft

## Abstract

This document defines calendar events and RSVPs within a `cordn` group, following the tag shapes of [NIP-52](https://github.com/nostr-protocol/nips/blob/master/52.md) (kinds `31922`, `31923`, `31925`). Events are unsigned Nostr-shaped envelopes ([`spec/02.md`](../02.md)) inside sealed group payloads ([`spec/03.md`](../03.md)); authorship comes from MLS authenticated sender identity, not signatures.

The group **is** the calendar: there is no calendar-list object (kind `31924`) and no add-request flow. Events are addressable by `(kind, author, d)` — a revision replaces the earlier version in place, and the author cancels with a kind-`5` envelope carrying the coordinate. RSVPs are the event's sparse aggregate: one effective answer per account, latest wins, never rendered as standalone rows. The coordinator is unchanged and remains content-opaque. Recurrence, multiple calendars per group, free/busy, reminders, and export are out of scope.

## Specification

### 1. Overview

- `31922` — date-based (all-day / multi-day) event; `31923` — time-based event; `31925` — RSVP; kind `5` with an `a` tag — cancellation.
- All four are ordinary sealed group messages. The coordinator gains no surface: it does not parse, index, or validate any of them.
- Clients project the group's history (these kinds, durable rows merged with the live window, deduplicated by cursor) into event cards. The chat stream renders only the latest revision of each event; RSVPs never render as rows.

### 2. Event Identity

An event's coordinate is `<kind>:<author-pubkey>:<d>` (hex pubkey, `d` tag value).

- `d` MUST match `[A-Za-z0-9_-]{1,64}`. The reference client uses a 32-character lowercase hex UUID.
- Every revision MUST reuse the same `d`.
- The kind is part of the identity: `31922` and `31923` with the same `d` are different events, and a revision MUST NOT change the event's type. Clients lock the all-day/timed choice when editing.

### 3. Event Format

The envelope `content` is the description (Markdown, MAY be empty). Tags:

| Tag          | Required | Meaning                                                   |
| ------------ | -------- | --------------------------------------------------------- |
| `d`          | Yes      | Event identifier (§2)                                     |
| `title`      | Yes      | Non-empty title                                           |
| `start`      | Yes      | `YYYY-MM-DD` for `31922`; unix seconds for `31923`        |
| `end`        | No       | Exclusive end, same format as `start`                     |
| `D`          | No       | UTC day indexes (interop hint, §8)                        |
| `start_tzid` | No       | Author's IANA zone (timed events)                         |
| `end_tzid`   | No       | Defaults to `start_tzid`                                  |
| `location`   | No       | Free text                                                 |
| `image`      | No       | Cover image URL (`http`/`https`)                          |
| `r`          | No       | Related link (`http`/`https`), repeatable                 |
| `summary`    | No       | Accepted inbound; the reference client does not emit it   |
| `alt`        | SHOULD   | NIP-31 plaintext fallback, e.g. `Calendar event: <title>` |

Timing:

- **Date-based:** `end` is exclusive — no `end` covers exactly the start date; `end`, when present, MUST be after `start`. Dates are zone-free and MUST NOT be zone-converted for display.
- **Time-based:** `end`, when present, MUST be strictly greater than `start`; absent `end` means an instant. Receivers display in the viewer's zone and MAY name the author's zone when it differs.

There are no field-size caps: an implementation MUST accept any value that satisfies the shape and safety rules below. Text fields MUST NOT contain control characters, except `\r`/`\n` in the description. Unix timestamps MUST fall within `1 … 253402300799` (four-digit ISO years) so every accepted instant is renderable. Day-key expansion is capped at 366 keys (§8) to bound the one-envelope-to-many-days amplification; that cap truncates the expansion and MUST NOT reject the event.

### 4. Validation

- Scalar tags (`d`, `title`, `start`, `end`, `*_tzid`, `location`, `image`, `summary`) MUST have exactly two elements and appear at most once; a duplicate or malformed scalar rejects the whole event.
- `r` tags MUST have exactly two elements and a valid `http`/`https` URL; a malformed `r` rejects the event. Duplicate URLs dedupe.
- Unknown extension tags are ignored.
- The send path applies the same rules, so a conforming client never emits what another rejects. A failing envelope MUST NOT be projected; clients SHOULD show an "unsupported event" placeholder rather than drop the row silently.

### 5. Revisions

- Revision order: envelope `created_at` descending, coordinator cursor descending as tie-break. Clients persist `created_at` alongside the cursor for this.
- The latest revision per coordinate is the current definition; all revision ids are retained so references to earlier revisions resolve to the current card.
- The chat stream renders only the latest revision's row (earlier ones suppressed, not deleted), with the same "edited" indicator as an edited message. Editing goes through the event composer with the same `d`, never a text-edit of the description.

### 6. Cancellation

The author posts a kind-`5` envelope with `a` = coordinate, `e` = latest revision id, `k` = event kind, and an `alt` fallback.

- Effective only when the sender is the event's author **and** the cancellation's cursor is greater than the latest revision's cursor. Other members' cancellations are ignored.
- The `a` tag cancels the coordinate; the `e` tag lets the ordinary deletion fold hide the chat row. Clients MUST special-case this so the row renders the **cancelled card** (visible cancelled marker), not "message deleted". Cancelled events are hidden from calendar views, their RSVP controls disabled, and reply quotes MUST NOT claim deletion.
- A revision delivered after the cancellation (higher cursor) revives the event.
- Clients MUST NOT offer single-revision deletion of a confirmed event: it would resurrect the previous revision.

### 7. RSVPs

A kind-`31925` envelope with `a` = coordinate, `e` = latest revision id at send time, `d` = `rsvp-<event d>`, `status` = `accepted` | `tentative` | `declined`, `p` = event author, and an `alt` fallback. `content` MAY carry a label (`Going`, `Maybe`, `Can't go`); receivers MUST NOT depend on it.

- Sparse aggregate: never a stream row, consumed only by the event's projection and renderers.
- One effective answer per `(coordinate, sender pubkey)`, latest wins by the §5 order — answers from multiple devices of one identity converge. Receivers key on the authenticated sender, not on `d`.
- RSVPs for unknown coordinates are retained (the event may arrive later); malformed ones (missing/invalid `a` or `status`) are ignored. Cancellation does not delete RSVPs.

### 8. Day Coverage

- Date-based events cover their authored dates, `start` inclusive to `end` exclusive (default `start + 1 day`).
- Time-based events cover the **viewer's-zone** days of `start` through `end − 1s` (just `start` when no end).
- Expansion is capped at 366 keys so a single envelope cannot allocate millions of them; the cap truncates the expansion and MUST NOT reject the event. `D` tags (UTC day indexes `floor(start/86400) … floor((end−1)/86400)`) are an interop hint for NIP-52 day queries; display coverage MUST be computed from `start`/`end`, not from `D`.

### 9. Security Considerations

- Confidentiality, authorship, and cancellation authority are inherited from the sealed-payload and envelope models ([`spec/03.md`](../03.md), [`spec/02.md`](../02.md)): only members read events; envelope `pubkey` equals the MLS-authenticated sender, so authorship and RSVP attribution cannot be forged.
- Strict shape validation and the timestamp ceiling of §3 keep malformed or hostile rows from crashing the projection.
- Cover images and links are external URLs: fetching them exposes the viewer's access pattern to the third-party host, same as pasted media. Clients SHOULD apply the same auto-load gate to covers.
- Attendance is visible to all group members by design; there is no private RSVP.

### 10. Interoperability Requirements

Implementations MUST agree on: the kinds and tag sets (§3, §6, §7); the coordinate format and kind-as-identity (§2); exclusive `end` semantics; the revision order (§5); author-only, cursor-newer cancellation with revival (§6); one latest-wins RSVP per `(coordinate, sender)` (§7); the validation rules of §3–§4 (shape and safety, no field-size caps); and viewer-zone day coverage with `D` as hint only (§8). Unknown extension tags MAY be ignored; an event failing validation MUST NOT be rendered.

### 11. Rationale

- **Group as calendar.** A kind-`31924` list would add a second addressable object and an add-request workflow; MLS membership already answers who the calendar is for.
- **NIP-52 addressable kinds.** Existing tooling and expectations read `31922`/`31923`/`31925`, and the unsigned-envelope model keeps authentication rooted in MLS. Addressability is what makes in-place revisions and coordinate-wide cancellation expressible without inventing a revision protocol; a 1xxxx kind would carry the same revision machinery while forfeiting NIP-52 interoperability, and would only simplify anything if events were immutable. (Polls use NIP-88's `1068`/`1018` because a poll never changes.)
- **`created_at` before cursor.** Replaceable semantics belong to the author's clock; the cursor is a per-coordinator delivery primitive ([`spec/00.md`](../00.md)), fit only as tie-break.
- **Cancellation by coordinate.** Deleting one revision would resurrect the previous one; `a` cancels the coordinate, `e` hides the row, and the cancelled-card case keeps the cancellation visible.
- **RSVP as sparse aggregate.** The poll-response pattern: no rows, no coordinator state, latest-wins convergence across devices without tombstones.
- **`D` emitted, not consumed.** It serves UTC-day queries; display must follow the viewer's zone, so trusting `D` would dot the wrong day outside UTC.
- **No field-size caps.** Calendar payloads follow the other cordn kinds: a member who can post a long message can post a long event. Validation is shape, safety, and renderability — structural checks reject malformed rows, the timestamp ceiling keeps `Date`/`Intl` from throwing, and the day-key cap bounds amplification rather than field size.
- **Recurrence and free/busy deferred.** NIP-52 punts recurrence to clients and nothing consumes availability; both fit later as extension tags without breaking these semantics.
