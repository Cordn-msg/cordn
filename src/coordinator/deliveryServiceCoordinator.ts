import type {
  DeliveryServiceSnapshot,
  FetchGroupMessagesInput,
  GroupMessageRecord,
  GroupRoutingRecord,
  PostGroupMessageInput,
  PublishedKeyPackageRecord,
  PublishKeyPackageInput,
  StablePublicKey,
  StoreWelcomeInput,
  WelcomeQueueRecord,
} from "./types.ts";

import {
  contentTypes,
  mlsMessageDecoder,
  wireformats,
  type MlsMessage,
} from "ts-mls";

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function cloneBytes(value: Uint8Array): Uint8Array {
  return Uint8Array.from(value);
}

function cloneMessageRecord(record: GroupMessageRecord): GroupMessageRecord {
  return {
    ...record,
    opaqueMessage: cloneBytes(record.opaqueMessage),
  };
}

function decodeOpaqueMessage(opaqueMessage: Uint8Array): MlsMessage {
  const decoded = mlsMessageDecoder(opaqueMessage, 0);
  if (!decoded) {
    throw new Error("Unable to decode MLS message");
  }

  return decoded[0];
}

function decodeGroupId(message: MlsMessage): string {
  const decoder = new TextDecoder();

  switch (message.wireformat) {
    case wireformats.mls_private_message:
      return decoder.decode(message.privateMessage.groupId);
    case wireformats.mls_public_message:
      return decoder.decode(message.publicMessage.content.groupId);
    default:
      throw new Error(
        "Group delivery only accepts MLS private or public messages",
      );
  }
}

function getMessageEpoch(message: MlsMessage): bigint {
  switch (message.wireformat) {
    case wireformats.mls_private_message:
      return message.privateMessage.epoch;
    case wireformats.mls_public_message:
      return message.publicMessage.content.epoch;
    default:
      throw new Error(
        "Group delivery only accepts MLS private or public messages",
      );
  }
}

function isHandshakeMessage(message: MlsMessage): boolean {
  switch (message.wireformat) {
    case wireformats.mls_private_message:
      return message.privateMessage.contentType !== contentTypes.application;
    case wireformats.mls_public_message:
      return (
        message.publicMessage.content.contentType !== contentTypes.application
      );
    default:
      throw new Error(
        "Group delivery only accepts MLS private or public messages",
      );
  }
}

export class DeliveryServiceCoordinator {
  private readonly keyPackagesByIdentity = new Map<
    StablePublicKey,
    PublishedKeyPackageRecord[]
  >();
  private readonly keyPackagesById = new Map<
    string,
    PublishedKeyPackageRecord
  >();
  private readonly welcomesByIdentity = new Map<
    StablePublicKey,
    WelcomeQueueRecord[]
  >();
  private readonly routingByGroup = new Map<string, GroupRoutingRecord>();
  private readonly messagesByGroup = new Map<string, GroupMessageRecord[]>();
  private nextMessageCursor = 1;

  publishKeyPackage(input: PublishKeyPackageInput): PublishedKeyPackageRecord {
    const record: PublishedKeyPackageRecord = {
      id: createId("kp"),
      stablePubkey: input.stablePubkey,
      keyPackage: input.keyPackage,
      keyPackageRef: input.keyPackageRef,
      publishedAt: Date.now(),
    };

    const existing = this.keyPackagesByIdentity.get(input.stablePubkey) ?? [];
    existing.push(record);
    this.keyPackagesByIdentity.set(input.stablePubkey, existing);
    this.keyPackagesById.set(record.id, record);

    return record;
  }

  listKeyPackagesForIdentity(
    stablePubkey: StablePublicKey,
  ): PublishedKeyPackageRecord[] {
    return [...(this.keyPackagesByIdentity.get(stablePubkey) ?? [])];
  }

  listAllKeyPackages(): PublishedKeyPackageRecord[] {
    return Array.from(this.keyPackagesByIdentity.values()).flatMap(
      (records) => [...records],
    );
  }

