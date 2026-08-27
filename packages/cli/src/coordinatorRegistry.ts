import type { NostrTransportOptions, RelayHandler } from "@contextvm/sdk";

import { cordnClient } from "./coordinatorClient.ts";

export interface CoordinatorTarget {
  serverPubkey: string;
  relays?: string[];
  relayHandler?: RelayHandler;
}

export interface CoordinatorRegistryOptions extends Partial<NostrTransportOptions> {
  privateKey?: string;
  ephemeralPrivateKey?: string;
  relays?: string[];
  relayHandler?: RelayHandler;
  serverPubkey?: string;
  defaultCoordinator?: CoordinatorTarget;
  coordinators?: Record<string, CoordinatorTarget>;
}

function normalizeRelays(relays?: string[]): string[] {
  return [...(relays ?? cordnClient.DEFAULT_RELAYS)].sort();
}

function coordinatorTargetsMatch(
  left: CoordinatorTarget,
  right: CoordinatorTarget,
): boolean {
  if (left.serverPubkey !== right.serverPubkey) {
    return false;
  }

  if (left.relayHandler || right.relayHandler) {
    return left.relayHandler === right.relayHandler;
  }

  const leftRelays = normalizeRelays(left.relays);
  const rightRelays = normalizeRelays(right.relays);
  return JSON.stringify(leftRelays) === JSON.stringify(rightRelays);
}

export class CoordinatorClientRegistry {
  private readonly options: CoordinatorRegistryOptions;
  private readonly defaultCoordinatorPubkey: string;
  private readonly targets = new Map<string, CoordinatorTarget>();
  private readonly clients = new Map<string, cordnClient>();

  constructor(options: CoordinatorRegistryOptions = {}) {
    this.options = options;

    const defaultCoordinator =
      options.defaultCoordinator ??
      (options.serverPubkey
        ? {
            serverPubkey: options.serverPubkey,
            relays: options.relays,
            relayHandler: options.relayHandler,
          }
        : undefined);

    if (!defaultCoordinator) {
      throw new Error(
        "Missing default coordinator configuration. Provide serverPubkey or defaultCoordinator when creating the CLI session.",
      );
    }

    this.defaultCoordinatorPubkey = defaultCoordinator.serverPubkey;
    this.register(defaultCoordinator);

    for (const coordinator of Object.values(options.coordinators ?? {})) {
      this.register(coordinator);
    }
  }

  get defaultCoordinatorKey(): string {
    return this.defaultCoordinatorPubkey;
  }

  get defaultCoordinatorTarget(): CoordinatorTarget {
    const target = this.getTarget(this.defaultCoordinatorPubkey);
    return {
      serverPubkey: target.serverPubkey,
      ...(target.relays ? { relays: [...target.relays] } : {}),
    };
  }

  register(target: CoordinatorTarget): string {
    const key = target.serverPubkey;
    const existing = this.targets.get(key);

    if (existing && !coordinatorTargetsMatch(existing, target)) {
      throw new Error(
        `Conflicting coordinator configuration for pubkey: ${key}`,
      );
    }

    this.targets.set(key, {
      serverPubkey: target.serverPubkey,
      relays: target.relays,
      relayHandler: target.relayHandler,
    });

    return key;
  }

  getTarget(key?: string): CoordinatorTarget {
    const resolvedKey = key ?? this.defaultCoordinatorKey;
    const target = this.targets.get(resolvedKey);

    if (!target) {
      return {
        serverPubkey: resolvedKey,
        relays: this.options.relays,
        relayHandler: this.options.relayHandler,
      };
    }

    return target;
  }

  getClient(key?: string): cordnClient {
    const target = this.getTarget(key);
    const cacheKey = target.serverPubkey;
    const existing = this.clients.get(cacheKey);

    if (existing) {
      return existing;
    }

    const {
      defaultCoordinator: _,
      coordinators: __,
      serverPubkey: ___,
      relays: ____,
      relayHandler: _____,
      ...clientOptions
    } = this.options;

    const client = new cordnClient({
      ...clientOptions,
      serverPubkey: target.serverPubkey,
      relays: target.relays,
      relayHandler: target.relayHandler,
    });

    this.clients.set(cacheKey, client);
    return client;
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled(
      [...this.clients.values()].map((client) => client.disconnect()),
    );
    this.clients.clear();
  }
}
