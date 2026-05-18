import type { ProviderQuotaResult } from "./quota-adapters";

export interface StoredQuotaResult extends ProviderQuotaResult {
  provider: string;
  capturedAt: number;
}

const quotaStore = new Map<string, StoredQuotaResult>();

export function storeQuotaResult(
  providerName: string,
  result: ProviderQuotaResult
): void {
  if (!providerName) return;

  quotaStore.set(providerName, {
    ...result,
    provider: providerName,
    capturedAt: Date.now(),
  });
}

export function getQuotaResult(
  providerName: string
): StoredQuotaResult | undefined {
  const result = quotaStore.get(providerName);
  return result ? { ...result } : undefined;
}

export function getAllQuotaResults(): StoredQuotaResult[] {
  return Array.from(quotaStore.values()).map((result) => ({ ...result }));
}
