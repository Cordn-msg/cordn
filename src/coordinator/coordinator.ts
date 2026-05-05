import type {
  DeliveryServiceSnapshot,
  FetchGroupMessagesInput,
  GroupMessageRecord,
  GroupRoutingRecord,
  PostGroupMessageInput,
  PublishedKeyPackageRecord,
  PublishKeyPackageInput,
  StoreWelcomeInput,
  WelcomeQueueRecord,
} from "./types.ts";
import type { CoordinatorStorage } from "./storage/storage.ts";
import { InMemoryCoordinatorStorage } from "./storage/inMemoryStorage.ts";
import { isLastResortKeyPackage } from "../lastResortKeyPackage.ts";

import {
  contentTypes,
  mlsMessageDecoder,
  wireformats,
  type MlsMessage,
} from "ts-mls";

const groupIdDecoder = new TextDecoder();

export interface CoordinatorOptions {
  storage?: CoordinatorStorage;
  now?: () => number;
}

function decodeOpaqueMessage(opaqueMessage: Uint8Array): MlsMessage {
  const decoded = mlsMessageDecoder(opaqueMessage, 0);
  if (!decoded) {
    throw new Error("Unable to decode MLS message");
  }

  return decoded[0];
}

function getMessageMetadata(message: MlsMessage): {
  groupId: string;
  epoch: bigint;
  handshakeMessage: boolean;
} {
  switch (message.wireformat) {
    case wireformats.mls_private_message:
      return {
        groupId: groupIdDecoder.decode(message.privateMessage.groupId),
        epoch: message.privateMessage.epoch,
        handshakeMessage:
          message.privateMessage.contentType !== contentTypes.application,
      };
    case wireformats.mls_public_message:
      return {
        groupId: groupIdDecoder.decode(message.publicMessage.content.groupId),
        epoch: message.publicMessage.content.epoch,
        handshakeMessage:
          message.publicMessage.content.contentType !==
          contentTypes.application,
      };
    default:
      throw new Error(
        "Group delivery only accepts MLS private or public messages",
      );
  }
}

function resolveLatestHandshakeEpoch(
  currentRouting: GroupRoutingRecord | null,
  epoch: bigint,
  handshakeMessage: boolean,
): bigint {
  if (!handshakeMessage) {
    return currentRouting?.latestHandshakeEpoch ?? epoch;
  }

  return currentRouting && currentRouting.latestHandshakeEpoch > epoch
    ? currentRouting.latestHandshakeEpoch
    : epoch;
}

export class Coordinator {
  private readonly storage: CoordinatorStorage;
  private readonly now: () => number;

  constructor(options: CoordinatorOptions = {}) {
    this.storage = options.storage ?? new InMemoryCoordinatorStorage();
    this.now = options.now ?? Date.now;
  }

  publishKeyPackage(input: PublishKeyPackageInput): PublishedKeyPackageRecord {
    const record: PublishedKeyPackageRecord = {
      stablePubkey: input.stablePubkey,
      keyPackage: input.keyPackage,
      keyPackageRef: input.keyPackageRef,
      isLastResort: isLastResortKeyPackage(input.keyPackage),
      publishedAt: this.now(),
    };

    return this.storage.publishKeyPackage(record);
  }

  listKeyPackagesForIdentity(
    stablePubkey: string,
  ): PublishedKeyPackageRecord[] {
    return this.storage.listKeyPackagesForIdentity(stablePubkey);
  }

  listAllKeyPackages(): PublishedKeyPackageRecord[] {
    return this.storage.listAllKeyPackages();
  }

  getKeyPackage(keyPackageRef: string): PublishedKeyPackageRecord | null {
    return this.storage.getKeyPackage(keyPackageRef);
  }

  removeKeyPackage(keyPackageRef: string): PublishedKeyPackageRecord | null {
    return this.storage.removeKeyPackage(keyPackageRef);
  }

  consumeKeyPackage(identifier: string): PublishedKeyPackageRecord | null {
    return this.storage.consumeKeyPackage(identifier);
  }

  storeWelcome(input: StoreWelcomeInput): WelcomeQueueRecord {
    const record: WelcomeQueueRecord = {
      targetStablePubkey: input.targetStablePubkey,
      keyPackageReference: input.keyPackageReference,
      welcome: input.welcome,
      createdAt: this.now(),
    };

    return this.storage.storeWelcome(record);
  }

  fetchPendingWelcomes(targetStablePubkey: string): WelcomeQueueRecord[] {
    return this.storage.fetchPendingWelcomes(targetStablePubkey);
  }

  postGroupMessage(input: PostGroupMessageInput): GroupMessageRecord {
    const decodedMessage = decodeOpaqueMessage(input.opaqueMessage);
    const { groupId, epoch, handshakeMessage } =
      getMessageMetadata(decodedMessage);
    const currentRouting = this.storage.getGroupRouting(groupId);

    if (
      handshakeMessage &&
      currentRouting &&
      epoch < currentRouting.latestHandshakeEpoch
    ) {
      throw new Error(
        `Rejected stale handshake message for group ${groupId}: ${epoch} < ${currentRouting.latestHandshakeEpoch}`,
      );
    }

    const latestHandshakeEpoch = resolveLatestHandshakeEpoch(
      currentRouting,
      epoch,
      handshakeMessage,
    );

    return this.storage.appendGroupMessage({
      groupId,
      latestHandshakeEpoch,
      ephemeralSenderPubkey: input.ephemeralSenderPubkey,
      opaqueMessage: input.opaqueMessage,
      createdAt: this.now(),
    });
  }

  fetchGroupMessages(input: FetchGroupMessagesInput): GroupMessageRecord[] {
    return this.storage.fetchGroupMessages(input);
  }

  getGroupRouting(groupId: string): GroupRoutingRecord | null {
    return this.storage.getGroupRouting(groupId);
  }

  snapshot(): DeliveryServiceSnapshot {
    return this.storage.snapshot();
  }
}

export function createCoordinator(
  options: CoordinatorOptions = {},
): Coordinator {
  return new Coordinator(options);
}
