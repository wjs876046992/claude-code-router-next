/**
 * Fallback Promotion Cache
 *
 * When a primary model fails and fallback succeeds, we "promote" the fallback model
 * so subsequent requests skip the failing primary entirely until TTL expires or
 * the promoted model becomes unhealthy.
 */

import { getHealthStore } from "../services/provider-health";

export interface FallbackPromotionConfig {
  enabled?: boolean;
  ttlMinutes?: number;
}

interface PromotionEntry {
  promotedModel: string;
  timestamp: number;
  ttlMs: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Fallback Promotion Store
 * Tracks successful fallback promotions to avoid retrying failing primaries
 */
class FallbackPromotionStore {
  private promotions: Map<string, PromotionEntry> = new Map();
  private enabled: boolean = true;
  private ttlMs: number = DEFAULT_TTL_MS;

  configure(config?: FallbackPromotionConfig): void {
    if (config?.enabled !== undefined) {
      this.enabled = config.enabled;
    }
    if (config?.ttlMinutes !== undefined) {
      this.ttlMs = config.ttlMinutes * 60 * 1000;
    }
  }

  /**
   * Generate a cache key for a primary model
   * Format: ${provider},${model}:${scenarioType}
   */
  private getKey(provider: string, model: string, scenarioType: string): string {
    return `${provider},${model}:${scenarioType}`;
  }

  /**
   * Promote a fallback model for a failing primary
   * After this, all clients will use the promoted model until TTL expires
   */
  promote(
    provider: string,
    model: string,
    scenarioType: string,
    fallbackProvider: string,
    fallbackModel: string,
    ttlMs?: number
  ): void {
    if (!this.enabled) return;

    const key = this.getKey(provider, model, scenarioType);
    const promotedModel = `${fallbackProvider},${fallbackModel}`;

    this.promotions.set(key, {
      promotedModel,
      timestamp: Date.now(),
      ttlMs: ttlMs ?? this.ttlMs,
    });
  }

  /**
   * Get the promoted model for a primary, if one exists and is valid
   * Returns null if: disabled, no promotion, expired, or promoted model unhealthy
   */
  getPromotion(
    provider: string,
    model: string,
    scenarioType: string,
    providers: any[]
  ): string | null {
    if (!this.enabled) return null;

    const key = this.getKey(provider, model, scenarioType);
    const entry = this.promotions.get(key);

    if (!entry) return null;

    // Check TTL expiration
    const elapsed = Date.now() - entry.timestamp;
    if (elapsed >= entry.ttlMs) {
      this.promotions.delete(key);
      return null;
    }

    // Check if promoted model is still healthy
    const [promotedProvider, ...promotedModelParts] = entry.promotedModel.split(",");
    const promotedModelName = promotedModelParts.join(",");

    const healthStore = getHealthStore();
    if (!healthStore.isAvailable(promotedProvider, promotedModelName)) {
      // Promoted model is now unhealthy, clear the promotion
      this.promotions.delete(key);
      return null;
    }

    // Verify the promoted model exists in providers
    const finalProvider = providers.find(
      (p: any) => p.name.toLowerCase() === promotedProvider.toLowerCase()
    );
    const finalModel = finalProvider?.models?.find(
      (m: any) => String(m).toLowerCase() === promotedModelName.toLowerCase()
    );

    if (!finalProvider || !finalModel) {
      // Provider/model no longer exists, clear promotion
      this.promotions.delete(key);
      return null;
    }

    return `${finalProvider.name},${finalModel}`;
  }

  /**
   * Clear a specific promotion
   */
  clear(provider: string, model: string, scenarioType: string): void {
    const key = this.getKey(provider, model, scenarioType);
    this.promotions.delete(key);
  }

  /**
   * Clear all promotions for a specific primary model
   * Called when a model recovers to closed (healthy) state
   * @returns number of promotions cleared
   */
  clearByPrimary(provider: string, model: string): number {
    const prefix = `${provider},${model}:`;
    let count = 0;
    for (const key of this.promotions.keys()) {
      if (key.startsWith(prefix)) {
        this.promotions.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Clear all promotions
   */
  clearAll(): void {
    this.promotions.clear();
  }

  /**
   * Clear expired promotions (cleanup utility)
   */
  clearExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.promotions) {
      if (now - entry.timestamp >= entry.ttlMs) {
        this.promotions.delete(key);
      }
    }
  }

  /**
   * Get all active promotions (for debugging/monitoring)
   */
  getAllPromotions(): Array<{ key: string; promotedModel: string; remainingMs: number }> {
    const now = Date.now();
    const result: Array<{ key: string; promotedModel: string; remainingMs: number }> = [];

    for (const [key, entry] of this.promotions) {
      const remainingMs = entry.ttlMs - (now - entry.timestamp);
      if (remainingMs > 0) {
        result.push({
          key,
          promotedModel: entry.promotedModel,
          remainingMs,
        });
      }
    }

    return result;
  }
}

// Singleton instance
let globalFallbackPromotionStore: FallbackPromotionStore | null = null;

export function getFallbackPromotionStore(config?: FallbackPromotionConfig): FallbackPromotionStore {
  if (!globalFallbackPromotionStore) {
    globalFallbackPromotionStore = new FallbackPromotionStore();
    if (config) {
      globalFallbackPromotionStore.configure(config);
    }
  }
  return globalFallbackPromotionStore;
}

export function resetFallbackPromotionStore(): void {
  if (globalFallbackPromotionStore) {
    globalFallbackPromotionStore.clearAll();
    globalFallbackPromotionStore = null;
  }
}