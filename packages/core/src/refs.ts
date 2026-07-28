/** Reference to a welcome the caller has consumed (joined locally) and
 *  wants the coordinator to retire. Scoped to the caller's own inbox, so
 *  `(keyPackageReference, createdAt)` uniquely identifies the record. */
export interface ConsumedWelcomeRef {
  keyPackageReference: string;
  createdAt: number;
}

/** Reference to a join request an admin has handled and wants the
 *  coordinator to retire. Scoped to a single group fetch, so
 *  `(requesterStablePubkey, createdAt)` uniquely identifies the record. */
export interface ConsumedJoinRequestRef {
  requesterStablePubkey: string;
  createdAt: number;
}
