import { describe, expect, test } from "vitest";

import {
  decodeCordnGroupMetadata,
  encodeCordnGroupMetadata,
} from "./groupMetadata.ts";

describe("cordn group metadata codec", () => {
  test("roundtrips v1 metadata", () => {
    const metadata = {
      name: "demo",
      description: "shared group",
      adminPubkeys: ["11".repeat(32), "22".repeat(32)],
      icon: "🧵",
      imageUrl: "https://example.com/group.png",
    };

    const encoded = encodeCordnGroupMetadata(metadata);
    const decoded = decodeCordnGroupMetadata(encoded);

    expect(decoded).toEqual(metadata);
  });

  test("treats empty optional fields as absent", () => {
    const encoded = encodeCordnGroupMetadata({ name: "egalitarian" });

    expect(decodeCordnGroupMetadata(encoded)).toEqual({
      name: "egalitarian",
      description: undefined,
      adminPubkeys: undefined,
      icon: undefined,
      imageUrl: undefined,
    });
  });
});
