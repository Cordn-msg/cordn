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

import {
  contentTypes,
  mlsMessageDecoder,
  wireformats,
  type MlsMessage,
} from "ts-mls";

const groupIdDecoder = new TextDecoder();

interface KeyPackageQueue {
  records: PublishedKeyPackageRecord[];
  head: number;
}

interface GroupLog {
  nextCursor: number;
  routing: GroupRoutingRecord;
  messages: GroupMessageRecord[];
}

function createGroupLog(groupId: string, epoch: bigint): GroupLog {
  return {
    nextCursor: 1,
    routing: {
      groupId,
      latestHandshakeEpoch: epoch,
      lastMessageCursor: 0,
    },
    messages: [],
  };
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

export class Coordinator {
  private readonly keyPackagesByIdentity = new Map<string, KeyPackageQueue>();
  private readonly welcomesByIdentity = new Map<string, WelcomeQueueRecord[]>();
  private readonly groups = new Map<string, GroupLog>();

  publishKeyPackage(input: PublishKeyPackageInput): PublishedKeyPackageRecord {
    const record: PublishedKeyPackageRecord = {
      stablePubkey: input.stablePubkey,
      keyPackage: input.keyPackage,
      keyPackageRef: input.keyPackageRef,
      publishedAt: Date.now(),
    };

    const queue = this.keyPackagesByIdentity.get(input.stablePubkey) ?? {
      records: [],
      head: 0,
    };
    queue.records.push(record);
    this.keyPackagesByIdentity.set(input.stablePubkey, queue);

    return record;
  }

  listKeyPackagesForIdentity(
    stablePubkey: string,
  ): PublishedKeyPackageRecord[] {
    const queue = this.keyPackagesByIdentity.get(stablePubkey);
    if (!queue) {
      return [];
    }

    if (queue.head === 0) {
      return queue.records;
    }

    return queue.records.slice(queue.head);
  }

  listAllKeyPackages(): PublishedKeyPackageRecord[] {
    const records: PublishedKeyPackageRecord[] = [];

    for (const queue of this.keyPackagesByIdentity.values()) {
      for (let index = queue.head; index < queue.records.length; index += 1) {
        records.push(queue.records[index]!);
      }
    }

    return records;
  }
  // TODO: In a future iteration we should also consider last resort key packages
  consumeKeyPackage(identifier: string): PublishedKeyPackageRecord | null {
    const directRecord = this.consumeKeyPackageByReference(identifier);
    if (directRecord) {
      return directRecord;
    }

    return this.consumeKeyPackageByIdentity(identifier);
  }

  private consumeKeyPackageByIdentity(
    stablePubkey: string,
  ): PublishedKeyPackageRecord | null {
    const queue = this.keyPackagesByIdentity.get(stablePubkey);
    if (!queue || queue.head >= queue.records.length) {
      return null;
    }

    const record = queue.records[queue.head] ?? null;
    if (!record) {
      return null;
    }

    queue.head += 1;

    if (queue.head >= queue.records.length) {
      this.keyPackagesByIdentity.delete(stablePubkey);
    }

    return record;
  }

  private consumeKeyPackageByReference(
    keyPackageRef: string,
  ): PublishedKeyPackageRecord | null {
    for (const [stablePubkey, queue] of this.keyPackagesByIdentity.entries()) {
      for (let index = queue.head; index < queue.records.length; index += 1) {
        const record = queue.records[index];
        if (record?.keyPackageRef !== keyPackageRef) {
          continue;
        }

        if (index === queue.head) {
          return this.consumeKeyPackageByIdentity(stablePubkey);
        }

        queue.records.splice(index, 1);
        if (queue.head >= queue.records.length) {
          this.keyPackagesByIdentity.delete(stablePubkey);
        }

        return record;
      }
    }

    return null;
  }

  storeWelcome(input: StoreWelcomeInput): WelcomeQueueRecord {
    const record: WelcomeQueueRecord = {
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

  fetchPendingWelcomes(targetStablePubkey: string): WelcomeQueueRecord[] {
    const records = this.welcomesByIdentity.get(targetStablePubkey);
    if (!records) {
      return [];
    }

    // TODO: If we are deleting it, might be a risk if the user never accept the welcome and it cannot get it again later(?)
    this.welcomesByIdentity.delete(targetStablePubkey);
    return records;
  }

  postGroupMessage(input: PostGroupMessageInput): GroupMessageRecord {
    const decodedMessage = decodeOpaqueMessage(input.opaqueMessage);
    const { groupId, epoch, handshakeMessage } =
      getMessageMetadata(decodedMessage);
    const group = this.groups.get(groupId) ?? createGroupLog(groupId, epoch);
    const currentRouting = group.routing;

    if (handshakeMessage) {
      if (epoch < currentRouting.latestHandshakeEpoch) {
        throw new Error(
          `Rejected stale handshake message for group ${groupId}: ${epoch} < ${currentRouting.latestHandshakeEpoch}`,
        );
      }
    }

    const record: GroupMessageRecord = {
      cursor: group.nextCursor,
      groupId,
      ephemeralSenderPubkey: input.ephemeralSenderPubkey,
      opaqueMessage: input.opaqueMessage,
      createdAt: Date.now(),
    };
    group.nextCursor += 1;

    group.messages.push(record);
    if (handshakeMessage && epoch > currentRouting.latestHandshakeEpoch) {
      currentRouting.latestHandshakeEpoch = epoch;
    }
    currentRouting.lastMessageCursor = record.cursor;

    this.groups.set(groupId, group);

    return record;
  }

  fetchGroupMessages(input: FetchGroupMessagesInput): GroupMessageRecord[] {
    const messages = this.groups.get(input.groupId)?.messages ?? [];
    if (input.afterCursor === undefined) {
      return messages;
    }

    const startIndex = input.afterCursor;
    if (startIndex <= 0) {
      return messages;
    }

    if (startIndex >= messages.length) {
      return [];
    }

    return messages.slice(startIndex);
  }

  getGroupRouting(groupId: string): GroupRoutingRecord | null {
    return this.groups.get(groupId)?.routing ?? null;
  }

  snapshot(): DeliveryServiceSnapshot {
    let publishedKeyPackages = 0;
    for (const queue of this.keyPackagesByIdentity.values()) {
      publishedKeyPackages += queue.records.length - queue.head;
    }

    const pendingWelcomes = Array.from(this.welcomesByIdentity.values()).reduce(
      (total, current) => total + current.length,
      0,
    );
    let queuedMessages = 0;
    for (const group of this.groups.values()) {
      queuedMessages += group.messages.length;
    }

    return {
      stableIdentities: this.keyPackagesByIdentity.size,
      publishedKeyPackages,
      pendingWelcomes,
      trackedGroups: this.groups.size,
      queuedMessages,
    };
  }
}

export function createCoordinator(): Coordinator {
  return new Coordinator();
}
