import { useTranslation } from "react-i18next";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Provider, ProviderHealthState, ProviderQuotaUsage } from "@/types";

interface ProviderListProps {
  providers: Provider[];
  healthStates?: ProviderHealthState[];
  quotaUsages?: ProviderQuotaUsage[];
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
}

// Get health status for a provider
function getProviderHealth(providerName: string, healthStates?: ProviderHealthState[]): {
  status: 'closed' | 'open' | 'half-open' | 'unknown';
  hasFailure: boolean;
  lastError?: string;
} {
  if (!healthStates || healthStates.length === 0) {
    return { status: 'closed', hasFailure: false }; // No failures recorded = healthy
  }

  // Find all health states for this provider
  const providerStates = healthStates.filter(s => s.provider === providerName);

  if (providerStates.length === 0) {
    return { status: 'closed', hasFailure: false }; // No failures = healthy
  }

  // Check if any model is in open or half-open state
  const openStates = providerStates.filter(s => s.status === 'open');
  const halfOpenStates = providerStates.filter(s => s.status === 'half-open');

  if (openStates.length > 0) {
    return {
      status: 'open',
      hasFailure: true,
      lastError: openStates[0].lastError,
    };
  }

  if (halfOpenStates.length > 0) {
    return {
      status: 'half-open',
      hasFailure: true,
      lastError: halfOpenStates[0].lastError,
    };
  }

  // All models are in closed state (recovering)
  return { status: 'closed', hasFailure: false };
}

// Health indicator component
function HealthIndicator({ status }: { status: 'closed' | 'open' | 'half-open' | 'unknown' }) {
  const colors: Record<string, string> = {
    closed: 'bg-green-500',
    open: 'bg-red-500',
    'half-open': 'bg-yellow-500',
    unknown: 'bg-gray-400',
  };

  const labels: Record<string, string> = {
    closed: 'Healthy',
    open: 'Failed',
    'half-open': 'Recovering',
    unknown: 'Unknown',
  };

  return (
    <div className="flex items-center gap-1">
      <div
        className={`w-3 h-3 rounded-full ${colors[status]} animate-pulse`}
        title={labels[status]}
      />
      <span className="text-xs text-gray-500">{labels[status]}</span>
    </div>
  );
}

// Format tokens to human readable (K, M)
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(tokens);
}

