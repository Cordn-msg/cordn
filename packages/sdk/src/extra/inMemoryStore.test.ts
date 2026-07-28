import { describe, expect, test } from "vitest";

import { InMemoryKeyValueStore } from "./inMemoryStore.ts";

describe("InMemoryKeyValueStore", () => {
  test("get/set/remove/keys/clear round-trip", async () => {
    const store = new InMemoryKeyValueStore<number>();

    expect(await store.getItem("a")).toBeNull();
    await store.setItem("a", 1);
    expect(await store.getItem("a")).toBe(1);
    expect(await store.keys()).toEqual(["a"]);

    await store.setItem("b", 2);
    expect((await store.keys()).sort()).toEqual(["a", "b"]);

    await store.removeItem("a");
    expect(await store.getItem("a")).toBeNull();

    await store.clear();
    expect(await store.keys()).toEqual([]);
  });
});
