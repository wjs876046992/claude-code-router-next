import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, RefreshCw } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface UsageRecord {
  id: string;
  timestamp: string;
  sessionId: string;
  provider: string;
  originalModel: string; // Original request model before routing
  model: string; // Actual routed model
  modelFamily: string;
  scenarioType: string;
  stream: boolean;
  inputTokens: number;
  outputTokens: number;
  ttft: number | null;
  tokensPerSecond: number | null;
  durationMs: number;
  status: "success" | "error";
  errorMessage?: string;
  responseBody?: string;
}

interface UsageSummary {
  totalRequests: number;
  successCount: number;
  errorCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadInputTokens: number;
  totalCacheCreationInputTokens: number;
  avgTtft: number | null;
  avgTokensPerSecond: number | null;
  byModel: Record<string, { count: number; inputTokens: number; outputTokens: number }>;
  byProvider: Record<string, { count: number; inputTokens: number; outputTokens: number }>;
  byScenario: Record<string, { count: number; inputTokens: number; outputTokens: number }>;
  byFamily: Record<string, { count: number; inputTokens: number; outputTokens: number }>;
  byDay: Record<string, { count: number; inputTokens: number; outputTokens: number }>;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

function formatMs(ms: number | null): string {
  if (ms == null) return "-";
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
  return String(Math.round(ms));
}

function formatSpeed(speed: number | null): string {
  if (speed == null) return "-";
  return speed + " t/s";
}

function formatDuration(ms: number): string {
  if (ms >= 60000) return (ms / 60000).toFixed(1) + "m";
  if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
  return ms + "ms";
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function UsageStats() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const autoRefreshRef = useRef<NodeJS.Timeout | null>(null);

  // Filters
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [activeRange, setActiveRange] = useState<number | null>(null);
  const [filterModel, setFilterModel] = useState("");
  const [filterProvider, setFilterProvider] = useState("");
  const [filterScenario, setFilterScenario] = useState("");

  const pageSize = 20;

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, any> = { page, pageSize };
      if (startDate) params.startDate = new Date(startDate).toISOString();
      if (endDate) params.endDate = new Date(endDate + "T23:59:59").toISOString();
      if (filterModel) params.model = filterModel;
      if (filterProvider) params.provider = filterProvider;
      if (filterScenario) params.scenario = filterScenario;

      const result = await api.getUsage(params);
      setRecords(result.records || []);
      setSummary(result.summary);
      setTotal(result.total);
    } catch (e) {
      console.error("Failed to load usage:", e);
    } finally {
      setLoading(false);
    }
  }, [page, startDate, endDate, filterModel, filterProvider, filterScenario]);

  useEffect(() => {
    loadData();
    // Auto refresh every 30 seconds
    autoRefreshRef.current = setInterval(loadData, 10000);
    return () => {
      if (autoRefreshRef.current) {
        clearInterval(autoRefreshRef.current);
      }
    };
  }, [loadData]);

  const handleClear = async () => {
    if (!confirm(t("usage.clear_confirm"))) return;
    try {
      await api.clearUsage();
      loadData();
    } catch (e) {
      console.error("Failed to clear usage:", e);
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  // Extract unique values from summary for filter dropdowns
  const models = summary ? Object.keys(summary.byModel) : [];
  const providers = summary ? Object.keys(summary.byProvider) : [];
  const scenarios = summary ? Object.keys(summary.byScenario) : [];

  // Daily chart data (last 14 days)
  const dailyData = summary?.byDay ? Object.entries(summary.byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-14) : [];
  const maxDailyTokens = Math.max(1, ...dailyData.map(([, d]) => d.inputTokens + d.outputTokens));

  return (
    <Card className="h-full flex flex-col">
      <div className="flex items-center justify-end gap-1 pb-2 flex-shrink-0 px-6 pt-6">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={loadData} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-red-400 hover:text-red-600" onClick={handleClear}>
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <CardContent className="flex-1 overflow-auto pt-0">
          {/* Time range presets */}
          <div className="flex gap-2 mb-3">
            {[24, 168, 720].map((hours) => {
              const label = hours === 24 ? "24h" : hours === 168 ? "7d" : "30d";
              const isActive = startDate && !endDate && (() => {
                const d = new Date(startDate);
                const now = new Date();
                const diff = (now.getTime() - d.getTime()) / (1000 * 60 * 60);
                return Math.abs(diff - hours) < 1;
              })();
              return (
                <Button
                  key={hours}
                  variant={isActive ? "default" : "outline"}
                  size="sm"
                  className="h-8 text-sm px-4"
                  onClick={() => {
                    const now = new Date();
                    const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
                    setStartDate(start.toISOString().slice(0, 10));
                    setEndDate("");
                    setPage(1);
                  }}
                >
                  {label}
                </Button>
              );
            })}
            <Button
              variant={!startDate && !endDate ? "default" : "outline"}
              size="sm"
              className="h-8 text-sm px-4"
              onClick={() => { setStartDate(""); setEndDate(""); setPage(1); }}
            >
              {t("usage.all")}
            </Button>
          </div>

          {/* Summary Cards */}
          {summary && (
            <div className="grid grid-cols-4 gap-2 mb-3">
              <div className="rounded-lg border bg-blue-50 p-2 text-center">
                <div className="text-lg font-bold text-blue-600">{summary.totalRequests}</div>
                <div className="text-xs text-gray-500">{t("usage.total_requests")}</div>
                <div className="text-xs text-green-500">{summary.successCount} ok / <span className="text-red-500">{summary.errorCount} err</span></div>
              </div>
              <div className="rounded-lg border bg-green-50 p-2 text-center">
                <div className="text-lg font-bold text-green-600">{formatTokens(summary.totalInputTokens)}</div>
                <div className="text-xs text-gray-500">{t("usage.total_input_tokens")}</div>
              </div>
              <div className="rounded-lg border bg-yellow-50 p-2 text-center">
                <div className="text-lg font-bold text-yellow-600">{formatTokens(summary.totalOutputTokens)}</div>
                <div className="text-xs text-gray-500">{t("usage.total_output_tokens")}</div>
              </div>
              <div className="rounded-lg border bg-indigo-50 p-2 text-center">
                <div className="text-lg font-bold text-indigo-600">{formatTokens(summary.totalInputTokens + summary.totalOutputTokens)}</div>
                <div className="text-xs text-gray-500">{t("usage.total_tokens")}</div>
              </div>
              <div className="rounded-lg border bg-gray-50 p-2 text-center">
                <div className="text-lg font-bold text-gray-700">
                  {summary.totalRequests > 0 ? ((summary.successCount / summary.totalRequests) * 100).toFixed(1) + "%" : "-"}
                </div>
                <div className="text-xs text-gray-500">{t("usage.success_rate")}</div>
              </div>
              <div className="rounded-lg border bg-emerald-50 p-2 text-center">
                <div className="text-lg font-bold text-emerald-600">{formatTokens(summary.totalCacheReadInputTokens || 0)}</div>
                <div className="text-xs text-gray-500">{t("usage.cache_read")}</div>
              </div>
              <div className="rounded-lg border bg-teal-50 p-2 text-center">
                <div className="text-lg font-bold text-teal-600">{formatTokens(summary.totalCacheCreationInputTokens || 0)}</div>
                <div className="text-xs text-gray-500">{t("usage.cache_creation")}</div>
              </div>
              <div className="rounded-lg border bg-purple-50 p-2 text-center">
                <div className="text-lg font-bold text-purple-600">{formatMs(summary.avgTtft)}</div>
                <div className="text-xs text-gray-500">{t("usage.avg_ttft")}</div>
              </div>
            </div>
          )}

          {/* Daily Chart */}
          {dailyData.length > 0 && (
            <div className="mb-3">
              <div className="text-xs text-gray-500 mb-1">{t("usage.daily_chart")}</div>
              <div className="flex items-end gap-1 h-16">
                {dailyData.map(([day, data]) => {
                  const totalTokens = data.inputTokens + data.outputTokens;
                  const height = Math.max(4, (totalTokens / maxDailyTokens) * 100);
                  return (
                    <div key={day} className="flex-1 flex flex-col items-center" title={`${day}: ${formatTokens(totalTokens)}`}>
                      <div className="w-full bg-blue-400 rounded-t" style={{ height: `${height}%` }} />
                      <div className="text-[8px] text-gray-400 mt-0.5">{day.slice(5)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Filters */}
          <div className="flex gap-2 mb-3 flex-wrap">
            <Input
              type="date"
              className="h-7 text-xs w-[120px]"
              value={startDate}
              onChange={(e) => { setStartDate(e.target.value); setPage(1); }}
              placeholder={t("usage.start_date")}
            />
            <Input
              type="date"
              className="h-7 text-xs w-[120px]"
              value={endDate}
              onChange={(e) => { setEndDate(e.target.value); setPage(1); }}
              placeholder={t("usage.end_date")}
            />
            <Select value={filterProvider} onValueChange={(v) => { setFilterProvider(v === "__all__" ? "" : v); setPage(1); }}>
              <SelectTrigger className="h-7 text-xs w-[100px]">
                <SelectValue placeholder={t("usage.provider")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t("usage.all")}</SelectItem>
                {providers.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filterModel} onValueChange={(v) => { setFilterModel(v === "__all__" ? "" : v); setPage(1); }}>
              <SelectTrigger className="h-7 text-xs w-[130px]">
                <SelectValue placeholder={t("usage.model")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t("usage.all")}</SelectItem>
                {models.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filterScenario} onValueChange={(v) => { setFilterScenario(v === "__all__" ? "" : v); setPage(1); }}>
              <SelectTrigger className="h-7 text-xs w-[100px]">
                <SelectValue placeholder={t("usage.scenario")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t("usage.all")}</SelectItem>
                {scenarios.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {/* Table */}
          <div className="overflow-auto border rounded text-xs">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b">
                  <th className="text-left p-1.5">{t("usage.time")}</th>
                  <th className="text-left p-1.5">{t("usage.provider")}</th>
                  <th className="text-left p-1.5">{t("usage.model")}</th>
                  <th className="text-left p-1.5">{t("usage.route")}</th>
                  <th className="text-right p-1.5">{t("usage.input_tokens")}</th>
                  <th className="text-right p-1.5">{t("usage.output_tokens")}</th>
                  <th className="text-right p-1.5">{t("usage.ttft")}</th>
                  <th className="text-right p-1.5">{t("usage.speed")}</th>
                  <th className="text-right p-1.5">{t("usage.duration")}</th>
                  <th className="text-center p-1.5">{t("usage.status")}</th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 ? (
                  <tr><td colSpan={10} className="text-center p-4 text-gray-400">{t("usage.no_data")}</td></tr>
                ) : records.map((r) => {
                  // Show model mapping: original → routed
                  const modelDisplay = r.originalModel && r.originalModel !== r.model
                    ? `${r.originalModel} → ${r.model}`
                    : r.model;
                  return (
                  <tr key={r.id} className="border-b hover:bg-gray-50">
                    <td className="p-1.5 whitespace-nowrap">{formatTime(r.timestamp)}</td>
                    <td className="p-1.5">{r.provider}</td>
                    <td className="p-1.5 max-w-[180px] truncate" title={modelDisplay}>{modelDisplay}</td>
                    <td className="p-1.5">{r.modelFamily ? `${r.modelFamily}/${r.scenarioType}` : r.scenarioType}</td>
                    <td className="text-right p-1.5">{formatTokens(r.inputTokens)}</td>
                    <td className="text-right p-1.5">{formatTokens(r.outputTokens)}</td>
                    <td className="text-right p-1.5">{formatMs(r.ttft)}</td>
                    <td className="text-right p-1.5">{formatSpeed(r.tokensPerSecond)}</td>
                    <td className="text-right p-1.5">{formatDuration(r.durationMs)}</td>
                    <td className="text-center p-1.5">
                      {r.status === "error" && (r.errorMessage || r.responseBody) ? (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-block w-2 h-2 rounded-full bg-red-500 cursor-pointer" />
                            </TooltipTrigger>
                            <TooltipContent className="max-w-md text-xs whitespace-pre-wrap overflow-auto max-h-64">
                              {r.responseBody ? (
                                <div>
                                  <div className="font-semibold mb-1">Response Body:</div>
                                  <pre className="text-xs bg-gray-100 p-2 rounded overflow-auto">
                                    {r.responseBody}
                                  </pre>
                                </div>
                              ) : r.errorMessage}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <span className={`inline-block w-2 h-2 rounded-full ${r.status === "success" ? "bg-green-500" : "bg-red-500"}`} />
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-2 text-xs text-gray-500">
              <span>{t("usage.page")} {page} / {totalPages} ({total} {t("usage.records")})</span>
              <div className="flex gap-1">
                <Button variant="outline" size="sm" className="h-6 text-xs px-2" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  &lt;
                </Button>
                <Button variant="outline" size="sm" className="h-6 text-xs px-2" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                  &gt;
                </Button>
              </div>
            </div>
          )}
        </CardContent>
    </Card>
  );
}
