import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useConfig } from "./ConfigProvider";
import { Combobox } from "./ui/combobox";

export function Router() {
  const { t } = useTranslation();
  const { config, setConfig } = useConfig();

  // Handle case where config is null or undefined
  if (!config) {
    return (
      <Card className="flex h-full flex-col rounded-lg border shadow-sm">
        <CardHeader className="border-b p-4">
          <CardTitle className="text-lg">{t("router.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex-grow flex items-center justify-center p-4">
          <div className="text-gray-500">Loading router configuration...</div>
        </CardContent>
      </Card>
    );
  }

  // Handle case where config.Router is null or undefined
  const routerConfig = config.Router || {
    default: "",
    think: "",
    longContext: "",
    longContextThreshold: 60000,
    webSearch: "",
    image: ""
  };

  const handleRouterChange = (field: string, value: string | number | boolean) => {
    // Handle case where config.Router might be null or undefined
    const currentRouter = config.Router || {};
    const newRouter = { ...currentRouter, [field]: value };
    setConfig({ ...config, Router: newRouter });
  };

  const handleForceUseImageAgentChange = (value: boolean) => {
    setConfig({ ...config, forceUseImageAgent: value });
  };

  // Handle case where config.Providers might be null or undefined
  const providers = Array.isArray(config.Providers) ? config.Providers : [];
  
  const modelOptions = providers.flatMap((provider) => {
    // Handle case where individual provider might be null or undefined
    if (!provider) return [];
    
    // Handle case where provider.models might be null or undefined
    const models = Array.isArray(provider.models) ? provider.models : [];
    
    // Handle case where provider.name might be null or undefined
    const providerName = provider.name || "Unknown Provider";
    
    return models.map((model) => ({
      value: `${providerName},${model || "Unknown Model"}`,
      label: `${providerName}, ${model || "Unknown Model"}`,
    }));
  });

  return (
    <Card className="flex h-full flex-col glass-card border-white/10 shadow-xl overflow-hidden">
      <CardHeader className="border-b border-white/10 bg-white/5 p-5">
        <CardTitle className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
          {t("router.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-grow space-y-6 overflow-y-auto p-6 custom-scrollbar">
        <div className="space-y-3 animate-in" style={{ animationDelay: '0.1s' }}>
          <Label className="text-sm font-bold ml-1 text-muted-foreground/80 uppercase tracking-wider">{t("router.default")}</Label>
          <Combobox
            options={modelOptions}
            value={routerConfig.default || ""}
            onChange={(value) => handleRouterChange("default", value)}
            placeholder={t("router.selectModel")}
            searchPlaceholder={t("router.searchModel")}
            emptyPlaceholder={t("router.noModelFound")}
          />
        </div>

        <div className="space-y-3 animate-in" style={{ animationDelay: '0.2s' }}>
          <div className="flex items-center gap-4">
            <div className="flex-1 space-y-3">
              <Label className="text-sm font-bold ml-1 text-muted-foreground/80 uppercase tracking-wider">{t("router.longContext")}</Label>
              <Combobox
                options={modelOptions}
                value={routerConfig.longContext || ""}
                onChange={(value) => handleRouterChange("longContext", value)}
                placeholder={t("router.selectModel")}
                searchPlaceholder={t("router.searchModel")}
                emptyPlaceholder={t("router.noModelFound")}
              />
            </div>
            <div className="w-40 space-y-3">
              <Label className="text-sm font-bold ml-1 text-muted-foreground/80 uppercase tracking-wider">{t("router.threshold")}</Label>
              <Input
                type="number"
                value={routerConfig.longContextThreshold || 60000}
                onChange={(e) => handleRouterChange("longContextThreshold", parseInt(e.target.value) || 60000)}
                className="bg-input/50 border border-input text-center font-mono"
              />
            </div>
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-white/5 border border-white/10 space-y-4 animate-in" style={{ animationDelay: '0.3s' }}>
          <div className="flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <Label htmlFor="enable-extended-context" className="text-base font-bold">
                {t("router.enableExtendedContext")}
              </Label>
              <span className="text-xs text-muted-foreground/60 leading-tight">
                {t("router.enableExtendedContextDesc")}
              </span>
            </div>
            <Switch
              id="enable-extended-context"
              checked={routerConfig.enableExtendedContext ?? false}
              onCheckedChange={(checked) => handleRouterChange("enableExtendedContext", checked)}
              className="data-[state=checked]:bg-primary"
            />
          </div>
          
          {routerConfig.enableExtendedContext && (
            <div className="flex items-center gap-4 pt-2 animate-in">
              <div className="flex-1 space-y-3">
                <Label className="text-sm font-bold ml-1 text-muted-foreground/80 uppercase tracking-wider">{t("router.extendedContext")}</Label>
                <Combobox
                  options={modelOptions}
                  value={routerConfig.extendedContext || ""}
                  onChange={(value) => handleRouterChange("extendedContext", value)}
                  placeholder={t("router.selectModel")}
                />
              </div>
              <div className="w-40 space-y-3">
                <Label className="text-sm font-bold ml-1 text-muted-foreground/80 uppercase tracking-wider">{t("router.threshold")}</Label>
                <Input
                  type="number"
                  value={routerConfig.extendedContextThreshold || 200000}
                  onChange={(e) => handleRouterChange("extendedContextThreshold", parseInt(e.target.value) || 200000)}
                  className="bg-input/50 border border-input text-center font-mono"
                />
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-6 pt-2">
          <div className="space-y-3 animate-in" style={{ animationDelay: '0.4s' }}>
            <Label className="text-sm font-bold ml-1 text-muted-foreground/80 uppercase tracking-wider">{t("router.think")}</Label>
            <Combobox
              options={modelOptions}
              value={routerConfig.think || ""}
              onChange={(value) => handleRouterChange("think", value)}
              placeholder={t("router.selectModel")}
            />
          </div>

          <div className="space-y-3 animate-in" style={{ animationDelay: '0.5s' }}>
            <Label className="text-sm font-bold ml-1 text-muted-foreground/80 uppercase tracking-wider">{t("router.webSearch")}</Label>
            <Combobox
              options={modelOptions}
              value={routerConfig.webSearch || ""}
              onChange={(value) => handleRouterChange("webSearch", value)}
              placeholder={t("router.selectModel")}
            />
          </div>

          <div className="space-y-3 animate-in" style={{ animationDelay: '0.6s' }}>
            <div className="flex items-center gap-4">
              <div className="flex-1 space-y-3">
                <Label className="text-sm font-bold ml-1 text-muted-foreground/80 uppercase tracking-wider">{t("router.image")} <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded-full ml-1">BETA</span></Label>
                <Combobox
                  options={modelOptions}
                  value={routerConfig.image || ""}
                  onChange={(value) => handleRouterChange("image", value)}
                  placeholder={t("router.selectModel")}
                />
              </div>
              <div className="w-40 space-y-3">
                <Label className="text-sm font-bold ml-1 text-muted-foreground/80 uppercase tracking-wider">{t("router.forceAgent")}</Label>
                <select
                  id="forceUseImageAgent"
                  value={config.forceUseImageAgent ? "true" : "false"}
                  onChange={(e) => handleForceUseImageAgentChange(e.target.value === "true")}
                  className="w-full h-11 px-4 py-2 rounded-xl bg-input/50 border border-input text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary/50 transition-all appearance-none cursor-pointer"
                >
                  <option value="false" className="bg-background">{t("common.no")}</option>
                  <option value="true" className="bg-background">{t("common.yes")}</option>
                </select>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
