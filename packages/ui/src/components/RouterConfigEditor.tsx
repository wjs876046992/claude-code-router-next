import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { MultiCombobox } from "@/components/ui/multi-combobox";
import { MODEL_FAMILIES } from "@/types";

const FALLBACK_SCENARIOS = ["default", "think", "longContext", "extendedContext", "webSearch", "image"] as const;
const SCENARIOS = ["default", "background", "think", "webSearch", "image"] as const;

interface RouterConfigEditorProps {
  value: Record<string, any>;
  onChange: (value: Record<string, any>) => void;
  modelOptions: { label: string; value: string }[];
}

export function RouterConfigEditor({ value, onChange, modelOptions }: RouterConfigEditorProps) {
  const { t } = useTranslation();
  const [expandedFamily, setExpandedFamily] = useState<string | null>(null);

  const update = (field: string, val: any) => {
    onChange({ ...value, [field]: val });
  };

  const handleFallbackChange = (scenario: string, models: string[]) => {
    const fallback = { ...(value.fallback || {}) };
    if (models.length === 0) {
      delete fallback[scenario];
    } else {
      fallback[scenario] = models;
    }
    if (Object.keys(fallback).length === 0) {
      const { fallback: _omit, ...rest } = value;
      onChange(rest);
    } else {
      onChange({ ...value, fallback });
    }
  };

  const handleAddFamily = (familyName: string) => {
    const families = value.families || {};
    if (expandedFamily === familyName) {
      setExpandedFamily(null);
      return;
    }
    if (!families[familyName]) {
      const firstModel = modelOptions.length > 0 ? modelOptions[0].value : "";
      onChange({ ...value, families: { ...families, [familyName]: { default: firstModel } } });
    }
    setExpandedFamily(familyName);
  };

  const handleRemoveFamily = (familyName: string) => {
    const families = { ...(value.families || {}) };
    delete families[familyName];
    onChange({ ...value, families });
  };

  const handleFamilyChange = (familyName: string, field: string, val: string | boolean) => {
    const families = { ...(value.families || {}) };
    families[familyName] = { ...(families[familyName] || {}), [field]: val };
    onChange({ ...value, families });
  };

  const handleFamilyFallbackChange = (familyName: string, scenario: string, models: string[]) => {
    const families = { ...(value.families || {}) };
    const family = { ...(families[familyName] || {}) };
    const fallback = { ...(family.fallback || {}) };
    if (models.length === 0) {
      delete fallback[scenario];
    } else {
      fallback[scenario] = models;
    }
    family.fallback = fallback;
    families[familyName] = family;
    onChange({ ...value, families });
  };

  return (
    <div className="space-y-6">
      {/* Scenario models */}
      <div className="grid grid-cols-2 gap-4">
        {SCENARIOS.map((scenario) => (
          <div key={scenario} className="space-y-1.5">
            <Label>{t(`router.${scenario}`)}</Label>
            <Combobox
              options={modelOptions}
              value={value[scenario] || ""}
              onChange={(v) => update(scenario, v)}
              placeholder={t("router.selectModel")}
              searchPlaceholder={t("router.searchModel")}
              emptyPlaceholder={t("router.noModelFound")}
            />
          </div>
        ))}

        {/* Long Context */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label>{t("router.longContext")}</Label>
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-400">{t("router.longContextThreshold")}:</span>
              <Input
                type="number"
                value={value.longContextThreshold || 60000}
                onChange={(e) => update("longContextThreshold", parseInt(e.target.value) || 60000)}
                className="h-5 w-20 text-[10px] px-1 py-0"
              />
            </div>
          </div>
          <Combobox
            options={modelOptions}
            value={value.longContext || ""}
            onChange={(v) => update("longContext", v)}
            placeholder={t("router.selectModel")}
            searchPlaceholder={t("router.searchModel")}
            emptyPlaceholder={t("router.noModelFound")}
          />
        </div>

        {/* Extended Context */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Switch
                checked={value.enableExtendedContext ?? false}
                onCheckedChange={(checked) => update("enableExtendedContext", checked)}
              />
              <Label className="cursor-pointer">{t("router.extendedContext")}</Label>
            </div>
            {value.enableExtendedContext && (
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-gray-400">{t("router.extendedContextThreshold")}:</span>
                <Input
                  type="number"
                  value={value.extendedContextThreshold || 200000}
                  onChange={(e) => update("extendedContextThreshold", parseInt(e.target.value) || 200000)}
                  className="h-5 w-20 text-[10px] px-1 py-0"
                />
              </div>
            )}
          </div>
          <div className={value.enableExtendedContext ? "" : "opacity-50 pointer-events-none"}>
            <Combobox
              options={modelOptions}
              value={value.extendedContext || ""}
              onChange={(v) => update("extendedContext", v)}
              placeholder={t("router.selectModel")}
              searchPlaceholder={t("router.searchModel")}
              emptyPlaceholder={t("router.noModelFound")}
            />
          </div>
        </div>
      </div>

      {/* Fallback Configuration */}
      <div className="border-t pt-4">
        <div className="flex items-center justify-between mb-1">
          <div>
            <h4 className="text-sm font-medium text-gray-700">{t("settings.fallback_title")}</h4>
            <p className="text-xs text-gray-500">{t("settings.fallback_description")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={value.enableFallback ?? false}
              onCheckedChange={(checked) => update("enableFallback", checked)}
            />
            <Label className="text-xs text-gray-500">
              {value.enableFallback ? t("router.enabled") : t("router.disabled")}
            </Label>
          </div>
        </div>
        <div className={`grid grid-cols-2 gap-4 mb-3 transition-opacity ${value.enableFallback ? "" : "opacity-50 pointer-events-none"}`}>
          {FALLBACK_SCENARIOS.map((scenario) => (
            <div key={scenario} className="space-y-1.5">
              <Label>{t(`router.${scenario}`)}</Label>
              <MultiCombobox
                options={modelOptions}
                value={value.fallback?.[scenario] || []}
                onChange={(models) => handleFallbackChange(scenario, models)}
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
        <div className="flex items-center justify-between mb-1">
          <div>
            <h4 className="text-sm font-medium text-gray-700">{t("router.family_routing")}</h4>
            <p className="text-xs text-gray-500">{t("router.family_routing_desc")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              checked={value.enableFamilyRouting ?? false}
              onCheckedChange={(checked) => update("enableFamilyRouting", checked)}
            />
            <Label className="text-xs text-gray-500">
              {value.enableFamilyRouting ? t("router.enabled") : t("router.disabled")}
            </Label>
          </div>
        </div>
        <div className={`flex gap-2 mb-3 transition-opacity ${value.enableFamilyRouting ? "" : "opacity-50 pointer-events-none"}`}>
          {MODEL_FAMILIES.map((family) => {
            const isConfigured = value.families?.[family];
            const isExpanded = expandedFamily === family;
            return (
              <Button
                key={family}
                variant="outline"
                size="sm"
                onClick={() => handleAddFamily(family)}
                className={`capitalize ${
                  isExpanded
                    ? "bg-blue-500 hover:bg-blue-600 text-white border-blue-500 ring-2 ring-blue-300 shadow-sm"
                    : isConfigured
                      ? "bg-blue-100 text-blue-700 border-blue-300 hover:bg-blue-200"
                      : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {family}
                {!isConfigured && !isExpanded && " +"}
              </Button>
            );
          })}
        </div>
        {expandedFamily && value.families?.[expandedFamily] && (
          <div className="border rounded-lg p-4 mt-3 bg-blue-50/30">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-blue-600 capitalize">{expandedFamily}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-xs text-red-400 hover:text-red-600"
                onClick={() => {
                  handleRemoveFamily(expandedFamily);
                  setExpandedFamily(null);
                }}
              >
                {t("router.remove_family")}
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t("router.default")}</Label>
                <Combobox
                  options={modelOptions}
                  value={value.families[expandedFamily]?.default || ""}
                  onChange={(v) => handleFamilyChange(expandedFamily, "default", v)}
                  placeholder={t("router.selectModel")}
                  searchPlaceholder={t("router.searchModel")}
                  emptyPlaceholder={t("router.noModelFound")}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("router.longContext")}</Label>
                <Combobox
                  options={modelOptions}
                  value={value.families[expandedFamily]?.longContext || ""}
                  onChange={(v) => handleFamilyChange(expandedFamily, "longContext", v)}
                  placeholder={t("router.selectModel")}
                  searchPlaceholder={t("router.searchModel")}
                  emptyPlaceholder={t("router.noModelFound")}
                />
              </div>
              <div className="space-y-1.5 flex items-center gap-2">
                <Switch
                  checked={value.families[expandedFamily]?.enableExtendedContext ?? false}
                  onCheckedChange={(checked) => handleFamilyChange(expandedFamily, "enableExtendedContext", checked)}
                />
                <div className="flex flex-col">
                  <Label className="text-sm">{t("router.enableExtendedContext")}</Label>
                  <span className="text-xs text-gray-500">{t("router.enableExtendedContextDesc")}</span>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>{t("router.extendedContext")}</Label>
                <Combobox
                  options={modelOptions}
                  value={value.families[expandedFamily]?.extendedContext || ""}
                  onChange={(v) => handleFamilyChange(expandedFamily, "extendedContext", v)}
                  placeholder={t("router.selectModel")}
                  searchPlaceholder={t("router.searchModel")}
                  emptyPlaceholder={t("router.noModelFound")}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("router.think")}</Label>
                <Combobox
                  options={modelOptions}
                  value={value.families[expandedFamily]?.think || ""}
                  onChange={(v) => handleFamilyChange(expandedFamily, "think", v)}
                  placeholder={t("router.selectModel")}
                  searchPlaceholder={t("router.searchModel")}
                  emptyPlaceholder={t("router.noModelFound")}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("router.webSearch")}</Label>
                <Combobox
                  options={modelOptions}
                  value={value.families[expandedFamily]?.webSearch || ""}
                  onChange={(v) => handleFamilyChange(expandedFamily, "webSearch", v)}
                  placeholder={t("router.selectModel")}
                  searchPlaceholder={t("router.searchModel")}
                  emptyPlaceholder={t("router.noModelFound")}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("router.image")}</Label>
                <Combobox
                  options={modelOptions}
                  value={value.families[expandedFamily]?.image || ""}
                  onChange={(v) => handleFamilyChange(expandedFamily, "image", v)}
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
                  <div key={`${expandedFamily}-${scenario}`} className="space-y-1">
                    <Label className="text-xs">{t(`router.${scenario}`)}</Label>
                    <MultiCombobox
                      options={modelOptions}
                      value={value.families[expandedFamily]?.fallback?.[scenario] || []}
                      onChange={(models) => handleFamilyFallbackChange(expandedFamily, scenario, models)}
                      placeholder={t("router.selectModel")}
                      searchPlaceholder={t("router.searchModel")}
                      emptyPlaceholder={t("router.noModelFound")}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
