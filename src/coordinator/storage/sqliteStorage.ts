import Database from "better-sqlite3";
import {
  decodeKeyPackage,
  decodeWelcome,
  encodeKeyPackage,
  encodeWelcome,
} from "../../mlsCodec.ts";

import type {
  FetchManyGroupMessagesInput,
  FetchManyPendingJoinRequestsInput,
  FetchGroupMessagesInput,
  GroupMessageRecord,
  GroupRoutingRecord,
  JoinRequestRecord,
  PublishedKeyPackageRecord,
  WelcomeQueueRecord,
} from "../types.ts";
import {
  type AppendGroupMessageParams,
  type CoordinatorStorage,
  MAX_PENDING_JOIN_REQUESTS_PER_GROUP,
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
  publication_event_json: string;
}

interface WelcomeRow {
  target_stable_pubkey: string;
  key_package_reference: string;
  welcome_bytes: Buffer;
  created_at: number;
  read_at: number | null;
}

interface JoinRequestRow {
  group_id: string;
  requester_stable_pubkey: string;
  key_package_ref: string;
  created_at: number;
  read_at: number | null;
}

interface GroupMessageRow {
  cursor: number;
  group_id: string;
  epoch: string | null;
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
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

export class SqliteCoordinatorStorage implements CoordinatorStorage {
  private readonly database: SqliteDatabase;
  private readonly ownsDatabase: boolean;
  private readonly publishKeyPackageStatement: Database.Statement<
    [string, string, Buffer, number, number, string]
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
    [string, string, Buffer, number, number | null]
  >;
  private readonly markWelcomesReadStatement: Database.Statement<
    [number, string]
  >;
  private readonly fetchPendingWelcomesStatement: Database.Statement<
    [string],
    WelcomeRow & { id: number }
  >;
  private readonly deleteExpiredWelcomesStatement: Database.Statement<
    [number, number]
  >;
  private readonly storeJoinRequestStatement: Database.Statement<
    [string, string, string, number, number | null]
  >;
  private readonly findUnreadJoinRequestStatement: Database.Statement<
    [string, string],
    JoinRequestRow & { id: number }
  >;
  private readonly markJoinRequestsReadStatement: Database.Statement<
    [number, string]
  >;
  private readonly fetchPendingJoinRequestsStatement: Database.Statement<
    [string],
    JoinRequestRow & { id: number }
  >;
  private readonly deleteExpiredJoinRequestsStatement: Database.Statement<
    [number, number]
  >;
  private readonly countUnreadJoinRequestsStatement: Database.Statement<
    [string],
    { count: number }
  >;
  private readonly upsertGroupRoutingStatement: Database.Statement<
    [string, string, number]
  >;
  private readonly selectGroupRoutingStatement: Database.Statement<
    [string],
    GroupRoutingRow
  >;
  private readonly insertGroupMessageStatement: Database.Statement<
    [number, string, string, string, Buffer, number]
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
  private readonly fetchGroupMessagesSinceEpochStatement: Database.Statement<
    [string, string],
    GroupMessageRow
  >;
  private readonly fetchGroupMessagesSinceEpochAfterCursorStatement: Database.Statement<
    [string, number, string],
    GroupMessageRow
  >;
  private readonly fetchManyGroupMessagesStatements = new Map<
    number,
    Database.Statement<unknown[], GroupMessageRow>
  >();
  private readonly fetchManyPendingJoinRequestsStatements = new Map<
    number,
    Database.Statement<unknown[], JoinRequestRow & { id: number }>
  >();
  private readonly consumeKeyPackageByReferenceTransaction: (
    identifier: string,
  ) => KeyPackageRow | null;
  private readonly consumeKeyPackageByIdentityTransaction: (
    stablePubkey: string,
  ) => KeyPackageRow | null;
  private readonly fetchPendingWelcomesTransaction: (
    targetStablePubkey: string,
    now: number,
  ) => WelcomeRow[];
  private readonly fetchPendingJoinRequestsTransaction: (
    groupId: string,
    now: number,
  ) => JoinRequestRow[];
  private readonly fetchManyPendingJoinRequestsTransaction: (
    groupIds: string[],
    now: number,
  ) => JoinRequestRow[];
  private readonly storeJoinRequestTransaction: (
    record: JoinRequestRecord,
  ) => JoinRequestRecord;
  private readonly appendGroupMessageTransaction: (
    params: AppendGroupMessageParams,
  ) => GroupMessageRecord;

