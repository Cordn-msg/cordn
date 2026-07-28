export interface TokenBucketRateLimitConfig {
  enabled: boolean;
  refillPerMinute: number;
  burst: number;
  idleTtlMs: number;
}

interface TokenBucketState {
  tokens: number;
  lastRefillAt: number;
  lastSeenAt: number;
}

function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, TokenBucketState>();
  private readonly enabled: boolean;
  private readonly burst: number;
  private readonly idleTtlMs: number;
  private readonly refillTokensPerMs: number;

  constructor(config: TokenBucketRateLimitConfig) {
    this.enabled = config.enabled;
    this.burst = clampNonNegative(config.burst);
    this.idleTtlMs = clampNonNegative(config.idleTtlMs);
    this.refillTokensPerMs = clampNonNegative(config.refillPerMinute) / 60_000;
  }

  check(key: string, now: number = Date.now()): boolean {
    if (!this.enabled) {
      return true;
    }

    this.evictIdleBuckets(now);

    const bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.burst < 1) {
        return false;
      }

      this.buckets.set(key, {
        tokens: this.burst - 1,
        lastRefillAt: now,
        lastSeenAt: now,
      });
      return true;
    }

    const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
    const refilledTokens = elapsedMs * this.refillTokensPerMs;
    const availableTokens = Math.min(
      this.burst,
      bucket.tokens + refilledTokens,
    );

    bucket.lastRefillAt = now;
    bucket.lastSeenAt = now;

    if (availableTokens < 1) {
      bucket.tokens = availableTokens;
      return false;
    }

    bucket.tokens = availableTokens - 1;
    return true;
  }

  private evictIdleBuckets(now: number): void {
    if (this.idleTtlMs <= 0 || this.buckets.size === 0) {
      return;
    }

    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.lastSeenAt >= this.idleTtlMs) {
        this.buckets.delete(key);
      }
    }
  }
}
