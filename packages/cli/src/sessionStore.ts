import type {
  GroupSessionState,
  StoredKeyPackage,
  StoredWelcome,
} from "./sessionState.ts";
import type { PendingEpochOperation } from "./pendingEpochOperations.ts";
import type { ConsumedJoinRequestRef, ConsumedWelcomeRef } from "@cordn/core";
import {
  AmbiguousWelcomeReferenceError,
  DuplicateGroupAliasError,
  DuplicateKeyPackageAliasError,
  UnknownGroupAliasError,
  UnknownKeyPackageAliasError,
  UnknownWelcomeReferenceError,
} from "./sessionErrors.ts";

const MAX_ACCEPTED_WELCOME_IDS = 1000;

function welcomeAckKey(ref: ConsumedWelcomeRef): string {
  return `${ref.keyPackageReference}@${ref.createdAt}`;
}

/** Stable identifier accepted by CLI commands. `kp_ref` remains accepted when
 *  it identifies exactly one pending Welcome. */
export function welcomeIdentifier(
  welcome: Pick<StoredWelcome, "coordinatorKey" | "kp_ref" | "at">,
): string {
  return `${welcome.coordinatorKey?.toLowerCase() ?? "default"}:${welcome.kp_ref}:${welcome.at}`;
}

function welcomeStorageKey(
  welcome: Pick<StoredWelcome, "coordinatorKey" | "kp_ref" | "at">,
): string {
  return welcomeIdentifier(welcome);
}

function joinAckKey(ref: ConsumedJoinRequestRef): string {
  return `${ref.requesterStablePubkey}@${ref.createdAt}`;
}

export interface FetchedJoinRequestRef extends ConsumedJoinRequestRef {
  keyPackageReference: string;
}

/** A capped Set that evicts the oldest entry when the cap is exceeded. */
class CappedRefSet {
  private readonly refs = new Set<string>();
  private readonly insertionOrder: string[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  has(ref: string): boolean {
    return this.refs.has(ref);
  }

  /** Insertion-ordered contents, oldest first. */
  values(): string[] {
    return [...this.insertionOrder];
  }

  add(ref: string): void {
    if (this.refs.has(ref)) {
      return;
    }

    while (this.refs.size >= this.maxSize) {
      const oldest = this.insertionOrder.shift();
      if (oldest !== undefined) {
        this.refs.delete(oldest);
      }
    }

    this.refs.add(ref);
    this.insertionOrder.push(ref);
  }
}

export class CliSessionStore {
  private readonly keyPackages = new Map<string, StoredKeyPackage>();
  private readonly welcomes = new Map<string, StoredWelcome>();
  private readonly acceptedWelcomeIds = new CappedRefSet(
    MAX_ACCEPTED_WELCOME_IDS,
  );
  /** Accepted Welcomes awaiting a coordinator-scoped `consumed` ack. */
  private readonly pendingConsumedWelcomes = new Map<
    string,
    Map<string, ConsumedWelcomeRef>
  >();
  /** Join requests seen via the last fetch, including the kp ref needed to
   *  match the exact request consumed by addMember. */
  private readonly fetchedJoinRequestsByGroup = new Map<
    string,
    Map<string, FetchedJoinRequestRef>
  >();
  /** Join requests handled locally (admin added/rejected), awaiting the next
   *  fetch's `consumed` ack, keyed by groupId then ack key. */
  private readonly pendingConsumedJoinRequests = new Map<
    string,
    Map<string, ConsumedJoinRequestRef>
  >();
  private readonly groups = new Map<string, GroupSessionState>();
  private readonly pendingEpochOperations = new Map<
    string,
    PendingEpochOperation[]
  >();

  listKeyPackages(): StoredKeyPackage[] {
    return [...this.keyPackages.values()];
  }

  addKeyPackage(keyPackage: StoredKeyPackage): void {
    if (this.keyPackages.has(keyPackage.alias)) {
      throw new DuplicateKeyPackageAliasError(keyPackage.alias);
    }

    this.keyPackages.set(keyPackage.alias, keyPackage);
  }

  getKeyPackage(alias: string): StoredKeyPackage {
    const keyPackage = this.keyPackages.get(alias);

    if (!keyPackage) {
      throw new UnknownKeyPackageAliasError(alias);
    }

    return keyPackage;
  }

