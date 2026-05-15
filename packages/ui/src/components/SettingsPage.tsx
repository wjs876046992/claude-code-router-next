import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Combobox } from "@/components/ui/combobox";
import { MultiCombobox } from "@/components/ui/multi-combobox";
import { useConfig } from "./ConfigProvider";
import { StatusLineConfigDialog } from "./StatusLineConfigDialog";
import { useState, useMemo } from "react";
import type { StatusLineConfig, FallbackConfig } from "@/types";
import { FileJson, FileText, BarChart3, CircleArrowUp, FileCog, ArrowLeft, Save, RefreshCw, Trash2 } from "lucide-react";
import { Toast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import { MODEL_FAMILIES } from "@/types";
import type { ModelFamilyConfig } from "@/types";

const FALLBACK_SCENARIOS = ["default", "background", "think", "longContext", "extendedContext", "webSearch", "image"] as const;

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { config, setConfig } = useConfig();
  const [isStatusLineConfigOpen, setIsStatusLineConfigOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);

  const providers = useMemo(
    () => (Array.isArray(config?.Providers) ? config.Providers : []),
    [config?.Providers]
  );

  const modelOptions = useMemo(
    () =>
      providers.flatMap((provider) => {
        if (!provider) return [];
        const models = Array.isArray(provider.models) ? provider.models : [];
        const providerName = provider.name || "Unknown Provider";
        return models.map((model) => ({
          value: `${providerName},${model || "Unknown Model"}`,
          label: `${providerName}, ${model || "Unknown Model"}`,
        }));
      }),
    [providers]
  );

  if (!config) {
    return (
      <div className="h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  const routerConfig = config.Router || {
    default: "",
    background: "",
    think: "",
    longContext: "",
    longContextThreshold: 60000,
    webSearch: "",
    image: "",
  };

  const handleRouterChange = (field: string, value: string | number) => {
    const currentRouter = config.Router || {};
    setConfig({ ...config, Router: { ...currentRouter, [field]: value } });
  };

  const handleFallbackChange = (scenario: string, value: string[]) => {
    const currentFallback = config.fallback || {};
    const updated = { ...currentFallback, [scenario]: value };
    if (value.length === 0) {
      delete updated[scenario];
    }
    if (Object.keys(updated).length === 0) {
      const { fallback, ...rest } = config;
      setConfig(rest);
    } else {
      setConfig({ ...config, fallback: updated as FallbackConfig });
    }
  };

  const handleAddFamily = (familyName: string) => {
    const currentRouter = config.Router || {};
    const families = currentRouter.families || {};
    if (families[familyName]) return;
    setConfig({
      ...config,
      Router: { ...currentRouter, families: { ...families, [familyName]: { default: "" } } },
    });
  };

  const handleRemoveFamily = (familyName: string) => {
    const currentRouter = config.Router || {};
    const families = { ...(currentRouter.families || {}) };
    delete families[familyName];
    setConfig({ ...config, Router: { ...currentRouter, families } });
  };

  const handleFamilyChange = (familyName: string, field: string, value: string) => {
    const currentRouter = config.Router || {};
    const families = { ...(currentRouter.families || {}) };
    families[familyName] = { ...(families[familyName] || {}), [field]: value };
    setConfig({ ...config, Router: { ...currentRouter, families } });
  };

  const handleFamilyFallbackChange = (familyName: string, scenario: string, value: string[]) => {
    const currentRouter = config.Router || {};
    const families = { ...(currentRouter.families || {}) };
    const family = { ...(families[familyName] || {}) };
    const fallback = { ...(family.fallback || {}) };
    if (value.length === 0) {
      delete fallback[scenario];
    } else {
      fallback[scenario] = value;
    }
    family.fallback = fallback;
    families[familyName] = family;
    setConfig({ ...config, Router: { ...currentRouter, families } });
  };

  const handleStatusLineEnabledChange = (checked: boolean) => {
    const newStatusLineConfig: StatusLineConfig = {
      enabled: checked,
      currentStyle: config.StatusLine?.currentStyle || "default",
      default: config.StatusLine?.default || { modules: [] },
      powerline: config.StatusLine?.powerline || { modules: [] },
    };
    setConfig({ ...config, StatusLine: newStatusLineConfig });
  };

  const saveConfig = async () => {
    setIsSaving(true);
    try {
      const response = await api.updateConfig(config);
      if (response.success) {
        setToast({ message: response.message || t('app.config_saved_success'), type: 'success' });
      } else {
        setToast({ message: response.message || t('app.config_saved_failed'), type: 'error' });
      }
    } catch (error) {
      setToast({ message: t('app.config_saved_failed') + ': ' + (error as Error).message, type: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const saveAndRestart = async () => {
    setIsRestarting(true);
    try {
      const response = await api.updateConfig(config);
      if (!response.success) {
        setToast({ message: response.message || t('app.config_saved_failed'), type: 'error' });
        return;
      }
      const restartResponse = await api.restartService();
      if (restartResponse && typeof restartResponse === 'object' && 'success' in restartResponse) {
        setToast({ message: t('app.config_saved_restart_success'), type: 'success' });
      }
    } catch (error) {
      setToast({ message: t('app.config_saved_restart_failed'), type: 'error' });
    } finally {
      setIsRestarting(false);
    }
  };

  const tools = [
    { icon: FileJson, label: t("settings.tools.json_editor"), desc: t("settings.tools.json_editor_desc"), href: "/debug" },
    { icon: FileText, label: t("settings.tools.log_viewer"), desc: t("settings.tools.log_viewer_desc"), href: "/debug" },
    { icon: BarChart3, label: t("settings.tools.usage_stats"), desc: t("settings.tools.usage_stats_desc"), href: "/usage" },
    { icon: FileCog, label: t("settings.tools.presets"), desc: t("settings.tools.presets_desc"), href: "/presets" },
  ];

  return (
    <div className="h-screen bg-gray-50">
      <header className="flex h-16 items-center justify-between border-b bg-white px-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => navigate('/dashboard')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t('advanced_router.back')}
          </Button>
          <h1 className="text-xl font-semibold text-gray-800">{t('toplevel.title')}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={saveConfig} disabled={isSaving || isRestarting}>
            <Save className="mr-2 h-4 w-4" />
            {t('app.save')}
          </Button>
          <Button onClick={saveAndRestart} disabled={isSaving || isRestarting}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {t('app.save_and_restart')}
          </Button>
        </div>
      </header>

      <main className="h-[calc(100vh-4rem)] overflow-auto p-6">
        <div className="max-w-4xl mx-auto">
          <Tabs defaultValue="general" className="w-full">
            <TabsList className="w-full justify-start mb-4">
              <TabsTrigger value="general">{t("settings.tabs.general")}</TabsTrigger>
              <TabsTrigger value="router">{t("settings.tabs.router")}</TabsTrigger>
              <TabsTrigger value="tools">{t("settings.tabs.tools")}</TabsTrigger>
            </TabsList>

            {/* General Tab */}
            <TabsContent value="general" className="space-y-4">
              <div className="flex items-center space-x-2">
                <Switch
                  id="log"
                  checked={config.LOG ?? false}
                  onCheckedChange={(checked) => setConfig({ ...config, LOG: checked })}
                />
                <Label htmlFor="log">{t("toplevel.log")}</Label>
              </div>

              <div className="flex items-center justify-between border-t pt-4">
                <div className="flex items-center space-x-2">
                  <Switch
                    id="statusline"
                    checked={config.StatusLine?.enabled || false}
                    onCheckedChange={handleStatusLineEnabledChange}
                  />
                  <Label htmlFor="statusline">{t("statusline.title")}</Label>
                </div>
                <Button variant="outline" size="sm" onClick={() => setIsStatusLineConfigOpen(true)}>
                  {t("app.settings")}
                </Button>
              </div>

              <div className="flex items-center space-x-2 border-t pt-4">
                <Switch
                  id="token-speed"
                  checked={config.Plugins?.some((p: any) => p.name === 'token-speed' && p.enabled) ?? false}
                  onCheckedChange={(checked) => {
                    const plugins = [...(config.Plugins || [])];
                    const idx = plugins.findIndex((p: any) => p.name === 'token-speed');
                    if (idx >= 0) {
                      plugins[idx] = { ...plugins[idx], enabled: checked };
                    } else {
                      plugins.push({ name: 'token-speed', enabled: checked });
                    }
                    setConfig({ ...config, Plugins: plugins });
                  }}
                />
                <Label htmlFor="token-speed">{t("settings.token_speed")}</Label>
              </div>

              <div className="space-y-2">
                <Label htmlFor="log-level">{t("toplevel.log_level")}</Label>
                <Combobox
                  options={[
                    { label: "fatal", value: "fatal" },
                    { label: "error", value: "error" },
                    { label: "warn", value: "warn" },
                    { label: "info", value: "info" },
                    { label: "debug", value: "debug" },
                    { label: "trace", value: "trace" },
                  ]}
                  value={config.LOG_LEVEL || "debug"}
                  onChange={(value) => setConfig({ ...config, LOG_LEVEL: value })}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="claude-path">{t("toplevel.claude_path")}</Label>
                  <Input
                    id="claude-path"
                    value={config.CLAUDE_PATH || ""}
                    onChange={(e) => setConfig({ ...config, CLAUDE_PATH: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="host">{t("toplevel.host")}</Label>
                  <Input
                    id="host"
                    value={config.HOST || ""}
                    onChange={(e) => setConfig({ ...config, HOST: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="port">{t("toplevel.port")}</Label>
                  <Input
                    id="port"
                    type="number"
                    value={config.PORT ?? 3456}
                    onChange={(e) => setConfig({ ...config, PORT: parseInt(e.target.value, 10) })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="timeout">{t("toplevel.timeout")}</Label>
                  <Input
                    id="timeout"
                    value={config.API_TIMEOUT_MS || "600000"}
                    onChange={(e) => setConfig({ ...config, API_TIMEOUT_MS: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="proxy-url">{t("toplevel.proxy_url")}</Label>
                  <Input
                    id="proxy-url"
                    value={config.PROXY_URL || ""}
                    onChange={(e) => setConfig({ ...config, PROXY_URL: e.target.value })}
                    placeholder="http://127.0.0.1:7890"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="apikey">{t("toplevel.apikey")}</Label>
                  <Input
                    id="apikey"
                    type="password"
                    value={config.APIKEY || ""}
                    onChange={(e) => setConfig({ ...config, APIKEY: e.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="custom-router-path">{t("toplevel.custom_router_path")}</Label>
                <Input
                  id="custom-router-path"
                  value={config.CUSTOM_ROUTER_PATH || ""}
                  onChange={(e) => setConfig({ ...config, CUSTOM_ROUTER_PATH: e.target.value })}
                  placeholder={t("toplevel.custom_router_path_placeholder")}
                />
              </div>

              {/* Language */}
              <div className="space-y-2 border-t pt-4">
                <Label>{t("settings.language")}</Label>
                <div className="flex gap-2">
                  <Button
                    variant={i18n.language.startsWith("en") ? "default" : "outline"}
                    size="sm"
                    onClick={() => i18n.changeLanguage("en")}
                  >
                    English
                  </Button>
                  <Button
                    variant={i18n.language.startsWith("zh") ? "default" : "outline"}
                    size="sm"
                    onClick={() => i18n.changeLanguage("zh")}
                  >
                    中文
                  </Button>
                </div>
              </div>
            </TabsContent>

            {/* Router Tab */}
            <TabsContent value="router" className="space-y-6">
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-3">{t("router.title")}</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <Label>{t("router.default")}</Label>
                    <Combobox
                      options={modelOptions}
                      value={routerConfig.default || ""}
                      onChange={(v) => handleRouterChange("default", v)}
                      placeholder={t("router.selectModel")}
                      searchPlaceholder={t("router.searchModel")}
                      emptyPlaceholder={t("router.noModelFound")}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("router.background")}</Label>
                    <Combobox
                      options={modelOptions}
                      value={routerConfig.background || ""}
                      onChange={(v) => handleRouterChange("background", v)}
                      placeholder={t("router.selectModel")}
                      searchPlaceholder={t("router.searchModel")}
                      emptyPlaceholder={t("router.noModelFound")}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("router.think")}</Label>
                    <Combobox
                      options={modelOptions}
                      value={routerConfig.think || ""}
                      onChange={(v) => handleRouterChange("think", v)}
                      placeholder={t("router.selectModel")}
                      searchPlaceholder={t("router.searchModel")}
                      emptyPlaceholder={t("router.noModelFound")}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t("router.webSearch")}</Label>
                    <Combobox
                      options={modelOptions}
                      value={routerConfig.webSearch || ""}
                      onChange={(v) => handleRouterChange("webSearch", v)}
                      placeholder={t("router.selectModel")}
                      searchPlaceholder={t("router.searchModel")}
                      emptyPlaceholder={t("router.noModelFound")}
                    />
                  </div>
                  <div className="space-y-1.5 col-span-2">
                    <div className="flex items-end gap-4">
                      <div className="flex-1">
                        <Label>{t("router.longContext")}</Label>
                        <Combobox
                          options={modelOptions}
                          value={routerConfig.longContext || ""}
                          onChange={(v) => handleRouterChange("longContext", v)}
                          placeholder={t("router.selectModel")}
                          searchPlaceholder={t("router.searchModel")}
                          emptyPlaceholder={t("router.noModelFound")}
                        />
                      </div>
                      <div className="w-32">
                        <Label>{t("router.longContextThreshold")}</Label>
                        <Input
                          type="number"
                          value={routerConfig.longContextThreshold || 60000}
                          onChange={(e) => handleRouterChange("longContextThreshold", parseInt(e.target.value) || 60000)}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="space-y-1.5 col-span-2">
                    <div className="flex items-end gap-4">
                      <div className="flex-1">
                        <Label>{t("router.extendedContext")}</Label>
                        <Combobox
                          options={modelOptions}
                          value={routerConfig.extendedContext || ""}
                          onChange={(v) => handleRouterChange("extendedContext", v)}
                          placeholder={t("router.selectModel")}
                          searchPlaceholder={t("router.searchModel")}
                          emptyPlaceholder={t("router.noModelFound")}
                        />
                      </div>
                      <div className="w-32">
                        <Label>{t("router.extendedContextThreshold")}</Label>
                        <Input
                          type="number"
                          value={routerConfig.extendedContextThreshold || 200000}
                          onChange={(e) => handleRouterChange("extendedContextThreshold", parseInt(e.target.value) || 200000)}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="space-y-1.5 col-span-2">
                    <div className="flex items-end gap-4">
                      <div className="flex-1">
                        <Label>{t("router.image")} (beta)</Label>
                        <Combobox
                          options={modelOptions}
                          value={routerConfig.image || ""}
                          onChange={(v) => handleRouterChange("image", v)}
                          placeholder={t("router.selectModel")}
                          searchPlaceholder={t("router.searchModel")}
                          emptyPlaceholder={t("router.noModelFound")}
                        />
                      </div>
                      <div className="w-32">
                        <Label htmlFor="forceUseImageAgent">{t("router.forceUseImageAgent")}</Label>
                        <select
                          id="forceUseImageAgent"
                          value={config.forceUseImageAgent ? "true" : "false"}
                          onChange={(e) => setConfig({ ...config, forceUseImageAgent: e.target.value === "true" })}
                          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        >
                          <option value="false">{t("common.no")}</option>
                          <option value="true">{t("common.yes")}</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Fallback Configuration */}
              <div className="border-t pt-4">
                <h3 className="text-sm font-medium text-gray-700 mb-1">{t("settings.fallback_title")}</h3>
                <p className="text-xs text-gray-500 mb-3">{t("settings.fallback_description")}</p>
                <div className="grid grid-cols-2 gap-4">
                  {FALLBACK_SCENARIOS.map((scenario) => (
                    <div key={scenario} className="space-y-1.5">
                      <Label>{t(`router.${scenario}`)}</Label>
                      <MultiCombobox
                        options={modelOptions}
                        value={config.fallback?.[scenario] || []}
                        onChange={(value) => handleFallbackChange(scenario, value)}
                        placeholder={t("router.selectModel")}
                        searchPlaceholder={t("router.searchModel")}
                        emptyPlaceholder={t("router.noModelFound")}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Model Family Routing */}
              <div className="border-t pt-4">
                <div className="mb-1">
                  <h3 className="text-sm font-medium text-gray-700">{t("router.family_routing")}</h3>
                  <p className="text-xs text-gray-500">{t("router.family_routing_desc")}</p>
                </div>
                {/* Predefined family buttons */}
                <div className="flex gap-2 mb-3">
                  {MODEL_FAMILIES.map((family) => {
                    const isConfigured = config.Router?.families?.[family];
                    return (
                      <Button
                        key={family}
                        variant={isConfigured ? "default" : "outline"}
                        size="sm"
                        onClick={() => handleAddFamily(family)}
                        className="capitalize"
                      >
                        {family}
                        {!isConfigured && " +"}
                      </Button>
                    );
                  })}
                </div>
                {/* Configured families */}
                {Object.entries(config.Router?.families || {}).filter(([name]) => MODEL_FAMILIES.includes(name as any)).map(([familyName, familyCfg]) => (
                  <div key={familyName} className="border rounded-lg p-4 mt-3">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-blue-600 capitalize">{familyName}</span>
                      </div>
                      <Button variant="ghost" size="sm" className="h-6 text-xs text-red-400 hover:text-red-600" onClick={() => handleRemoveFamily(familyName)}>
                        {t("router.remove_family")}
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label>{t("router.default")}</Label>
                        <Combobox
                          options={modelOptions}
                          value={(familyCfg as any).default || ""}
                          onChange={(v) => handleFamilyChange(familyName, "default", v)}
                          placeholder={t("router.selectModel")}
                          searchPlaceholder={t("router.searchModel")}
                          emptyPlaceholder={t("router.noModelFound")}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t("router.longContext")}</Label>
                        <Combobox
                          options={modelOptions}
                          value={(familyCfg as any).longContext || ""}
                          onChange={(v) => handleFamilyChange(familyName, "longContext", v)}
                          placeholder={t("router.selectModel")}
                          searchPlaceholder={t("router.searchModel")}
                          emptyPlaceholder={t("router.noModelFound")}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t("router.extendedContext")}</Label>
                        <Combobox
                          options={modelOptions}
                          value={(familyCfg as any).extendedContext || ""}
                          onChange={(v) => handleFamilyChange(familyName, "extendedContext", v)}
                          placeholder={t("router.selectModel")}
                          searchPlaceholder={t("router.searchModel")}
                          emptyPlaceholder={t("router.noModelFound")}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t("router.think")}</Label>
                        <Combobox
                          options={modelOptions}
                          value={(familyCfg as any).think || ""}
                          onChange={(v) => handleFamilyChange(familyName, "think", v)}
                          placeholder={t("router.selectModel")}
                          searchPlaceholder={t("router.searchModel")}
                          emptyPlaceholder={t("router.noModelFound")}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t("router.webSearch")}</Label>
                        <Combobox
                          options={modelOptions}
                          value={(familyCfg as any).webSearch || ""}
                          onChange={(v) => handleFamilyChange(familyName, "webSearch", v)}
                          placeholder={t("router.selectModel")}
                          searchPlaceholder={t("router.searchModel")}
                          emptyPlaceholder={t("router.noModelFound")}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>{t("router.image")}</Label>
                        <Combobox
                          options={modelOptions}
                          value={(familyCfg as any).image || ""}
                          onChange={(v) => handleFamilyChange(familyName, "image", v)}
                          placeholder={t("router.selectModel")}
                          searchPlaceholder={t("router.searchModel")}
                          emptyPlaceholder={t("router.noModelFound")}
                        />
                      </div>
                    </div>
                    {/* Family Fallback */}
                    <div className="border-t mt-3 pt-3">
                      <h4 className="text-xs font-medium text-gray-500 mb-2">{t("router.family_fallback_title")}</h4>
                      <div className="grid grid-cols-2 gap-3">
                        {FALLBACK_SCENARIOS.map((scenario) => (
                          <div key={`${familyName}-${scenario}`} className="space-y-1">
                            <Label className="text-xs">{t(`router.${scenario}`)}</Label>
                            <MultiCombobox
                              options={modelOptions}
                              value={(familyCfg as any).fallback?.[scenario] || []}
                              onChange={(value) => handleFamilyFallbackChange(familyName, scenario, value)}
                              placeholder={t("router.selectModel")}
                              searchPlaceholder={t("router.searchModel")}
                              emptyPlaceholder={t("router.noModelFound")}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </TabsContent>

            {/* Tools Tab */}
            <TabsContent value="tools" className="space-y-2">
              {tools.map((tool) => (
                <button
                  key={tool.label}
                  className="w-full flex items-center gap-3 rounded-lg border p-4 text-left hover:bg-gray-50 transition-colors"
                  onClick={() => navigate(tool.href)}
                >
                  <tool.icon className="h-5 w-5 text-gray-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{tool.label}</div>
                    <div className="text-xs text-gray-500">{tool.desc}</div>
                  </div>
                </button>
              ))}
            </TabsContent>
          </Tabs>
        </div>
      </main>

      <StatusLineConfigDialog
        isOpen={isStatusLineConfigOpen}
        onOpenChange={setIsStatusLineConfigOpen}
        data-testid="statusline-config-dialog"
      />

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}