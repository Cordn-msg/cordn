import type { Coordinator } from "@cordn/coordinator";
import { createCoordinator } from "@cordn/coordinator";

import type { CordnTransport } from "../transport.ts";

export interface InProcessTransportOptions {
  /** An existing coordinator instance. A fresh in-memory one is created if omitted. */
  coordinator?: Coordinator;
}

/**
 * Dev/test-only `CordnTransport` backed directly by `@cordn/coordinator` —
 * zero encoding, zero network. Lets the SDK and its consumers run end-to-end
 * against a real delivery service with no Nostr relay (design #10).
 *
 * `@cordn/coordinator` is a devDependency: never use this in production paths.
 */
export function createInProcessTransport(
  options: InProcessTransportOptions = {},
): { transport: CordnTransport; coordinator: Coordinator } {
  const coordinator = options.coordinator ?? createCoordinator();

  const transport: CordnTransport = {
    publishKeyPackage: (input) =>
      Promise.resolve(coordinator.publishKeyPackage(input)),
    listKeyPackages: (stablePubkey) =>
      Promise.resolve(coordinator.listKeyPackagesForIdentity(stablePubkey)),
    consumeKeyPackage: (keyPackageRef) =>
      Promise.resolve(coordinator.consumeKeyPackage(keyPackageRef)),
    removeKeyPackage: (keyPackageRef) =>
      Promise.resolve(coordinator.removeKeyPackage(keyPackageRef)),

    storeWelcome: (input) => Promise.resolve(coordinator.storeWelcome(input)),
    fetchPendingWelcomes: (targetStablePubkey, consumed) =>
      Promise.resolve(
        coordinator.fetchPendingWelcomes(targetStablePubkey, consumed),
      ),

    storeJoinRequest: (input) =>
      Promise.resolve(coordinator.storeJoinRequest(input)),
    fetchPendingJoinRequests: (groupId, consumed) =>
      Promise.resolve(coordinator.fetchPendingJoinRequests(groupId, consumed)),

    postGroupMessage: (input) =>
      Promise.resolve(coordinator.postGroupMessage(input)),
    fetchGroupMessages: (input) =>
      Promise.resolve(coordinator.fetchGroupMessages(input)),
    subscribeGroupMessages: (input) =>
      Promise.resolve(coordinator.subscribeGroupMessages(input)),
  };

  return { transport, coordinator };
}
