import Database from "better-sqlite3";
import {
  decodeKeyPackage,
  decodeWelcome,
  encodeKeyPackage,
  encodeWelcome,
} from "../../mlsCodec.ts";

import type {
  ConsumedJoinRequestRef,
  ConsumedWelcomeRef,
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
  partitionConsumedJoinRequests,
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
  join_after_cursor: number | null;
}

interface JoinRequestRow {
  group_id: string;
  requester_stable_pubkey: string;
  key_package_ref: string;
  created_at: number;
}

interface GroupMessageRow {
  cursor: number;
  group_id: string;
  opaque_message: Buffer;
  created_at: number;
}

interface GroupRoutingRow {
  group_id: string;
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
  private readonly fetchPendingWelcomesStatement: Database.Statement<
    [string],
    WelcomeRow & { id: number }
  >;
  private readonly deleteExpiredWelcomesStatement: Database.Statement<[number]>;
  private readonly storeJoinRequestStatement: Database.Statement<
    [string, string, string, number]
  >;
  private readonly updateJoinRequestOnReRequestStatement: Database.Statement<
    [string, number, string, string]
  >;
  private readonly findPendingJoinRequestStatement: Database.Statement<
    [string, string],
    JoinRequestRow & { id: number }
  >;
  private readonly fetchPendingJoinRequestsStatement: Database.Statement<
    [string],
    JoinRequestRow & { id: number }
  >;
  private readonly deleteExpiredJoinRequestsStatement: Database.Statement<
    [number]
  >;
  private readonly deleteConsumedWelcomeStatement: Database.Statement<
    [string, string, number]
  >;
  private readonly deleteConsumedJoinRequestStatement: Database.Statement<
    [string, string, number]
  >;
  private readonly countJoinRequestsStatement: Database.Statement<
    [string],
    { count: number }
  >;
  private readonly upsertGroupRoutingStatement: Database.Statement<
    [string, number]
  >;
  private readonly selectGroupRoutingStatement: Database.Statement<
    [string],
    GroupRoutingRow
  >;
  private readonly insertGroupMessageStatement: Database.Statement<
    [number, string, Buffer, number]
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
    consumed?: ConsumedWelcomeRef[],
  ) => WelcomeRow[];
  private readonly fetchPendingJoinRequestsTransaction: (
    groupId: string,
    consumed?: ConsumedJoinRequestRef[],
  ) => JoinRequestRow[];
  private readonly fetchManyPendingJoinRequestsTransaction: (
    groupIds: string[],
    consumedByGroup?: Map<string, ConsumedJoinRequestRef[]>,
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
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_welcomes_target_order
      ON welcomes (target_stable_pubkey, id);

      CREATE TABLE IF NOT EXISTS join_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        requester_stable_pubkey TEXT NOT NULL,
        key_package_ref TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_join_requests_group_order
      ON join_requests (group_id, id);
    `);

    // Migration: add join_after_cursor column for efficient post-join sync.
    // (Legacy read_at columns on welcomes and join_requests are intentionally
    // not created on fresh databases — observation no longer tracks a read
    // timestamp under the consumed-ack retirement model. Existing databases
    // keep their read_at columns harmlessly ignored.)
    const welcomesColumns = this.database
      .prepare("PRAGMA table_info('welcomes')")
      .all() as Array<{ name: string }>;
    if (!welcomesColumns.some((col) => col.name === "join_after_cursor")) {
      this.database.exec(
        "ALTER TABLE welcomes ADD COLUMN join_after_cursor INTEGER",
      );
    }

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS group_routing (
        group_id TEXT PRIMARY KEY,
        last_message_cursor INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cursor INTEGER NOT NULL,
        group_id TEXT NOT NULL,
        opaque_message BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_group_messages_group_cursor_unique
      ON group_messages (group_id, cursor);

      CREATE INDEX IF NOT EXISTS idx_group_messages_group_cursor
      ON group_messages (group_id, cursor);
    `);

    const groupMessagesColumns = this.database
      .prepare("PRAGMA table_info('group_messages')")
      .all() as Array<{ name: string }>;
    // Migration: drop the ephemeral_sender_pubkey column. It was a
    // session-scoped transport handle the coordinator never read (routing
    // is by gid, rate-limiting uses the caller identity at call time).
    if (
      groupMessagesColumns.some((col) => col.name === "ephemeral_sender_pubkey")
    ) {
      this.database.exec(
        "ALTER TABLE group_messages DROP COLUMN ephemeral_sender_pubkey",
      );
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
        join_after_cursor
      ) VALUES (?, ?, ?, ?, ?)
    `);
    this.fetchPendingWelcomesStatement = this.database.prepare<
      [string],
      WelcomeRow & { id: number }
    >(`
      SELECT id, target_stable_pubkey, key_package_reference, welcome_bytes, created_at, join_after_cursor
      FROM welcomes
      WHERE target_stable_pubkey = ?
      ORDER BY id ASC
    `);
    this.deleteExpiredWelcomesStatement = this.database.prepare<[number]>(
      "DELETE FROM welcomes WHERE created_at < ?",
    );
    this.deleteConsumedWelcomeStatement = this.database.prepare<
      [string, string, number]
    >(
      "DELETE FROM welcomes WHERE target_stable_pubkey = ? AND key_package_reference = ? AND created_at = ?",
    );
    this.storeJoinRequestStatement = this.database.prepare<
      [string, string, string, number]
    >(`
      INSERT INTO join_requests (
        group_id,
        requester_stable_pubkey,
        key_package_ref,
        created_at
      ) VALUES (?, ?, ?, ?)
    `);
    // ponytail: refresh-in-place on re-request. The consume-ack model retires
    // rows by (group, requester, createdAt), so a re-request must bump
    // createdAt (evading an admin's already-recorded consume ref) and update
    // keyPackageRef (so the admin accepts with the requester's current key
    // package). Without this a re-request silently returns the stale row and
    // the admin's next fetch consumes it away — making the user send twice.
    this.updateJoinRequestOnReRequestStatement = this.database.prepare<
      [string, number, string, string]
    >(
      "UPDATE join_requests SET key_package_ref = ?, created_at = ? WHERE group_id = ? AND requester_stable_pubkey = ?",
    );
    this.findPendingJoinRequestStatement = this.database.prepare<
      [string, string],
      JoinRequestRow & { id: number }
    >(`
      SELECT id, group_id, requester_stable_pubkey, key_package_ref, created_at
      FROM join_requests
      WHERE group_id = ? AND requester_stable_pubkey = ?
      LIMIT 1
    `);
    this.fetchPendingJoinRequestsStatement = this.database.prepare<
      [string],
      JoinRequestRow & { id: number }
    >(`
      SELECT id, group_id, requester_stable_pubkey, key_package_ref, created_at
      FROM join_requests
      WHERE group_id = ?
      ORDER BY id ASC
    `);
    this.deleteExpiredJoinRequestsStatement = this.database.prepare<[number]>(
      "DELETE FROM join_requests WHERE created_at < ?",
    );
    this.deleteConsumedJoinRequestStatement = this.database.prepare<
      [string, string, number]
    >(
      "DELETE FROM join_requests WHERE group_id = ? AND requester_stable_pubkey = ? AND created_at = ?",
    );
    this.countJoinRequestsStatement = this.database.prepare<
      [string],
      { count: number }
    >("SELECT COUNT(*) as count FROM join_requests WHERE group_id = ?");
    this.upsertGroupRoutingStatement = this.database.prepare<[string, number]>(`
      INSERT INTO group_routing (group_id, last_message_cursor)
      VALUES (?, ?)
      ON CONFLICT(group_id) DO UPDATE SET
        last_message_cursor = excluded.last_message_cursor
    `);
    this.selectGroupRoutingStatement = this.database.prepare<
      [string],
      GroupRoutingRow
    >(`
      SELECT group_id, last_message_cursor
      FROM group_routing
      WHERE group_id = ?
      LIMIT 1
    `);
    this.insertGroupMessageStatement = this.database.prepare<
      [number, string, Buffer, number]
    >(`
      INSERT INTO group_messages (cursor, group_id, opaque_message, created_at)
      VALUES (?, ?, ?, ?)
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
      SELECT cursor, group_id, opaque_message, created_at
      FROM group_messages
      WHERE group_id = ?
      ORDER BY cursor ASC
    `);
    this.fetchGroupMessagesAfterCursorStatement = this.database.prepare<
      [string, number],
      GroupMessageRow
    >(`
      SELECT cursor, group_id, opaque_message, created_at
      FROM group_messages
      WHERE group_id = ? AND cursor > ?
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
      (targetStablePubkey: string, consumed?: ConsumedWelcomeRef[]) => {
        for (const item of consumed ?? []) {
          this.deleteConsumedWelcomeStatement.run(
            targetStablePubkey,
            item.keyPackageReference,
            item.createdAt,
          );
        }
        return this.fetchPendingWelcomesStatement.all(targetStablePubkey);
      },
    );

    this.fetchPendingJoinRequestsTransaction = this.database.transaction(
      (groupId: string, consumed?: ConsumedJoinRequestRef[]) => {
        for (const item of consumed ?? []) {
          this.deleteConsumedJoinRequestStatement.run(
            groupId,
            item.requesterStablePubkey,
            item.createdAt,
          );
        }
        return this.fetchPendingJoinRequestsStatement.all(groupId);
      },
    );

    this.fetchManyPendingJoinRequestsTransaction = this.database.transaction(
      (
        groupIds: string[],
        consumedByGroup?: Map<string, ConsumedJoinRequestRef[]>,
      ) => {
        if (groupIds.length === 0) {
          return [];
        }
        // Retire consumed requests for each group before the fetch.
        for (const groupId of groupIds) {
          for (const item of consumedByGroup?.get(groupId) ?? []) {
            this.deleteConsumedJoinRequestStatement.run(
              groupId,
              item.requesterStablePubkey,
              item.createdAt,
            );
          }
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
        // Cap pending join requests per group to prevent unbounded accumulation.
        const existing = this.findPendingJoinRequestStatement.get(
          record.groupId,
          record.requesterStablePubkey,
        );
        if (existing) {
          // Re-request: refresh in place (see updateJoinRequestOnReRequestStatement).
          this.updateJoinRequestOnReRequestStatement.run(
            record.keyPackageRef,
            record.createdAt,
            record.groupId,
            record.requesterStablePubkey,
          );
          return record;
        }

        // New row — enforce the per-group cap only on the insert path. A
        // refresh above doesn't add a row, so it must not hit the cap.
        const countRow = this.countJoinRequestsStatement.get(record.groupId);
        if (countRow && countRow.count >= MAX_PENDING_JOIN_REQUESTS_PER_GROUP) {
          throw new Error("Too many pending join requests for this group");
        }

        this.storeJoinRequestStatement.run(
          record.groupId,
          record.requesterStablePubkey,
          record.keyPackageRef,
          record.createdAt,
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
          Buffer.from(params.opaqueMessage),
          params.createdAt,
        );

        this.upsertGroupRoutingStatement.run(params.groupId, cursor);

        return {
          cursor,
          groupId: params.groupId,
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
      record.joinAfterCursor ?? null,
    );

    return record;
  }

  fetchPendingWelcomes(
    targetStablePubkey: string,
    consumed?: ConsumedWelcomeRef[],
  ): WelcomeQueueRecord[] {
    return this.fetchPendingWelcomesTransaction(
      targetStablePubkey,
      consumed,
    ).map((row) => this.mapWelcomeRow(row));
  }

  deleteExpiredWelcomes(maxAgeThreshold: number): number {
    if (maxAgeThreshold <= 0) {
      return 0;
    }
    const result = this.deleteExpiredWelcomesStatement.run(maxAgeThreshold);
    return result.changes;
  }

  storeJoinRequest(record: JoinRequestRecord): JoinRequestRecord {
    return this.storeJoinRequestTransaction(record);
  }

  fetchPendingJoinRequests(
    groupId: string,
    consumed?: ConsumedJoinRequestRef[],
  ): JoinRequestRecord[] {
    return this.fetchPendingJoinRequestsTransaction(groupId, consumed).map(
      (row) => this.mapJoinRequestRow(row),
    );
  }

  fetchManyPendingJoinRequests(
    input: FetchManyPendingJoinRequestsInput,
  ): JoinRequestRecord[] {
    const groupIds = input.groups.map((g) => g.groupId);
    const consumedByGroup = partitionConsumedJoinRequests(input.consumed);
    return this.fetchManyPendingJoinRequestsTransaction(
      groupIds,
      consumedByGroup,
    ).map((row) => this.mapJoinRequestRow(row));
  }

  deleteExpiredJoinRequests(maxAgeThreshold: number): number {
    if (maxAgeThreshold <= 0) {
      return 0;
    }
    const result = this.deleteExpiredJoinRequestsStatement.run(maxAgeThreshold);
    return result.changes;
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

    const values = Array.from({ length: groupCount }, () => "(?, ?, ?)").join(
      ", ",
    );
    const statement = this.database.prepare<unknown[], GroupMessageRow>(`
        WITH requested(group_order, group_id, after_cursor) AS (
          VALUES ${values}
        )
        SELECT gm.cursor, gm.group_id, gm.opaque_message, gm.created_at
        FROM requested r
        JOIN group_messages gm
          ON gm.group_id = r.group_id
         AND gm.cursor > r.after_cursor
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
        SELECT jr.id, jr.group_id, jr.requester_stable_pubkey, jr.key_package_ref, jr.created_at
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
      joinAfterCursor: row.join_after_cursor ?? undefined,
    };
  }

  private mapJoinRequestRow(row: JoinRequestRow): JoinRequestRecord {
    return {
      groupId: row.group_id,
      requesterStablePubkey: row.requester_stable_pubkey,
      keyPackageRef: row.key_package_ref,
      createdAt: row.created_at,
    };
  }

  private mapGroupMessageRow(row: GroupMessageRow): GroupMessageRecord {
    return {
      cursor: row.cursor,
      groupId: row.group_id,
      opaqueMessage: toUint8Array(row.opaque_message),
      createdAt: row.created_at,
    };
  }
}
