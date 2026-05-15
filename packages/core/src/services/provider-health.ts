/**
 * Provider health state for circuit breaker pattern
 */
export interface ProviderHealthState {
  provider: string;
  model: string;
  status: 'closed' | 'open' | 'half-open';
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
  lastProbeTime: number;
  lastError?: string;
}

/**
 * Configuration for health pool behavior
 */
export interface HealthPoolConfig {
  enabled?: boolean;
  failureThreshold?: number;
  probeIntervalMinutes?: number;
  halfOpenSuccessThreshold?: number;
}

const DEFAULT_CONFIG: Required<HealthPoolConfig> = {
  enabled: true,
  failureThreshold: 3,
  probeIntervalMinutes: 5,
  halfOpenSuccessThreshold: 2,
};

/**
 * Provider health store implementing circuit breaker pattern
 * Tracks provider/model health and manages state transitions
 */
export class ProviderHealthStore {
  private states: Map<string, ProviderHealthState> = new Map();
  private config: Required<HealthPoolConfig>;
  private probeTimer?: NodeJS.Timeout;

  constructor(config?: HealthPoolConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private getKey(provider: string, model: string): string {
    return `${provider},${model}`;
  }

  /**
   * Record a successful request
   * Transitions: open -> half-open (if probe), half-open -> closed (if threshold reached)
   */
  recordSuccess(provider: string, model: string): void {
    if (!this.config.enabled) return;

    const key = this.getKey(provider, model);
    let state = this.states.get(key);

    if (!state) {
      return; // No state means model is healthy (closed)
    }

    state.successCount++;

    if (state.status === 'half-open') {
      if (state.successCount >= this.config.halfOpenSuccessThreshold) {
        // Transition to closed (fully healthy)
        this.states.delete(key);
      }
    } else if (state.status === 'open') {
      // This is a probe success
      state.status = 'half-open';
      state.successCount = 1;
      state.failureCount = 0;
    }
  }

  /**
   * Record a failed request
   * Transitions: closed -> open (if threshold), half-open -> open (immediate)
   */
  recordFailure(provider: string, model: string, error?: string): void {
    if (!this.config.enabled) return;

    const key = this.getKey(provider, model);
    let state = this.states.get(key);

    if (!state) {
      // New failure tracking - start from closed state
      state = {
        provider,
        model,
        status: 'closed',
        failureCount: 0,
        successCount: 0,
        lastFailureTime: 0,
        lastProbeTime: 0,
      };
      this.states.set(key, state);
    }

    state.failureCount++;
    state.lastFailureTime = Date.now();
    state.lastError = error;

    if (state.status === 'half-open') {
      // Immediate transition back to open on any failure in half-open
      state.status = 'open';
      state.successCount = 0;
      state.lastProbeTime = 0;
    } else if (state.status === 'closed' && state.failureCount >= this.config.failureThreshold) {
      // Transition to open (fail pool)
      state.status = 'open';
      state.lastProbeTime = 0;
    }
  }

  /**
   * Get current health state for a provider/model
   */
  getState(provider: string, model: string): ProviderHealthState | undefined {
    return this.states.get(this.getKey(provider, model));
  }

  /**
   * Check if a provider/model is available for routing
   * closed = available, half-open = available (lower priority), open = unavailable
   */
  isAvailable(provider: string, model: string): boolean {
    if (!this.config.enabled) return true;

    const state = this.getState(provider, model);
    if (!state) return true; // No state = closed (healthy)
    return state.status !== 'open';
  }

  /**
   * Get health status priority for sorting
   * Returns: 0 = closed (best), 1 = half-open (ok), 2 = open (worst)
   */
  getPriority(provider: string, model: string): number {
    if (!this.config.enabled) return 0;

    const state = this.getState(provider, model);
    if (!state) return 0;
    switch (state.status) {
      case 'closed': return 0;
      case 'half-open': return 1;
      case 'open': return 2;
    }
  }

  /**
   * Get all models that are healthy (closed status)
   */
  getHealthyModels(): string[] {
    const healthy: string[] = [];
    // Models without state entry are healthy
    // We can't enumerate all models, so this returns empty
    // Router should check isAvailable() for each candidate instead
    return healthy;
  }

  /**
   * Get all models in fail pool (open status)
   */
  getFailPoolModels(): string[] {
    const failed: string[] = [];
    for (const [key, state] of this.states) {
      if (state.status === 'open') {
        failed.push(key);
      }
    }
    return failed;
  }

  /**
   * Get all models in half-open state
   */
  getHalfOpenModels(): string[] {
    const halfOpen: string[] = [];
    for (const [key, state] of this.states) {
      if (state.status === 'half-open') {
        halfOpen.push(key);
      }
    }
    return halfOpen;
  }

  /**
   * Check if probe is needed for an open state
   * Returns true if probeInterval has elapsed since last probe
   */
  needsProbe(state: ProviderHealthState): boolean {
    const elapsed = Date.now() - state.lastProbeTime;
    return elapsed >= this.config.probeIntervalMinutes * 60 * 1000;
  }

  /**
   * Mark that a probe attempt has been made
   */
  markProbeAttempt(provider: string, model: string): void {
    const key = this.getKey(provider, model);
    const state = this.states.get(key);
    if (state && state.status === 'open') {
      state.lastProbeTime = Date.now();
    }
  }

  /**
   * Clear all health state (for testing or manual reset)
   */
  clear(): void {
    this.states.clear();
  }

  /**
   * Get all states for debugging/monitoring
   */
  getAllStates(): ProviderHealthState[] {
    return Array.from(this.states.values());
  }

  /**
   * Stop probe timer
   */
  stopProbeTimer(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = undefined;
    }
  }
}

// Singleton instance
let globalHealthStore: ProviderHealthStore | null = null;

export function getHealthStore(config?: HealthPoolConfig): ProviderHealthStore {
  if (!globalHealthStore) {
    globalHealthStore = new ProviderHealthStore(config);
  }
  return globalHealthStore;
}

export function resetHealthStore(): void {
  if (globalHealthStore) {
    globalHealthStore.stopProbeTimer();
    globalHealthStore = null;
  }
}