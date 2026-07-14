import { getHealthStore } from "../services/provider-health";

// Circuit-breaker health entries are keyed by provider + model. When a model is
// renamed/removed in config (or a provider is deleted), the persisted entry in
// runtime/provider-health.json becomes an orphan: it keeps a provider shown as
// "failed" in the UI forever, because the active probe only recovers models that
// still exist in the current config. These helpers reconcile the health store
// against the live config so such orphans are pruned automatically.

// NUL separator can never appear in a provider name or model id, so it is
// collision-proof even for provider names containing spaces (e.g. "阿里云 Coding Plan").
const KEY_SEP = "\u0000";
const makeKey = (provider: string, model: string) => `${provider}${KEY_SEP}${model}`;

/**
 * Walk an arbitrary config subtree and collect every "provider,model" routing
 * target string into `out`. Only targets whose provider is a known provider
 * name are kept, so unrelated strings can't pollute the reachable set.
 */
function collectRoutingTargets(node: any, providerNames: Set<string>, out: Set<string>): void {
  if (!node) return;
  if (typeof node === "string") {
    const comma = node.indexOf(",");
    if (comma > 0) {
      const provider = node.slice(0, comma).trim();
      const model = node.slice(comma + 1).trim();
      if (provider && model && providerNames.has(provider)) {
        out.add(makeKey(provider, model));
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectRoutingTargets(item, providerNames, out);
    return;
  }
  if (typeof node === "object") {
    for (const value of Object.values(node)) collectRoutingTargets(value, providerNames, out);
  }
}

/**
 * Build the set of provider+model pairs the current config can actually route
 * to: every model listed under a provider, plus every "provider,model" target
 * referenced anywhere in Router / fallback. Some providers leave `models` empty
 * and are only reachable via Router, so both sources must be considered to avoid
 * pruning a still-routable model's health state.
 */
export function collectReachableModelKeys(config: any): Set<string> {
  const providers = config?.Providers || config?.providers || [];
  const providerNames = new Set<string>();
  const keys = new Set<string>();
  for (const provider of providers) {
    const name = provider?.name;
    if (!name) continue;
    providerNames.add(name);
    const models = Array.isArray(provider?.models) ? provider.models : [];
    for (const model of models) {
      if (model) keys.add(makeKey(name, model));
    }
  }
  // Router and the top-level fallback both hold "provider,model" routing targets.
  collectRoutingTargets(config?.Router, providerNames, keys);
  collectRoutingTargets(config?.fallback, providerNames, keys);
  return keys;
}

/**
 * Remove circuit-breaker health entries the current config can no longer route
 * to (renamed/removed models, deleted providers). Returns the number pruned.
 */
export function reconcileHealthStore(config: any, logger?: any): number {
  try {
    const healthStore = getHealthStore();
    if (!healthStore?.getAllStates || !healthStore?.recover) return 0;
    const reachable = collectReachableModelKeys(config);
    let pruned = 0;
    for (const state of healthStore.getAllStates() || []) {
      const provider = state?.provider;
      const model = state?.model;
      if (!provider || !model) continue;
      if (!reachable.has(makeKey(provider, model))) {
        healthStore.recover(provider, model);
        pruned++;
      }
    }
    if (pruned > 0) {
      logger?.info?.(
        `[health-reconcile] Pruned ${pruned} orphaned provider-health entr${pruned === 1 ? "y" : "ies"}`
      );
    }
    return pruned;
  } catch (error: any) {
    logger?.warn?.(`[health-reconcile] Failed to reconcile health store: ${error?.message || error}`);
    return 0;
  }
}

/**
 * Clear every circuit-breaker entry for a provider whose endpoint just probed
 * successfully. The probe checks endpoint-level reachability (GET /v1/models),
 * so a success means any lingering "open" breaker for that provider — including
 * orphaned/renamed model names the per-model recover can't reach — should be
 * cleared. Genuinely broken models will reopen on the next real request.
 * Returns the number of entries cleared.
 */
export function clearProviderHealth(providerName: string, logger?: any): number {
  try {
    if (!providerName) return 0;
    const healthStore = getHealthStore();
    if (!healthStore?.getAllStates || !healthStore?.recover) return 0;
    let cleared = 0;
    for (const state of healthStore.getAllStates() || []) {
      if (state?.provider === providerName && state?.model) {
        healthStore.recover(providerName, state.model);
        cleared++;
      }
    }
    if (cleared > 0) {
      logger?.info?.(
        `[health-reconcile] Cleared ${cleared} health entr${cleared === 1 ? "y" : "ies"} for probed provider ${providerName}`
      );
    }
    return cleared;
  } catch (error: any) {
    logger?.warn?.(
      `[health-reconcile] Failed to clear provider health for ${providerName}: ${error?.message || error}`
    );
    return 0;
  }
}
