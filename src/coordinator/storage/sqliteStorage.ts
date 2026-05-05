import Database from "better-sqlite3";
import {
  decodeKeyPackage,
  decodeWelcome,
  encodeKeyPackage,
  encodeWelcome,
} from "../../mlsCodec.ts";

import type {
  DeliveryServiceSnapshot,
  FetchGroupMessagesInput,
  GroupMessageRecord,
  GroupRoutingRecord,
  PublishedKeyPackageRecord,
  WelcomeQueueRecord,
} from "../types.ts";
import type {
  AppendGroupMessageParams,
  CoordinatorStorage,
} from "./storage.ts";

type SqliteDatabase = InstanceType<typeof Database>;

interface SqliteCoordinatorStorageOptions {
  path?: string;
  database?: SqliteDatabase;
}

interface KeyPackageRow {
  id?: number;
  stable_pubkey: string;
  key_package_ref: string;
  key_package_bytes: Buffer;
  is_last_resort: number;
  published_at: number;
}

interface WelcomeRow {
  target_stable_pubkey: string;
  key_package_reference: string;
  welcome_bytes: Buffer;
  created_at: number;
}

interface GroupMessageRow {
  cursor: number;
  group_id: string;
  ephemeral_sender_pubkey: string;
  opaque_message: Buffer;
  created_at: number;
}

interface GroupRoutingRow {
  group_id: string;
  latest_handshake_epoch: string;
  last_message_cursor: number;
}

function toUint8Array(buffer: Buffer): Uint8Array {
  return Uint8Array.from(buffer);
}

export class SqliteCoordinatorStorage implements CoordinatorStorage {
  private readonly database: SqliteDatabase;
  private readonly ownsDatabase: boolean;
  private readonly publishKeyPackageStatement: Database.Statement<
    [string, string, Buffer, number, number]
  >;
  private readonly listKeyPackagesForIdentityStatement: Database.Statement<
    [string],
    KeyPackageRow
  >;
  private readonly listAllKeyPackagesStatement: Database.Statement<
    [],
    KeyPackageRow
  >;
  private readonly consumeKeyPackageByRefStatement: Database.Statement<
    [string],
    KeyPackageRow & { id: number }
  >;
  private readonly consumeKeyPackageByIdentityStatement: Database.Statement<
    [string],
    KeyPackageRow & { id: number }
  >;
  private readonly deleteKeyPackageStatement: Database.Statement<[number]>;
  private readonly getKeyPackageByRefStatement: Database.Statement<
    [string],
    KeyPackageRow
  >;
  private readonly storeWelcomeStatement: Database.Statement<
    [string, string, Buffer, number]
  >;
  private readonly fetchPendingWelcomesStatement: Database.Statement<
    [string],
    WelcomeRow & { id: number }
  >;
  private readonly deleteWelcomesStatement: Database.Statement<[string]>;
  private readonly upsertGroupRoutingStatement: Database.Statement<
    [string, string, number]
  >;
  private readonly selectGroupRoutingStatement: Database.Statement<
    [string],
    GroupRoutingRow
  >;
  private readonly insertGroupMessageStatement: Database.Statement<
    [number, string, string, Buffer, number]
  >;
  private readonly selectGroupRoutingForCursorStatement: Database.Statement<
    [string],
    Pick<GroupRoutingRow, "last_message_cursor">
  >;
  private readonly fetchGroupMessagesStatement: Database.Statement<
    [string],
    GroupMessageRow
  >;
  private readonly fetchGroupMessagesAfterCursorStatement: Database.Statement<
    [string, number],
    GroupMessageRow
  >;
  private readonly snapshotCountsStatement: Database.Statement<
    [],
    DeliveryServiceSnapshot
  >;
  private readonly consumeKeyPackageByReferenceTransaction: (
    identifier: string,
  ) => KeyPackageRow | null;
  private readonly consumeKeyPackageByIdentityTransaction: (
    stablePubkey: string,
  ) => KeyPackageRow | null;
  private readonly fetchPendingWelcomesTransaction: (
    targetStablePubkey: string,
  ) => WelcomeRow[];
  private readonly appendGroupMessageTransaction: (
    params: AppendGroupMessageParams,
  ) => GroupMessageRecord;

