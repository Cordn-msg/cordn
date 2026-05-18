import { defaultProposalTypes } from "ts-mls";
import { describe, expect, test, vi } from "vitest";

const { listGroupMembers } = vi.hoisted(() => ({
  listGroupMembers: vi.fn(),
}));

vi.mock("./utils/mlsGroupLifecycle.ts", () => ({
  listGroupMembers,
}));

import {
  assertCanAdministerGroup,
  commitRequiresAdmin,
  createAdminAuthorizationCallback,
  createUnauthorizedAdminRejectionDetail,
  getGroupAdminPubkeys,
  isEgalitarianGroup,
  isGroupAdmin,
  proposalRequiresAdmin,
} from "./adminPolicy.ts";
import { UnauthorizedGroupAdminActionError } from "./sessionErrors.ts";

describe("admin policy", () => {
  test("normalizes configured admin pubkeys and detects egalitarian mode", () => {
    expect(getGroupAdminPubkeys()).toEqual([]);
    expect(isEgalitarianGroup()).toBe(true);

    const metadata = {
      name: "demo",
      adminPubkeys: ["AA".repeat(32), "bb".repeat(32)],
    };

    expect(getGroupAdminPubkeys(metadata)).toEqual([
      "aa".repeat(32),
      "bb".repeat(32),
    ]);
    expect(isEgalitarianGroup(metadata)).toBe(false);
  });

  test("treats egalitarian groups as open and restricted groups as explicit", () => {
    expect(isGroupAdmin({ stablePubkey: "aa".repeat(32) })).toBe(true);

    const metadata = {
      name: "demo",
      adminPubkeys: ["aa".repeat(32)],
    };

    expect(isGroupAdmin({ metadata, stablePubkey: "aa".repeat(32) })).toBe(
      true,
    );
    expect(isGroupAdmin({ metadata, stablePubkey: "bb".repeat(32) })).toBe(
      false,
    );
  });

  test("throws for unauthorized outbound admin actions", () => {
    expect(() =>
      assertCanAdministerGroup({
        groupAlias: "demo",
        metadata: { name: "demo", adminPubkeys: ["aa".repeat(32)] },
        stablePubkey: "bb".repeat(32),
      }),
    ).toThrow(UnauthorizedGroupAdminActionError);
  });

  test("detects which proposals require admin authorization", () => {
    expect(
      commitRequiresAdmin({
        proposals: [
          {
            proposal: { proposalType: defaultProposalTypes.add },
          },
        ],
      }),
    ).toBe(true);

    expect(
      commitRequiresAdmin({
        proposals: [
          {
            proposal: {
              proposalType: defaultProposalTypes.group_context_extensions,
            },
          },
        ],
      }),
    ).toBe(true);

    expect(
      proposalRequiresAdmin({
        proposal: {
          proposal: { proposalType: defaultProposalTypes.remove },
        },
      }),
    ).toBe(true);

    expect(
      commitRequiresAdmin({
        proposals: [
          {
            proposal: { proposalType: defaultProposalTypes.update },
          },
        ],
      }),
    ).toBe(false);
  });

  test("accepts egalitarian admin proposals", () => {
    listGroupMembers.mockReturnValue([
      { leafIndex: 1, stablePubkey: "aa".repeat(32) },
    ]);

    const callback = createAdminAuthorizationCallback({
      state: {} as never,
    });

    expect(
      callback({
        kind: "proposal",
        proposal: {
          senderLeafIndex: 1,
          proposal: { proposalType: defaultProposalTypes.add },
        },
      } as never),
    ).toBe("accept");
  });

  test("rejects unauthorized admin proposals from non-admin senders", () => {
    listGroupMembers.mockReturnValue([
      { leafIndex: 2, stablePubkey: "bb".repeat(32) },
    ]);

    const callback = createAdminAuthorizationCallback({
      state: {} as never,
      metadata: { name: "demo", adminPubkeys: ["aa".repeat(32)] },
    });

    expect(
      callback({
        kind: "commit",
        senderLeafIndex: 2,
        proposals: [
          {
            proposal: { proposalType: defaultProposalTypes.remove },
          },
        ],
      } as never),
    ).toBe("reject");
  });

  test("accepts non-admin proposal types without admin checks", () => {
    listGroupMembers.mockReturnValue([]);

    const callback = createAdminAuthorizationCallback({
      state: {} as never,
      metadata: { name: "demo", adminPubkeys: ["aa".repeat(32)] },
    });

    expect(
      callback({
        kind: "proposal",
        proposal: {
          senderLeafIndex: undefined,
          proposal: { proposalType: defaultProposalTypes.update },
        },
      } as never),
    ).toBe("accept");
  });

  test("formats unauthorized rejection details directly", () => {
    expect(createUnauthorizedAdminRejectionDetail({ groupAlias: "demo" })).toBe(
      "Rejected unauthorized admin action in group demo",
    );
  });
});