// Quota progress bar component
function QuotaProgressBar({
  label,
  used,
  limit,
  resetTime,
  t,
}: {
  label: string;
  used: number;
  limit?: number;
  resetTime?: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  // Only show if there's usage data or a configured limit
  if (used === 0 && !limit) {
    return null;
  }

  const percentage = limit ? Math.min(100, (used / limit) * 100) : undefined;
  const usedText = formatTokens(used);
  const barWidth = percentage !== undefined ? Math.max(2, percentage) : 100;

  // Determine bar and text color based on percentage
  let barColor = percentage === undefined ? 'bg-blue-300' : 'bg-emerald-400';
  let textColor = percentage === undefined ? 'text-blue-600' : 'text-emerald-600';
  if (percentage !== undefined) {
    if (percentage >= 90) { barColor = 'bg-red-500'; textColor = 'text-red-600'; }
    else if (percentage >= 70) { barColor = 'bg-amber-400'; textColor = 'text-amber-600'; }
    else if (percentage >= 40) { barColor = 'bg-blue-400'; textColor = 'text-blue-600'; }
  }

  return (
    <div className="flex items-center gap-2 text-xs text-gray-600">
      <span className="w-12 shrink-0">{label}</span>
      <div className="flex-1 h-2.5 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${barColor} transition-all duration-300`}
          style={{ width: `${barWidth}%` }}
        />
      </div>
      <span className={`w-14 shrink-0 text-right tabular-nums font-medium ${textColor}`}>
        {percentage !== undefined ? `${percentage.toFixed(1)}%` : usedText}
      </span>
      {resetTime && (
        <span className="w-24 shrink-0 text-right text-gray-400">
          {t("providers.quota_reset", { time: new Date(resetTime).toLocaleTimeString() })}
        </span>
      )}
    </div>
  );
}

export function ProviderList({ providers, healthStates, quotaUsages, onEdit, onRemove }: ProviderListProps) {
  const { t } = useTranslation();
  // Handle case where providers might be null or undefined
  if (!providers || !Array.isArray(providers)) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-center rounded-md border bg-white p-8 text-gray-500">
          No providers configured
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {providers.map((provider, index) => {
        // Handle case where individual provider might be null or undefined
        if (!provider) {
          return (
            <div key={index} className="flex items-start justify-between rounded-md border bg-white p-4 transition-all hover:shadow-md animate-slide-in hover:scale-[1.01]">
              <div className="flex-1 space-y-1.5">
                <p className="text-md font-semibold text-gray-800">Invalid Provider</p>
                <p className="text-sm text-gray-500">Provider data is missing</p>
              </div>
              <div className="ml-4 flex flex-shrink-0 items-center gap-2">
                <Button variant="ghost" size="icon" onClick={() => onEdit(index)} className="transition-all-ease hover:scale-110" disabled>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="destructive" size="icon" onClick={() => onRemove(index)} className="transition-all duration-200 hover:scale-110">
                  <Trash2 className="h-4 w-4 text-current transition-colors duration-200" />
                </Button>
              </div>
            </div>
          );
        }

        // Handle case where provider.name might be null or undefined
        const providerName = provider.name || "Unnamed Provider";

        // Handle case where provider.api_base_url might be null or undefined
        const apiBaseUrl = provider.api_base_url || "No API URL";

        // Handle case where provider.models might be null or undefined
        const models = Array.isArray(provider.models) ? provider.models : [];

        // Get health status for this provider
        const health = getProviderHealth(providerName, healthStates);

        // Get quota usage for this provider
        const quota = quotaUsages?.find(q => q.provider === providerName);

        return (
          <div key={index} className="flex items-start justify-between rounded-md border bg-white p-4 transition-all hover:shadow-md animate-slide-in hover:scale-[1.01]">
            <div className="flex-1 space-y-1.5">
              <div className="flex items-center gap-2">
                <p className="text-md font-semibold text-gray-800">{providerName}</p>
              </div>
              <div className="flex items-center gap-2">
                <p className="text-sm text-gray-500">{apiBaseUrl}</p>
              </div>
              {health.lastError && (
                <p className="text-xs text-red-500 truncate max-w-md" title={health.lastError}>
                  Error: {health.lastError}
                </p>
              )}
              {quota && (quota.used5h > 0 || quota.used7d > 0 || quota.limit5h || quota.limit7d) && (
                <div className="space-y-1 pt-1">
                  <QuotaProgressBar
                    label={t("providers.quota_5h")}
                    used={quota.used5h}
                    limit={quota.limit5h}
                    resetTime={quota.limit5h ? quota.reset5h : undefined}
                    t={t}
                  />
                  <QuotaProgressBar
                    label={t("providers.quota_7d")}
                    used={quota.used7d}
                    limit={quota.limit7d}
                    resetTime={quota.limit7d ? quota.reset7d : undefined}
                    t={t}
                  />
                </div>
              )}
              <div className="flex flex-wrap gap-2 pt-2">
                {models.map((model, modelIndex) => (
                  // Handle case where model might be null or undefined
                  <Badge key={modelIndex} variant="outline" className="font-normal transition-all-ease hover:scale-105">
                    {model || "Unnamed Model"}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="ml-4 flex flex-shrink-0 items-center gap-2">
              <HealthIndicator status={health.status} />
              <Button variant="ghost" size="icon" onClick={() => onEdit(index)} className="transition-all-ease hover:scale-110">
                <Pencil className="h-4 w-4" />
              </Button>
              <Button variant="destructive" size="icon" onClick={() => onRemove(index)} className="transition-all duration-200 hover:scale-110">
                <Trash2 className="h-4 w-4 text-current transition-colors duration-200" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}