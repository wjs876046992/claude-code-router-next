/**
 * Concurrency-Priority Routing
 *
 * When enabled (`Router.enableConcurrencyPriority`), this layers on top of the
 * normal routing decision: whatever model the existing router selects (default,
 * think, longContext, family default, ...) is checked against live in-flight
 * concurrency:
 *
 * - A new (not yet pinned) session overflows to the least-loaded healthy model
 *   in the scenario-matching fallback list once the selected model's in-flight
 *   concurrency reaches `Router.concurrencyThreshold` (default 3).
 * - Each session sticks to the first model it was assigned per routing slot
 *   (session + model family + scenario), which keeps provider-side prompt
 *   caches warm and avoids mid-session provider switches.
 * - A session only changes models when its current model errors and the
 *   error-fallback path succeeds (routes.ts calls rebindSessionModel).
 *
 * All state is in-memory: bindings and in-flight leases are reset on restart,
 * which is safe because a restart also drops all in-flight requests.
 */

export const DEFAULT_CONCURRENCY_THRESHOLD = 3;

// Leases older than this are considered stale (e.g. client disconnected
// mid-stream and onResponse never fired) and are pruned from the counts.
const STALE_LEASE_MS = 30 * 60 * 1000; // 30 minutes

// Session bindings use a sliding TTL; an active session refreshes it on every
// request, so only truly idle sessions lose their binding.
const BINDING_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const BINDING_MAX_ENTRIES = 2000;

interface Lease {
  id: number;
  key: string; // "provider,model"
  createdAt: number;
  released: boolean;
}

interface Binding {
  modelKey: string;
  updatedAt: number;
}

export interface ConcurrencyPriorityDeps {
  /**
   * Resolve a "provider,model" route to its canonical form, or null when the
   * target is unusable (missing, disabled, unhealthy, quota-exhausted). The
   * caller injects router.ts's resolveConfiguredModel to avoid a module cycle.
   */
  resolve: (modelKey: string) => string | null;
  /** Ordered overflow candidates (the scenario-matching fallback lists). */
  fallbackModels: string[];
  /** Primary-model in-flight concurrency at which new sessions overflow. */
  threshold: number;
  log?: (msg: string) => void;
}

class ConcurrencyTracker {
  private leases = new Map<number, Lease>();
  private nextId = 1;

  acquire(key: string): Lease {
    const lease: Lease = {
      id: this.nextId++,
      key,
      createdAt: Date.now(),
      released: false,
    };
    this.leases.set(lease.id, lease);
    return lease;
  }

  release(lease: Lease | undefined | null): void {
    if (!lease || lease.released) return;
    lease.released = true;
    this.leases.delete(lease.id);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, lease] of this.leases) {
      if (now - lease.createdAt > STALE_LEASE_MS) {
        this.leases.delete(id);
      }
    }
  }

  count(key: string): number {
    this.prune();
    let n = 0;
    for (const lease of this.leases.values()) {
      if (lease.key === key) n++;
    }
    return n;
  }

  clear(): void {
    this.leases.clear();
  }
}

class SessionBindingStore {
  private bindings = new Map<string, Binding>();

  get(sessionId: string): string | undefined {
    const binding = this.bindings.get(sessionId);
    if (!binding) return undefined;
    if (Date.now() - binding.updatedAt > BINDING_TTL_MS) {
      this.bindings.delete(sessionId);
      return undefined;
    }
    // Sliding TTL refresh + LRU touch.
    binding.updatedAt = Date.now();
    this.bindings.delete(sessionId);
    this.bindings.set(sessionId, binding);
    return binding.modelKey;
  }

  bind(sessionId: string, modelKey: string): void {
    this.bindings.delete(sessionId);
    this.bindings.set(sessionId, { modelKey, updatedAt: Date.now() });
    while (this.bindings.size > BINDING_MAX_ENTRIES) {
      const oldest = this.bindings.keys().next().value;
      if (oldest === undefined) break;
      this.bindings.delete(oldest);
    }
  }

  unbind(sessionId: string): void {
    this.bindings.delete(sessionId);
  }

  clear(): void {
    this.bindings.clear();
  }
}

let globalTracker: ConcurrencyTracker | null = null;
let globalBindingStore: SessionBindingStore | null = null;

export function getConcurrencyTracker(): ConcurrencyTracker {
  if (!globalTracker) {
    globalTracker = new ConcurrencyTracker();
  }
  return globalTracker;
}

export function getSessionBindingStore(): SessionBindingStore {
  if (!globalBindingStore) {
    globalBindingStore = new SessionBindingStore();
  }
  return globalBindingStore;
}

/** Test helper: reset all concurrency-priority state. */
export function resetConcurrencyPriorityState(): void {
  globalTracker?.clear();
  globalBindingStore?.clear();
}

const LEASE_PROP = "__concurrencyLease";

function getRequestSessionId(req: any): string | undefined {
  return req?.sessionId || req?.clientContext?.stableSessionId || undefined;
}

/**
 * Stickiness slot key: bindings are tracked per session AND routing slot
 * (model family + scenario), so a session can pin one model for its default
 * traffic and another for think/longContext traffic without interfering.
 */