  constructor(options: SqliteCoordinatorStorageOptions = {}) {
    this.database =
      options.database ?? new Database(options.path ?? ":memory:");
    this.ownsDatabase = options.database === undefined;

    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS key_packages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stable_pubkey TEXT NOT NULL,
        key_package_ref TEXT NOT NULL UNIQUE,
        key_package_bytes BLOB NOT NULL,
        is_last_resort INTEGER NOT NULL,
        published_at INTEGER NOT NULL,
        publication_event_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_key_packages_identity_order
      ON key_packages (stable_pubkey, id);

      CREATE INDEX IF NOT EXISTS idx_key_packages_identity_last_resort_order
      ON key_packages (stable_pubkey, is_last_resort, id);

      CREATE TABLE IF NOT EXISTS welcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_stable_pubkey TEXT NOT NULL,
        key_package_reference TEXT NOT NULL,
        welcome_bytes BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        read_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_welcomes_target_order
      ON welcomes (target_stable_pubkey, id);

      CREATE TABLE IF NOT EXISTS join_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        requester_stable_pubkey TEXT NOT NULL,
        key_package_ref TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_join_requests_group_order
      ON join_requests (group_id, id);
    `);

    // Migration: add read_at column for existing databases that predate
    // the read-before-delete welcome TTL model. Skip if already present.
    const welcomesColumns = this.database
      .prepare("PRAGMA table_info('welcomes')")
      .all() as Array<{ name: string }>;
    if (!welcomesColumns.some((col) => col.name === "read_at")) {
      this.database.exec("ALTER TABLE welcomes ADD COLUMN read_at INTEGER");
    }

    this.database.exec(`
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

    // Migration: add epoch column for group message sinceEpoch filtering.
    // NULL means "unknown epoch" (legacy data). SinceEpoch > 0 excludes NULL
    // epochs; sinceEpoch = 0 (or undefined) includes them for backward compat.
    const groupMessagesColumns = this.database
      .prepare("PRAGMA table_info('group_messages')")
      .all() as Array<{ name: string }>;
    if (!groupMessagesColumns.some((col) => col.name === "epoch")) {
      this.database.exec("ALTER TABLE group_messages ADD COLUMN epoch TEXT");
    }

    this.publishKeyPackageStatement = this.database.prepare<
      [string, string, Buffer, number, number, string]
    >(`
      INSERT INTO key_packages (
        stable_pubkey,
        key_package_ref,
        key_package_bytes,
        is_last_resort,
        published_at,
        publication_event_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.listKeyPackagesForIdentityStatement = this.database.prepare<
      [string],
      KeyPackageRow
    >(`
      SELECT id, stable_pubkey, key_package_ref, key_package_bytes, is_last_resort, published_at, publication_event_json
      FROM key_packages
      WHERE stable_pubkey = ?
      ORDER BY id ASC
    `);
    this.listAllKeyPackagesStatement = this.database.prepare<
      [],
      KeyPackageRow
    >(`
      SELECT id, stable_pubkey, key_package_ref, key_package_bytes, is_last_resort, published_at, publication_event_json
      FROM key_packages
      ORDER BY id ASC
    `);
    this.getKeyPackageByRefStatement = this.database.prepare<
      [string],
      KeyPackageRow
    >(`
      SELECT id, stable_pubkey, key_package_ref, key_package_bytes, is_last_resort, published_at, publication_event_json
      FROM key_packages
      WHERE key_package_ref = ?
      LIMIT 1
    `);
    this.consumeKeyPackageByRefStatement = this.database.prepare<
      [string],
      KeyPackageRow & { id: number }
    >(`
      SELECT id, stable_pubkey, key_package_ref, key_package_bytes, is_last_resort, published_at, publication_event_json
      FROM key_packages
      WHERE key_package_ref = ?
      LIMIT 1
    `);
    this.consumeKeyPackageByIdentityStatement = this.database.prepare<
      [string],
      KeyPackageRow & { id: number }
    >(`
      SELECT id, stable_pubkey, key_package_ref, key_package_bytes, is_last_resort, published_at, publication_event_json
      FROM key_packages
      WHERE stable_pubkey = ?
      ORDER BY is_last_resort ASC, CASE WHEN is_last_resort = 0 THEN id END ASC, CASE WHEN is_last_resort = 1 THEN id END DESC
      LIMIT 1
    `);
    this.deleteKeyPackageStatement = this.database.prepare<[number]>(
      "DELETE FROM key_packages WHERE id = ?",
    );
    this.storeWelcomeStatement = this.database.prepare<
      [string, string, Buffer, number, number | null]
    >(`
      INSERT INTO welcomes (
        target_stable_pubkey,
        key_package_reference,
        welcome_bytes,
        created_at,
        read_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    this.markWelcomesReadStatement = this.database.prepare<[number, string]>(`
      UPDATE welcomes
      SET read_at = ?
      WHERE target_stable_pubkey = ? AND read_at IS NULL
    `);
    this.fetchPendingWelcomesStatement = this.database.prepare<
      [string],
      WelcomeRow & { id: number }
    >(`
      SELECT id, target_stable_pubkey, key_package_reference, welcome_bytes, created_at, read_at
      FROM welcomes
      WHERE target_stable_pubkey = ?
      ORDER BY id ASC
    `);
    this.deleteExpiredWelcomesStatement = this.database.prepare<
      [number, number]
    >(
      "DELETE FROM welcomes WHERE (read_at IS NOT NULL AND read_at < ?) OR (read_at IS NULL AND created_at < ?)",
    );
    this.storeJoinRequestStatement = this.database.prepare<
      [string, string, string, number, number | null]
    >(`
      INSERT INTO join_requests (
        group_id,
        requester_stable_pubkey,
        key_package_ref,
        created_at,
        read_at
      ) VALUES (?, ?, ?, ?, ?)
    `);
    this.findUnreadJoinRequestStatement = this.database.prepare<
      [string, string],
      JoinRequestRow & { id: number }
    >(`
      SELECT id, group_id, requester_stable_pubkey, key_package_ref, created_at, read_at
      FROM join_requests
      WHERE group_id = ? AND requester_stable_pubkey = ? AND read_at IS NULL
      LIMIT 1
    `);
    this.markJoinRequestsReadStatement = this.database.prepare<
      [number, string]
    >(`
      UPDATE join_requests
      SET read_at = ?
      WHERE group_id = ? AND read_at IS NULL
    `);
    this.fetchPendingJoinRequestsStatement = this.database.prepare<
      [string],
      JoinRequestRow & { id: number }
    >(`
      SELECT id, group_id, requester_stable_pubkey, key_package_ref, created_at, read_at
      FROM join_requests
      WHERE group_id = ?
      ORDER BY id ASC
    `);
    this.deleteExpiredJoinRequestsStatement = this.database.prepare<
      [number, number]
    >(
      "DELETE FROM join_requests WHERE (read_at IS NOT NULL AND read_at < ?) OR (read_at IS NULL AND created_at < ?)",
    );
    this.countUnreadJoinRequestsStatement = this.database.prepare<
      [string],
      { count: number }
    >(
      "SELECT COUNT(*) as count FROM join_requests WHERE group_id = ? AND read_at IS NULL",
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
      [number, string, string, string, Buffer, number]
    >(`
      INSERT INTO group_messages (
        cursor,
        group_id,
        epoch,
        ephemeral_sender_pubkey,
        opaque_message,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
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
      SELECT cursor, group_id, epoch, ephemeral_sender_pubkey, opaque_message, created_at
      FROM group_messages
      WHERE group_id = ?
      ORDER BY cursor ASC
    `);
    this.fetchGroupMessagesAfterCursorStatement = this.database.prepare<
      [string, number],
      GroupMessageRow
    >(`
      SELECT cursor, group_id, epoch, ephemeral_sender_pubkey, opaque_message, created_at
      FROM group_messages
      WHERE group_id = ? AND cursor > ?
      ORDER BY cursor ASC
    `);
    this.fetchGroupMessagesSinceEpochStatement = this.database.prepare<
      [string, string],
      GroupMessageRow
    >(`
      SELECT cursor, group_id, epoch, ephemeral_sender_pubkey, opaque_message, created_at
      FROM group_messages
      WHERE group_id = ?
        AND epoch IS NOT NULL
        AND CAST(epoch AS INTEGER) >= CAST(? AS INTEGER)
      ORDER BY cursor ASC
    `);
    this.fetchGroupMessagesSinceEpochAfterCursorStatement = this.database
      .prepare<[string, number, string], GroupMessageRow>(`
      SELECT cursor, group_id, epoch, ephemeral_sender_pubkey, opaque_message, created_at
      FROM group_messages
      WHERE group_id = ? AND cursor > ?
        AND epoch IS NOT NULL
        AND CAST(epoch AS INTEGER) >= CAST(? AS INTEGER)
      ORDER BY cursor ASC
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
      (targetStablePubkey: string, now: number) => {
        this.markWelcomesReadStatement.run(now, targetStablePubkey);
        const rows = this.fetchPendingWelcomesStatement.all(targetStablePubkey);
        return rows;
      },
    );

    this.fetchPendingJoinRequestsTransaction = this.database.transaction(
      (groupId: string, now: number) => {
        this.markJoinRequestsReadStatement.run(now, groupId);
        const rows = this.fetchPendingJoinRequestsStatement.all(groupId);
        return rows;
      },
    );

    this.fetchManyPendingJoinRequestsTransaction = this.database.transaction(
      (groupIds: string[], now: number) => {
        if (groupIds.length === 0) {
          return [];
        }
        // Mark all unread requests as read for all requested groups atomically.
        for (const groupId of groupIds) {
          this.markJoinRequestsReadStatement.run(now, groupId);
        }
        // Fetch all requests using the CTE-based statement for ordering.
        const statement = this.getFetchManyPendingJoinRequestsStatement(
          groupIds.length,
        );
        const params = groupIds
          .map((groupId, index) => [index, groupId])
          .flat();
        return statement.all(...params);
      },
    );

    this.storeJoinRequestTransaction = this.database.transaction(
      (record: JoinRequestRecord) => {
        // Cap unread pending join requests per group to prevent unbounded accumulation.
        const countRow = this.countUnreadJoinRequestsStatement.get(
          record.groupId,
        );
        if (countRow && countRow.count >= MAX_PENDING_JOIN_REQUESTS_PER_GROUP) {
          throw new Error("Too many pending join requests for this group");
        }

        const existing = this.findUnreadJoinRequestStatement.get(
          record.groupId,
          record.requesterStablePubkey,
        );
        if (existing) {
          return this.mapJoinRequestRow(existing);
        }

        this.storeJoinRequestStatement.run(
          record.groupId,
          record.requesterStablePubkey,
          record.keyPackageRef,
          record.createdAt,
          record.readAt ?? null,
        );
        return record;
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
          params.epoch.toString(),
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
          epoch: params.epoch,
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
      JSON.stringify(record.publicationEvent),
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
      record.readAt ?? null,
    );

    return record;
  }

  fetchPendingWelcomes(
    targetStablePubkey: string,
    now: number,
  ): WelcomeQueueRecord[] {
    return this.fetchPendingWelcomesTransaction(targetStablePubkey, now).map(
      (row) => this.mapWelcomeRow(row),
    );
  }

  deleteExpiredWelcomes(
    readThreshold: number,
    unreadThreshold: number,
  ): number {
    const result = this.deleteExpiredWelcomesStatement.run(
      readThreshold,
      unreadThreshold,
    );
    return result.changes;
  }

  storeJoinRequest(record: JoinRequestRecord): JoinRequestRecord {
    return this.storeJoinRequestTransaction(record);
  }

  fetchPendingJoinRequests(groupId: string, now: number): JoinRequestRecord[] {
    return this.fetchPendingJoinRequestsTransaction(groupId, now).map((row) =>
      this.mapJoinRequestRow(row),
    );
  }

  fetchManyPendingJoinRequests(
    input: FetchManyPendingJoinRequestsInput,
    now: number,
  ): JoinRequestRecord[] {
    const groupIds = input.groups.map((g) => g.groupId);
    return this.fetchManyPendingJoinRequestsTransaction(groupIds, now).map(
      (row) => this.mapJoinRequestRow(row),
    );
  }

  deleteExpiredJoinRequests(
    readThreshold: number,
    unreadThreshold: number,
  ): number {
    const result = this.deleteExpiredJoinRequestsStatement.run(
      readThreshold,
      unreadThreshold,
    );
    return result.changes;
  }

  appendGroupMessage(params: AppendGroupMessageParams): GroupMessageRecord {
    return this.appendGroupMessageTransaction(params);
  }

  fetchGroupMessages(input: FetchGroupMessagesInput): GroupMessageRecord[] {
    if (input.sinceEpoch !== undefined && input.sinceEpoch > 0n) {
      const sinceEpochStr = input.sinceEpoch.toString();
      const rows =
        input.afterCursor === undefined
          ? this.fetchGroupMessagesSinceEpochStatement.all(
              input.groupId,
              sinceEpochStr,
            )
          : this.fetchGroupMessagesSinceEpochAfterCursorStatement.all(
              input.groupId,
              input.afterCursor,
              sinceEpochStr,
            );
      return rows.map((row) => this.mapGroupMessageRow(row));
    }

    const rows =
      input.afterCursor === undefined
        ? this.fetchGroupMessagesStatement.all(input.groupId)
        : this.fetchGroupMessagesAfterCursorStatement.all(
            input.groupId,
            input.afterCursor,
          );

    return rows.map((row) => this.mapGroupMessageRow(row));
  }

  fetchManyGroupMessages(
    input: FetchManyGroupMessagesInput,
  ): GroupMessageRecord[] {
    if (input.groups.length === 0) {
      return [];
    }

    const statement = this.getFetchManyGroupMessagesStatement(
      input.groups.length,
    );
    const params = input.groups.flatMap((group, index) => [
      index,
      group.groupId,
      group.afterCursor ?? 0,
      group.sinceEpoch !== undefined && group.sinceEpoch > 0n
        ? group.sinceEpoch.toString()
        : "0",
    ]);
    const rows = statement.all(...params);

    return rows.map((row) => this.mapGroupMessageRow(row));
  }

  private getFetchManyGroupMessagesStatement(
    groupCount: number,
  ): Database.Statement<unknown[], GroupMessageRow> {
    const cached = this.fetchManyGroupMessagesStatements.get(groupCount);
    if (cached) {
      return cached;
    }

    const values = Array.from(
      { length: groupCount },
      () => "(?, ?, ?, ?)",
    ).join(", ");
    const statement = this.database.prepare<unknown[], GroupMessageRow>(`
        WITH requested(group_order, group_id, after_cursor, since_epoch) AS (
          VALUES ${values}
        )
        SELECT gm.cursor, gm.group_id, gm.epoch, gm.ephemeral_sender_pubkey, gm.opaque_message, gm.created_at
        FROM requested r
        JOIN group_messages gm
          ON gm.group_id = r.group_id
         AND gm.cursor > r.after_cursor
         AND (
           CAST(r.since_epoch AS INTEGER) = 0
           OR gm.epoch IS NOT NULL AND CAST(gm.epoch AS INTEGER) >= CAST(r.since_epoch AS INTEGER)
         )
        ORDER BY r.group_order ASC, gm.cursor ASC
      `);

    this.fetchManyGroupMessagesStatements.set(groupCount, statement);
    return statement;
  }

  private getFetchManyPendingJoinRequestsStatement(
    groupCount: number,
  ): Database.Statement<unknown[], JoinRequestRow & { id: number }> {
    const cached = this.fetchManyPendingJoinRequestsStatements.get(groupCount);
    if (cached) {
      return cached;
    }

    const values = Array.from({ length: groupCount }, () => "(?, ?)").join(
      ", ",
    );
    const statement = this.database.prepare<
      unknown[],
      JoinRequestRow & { id: number }
    >(`
        WITH requested(group_order, group_id) AS (
          VALUES ${values}
        )
        SELECT jr.id, jr.group_id, jr.requester_stable_pubkey, jr.key_package_ref, jr.created_at, jr.read_at
        FROM requested r
        JOIN join_requests jr
          ON jr.group_id = r.group_id
        ORDER BY r.group_order ASC, jr.id ASC
      `);

    this.fetchManyPendingJoinRequestsStatements.set(groupCount, statement);
    return statement;
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
      publicationEvent: JSON.parse(row.publication_event_json),
    };
  }

  private mapWelcomeRow(row: WelcomeRow): WelcomeQueueRecord {
    return {
      targetStablePubkey: row.target_stable_pubkey,
      keyPackageReference: row.key_package_reference,
      welcome: decodeWelcome(toUint8Array(row.welcome_bytes)),
      createdAt: row.created_at,
      readAt: row.read_at,
    };
  }

  private mapJoinRequestRow(row: JoinRequestRow): JoinRequestRecord {
    return {
      groupId: row.group_id,
      requesterStablePubkey: row.requester_stable_pubkey,
      keyPackageRef: row.key_package_ref,
      createdAt: row.created_at,
      readAt: row.read_at,
    };
  }

  private mapGroupMessageRow(row: GroupMessageRow): GroupMessageRecord {
    return {
      cursor: row.cursor,
      groupId: row.group_id,
      epoch: row.epoch !== null ? BigInt(row.epoch) : 0n,
      ephemeralSenderPubkey: row.ephemeral_sender_pubkey,
      opaqueMessage: toUint8Array(row.opaque_message),
      createdAt: row.created_at,
    };
  }
}
