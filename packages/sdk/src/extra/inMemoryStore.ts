import type { KeyValueStore } from "../storage.ts";

/** Default in-memory {@link KeyValueStore}. Useful for tests and ephemeral sessions. */
export class InMemoryKeyValueStore<T> implements KeyValueStore<T> {
  private readonly entries = new Map<string, T>();

  async getItem(key: string): Promise<T | null> {
    return this.entries.get(key) ?? null;
  }

  async setItem(key: string, value: T): Promise<T> {
    this.entries.set(key, value);
    return value;
  }

  async removeItem(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }

  async keys(): Promise<string[]> {
    return [...this.entries.keys()];
  }
}