export function getRequestSlotKey(req: any): string {
  const sessionId = getRequestSessionId(req);
  if (!sessionId) return "";
  const family = typeof req?.modelFamily === "string" ? req.modelFamily : "";
  const scenario =
    typeof req?.scenarioType === "string" && req.scenarioType
      ? req.scenarioType
      : "default";
  return `${sessionId}:${family}:${scenario}`;
}

/**
 * Attach an in-flight lease for the given model key to the request. If the
 * request already holds a lease for a different model (e.g. after a fallback
 * switch), the old lease is released first so counts stay accurate.
 */
export function acquireRequestLease(req: any, key: string): void {
  const tracker = getConcurrencyTracker();
  const existing = req?.[LEASE_PROP] as Lease | undefined;
  if (existing && !existing.released) {
    if (existing.key === key) return;
    tracker.release(existing);
  }
  req[LEASE_PROP] = tracker.acquire(key);
}

/** Release the request's in-flight lease (idempotent). */
export function releaseRequestLease(req: any): void {
  const lease = req?.[LEASE_PROP] as Lease | undefined;
  if (lease) {
    getConcurrencyTracker().release(lease);
  }
}

/**
 * Rebind the request's session to a new model after the error-fallback path
 * succeeded with that model. No-op for requests that do not participate in
 * concurrency-priority routing (no lease and no existing binding).
 */
export function rebindSessionModel(req: any, modelKey: string): void {
  const slotKey = getRequestSlotKey(req);
  const lease = req?.[LEASE_PROP] as Lease | undefined;
  const hasBinding = slotKey
    ? getSessionBindingStore().get(slotKey) !== undefined
    : false;
  if (!lease && !hasBinding) return;
  if (slotKey) {
    getSessionBindingStore().bind(slotKey, modelKey);
  }
  acquireRequestLease(req, modelKey);
}

/**
 * Pick the least-loaded healthy overflow candidate, preserving the configured
 * order on ties. The current model is never returned as its own overflow.
 */
function pickOverflowModel(
  currentModel: string,
  fallbackModels: string[],
  resolve: (modelKey: string) => string | null
): string | null {
  const tracker = getConcurrencyTracker();
  let best: string | null = null;
  let bestCount = Infinity;
  for (const candidate of fallbackModels) {
    if (!candidate || typeof candidate !== "string") continue;
    const resolved = resolve(candidate);
    if (!resolved || resolved === currentModel) continue;
    const inFlight = tracker.count(resolved);
    if (inFlight < bestCount) {
      best = resolved;
      bestCount = inFlight;
    }
  }
  return best;
}

/**
 * Apply concurrency-priority routing to a resolved default-scenario model.
 *
 * `currentModel` is the model the normal routing pipeline resolved for this
 * request. The returned model is either the sticky bound model, an overflow
 * fallback model, or `currentModel` unchanged. An in-flight lease for the
 * returned model is attached to the request and must be released when the
 * response completes (see request-pipeline.ts onResponse hook).
 */
export function routeWithConcurrencyPriority(
  req: any,
  currentModel: string,
  deps: ConcurrencyPriorityDeps
): string {
  const slotKey = getRequestSlotKey(req);
  const store = getSessionBindingStore();
  const tracker = getConcurrencyTracker();
  const threshold =
    Number.isFinite(deps.threshold) && deps.threshold > 0
      ? Math.floor(deps.threshold)
      : DEFAULT_CONCURRENCY_THRESHOLD;

  let assigned: string | undefined;

  // 1. Honor an existing sticky binding first — a session never changes
  // providers unless its bound model is no longer usable.
  if (slotKey) {
    const bound = store.get(slotKey);
    if (bound && bound !== currentModel) {
      const resolved = deps.resolve(bound);
      if (resolved) {
        assigned = resolved;
        deps.log?.(
          `Concurrency priority: session slot ${slotKey} sticking to bound model ${resolved}`
        );
      } else {
        // Bound model is unusable (disabled/unhealthy/quota) — drop the
        // binding and re-assign below.
        store.unbind(slotKey);
      }
    } else if (bound) {
      assigned = currentModel;
    }
  }

  // 2. Fresh assignment: overflow to the least-loaded model of the
  // scenario-matching fallback list once the selected model's in-flight
  // concurrency reaches the threshold.
  if (!assigned) {
    const inFlight = tracker.count(currentModel);
    if (inFlight >= threshold) {
      const overflow = pickOverflowModel(
        currentModel,
        deps.fallbackModels,
        deps.resolve
      );
      if (overflow) {
        assigned = overflow;
        deps.log?.(
          `Concurrency priority: model ${currentModel} has ${inFlight} in-flight request(s) (>= ${threshold}); assigning ${
            slotKey ? `session slot ${slotKey} ` : "request "
          }to overflow model ${overflow}`
        );
      }
    }
    assigned = assigned || currentModel;
    if (slotKey) {
      store.bind(slotKey, assigned);
    }
  }

  // 3. Track in-flight concurrency for the assigned model.
  acquireRequestLease(req, assigned);
  return assigned;
}
