import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { useConfig } from "./ConfigProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Toast } from "@/components/ui/toast";
import { MultiCombobox } from "@/components/ui/multi-combobox";
import { RouterConfigEditor } from "./RouterConfigEditor";
import { Plus, RefreshCw, Trash2, Save, ChevronDown, ChevronRight } from "lucide-react";
import type { ClientId, ProjectConfigEntry } from "@/types";

// Clients that support project-level ccr takeover (a project-scoped config
// file). Mirrors PROJECT_TAKEOVER_CLIENT_IDS on the server; Codex is excluded
// because its config is global-only.
const TAKEOVER_CLIENTS: { id: ClientId; name: string }[] = [
  { id: "claudeCode", name: "Claude Code" },
  { id: "pi", name: "pi" },
  { id: "qwenCode", name: "Qwen Code" },
  { id: "opencode", name: "opencode" },
];
const ALL_TAKEOVER_CLIENT_IDS = TAKEOVER_CLIENTS.map((client) => client.id);

export function ProjectsPage() {
  const { t } = useTranslation();
  const { config } = useConfig();
  const [projects, setProjects] = useState<ProjectConfigEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [takeoverLoadingId, setTakeoverLoadingId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Record<string, any> | undefined>>({});
  const [useGlobal, setUseGlobal] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const providers = useMemo(
    () => (Array.isArray(config?.Providers) ? config!.Providers : []),
    [config?.Providers]
  );

  const modelOptions = useMemo(
    () =>
      providers.flatMap((provider) => {
        if (!provider || provider.enabled === false) return [];
        const models = Array.isArray(provider.models) ? provider.models : [];
        const providerName = provider.name || "Unknown Provider";
        return models.map((model) => ({
          value: `${providerName},${model || "Unknown Model"}`,
          label: `${providerName}, ${model || "Unknown Model"}`,
        }));
      }),
    [providers]
  );

  // The global `fallback` list lives at the config top level (a sibling of
  // `Router`), but a project's `Router` override must carry its own nested
  // `fallback`. Merge them so copying the global config into a project
  // override preserves the fallback chains.
  const globalRouterWithFallback = useMemo(() => {
    if (!config?.Router) return {};
    return { ...config.Router, fallback: config.fallback || {} };
  }, [config?.Router, config?.fallback]);

  // For projects without overrides, leave the draft undefined so the editor
  // always falls back to the *current* global Router (incl. fallback/families)
  // instead of a stale snapshot taken before the global config finished loading.
  const initEntryState = useCallback((project: ProjectConfigEntry) => {
    const hasOverrides = Object.keys(project.Router || {}).length > 0;
    return {
      draft: hasOverrides ? { ...project.Router } : undefined,
      useGlobal: !hasOverrides,
    };
  }, []);

  const loadProjects = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await api.getProjects();
      const list = response.projects || [];
      setProjects(list);
      setDrafts((current) => {
        const next: Record<string, Record<string, any> | undefined> = {};
        for (const project of list) {
          next[project.id] = project.id in current ? current[project.id] : initEntryState(project).draft;
        }
        return next;
      });
      setUseGlobal((current) => {
        const next: Record<string, boolean> = {};
        for (const project of list) {
          next[project.id] = current[project.id] ?? initEntryState(project).useGlobal;
        }
        return next;
      });
      setCollapsed((current) => {
        const next: Record<string, boolean> = {};
        for (const project of list) {
          next[project.id] = current[project.id] ?? true;
        }
        return next;
      });
    } catch (error) {
      setToast({ message: t("projects.load_failed") + ": " + (error as Error).message, type: "error" });
    } finally {
      setIsLoading(false);
    }
  }, [t, initEntryState]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const handleAdd = async () => {
    const path = newPath.trim();
    if (!path) return;
    setIsAdding(true);
    try {
      const project = await api.addProject(path);
      setNewPath("");
      setProjects((current) => [...current, project]);
      const initial = initEntryState(project);
      setDrafts((current) => ({ ...current, [project.id]: initial.draft }));
      setUseGlobal((current) => ({ ...current, [project.id]: initial.useGlobal }));
      setToast({ message: t("projects.add_success"), type: "success" });
    } catch (error) {
      setToast({ message: t("projects.add_failed") + ": " + (error as Error).message, type: "error" });
    } finally {
      setIsAdding(false);
    }
  };

  const handleToggleUseGlobal = (id: string, checked: boolean) => {
    setUseGlobal((current) => ({ ...current, [id]: checked }));
  };

  const handleRouterChange = (id: string, router: Record<string, any>) => {
    setDrafts((current) => ({ ...current, [id]: router }));
  };

  const handleToggleCollapsed = (id: string) => {
    setCollapsed((current) => ({ ...current, [id]: !current[id] }));
  };

  const applyTakeover = async (id: string, clients: ClientId[]) => {
    setTakeoverLoadingId(id);
    try {
      const result = await api.setProjectTakeover(id, clients);
      setProjects((current) =>
        current.map((project) =>
          project.id === id
            ? { ...project, ccrTakeover: result.ccrTakeover, ccrTakeoverClients: result.ccrTakeoverClients }
            : project
        )
      );
      setToast({ message: t("projects.takeover_update_success"), type: "success" });
    } catch (error) {
      setToast({ message: t("projects.takeover_update_failed") + ": " + (error as Error).message, type: "error" });
    } finally {
      setTakeoverLoadingId(null);
    }
  };

  // The master switch enables/disables takeover entirely. Enabling without
  // picking specific clients defaults to all supported ones ("不选 = 全部").
  const handleToggleTakeover = (id: string, checked: boolean) => {
    applyTakeover(id, checked ? [...ALL_TAKEOVER_CLIENT_IDS] : []);
  };

  // The multi-select narrows which clients are taken over. Clearing it falls
  // back to all supported clients rather than turning takeover off (use the
  // master switch for that).
  const handleTakeoverClientsChange = (id: string, clients: string[]) => {
    const selected = clients.filter((value): value is ClientId =>
      ALL_TAKEOVER_CLIENT_IDS.includes(value as ClientId)
    );
    applyTakeover(id, selected.length > 0 ? selected : [...ALL_TAKEOVER_CLIENT_IDS]);
  };

  const handleSave = async (id: string) => {
    setSavingId(id);
    try {
      // When using custom config without any local edits yet, fall back to the
      // current global Router so its fallback/families settings are preserved.
      const router = useGlobal[id] ? {} : drafts[id] ?? globalRouterWithFallback;
      const updated = await api.updateProject(id, router);
      setProjects((current) => current.map((project) => (project.id === id ? updated : project)));
      setToast({ message: t("projects.update_success"), type: "success" });
    } catch (error) {
      setToast({ message: t("projects.update_failed") + ": " + (error as Error).message, type: "error" });
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await api.deleteProject(id);
      setProjects((current) => current.filter((project) => project.id !== id));
      setDrafts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setUseGlobal((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setToast({ message: t("projects.delete_success"), type: "success" });
    } catch (error) {
      setToast({ message: t("projects.delete_failed") + ": " + (error as Error).message, type: "error" });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-gray-700">{t("projects.title")}</h3>
          <p className="text-xs text-gray-500">{t("projects.description")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={loadProjects} disabled={isLoading}>
          <RefreshCw className="mr-2 h-4 w-4" />
          {t("projects.refresh")}
        </Button>
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-2">
          <Label htmlFor="new-project-path">{t("projects.add")}</Label>
          <Input
            id="new-project-path"
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            placeholder={t("projects.add_placeholder")}
          />
        </div>
        <Button size="sm" onClick={handleAdd} disabled={isAdding || !newPath.trim()}>
          <Plus className="mr-2 h-4 w-4" />
          {t("projects.add_button")}
        </Button>
      </div>

      <div className="space-y-3">
        {projects.length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-sm text-gray-500">
            {isLoading ? t("projects.loading") : t("projects.empty")}
          </div>
        )}

        {projects.map((project) => {
          const isUsingGlobal = useGlobal[project.id] ?? true;
          const draft = drafts[project.id] ?? globalRouterWithFallback;
          const isCollapsed = collapsed[project.id] ?? true;
          const takeoverClients =
            project.ccrTakeoverClients ?? (project.ccrTakeover ? ["claudeCode" as ClientId] : []);
          return (
            <Card key={project.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-4">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => handleToggleCollapsed(project.id)}
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />
                    ) : (
                      <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="text-sm font-medium truncate">{project.path}</div>
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            project.ccrTakeover
                              ? "bg-green-100 text-green-700"
                              : "bg-gray-100 text-gray-500"
                          }`}
                        >
                          {project.ccrTakeover ? t("projects.ccr_takeover_on") : t("projects.ccr_takeover_off")}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 truncate">{project.configPath}</div>
                    </div>
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button size="sm" onClick={() => handleSave(project.id)} disabled={savingId === project.id}>
                      <Save className="mr-2 h-4 w-4" />
                      {t("projects.save")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDelete(project.id)}
                      disabled={deletingId === project.id}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t("projects.delete")}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              {!isCollapsed && (
                <CardContent className="space-y-4">
                  <div className="space-y-3 border-b pb-3">
                    <div className="flex items-center gap-2">
                      <Switch
                        id={`ccr-takeover-${project.id}`}
                        checked={takeoverClients.length > 0}
                        disabled={takeoverLoadingId === project.id}
                        onCheckedChange={(checked) => handleToggleTakeover(project.id, checked)}
                      />
                      <Label htmlFor={`ccr-takeover-${project.id}`} className="cursor-pointer">
                        {t("projects.ccr_takeover")}
                      </Label>
                      <span className="text-xs text-gray-500">{t("projects.ccr_takeover_desc")}</span>
                    </div>

                    {takeoverClients.length > 0 && (
                      <div className="space-y-1.5 pl-10">
                        <Label className="text-xs text-gray-600">
                          {t("projects.takeover_clients")}
                        </Label>
                        <MultiCombobox
                          options={TAKEOVER_CLIENTS.map((client) => ({
                            label: client.name,
                            value: client.id,
                          }))}
                          value={takeoverClients}
                          onChange={(clients) => handleTakeoverClientsChange(project.id, clients)}
                          placeholder={t("projects.takeover_clients_placeholder")}
                        />
                        <span className="text-xs text-gray-500">{t("projects.takeover_clients_desc")}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 border-b pb-3">
                    <Switch
                      id={`use-global-${project.id}`}
                      checked={isUsingGlobal}
                      onCheckedChange={(checked) => handleToggleUseGlobal(project.id, checked)}
                    />
                    <Label htmlFor={`use-global-${project.id}`} className="cursor-pointer">
                      {t("projects.use_global")}
                    </Label>
                    <span className="text-xs text-gray-500">{t("projects.use_global_desc")}</span>
                  </div>

                  {!isUsingGlobal && (
                    <RouterConfigEditor
                      value={draft}
                      onChange={(router) => handleRouterChange(project.id, router)}
                      modelOptions={modelOptions}
                    />
                  )}
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}