  deleteKeyPackage(alias: string): StoredKeyPackage {
    const keyPackage = this.getKeyPackage(alias);
    this.keyPackages.delete(alias);
    return keyPackage;
  }

  findUnconsumedKeyPackage(): StoredKeyPackage | undefined {
    for (const keyPackage of this.keyPackages.values()) {
      if (!keyPackage.consumed) {
        return keyPackage;
      }
    }

    return undefined;
  }

  findKeyPackageByRef(keyPackageRef: string): StoredKeyPackage | undefined {
    for (const candidate of this.keyPackages.values()) {
      if (candidate.keyPackageRef === keyPackageRef) {
        return candidate;
      }
    }

    return undefined;
  }

  deleteKeyPackageByRef(keyPackageRef: string): StoredKeyPackage | undefined {
    for (const [alias, candidate] of this.keyPackages.entries()) {
      if (candidate.keyPackageRef !== keyPackageRef) {
        continue;
      }

      this.keyPackages.delete(alias);
      return candidate;
    }

    return undefined;
  }

  listWelcomes(): StoredWelcome[] {
    return [...this.welcomes.values()].sort((a, b) => a.at - b.at);
  }

  putWelcome(welcome: StoredWelcome): void {
    const key = welcomeStorageKey(welcome);
    if (this.acceptedWelcomeIds.has(key)) return;
    this.welcomes.set(key, welcome);
  }

  hasWelcome(welcome: StoredWelcome): boolean {
    const key = welcomeStorageKey(welcome);
    return this.welcomes.has(key) || this.acceptedWelcomeIds.has(key);
  }

  getWelcome(identifier: string): StoredWelcome {
    const matches = this.listWelcomes().filter(
      (welcome) =>
        welcomeIdentifier(welcome) === identifier ||
        welcome.kp_ref === identifier,
    );
    if (matches.length > 1) {
      throw new AmbiguousWelcomeReferenceError(identifier);
    }
    if (!matches[0]) {
      throw new UnknownWelcomeReferenceError(identifier);
    }
    return matches[0];
  }

  deleteWelcome(identifier: string, coordinatorKey: string): void {
    this.retireWelcome(this.getWelcome(identifier), coordinatorKey);
  }

  retireWelcome(welcome: StoredWelcome, coordinatorKey: string): void {
    const key = welcomeStorageKey(welcome);
    this.queueConsumedWelcome(coordinatorKey, {
      keyPackageReference: welcome.kp_ref,
      createdAt: welcome.at,
    });
    this.welcomes.delete(key);
    this.acceptedWelcomeIds.add(key);
  }

  listGroups(): GroupSessionState[] {
    return [...this.groups.values()];
  }

  addGroup(group: GroupSessionState): void {
    if (this.groups.has(group.alias)) {
      throw new DuplicateGroupAliasError(group.alias);
    }

    this.groups.set(group.alias, group);
  }

  /** Remove a group from the store (soft-delete / tombstone drop). Watch
   *  handles and pending operations keyed by alias are the caller's job. */
  deleteGroup(alias: string): GroupSessionState {
    const group = this.getGroup(alias);
    this.groups.delete(alias);
    return group;
  }

  getGroup(alias: string): GroupSessionState {
    const group = this.groups.get(alias);

    if (!group) {
      throw new UnknownGroupAliasError(alias);
    }

    return group;
  }

  get keyPackageCount(): number {
    return this.keyPackages.size;
  }

  get welcomeCount(): number {
    return this.welcomes.size;
  }

  get groupCount(): number {
    return this.groups.size;
  }

  get pendingOperations(): Map<string, PendingEpochOperation[]> {
    return this.pendingEpochOperations;
  }

  queueConsumedWelcome(coordinatorKey: string, ref: ConsumedWelcomeRef): void {
    let bucket = this.pendingConsumedWelcomes.get(coordinatorKey);
    if (!bucket) {
      bucket = new Map();
      this.pendingConsumedWelcomes.set(coordinatorKey, bucket);
    }
    bucket.set(welcomeAckKey(ref), ref);
  }

  listAcceptedWelcomeIds(): string[] {
    return this.acceptedWelcomeIds.values();
  }

  peekConsumedWelcomes(coordinatorKey: string): ConsumedWelcomeRef[] {
    return [
      ...(this.pendingConsumedWelcomes.get(coordinatorKey)?.values() ?? []),
    ];
  }

