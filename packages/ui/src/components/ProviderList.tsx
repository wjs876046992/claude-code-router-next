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

// Helper to format reset time ISO string into a local readable time
function formatResetTime(resetTimeStr: string): string {
  try {
    const date = new Date(resetTimeStr);
    if (isNaN(date.getTime())) return resetTimeStr;
    
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    
    const pad = (n: number) => String(n).padStart(2, '0');
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    
    if (isToday) {
      return `${hours}:${minutes}`;
    } else {
      const month = pad(date.getMonth() + 1);
      const day = pad(date.getDate());
      return `${month}-${day} ${hours}:${minutes}`;
    }
  } catch (e) {
    return resetTimeStr;
  }
}

// Quota progress bar component
function QuotaProgressBar({
  label,
  used,
  limit,
  resetTime,
  isBalance,
  currency,
  t,
}: {
  label: string;
  used: number;
  limit?: number;
  resetTime?: string;
  isBalance?: boolean;
  currency?: string;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  if (limit === undefined || (!isBalance && limit <= 0)) {
    return null;
  }

  if (isBalance) {
    const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : '';
    const balance = limit - used;

    let barColor = 'bg-emerald-400';
    let textColor = 'text-emerald-600';
    if (balance < 10) {
      barColor = 'bg-red-500';
      textColor = 'text-red-600';
    } else if (balance < 50) {
      barColor = 'bg-amber-400';
      textColor = 'text-amber-600';
    }

    const progressWidth = Math.min(100, Math.max(0, (balance / 50) * 100));

    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground/80">
        <span className="w-12 shrink-0 font-medium">{label}</span>
        <div className="flex-1 space-y-0.5">
          <div className="relative h-2 rounded-full bg-white/10 overflow-hidden">
            <div
              className={`h-full rounded-full ${barColor} transition-all duration-300 shadow-[0_0_8px_rgba(var(--primary),0.3)]`}
              style={{ width: `${progressWidth}%` }}
            />
          </div>
        </div>
        <div className="flex flex-col items-end shrink-0 min-w-[70px]">
          <span className={`text-right tabular-nums font-bold ${textColor}`}>
            {symbol}{balance.toFixed(2)}
          </span>
          {resetTime && (
            <span className="text-[9px] text-muted-foreground/50 leading-none mt-0.5">
              {t("providers.quota_reset", { time: formatResetTime(resetTime) })}
            </span>
          )}
        </div>
      </div>
    );
  }

  const percentage = Math.min(100, (used / limit) * 100);
  const barWidth = Math.max(2, percentage);

  // Determine bar and text color based on percentage
  let barColor = 'bg-emerald-500';
  let textColor = 'text-emerald-500';
  if (percentage >= 90) { barColor = 'bg-red-500'; textColor = 'text-red-500'; }
  else if (percentage >= 70) { barColor = 'bg-amber-500'; textColor = 'text-amber-500'; }
  else if (percentage >= 40) { barColor = 'bg-primary'; textColor = 'text-primary'; }

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground/80">
      <span className="w-12 shrink-0 font-medium">{label}</span>
      <div className="flex-1 h-2 bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${barColor} transition-all duration-300 shadow-sm`}
          style={{ width: `${barWidth}%` }}
        />
      </div>
      <div className="flex flex-col items-end shrink-0 min-w-[70px]">
        <span className={`text-right tabular-nums font-bold ${textColor}`}>
          {`${percentage.toFixed(1)}%`}
        </span>
        {resetTime && (
          <span className="text-[9px] text-muted-foreground/50 leading-none mt-0.5">
            {t("providers.quota_reset", { time: formatResetTime(resetTime) })}
          </span>
        )}
      </div>
    </div>
  );
}

export function ProviderList({ providers, healthStates, quotaUsages, onEdit, onRemove }: ProviderListProps) {
  const { t } = useTranslation();

  if (!providers || !Array.isArray(providers)) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-center rounded-2xl border border-white/10 bg-white/5 p-12 text-muted-foreground animate-in">
          No providers configured
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {providers.map((provider, index) => {
        if (!provider) return null;

        const providerName = provider.name || "Unnamed Provider";
        const apiBaseUrl = provider.api_base_url || "No API URL";
        const models = Array.isArray(provider.models) ? provider.models : [];
        const health = getProviderHealth(providerName, healthStates);
        const quota = quotaUsages?.find(q => q.provider === providerName);

        return (
          <div key={index} className="flex items-start justify-between rounded-2xl border border-white/10 bg-white/5 p-5 transition-all hover:bg-white/10 hover:border-primary/30 group animate-in shadow-lg shadow-black/5 glass-card">
            <div className="flex-1 space-y-3">
                <div className="flex flex-col gap-1">
                  <p className="text-lg font-bold tracking-tight text-foreground">{providerName}</p>
                  <p className="text-xs font-medium text-muted-foreground/60 truncate max-w-md">{apiBaseUrl}</p>
                </div>
              
              {health.lastError && (
                <div className="p-2 px-3 bg-red-500/10 border border-red-500/20 rounded-lg text-[11px] text-red-500 font-medium truncate max-w-md">
                  {health.lastError}
                </div>
              )}
              
              {quota && (quota.limit5h !== undefined || quota.limit7d !== undefined) && (
                <div className="space-y-2 py-1 max-w-md">
                  <QuotaProgressBar
                    label={quota.type5h === 'balance' ? t("providers.quota_balance") : t("providers.quota_5h")}
                    used={quota.used5h}
                    limit={quota.limit5h}
                    resetTime={quota.limit5h ? quota.reset5h : undefined}
                    isBalance={quota.type5h === 'balance'}
                    currency={quota.currency}
                    t={t}
                  />
                  <QuotaProgressBar
                    label={quota.type7d === 'balance' ? t("providers.quota_balance") : t("providers.quota_7d")}
                    used={quota.used7d}
                    limit={quota.limit7d}
                    resetTime={quota.limit7d ? quota.reset7d : undefined}
                    isBalance={quota.type7d === 'balance'}
                    currency={quota.currency}
                    t={t}
                  />
                </div>
              )}
              
              <div className="flex flex-wrap gap-2 pt-1">
                {models.map((model, modelIndex) => (
                  <Badge key={modelIndex} variant="secondary" className="px-2 py-0.5 rounded-lg bg-white/5 border-white/5 text-[10px] font-bold text-muted-foreground group-hover:text-foreground transition-colors">
                    {model || "Unnamed Model"}
                  </Badge>
                ))}
              </div>
            </div>
            
            <div className="ml-4 flex flex-col items-end gap-4">
              <HealthIndicator status={health.status} />
              <div className="flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button variant="ghost" size="icon" onClick={() => onEdit(index)} className="h-9 w-9 rounded-lg hover:bg-primary/20 hover:text-primary">
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="destructive" size="icon" onClick={() => onRemove(index)} className="h-9 w-9 rounded-lg opacity-80 hover:opacity-100">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}