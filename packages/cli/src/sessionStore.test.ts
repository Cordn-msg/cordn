import { describe, expect, test } from "vitest";

import { CliSessionStore, welcomeIdentifier } from "./sessionStore.ts";
import {
  AmbiguousWelcomeReferenceError,
  DuplicateGroupAliasError,
  DuplicateKeyPackageAliasError,
  UnknownGroupAliasError,
  UnknownWelcomeReferenceError,
} from "./sessionErrors.ts";
import type {
  GroupSessionState,
  StoredKeyPackage,
  StoredWelcome,
} from "./sessionState.ts";

function createKeyPackage(alias: string): StoredKeyPackage {
  return {
    alias,
    keyPackage: {} as StoredKeyPackage["keyPackage"],
    privateKeyPackage: {} as StoredKeyPackage["privateKeyPackage"],
    keyPackageRef: `${alias}-ref`,
    keyPackageBase64: `${alias}-base64`,
    isLastResort: false,
    consumed: false,
  };
}

function createGroup(alias: string): GroupSessionState {
  return {
    alias,
    coordinatorKey: `${alias}-coordinator`,
    state: {} as GroupSessionState["state"],
    status: "active",
    lastCursor: 0,
    fetchCursor: 0,
    messages: [],
    syncIssues: [],
  };
}

function createWelcome(keyPackageReference: string): StoredWelcome {
  return {
    kp_ref: keyPackageReference,
    welcome_64: "welcome-base64",
    at: 1,
    coordinatorKey: "welcome-coordinator",
  };
}

describe("CliSessionStore", () => {
  test("rejects duplicate key package aliases", () => {
    const store = new CliSessionStore();
    store.addKeyPackage(createKeyPackage("alice-main"));

    expect(() => store.addKeyPackage(createKeyPackage("alice-main"))).toThrow(
      DuplicateKeyPackageAliasError,
    );
  });

  test("rejects duplicate group aliases", () => {
    const store = new CliSessionStore();
    store.addGroup(createGroup("demo"));

    expect(() => store.addGroup(createGroup("demo"))).toThrow(
      DuplicateGroupAliasError,
    );
  });

  test("throws typed errors for unknown group and welcome lookups", () => {
    const store = new CliSessionStore();

    expect(() => store.getGroup("missing")).toThrow(UnknownGroupAliasError);
    expect(() => store.getWelcome("missing-ref")).toThrow(
      UnknownWelcomeReferenceError,
    );
  });

  test("keeps multiple last-resort welcomes with the same kp ref", () => {
    const store = new CliSessionStore();
    const first = { ...createWelcome("last-resort"), at: 1 };
    const second = { ...createWelcome("last-resort"), at: 2 };
    store.putWelcome(first);
    store.putWelcome(second);

    expect(store.listWelcomes()).toEqual([first, second]);
    expect(() => store.getWelcome("last-resort")).toThrow(
      AmbiguousWelcomeReferenceError,
    );
    expect(store.getWelcome(welcomeIdentifier(second))).toEqual(second);

    store.deleteWelcome(welcomeIdentifier(first), first.coordinatorKey!);
    store.putWelcome(first);
    expect(store.listWelcomes()).toEqual([second]);
  });

  test("finds unconsumed key packages and tracks welcome ordering", () => {
    const store = new CliSessionStore();
    const consumed = createKeyPackage("consumed");
    consumed.consumed = true;
    const available = createKeyPackage("available");
    store.addKeyPackage(consumed);
    store.addKeyPackage(available);
    store.putWelcome({ ...createWelcome("b-ref"), at: 2 });
    store.putWelcome({ ...createWelcome("a-ref"), at: 1 });

    expect(store.findUnconsumedKeyPackage()?.alias).toBe("available");
    expect(store.listWelcomes().map((welcome) => welcome.kp_ref)).toEqual([
      "a-ref",
      "b-ref",
    ]);
  });
});
