import type { ClientState, KeyPackage, PrivateKeyPackage } from "ts-mls";

import type { PendingWelcome } from "../contracts/index.ts";
import type { CordnGroupMetadata } from "./groupMetadata.ts";

export interface CliSessionOptions {
  privateKey?: string;
  serverPubkey?: string;
  relays?: string[];
  relayHandler?: import("@contextvm/sdk").RelayHandler;
}

export interface SessionStatus {
  stablePubkey: string;
  keyPackageCount: number;
  welcomeCount: number;
  groupCount: number;
}

export interface StoredKeyPackage {
  alias: string;
  keyPackage: KeyPackage;
  privateKeyPackage: PrivateKeyPackage;
  keyPackageRef: string;
  keyPackageBase64: string;
  publishedAt?: number;
  consumed: boolean;
}

export interface KeyPackageSummary {
  alias?: string;
  stablePubkey: string;
  keyPackageRef: string;
  publishedAt?: number;
  consumed?: boolean;
  supportsGroupMetadata: boolean;
}

export interface StoredMessage {
  cursor: number;
  createdAt: number;
  direction: "inbound" | "outbound";
  sender: string;
  plaintext: string;
}

export interface SyncIssue {
  cursor: number;
  createdAt: number;
  detail: string;
}

export interface GroupSessionState {
  alias: string;
  state: ClientState;
  metadata?: CordnGroupMetadata;
  lastCursor: number;
  fetchCursor: number;
  messages: StoredMessage[];
  syncIssues: SyncIssue[];
}

export interface CreateGroupOptions {
  groupId?: string;
  keyPackageAlias?: string;
  metadata?: CordnGroupMetadata;
}

export interface ConversationView {
  synced: StoredMessage[];
  messages: StoredMessage[];
}

export type StoredWelcome = PendingWelcome;
