import { describe, expect, test } from "vitest";

import { CliSessionStore } from "./sessionStore.ts";
import {
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
    state: {} as GroupSessionState["state"],
    lastCursor: 0,
    fetchCursor: 0,
    messages: [],
    syncIssues: [],
  };
}

function createWelcome(keyPackageReference: string): StoredWelcome {
  return {
    keyPackageReference,
    welcomeBase64: "welcome-base64",
    createdAt: 1,
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

  test("finds unconsumed key packages and tracks welcome ordering", () => {
    const store = new CliSessionStore();
    const consumed = createKeyPackage("consumed");
    consumed.consumed = true;
    const available = createKeyPackage("available");
    store.addKeyPackage(consumed);
    store.addKeyPackage(available);
    store.putWelcome({ ...createWelcome("b-ref"), createdAt: 2 });
    store.putWelcome({ ...createWelcome("a-ref"), createdAt: 1 });

    expect(store.findUnconsumedKeyPackage()?.alias).toBe("available");
    expect(
      store.listWelcomes().map((welcome) => welcome.keyPackageReference),
    ).toEqual(["a-ref", "b-ref"]);
  });
});
