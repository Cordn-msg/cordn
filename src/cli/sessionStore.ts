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

export class CliSessionStore {
  private readonly keyPackages = new Map<string, StoredKeyPackage>();
  private readonly welcomes = new Map<string, StoredWelcome>();
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

  listWelcomes(): StoredWelcome[] {
    return [...this.welcomes.values()].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }

  putWelcome(welcome: StoredWelcome): void {
    this.welcomes.set(welcome.keyPackageReference, welcome);
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
