import type {
  GroupSessionState,
  StoredKeyPackage,
  StoredWelcome,
} from "./sessionState.ts";
import type { PendingEpochOperation } from "./pendingEpochOperations.ts";
import {
  DuplicateGroupAliasError,
  DuplicateKeyPackageAliasError,
  UnknownGroupAliasError,
  UnknownKeyPackageAliasError,
  UnknownWelcomeReferenceError,
} from "./sessionErrors.ts";

const MAX_ACCEPTED_WELCOME_REFS = 1000;

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
  private readonly acceptedWelcomeRefs = new CappedRefSet(
    MAX_ACCEPTED_WELCOME_REFS,
  );
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
    // Skip re-adding welcomes whose key package reference was already
    // accepted (deleted after joining the group).
    if (this.acceptedWelcomeRefs.has(welcome.kp_ref)) {
      return;
    }

    this.welcomes.set(welcome.kp_ref, welcome);
  }

  hasWelcome(keyPackageReference: string): boolean {
    return (
      this.welcomes.has(keyPackageReference) ||
      this.acceptedWelcomeRefs.has(keyPackageReference)
    );
  }

  getWelcome(keyPackageReference: string): StoredWelcome {
    const welcome = this.welcomes.get(keyPackageReference);

    if (!welcome) {
      throw new UnknownWelcomeReferenceError(keyPackageReference);
    }

    return welcome;
  }

  deleteWelcome(keyPackageReference: string): void {
    this.welcomes.delete(keyPackageReference);
    this.acceptedWelcomeRefs.add(keyPackageReference);
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
}
