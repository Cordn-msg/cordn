/**
 * Named error hierarchy for @cordn/sdk. The thrown counterpart to the
 * structured ingest dispositions (see ./types.ts). Apps catch by `code`/type,
 * never by parsing message strings.
 *
 * Phase 3 introduces the ingest-relevant subset; the full taxonomy
 * (NotAMemberError, CoordinatorUnavailableError, WelcomeForUnknownKeyPackageError,
 * PublicationPayloadInvalidError, …) is filled in by later phases.
 */

export abstract class CordnError extends Error {
  abstract readonly code: string;
  constructor(message?: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Bytes from the coordinator are not a decodable MLS framed message. */
export class InvalidMlsMessageError extends CordnError {
  readonly code = "INVALID_MLS_MESSAGE";
}

/** Message belongs to a past epoch (benign; already applied or irrelevant). */
export class FormerEpochError extends CordnError {
  readonly code = "FORMER_EPOCH";
}

/** Ratchet generation is in the past (benign skip). */
export class StaleGenerationError extends CordnError {
  readonly code = "STALE_GENERATION";
}

/** Valid MLS framing but cannot be decrypted with current key material. */
export class UndecryptableMessageError extends CordnError {
  readonly code = "UNDECRYPTABLE";
}

/** A ratchet-tree structural invariant violation (benign skip in cordn). */
export class RatchetTreeInvariantError extends CordnError {
  readonly code = "RATCHET_TREE_INVARIANT";
}

/** Key-package publication binding failed verification (spec §7–8, gotcha #6). */
export class PublicationPayloadInvalidError extends CordnError {
  readonly code = "PUBLICATION_INVALID";
}

/** Attempted to remove the local member via a Remove proposal (blocked). */
export class SelfRemovalError extends CordnError {
  readonly code = "SELF_REMOVAL";
}

/**
 * A commit that removes the local member surfaced as a ts-mls error
 * ("Could not find common ancestor" / update-path overlap failure) before the
 * structured `removedFromGroup` state. Treated as a removal signal.
 */
export class MemberRemovalCommitError extends CordnError {
  readonly code = "REMOVAL_COMMIT";
}

/** An SDK feature path that is specified but not yet implemented. */
export class NotImplementedError extends CordnError {
  readonly code = "NOT_IMPLEMENTED";
}