  listPendingConsumedWelcomes(): Record<string, ConsumedWelcomeRef[]> {
    return Object.fromEntries(
      [...this.pendingConsumedWelcomes.entries()].map(([key, bucket]) => [
        key,
        [...bucket.values()],
      ]),
    );
  }

  clearConsumedWelcomes(
    coordinatorKey: string,
    refs: ConsumedWelcomeRef[],
  ): void {
    const bucket = this.pendingConsumedWelcomes.get(coordinatorKey);
    if (!bucket) return;
    for (const ref of refs) bucket.delete(welcomeAckKey(ref));
    if (bucket.size === 0) this.pendingConsumedWelcomes.delete(coordinatorKey);
  }

  setFetchedJoinRequests(groupId: string, refs: FetchedJoinRequestRef[]): void {
    this.fetchedJoinRequestsByGroup.set(
      groupId,
      new Map(refs.map((ref) => [joinAckKey(ref), ref])),
    );
  }

  findFetchedJoinRequest(
    groupId: string,
    requesterStablePubkey: string,
    keyPackageReference: string,
  ): ConsumedJoinRequestRef | undefined {
    return [...(this.fetchedJoinRequestsByGroup.get(groupId)?.values() ?? [])]
      .filter(
        (ref) =>
          ref.requesterStablePubkey === requesterStablePubkey &&
          ref.keyPackageReference === keyPackageReference,
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  listFetchedJoinRequests(): Record<string, FetchedJoinRequestRef[]> {
    return Object.fromEntries(
      [...this.fetchedJoinRequestsByGroup.entries()].map(
        ([groupId, bucket]) => [groupId, [...bucket.values()]],
      ),
    );
  }

  queueConsumedJoinRequest(groupId: string, ref: ConsumedJoinRequestRef): void {
    let bucket = this.pendingConsumedJoinRequests.get(groupId);
    if (!bucket) {
      bucket = new Map();
      this.pendingConsumedJoinRequests.set(groupId, bucket);
    }
    bucket.set(joinAckKey(ref), ref);
  }

  peekConsumedJoinRequests(groupId: string): ConsumedJoinRequestRef[] {
    return [...(this.pendingConsumedJoinRequests.get(groupId)?.values() ?? [])];
  }

  listPendingConsumedJoinRequests(): Record<string, ConsumedJoinRequestRef[]> {
    return Object.fromEntries(
      [...this.pendingConsumedJoinRequests.entries()].map(
        ([groupId, bucket]) => [groupId, [...bucket.values()]],
      ),
    );
  }

  clearConsumedJoinRequests(
    groupId: string,
    refs: ConsumedJoinRequestRef[],
  ): void {
    const bucket = this.pendingConsumedJoinRequests.get(groupId);
    if (!bucket) {
      return;
    }
    for (const ref of refs) {
      bucket.delete(joinAckKey(ref));
    }
    if (bucket.size === 0) {
      this.pendingConsumedJoinRequests.delete(groupId);
    }
  }

  /** Restores coordinator acknowledgement state persisted in a snapshot,
   *  so a restart neither re-delivers nor re-accepts handled records. */
  restoreTransientState(state: {
    acceptedWelcomeIds?: string[];
    pendingConsumedWelcomes?: Record<string, ConsumedWelcomeRef[]>;
    fetchedJoinRequests?: Record<string, FetchedJoinRequestRef[]>;
    pendingConsumedJoinRequests?: Record<string, ConsumedJoinRequestRef[]>;
  }): void {
    for (const id of state.acceptedWelcomeIds ?? []) {
      this.acceptedWelcomeIds.add(id);
    }
    for (const [coordinatorKey, refs] of Object.entries(
      state.pendingConsumedWelcomes ?? {},
    )) {
      for (const ref of refs) this.queueConsumedWelcome(coordinatorKey, ref);
    }
    for (const [groupId, refs] of Object.entries(
      state.fetchedJoinRequests ?? {},
    )) {
      this.setFetchedJoinRequests(groupId, refs);
    }
    for (const [groupId, refs] of Object.entries(
      state.pendingConsumedJoinRequests ?? {},
    )) {
      for (const ref of refs) this.queueConsumedJoinRequest(groupId, ref);
    }
  }
}