  consumeKeyPackageForIdentity(
    stablePubkey: StablePublicKey,
  ): PublishedKeyPackageRecord | null {
    const existing = this.keyPackagesByIdentity.get(stablePubkey);
    if (!existing || existing.length === 0) {
      return null;
    }

    const record = existing.shift() ?? null;
    if (!record) {
      return null;
    }

    if (existing.length === 0) {
      this.keyPackagesByIdentity.delete(stablePubkey);
    }

    this.keyPackagesById.delete(record.id);
    return record;
  }

  storeWelcome(input: StoreWelcomeInput): WelcomeQueueRecord {
    const record: WelcomeQueueRecord = {
      id: createId("welcome"),
      targetStablePubkey: input.targetStablePubkey,
      keyPackageReference: input.keyPackageReference,
      welcome: input.welcome,
      createdAt: Date.now(),
    };

    const existing =
      this.welcomesByIdentity.get(input.targetStablePubkey) ?? [];
    existing.push(record);
    this.welcomesByIdentity.set(input.targetStablePubkey, existing);

    return record;
  }

  fetchPendingWelcomes(
    targetStablePubkey: StablePublicKey,
  ): WelcomeQueueRecord[] {
    const records = this.welcomesByIdentity.get(targetStablePubkey) ?? [];
    this.welcomesByIdentity.delete(targetStablePubkey);
    return [...records];
  }

  postGroupMessage(input: PostGroupMessageInput): GroupMessageRecord {
    const decodedMessage = decodeOpaqueMessage(input.opaqueMessage);
    const groupId = decodeGroupId(decodedMessage);
    const currentRouting = this.routingByGroup.get(groupId);
    const epoch = getMessageEpoch(decodedMessage);
    const handshakeMessage = isHandshakeMessage(decodedMessage);

    if (handshakeMessage) {
      const latestHandshakeEpoch = currentRouting?.latestHandshakeEpoch;
      if (latestHandshakeEpoch !== undefined && epoch < latestHandshakeEpoch) {
        throw new Error(
          `Rejected stale handshake message for group ${groupId}: ${epoch} < ${latestHandshakeEpoch}`,
        );
      }
    }

    const record: GroupMessageRecord = {
      cursor: this.nextMessageCursor++,
      groupId,
      ephemeralSenderPubkey: input.ephemeralSenderPubkey,
      opaqueMessage: cloneBytes(input.opaqueMessage),
      createdAt: Date.now(),
    };

    const messages = this.messagesByGroup.get(groupId) ?? [];
    messages.push(record);
    this.messagesByGroup.set(groupId, messages);

    const nextRouting: GroupRoutingRecord = {
      groupId,
      latestHandshakeEpoch: !handshakeMessage
        ? (currentRouting?.latestHandshakeEpoch ?? epoch)
        : currentRouting?.latestHandshakeEpoch !== undefined &&
            currentRouting.latestHandshakeEpoch > epoch
          ? currentRouting.latestHandshakeEpoch
          : epoch,
      lastMessageCursor: record.cursor,
    };

    this.routingByGroup.set(groupId, nextRouting);

    return cloneMessageRecord(record);
  }

  fetchGroupMessages(input: FetchGroupMessagesInput): GroupMessageRecord[] {
    const messages = this.messagesByGroup.get(input.groupId) ?? [];
    if (input.afterCursor === undefined) {
      return messages.map(cloneMessageRecord);
    }

    const afterIndex = messages.findIndex(
      (message) => message.cursor === input.afterCursor,
    );
    const startIndex = afterIndex >= 0 ? afterIndex + 1 : 0;
    return messages.slice(startIndex).map(cloneMessageRecord);
  }

  getGroupRouting(groupId: string): GroupRoutingRecord | null {
    return this.routingByGroup.get(groupId) ?? null;
  }

  snapshot(): DeliveryServiceSnapshot {
    const publishedKeyPackages = Array.from(
      this.keyPackagesByIdentity.values(),
    ).reduce((total, current) => total + current.length, 0);
    const pendingWelcomes = Array.from(this.welcomesByIdentity.values()).reduce(
      (total, current) => total + current.length,
      0,
    );
    const queuedMessages = Array.from(this.messagesByGroup.values()).reduce(
      (total, current) => total + current.length,
      0,
    );

    return {
      stableIdentities: this.keyPackagesByIdentity.size,
      publishedKeyPackages,
      pendingWelcomes,
      trackedGroups: this.routingByGroup.size,
      queuedMessages,
    };
  }
}