  constructor(options: SqliteCoordinatorStorageOptions = {}) {
    this.database =
      options.database ?? new Database(options.path ?? ":memory:");
    this.ownsDatabase = options.database === undefined;

    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS key_packages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stable_pubkey TEXT NOT NULL,
        key_package_ref TEXT NOT NULL UNIQUE,
        key_package_bytes BLOB NOT NULL,
        is_last_resort INTEGER NOT NULL,
        published_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_key_packages_identity_order
      ON key_packages (stable_pubkey, id);

      CREATE TABLE IF NOT EXISTS welcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_stable_pubkey TEXT NOT NULL,
        key_package_reference TEXT NOT NULL,
        welcome_bytes BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_welcomes_target_order
      ON welcomes (target_stable_pubkey, id);

      CREATE TABLE IF NOT EXISTS group_routing (
        group_id TEXT PRIMARY KEY,
        latest_handshake_epoch TEXT NOT NULL,
        last_message_cursor INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cursor INTEGER NOT NULL,
        group_id TEXT NOT NULL,
        ephemeral_sender_pubkey TEXT NOT NULL,
        opaque_message BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_group_messages_group_cursor_unique
      ON group_messages (group_id, cursor);

      CREATE INDEX IF NOT EXISTS idx_group_messages_group_cursor
      ON group_messages (group_id, cursor);
    `);

    this.publishKeyPackageStatement = this.database.prepare<
      [string, string, Buffer, number, number]
    >(`
      INSERT INTO key_packages (
        stable_pubkey,
        key_package_ref,
        key_package_bytes,
        is_last_resort,
        published_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    this.listKeyPackagesForIdentityStatement = this.database.prepare<
      [string],
      KeyPackageRow
    >(`
      SELECT id, stable_pubkey, key_package_ref, key_package_bytes, is_last_resort, published_at
      FROM key_packages
      WHERE stable_pubkey = ?
      ORDER BY id ASC
    `);
    this.listAllKeyPackagesStatement = this.database.prepare<
      [],
      KeyPackageRow
    >(`
      SELECT id, stable_pubkey, key_package_ref, key_package_bytes, is_last_resort, published_at
      FROM key_packages
      ORDER BY id ASC
    `);
    this.getKeyPackageByRefStatement = this.database.prepare<
      [string],
      KeyPackageRow
    >(`
      SELECT id, stable_pubkey, key_package_ref, key_package_bytes, is_last_resort, published_at
      FROM key_packages
      WHERE key_package_ref = ?
      LIMIT 1
    `);
    this.consumeKeyPackageByRefStatement = this.database.prepare<
      [string],
      KeyPackageRow & { id: number }
    >(`
      SELECT id, stable_pubkey, key_package_ref, key_package_bytes, is_last_resort, published_at
      FROM key_packages
      WHERE key_package_ref = ?
      LIMIT 1
    `);
    this.consumeKeyPackageByIdentityStatement = this.database.prepare<
      [string],
      KeyPackageRow & { id: number }
    >(`
      SELECT id, stable_pubkey, key_package_ref, key_package_bytes, is_last_resort, published_at
      FROM key_packages
      WHERE stable_pubkey = ?
      ORDER BY is_last_resort ASC, CASE WHEN is_last_resort = 0 THEN id END ASC, CASE WHEN is_last_resort = 1 THEN id END DESC
      LIMIT 1
    `);
    this.deleteKeyPackageStatement = this.database.prepare<[number]>(
      "DELETE FROM key_packages WHERE id = ?",
    );
    this.storeWelcomeStatement = this.database.prepare<
      [string, string, Buffer, number]
    >(`
      INSERT INTO welcomes (
        target_stable_pubkey,
        key_package_reference,
        welcome_bytes,
        created_at
      ) VALUES (?, ?, ?, ?)
    `);
    this.fetchPendingWelcomesStatement = this.database.prepare<
      [string],
      WelcomeRow & { id: number }
    >(`
      SELECT id, target_stable_pubkey, key_package_reference, welcome_bytes, created_at
      FROM welcomes
      WHERE target_stable_pubkey = ?
      ORDER BY id ASC
    `);
    this.deleteWelcomesStatement = this.database.prepare<[string]>(
      "DELETE FROM welcomes WHERE target_stable_pubkey = ?",
    );
    this.upsertGroupRoutingStatement = this.database.prepare<
      [string, string, number]
    >(`
      INSERT INTO group_routing (
        group_id,
        latest_handshake_epoch,
        last_message_cursor
      ) VALUES (?, ?, ?)
      ON CONFLICT(group_id) DO UPDATE SET
        latest_handshake_epoch = excluded.latest_handshake_epoch,
        last_message_cursor = excluded.last_message_cursor
    `);
    this.selectGroupRoutingStatement = this.database.prepare<
      [string],
      GroupRoutingRow
    >(`
      SELECT group_id, latest_handshake_epoch, last_message_cursor
      FROM group_routing
      WHERE group_id = ?
      LIMIT 1
    `);
    this.insertGroupMessageStatement = this.database.prepare<
      [number, string, string, Buffer, number]
    >(`
      INSERT INTO group_messages (
        cursor,
        group_id,
        ephemeral_sender_pubkey,
        opaque_message,
        created_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    this.selectGroupRoutingForCursorStatement = this.database.prepare<
      [string],
      Pick<GroupRoutingRow, "last_message_cursor">
    >(`
      SELECT last_message_cursor
      FROM group_routing
      WHERE group_id = ?
    `);
    this.fetchGroupMessagesStatement = this.database.prepare<
      [string],
      GroupMessageRow
    >(`
      SELECT cursor, group_id, ephemeral_sender_pubkey, opaque_message, created_at
      FROM group_messages
      WHERE group_id = ?
      ORDER BY cursor ASC
    `);
    this.fetchGroupMessagesAfterCursorStatement = this.database.prepare<
      [string, number],
      GroupMessageRow
    >(`
      SELECT cursor, group_id, ephemeral_sender_pubkey, opaque_message, created_at
      FROM group_messages
      WHERE group_id = ? AND cursor > ?
      ORDER BY cursor ASC
    `);
    this.snapshotCountsStatement = this.database.prepare<
      [],
      DeliveryServiceSnapshot
    >(`
      SELECT
        (SELECT COUNT(DISTINCT stable_pubkey) FROM key_packages) AS stableIdentities,
        (SELECT COUNT(*) FROM key_packages) AS publishedKeyPackages,
        (SELECT COUNT(*) FROM welcomes) AS pendingWelcomes,
        (SELECT COUNT(*) FROM group_routing) AS trackedGroups,
        (SELECT COUNT(*) FROM group_messages) AS queuedMessages
    `);

    this.consumeKeyPackageByReferenceTransaction = this.database.transaction(
      (identifier: string) => {
        const row = this.consumeKeyPackageByRefStatement.get(identifier);
        if (!row) {
          return null;
        }

        if (!row.is_last_resort) {
          this.deleteKeyPackageStatement.run(row.id);
        }
        return row;
      },
    );

    this.consumeKeyPackageByIdentityTransaction = this.database.transaction(
      (stablePubkey: string) => {
        const row = this.consumeKeyPackageByIdentityStatement.get(stablePubkey);
        if (!row) {
          return null;
        }

        if (!row.is_last_resort) {
          this.deleteKeyPackageStatement.run(row.id);
        }
        return row;
      },
    );

    this.fetchPendingWelcomesTransaction = this.database.transaction(
      (targetStablePubkey: string) => {
        const rows = this.fetchPendingWelcomesStatement.all(targetStablePubkey);
        this.deleteWelcomesStatement.run(targetStablePubkey);
        return rows;
      },
    );

    this.appendGroupMessageTransaction = this.database.transaction(
      (params: AppendGroupMessageParams) => {
        const routingRow = this.selectGroupRoutingForCursorStatement.get(
          params.groupId,
        );
        const cursor = (routingRow?.last_message_cursor ?? 0) + 1;
        if (!Number.isSafeInteger(cursor) || cursor <= 0) {
          throw new Error("Unable to allocate per-group message cursor");
        }

        this.insertGroupMessageStatement.run(
          cursor,
          params.groupId,
          params.ephemeralSenderPubkey,
          Buffer.from(params.opaqueMessage),
          params.createdAt,
        );

        this.upsertGroupRoutingStatement.run(
          params.groupId,
          params.latestHandshakeEpoch.toString(),
          cursor,
        );

        return {
          cursor,
          groupId: params.groupId,
          ephemeralSenderPubkey: params.ephemeralSenderPubkey,
          opaqueMessage: params.opaqueMessage,
          createdAt: params.createdAt,
        } satisfies GroupMessageRecord;
      },
    );
  }

  publishKeyPackage(
    record: PublishedKeyPackageRecord,
  ): PublishedKeyPackageRecord {
    this.publishKeyPackageStatement.run(
      record.stablePubkey,
      record.keyPackageRef,
      Buffer.from(encodeKeyPackage(record.keyPackage)),
      record.isLastResort ? 1 : 0,
      record.publishedAt,
    );

    return record;
  }

  listKeyPackagesForIdentity(
    stablePubkey: string,
  ): PublishedKeyPackageRecord[] {
    const rows = this.listKeyPackagesForIdentityStatement.all(stablePubkey);
    return rows.map((row) => this.mapKeyPackageRow(row));
  }

  listAllKeyPackages(): PublishedKeyPackageRecord[] {
    const rows = this.listAllKeyPackagesStatement.all();
    return rows.map((row) => this.mapKeyPackageRow(row));
  }

  getKeyPackage(keyPackageRef: string): PublishedKeyPackageRecord | null {
    const row = this.getKeyPackageByRefStatement.get(keyPackageRef);
    return row ? this.mapKeyPackageRow(row) : null;
  }

  removeKeyPackage(keyPackageRef: string): PublishedKeyPackageRecord | null {
    const row = this.getKeyPackageByRefStatement.get(keyPackageRef);
    if (!row || row.id === undefined) {
      return null;
    }

    this.deleteKeyPackageStatement.run(row.id);
    return this.mapKeyPackageRow(row);
  }

  consumeKeyPackage(identifier: string): PublishedKeyPackageRecord | null {
    const direct = this.consumeKeyPackageByReferenceTransaction(identifier);
    if (direct) {
      return this.mapKeyPackageRow(direct);
    }

    const byIdentity = this.consumeKeyPackageByIdentityTransaction(identifier);
    return byIdentity ? this.mapKeyPackageRow(byIdentity) : null;
  }

  storeWelcome(record: WelcomeQueueRecord): WelcomeQueueRecord {
    this.storeWelcomeStatement.run(
      record.targetStablePubkey,
      record.keyPackageReference,
      Buffer.from(encodeWelcome(record.welcome)),
      record.createdAt,
    );

    return record;
  }

  fetchPendingWelcomes(targetStablePubkey: string): WelcomeQueueRecord[] {
    return this.fetchPendingWelcomesTransaction(targetStablePubkey).map((row) =>
      this.mapWelcomeRow(row),
    );
  }

  appendGroupMessage(params: AppendGroupMessageParams): GroupMessageRecord {
    return this.appendGroupMessageTransaction(params);
  }

  fetchGroupMessages(input: FetchGroupMessagesInput): GroupMessageRecord[] {
    const rows =
      input.afterCursor === undefined
        ? this.fetchGroupMessagesStatement.all(input.groupId)
        : this.fetchGroupMessagesAfterCursorStatement.all(
            input.groupId,
            input.afterCursor,
          );

    return rows.map((row) => this.mapGroupMessageRow(row));
  }

  getGroupRouting(groupId: string): GroupRoutingRecord | null {
    const row = this.selectGroupRoutingStatement.get(groupId);
    if (!row) {
      return null;
    }

    return {
      groupId: row.group_id,
      latestHandshakeEpoch: BigInt(row.latest_handshake_epoch),
      lastMessageCursor: row.last_message_cursor,
    };
  }

  snapshot(): DeliveryServiceSnapshot {
    const row = this.snapshotCountsStatement.get();
    if (!row) {
      throw new Error("Unable to read storage snapshot");
    }

    return row;
  }

  close(): void {
    if (this.ownsDatabase) {
      this.database.close();
    }
  }

  private mapKeyPackageRow(row: KeyPackageRow): PublishedKeyPackageRecord {
    return {
      stablePubkey: row.stable_pubkey,
      keyPackageRef: row.key_package_ref,
      keyPackage: decodeKeyPackage(toUint8Array(row.key_package_bytes)),
      isLastResort: row.is_last_resort === 1,
      publishedAt: row.published_at,
    };
  }

  private mapWelcomeRow(row: WelcomeRow): WelcomeQueueRecord {
    return {
      targetStablePubkey: row.target_stable_pubkey,
      keyPackageReference: row.key_package_reference,
      welcome: decodeWelcome(toUint8Array(row.welcome_bytes)),
      createdAt: row.created_at,
    };
  }

  private mapGroupMessageRow(row: GroupMessageRow): GroupMessageRecord {
    return {
      cursor: row.cursor,
      groupId: row.group_id,
      ephemeralSenderPubkey: row.ephemeral_sender_pubkey,
      opaqueMessage: toUint8Array(row.opaque_message),
      createdAt: row.created_at,
    };
  }
}
