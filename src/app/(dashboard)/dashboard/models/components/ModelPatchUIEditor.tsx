"use client";

import { useState, useMemo } from "react";
import { Button, Card, Input, Badge, Toggle } from "@/shared/components";
import Modal from "@/shared/components/Modal";
import { matchesSearch } from "@/shared/utils/turkishText";
import { useModelPatchesI18n, isChineseLocale } from "./i18n";
import type { PatchRuleEntry } from "./ModelPatchRulesList";
import type { ModelPatch } from "@/lib/models/modelPatches";

interface ModelPatchUIEditorProps {
  entries: PatchRuleEntry[];
  onRefresh: () => Promise<void> | void;
  onInspect: (modelId: string, provider: string) => void;
  prefillPattern?: string;
  prefillProvider?: string;
}

interface RuleFormData {
  provider: string;
  modelPattern: string;
  name: string;
  description: string;
  contextLength: string;
  maxOutputTokens: string;
  supportsVision: boolean;
  supportsThinking: boolean;
  effortTiers: string[];
  supportsTools: boolean;
  supportedParameters: string[];
  inputModalities: string[];
  outputModalities: string[];
}

const COMMON_PROVIDERS = [
  "nvidia",
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "groq",
  "mistral",
  "together",
  "openrouter",
  "cohere",
  "bedrock",
  "vertex",
  "ollama",
  "vllm",
];

const PRESET_PARAMETERS = [
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "reasoning_effort",
  "max_completion_tokens",
  "response_format",
  "modalities",
  "stream",
  "seed",
  "stop",
  "frequency_penalty",
  "presence_penalty",
];

const CONTEXT_PRESETS = [
  { label: "32K", value: 32768 },
  { label: "64K", value: 65536 },
  { label: "128K", value: 131072 },
  { label: "200K", value: 200000 },
  { label: "1M", value: 1048576 },
  { label: "2M", value: 2097152 },
];

const OUTPUT_PRESETS = [
  { label: "4K", value: 4096 },
  { label: "8K", value: 8192 },
  { label: "16K", value: 16384 },
  { label: "32K", value: 32768 },
  { label: "64K", value: 65536 },
  { label: "128K", value: 131072 },
];

export default function ModelPatchUIEditor({
  entries,
  onRefresh,
  onInspect,
}: ModelPatchUIEditorProps) {
  const i18n = useModelPatchesI18n();
  const isZh = isChineseLocale();

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [capabilityFilter, setCapabilityFilter] = useState<"all" | "vision" | "thinking" | "tools">(
    "all"
  );
  const [viewMode, setViewMode] = useState<"grid" | "table">("grid");

  // Modal form state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit" | "duplicate">("create");
  const [originalEntry, setOriginalEntry] = useState<{
    provider: string;
    modelPattern: string;
  } | null>(null);
  const [formData, setFormData] = useState<RuleFormData>({
    provider: "nvidia",
    modelPattern: "",
    name: "",
    description: "",
    contextLength: "",
    maxOutputTokens: "",
    supportsVision: false,
    supportsThinking: false,
    effortTiers: ["low", "medium", "high"],
    supportsTools: false,
    supportedParameters: ["temperature", "top_p"],
    inputModalities: ["text"],
    outputModalities: ["text"],
  });
  const [customParamInput, setCustomParamInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<PatchRuleEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Success / Status toast
  const [notification, setNotification] = useState<{
    message: string;
    type: "success" | "error";
  } | null>(null);

  const showNotification = (message: string, type: "success" | "error" = "success") => {
    setNotification({ message, type });
    setTimeout(() => {
      setNotification((curr) => (curr?.message === message ? null : curr));
    }, 4000);
  };

  // Distinct providers in current rules
  const ruleProviders = useMemo(() => {
    return Array.from(new Set(entries.map((e) => e.provider))).sort();
  }, [entries]);

  // Combined providers for selector
  const availableProviders = useMemo(() => {
    return Array.from(new Set([...ruleProviders, ...COMMON_PROVIDERS])).sort();
  }, [ruleProviders]);

  // Statistics
  const stats = useMemo(() => {
    let visionCount = 0;
    let thinkingCount = 0;
    let toolsCount = 0;

    for (const e of entries) {
      const caps = (e.patch.capabilities || {}) as Record<string, unknown>;
      if (caps.vision === true || e.patch.supportsVision === true) visionCount++;
      if (caps.thinking === true || caps.reasoning === true || e.patch.supportsThinking === true)
        thinkingCount++;
      if (caps.tool_calling === true || e.patch.supportsTools === true) toolsCount++;
    }

    return {
      total: entries.length,
      providers: ruleProviders.length,
      vision: visionCount,
      thinking: thinkingCount,
      tools: toolsCount,
    };
  }, [entries, ruleProviders]);

  // Filtered rules
  const filteredEntries = useMemo(() => {
    return entries.filter((entry) => {
      // Provider filter
      if (providerFilter !== "all" && entry.provider !== providerFilter) return false;

      // Capability filter
      const caps = (entry.patch.capabilities || {}) as Record<string, unknown>;
      const isVision = caps.vision === true || entry.patch.supportsVision === true;
      const isThinking =
        caps.thinking === true || caps.reasoning === true || entry.patch.supportsThinking === true;
      const isTools = caps.tool_calling === true || entry.patch.supportsTools === true;

      if (capabilityFilter === "vision" && !isVision) return false;
      if (capabilityFilter === "thinking" && !isThinking) return false;
      if (capabilityFilter === "tools" && !isTools) return false;

      // Text search
      if (!searchQuery.trim()) return true;
      const name = String(entry.patch.name || entry.patch.displayName || "");
      const desc = String(entry.patch.description || "");
      return (
        matchesSearch(entry.modelPattern, searchQuery) ||
        matchesSearch(name, searchQuery) ||
        matchesSearch(entry.provider, searchQuery) ||
        matchesSearch(desc, searchQuery)
      );
    });
  }, [entries, providerFilter, capabilityFilter, searchQuery]);

  // Open modal helpers
  const handleOpenCreate = () => {
    setModalMode("create");
    setOriginalEntry(null);
    setFormData({
      provider: providerFilter !== "all" ? providerFilter : "nvidia",
      modelPattern: "",
      name: "",
      description: "",
      contextLength: "131072",
      maxOutputTokens: "4096",
      supportsVision: false,
      supportsThinking: false,
      effortTiers: ["low", "medium", "high"],
      supportsTools: true,
      supportedParameters: ["tools", "temperature", "top_p"],
      inputModalities: ["text"],
      outputModalities: ["text"],
    });
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (entry: PatchRuleEntry) => {
    setModalMode("edit");
    setOriginalEntry({ provider: entry.provider, modelPattern: entry.modelPattern });

    const p = entry.patch;
    const caps = (p.capabilities || {}) as Record<string, unknown>;
    const isVision = caps.vision === true || p.supportsVision === true;
    const isThinking =
      caps.thinking === true || caps.reasoning === true || p.supportsThinking === true;
    const isTools = caps.tool_calling === true || p.supportsTools === true;
    const effortTiers = Array.isArray(caps.effort_tiers)
      ? (caps.effort_tiers as string[])
      : ["low", "medium", "high"];

    const supportedParams = Array.isArray(p.supported_parameters)
      ? (p.supported_parameters as string[])
      : [];

    const inputMods = Array.isArray(p.input_modalities)
      ? (p.input_modalities as string[])
      : isVision
        ? ["text", "image"]
        : ["text"];

    const outputMods = Array.isArray(p.output_modalities)
      ? (p.output_modalities as string[])
      : ["text"];

    const ctx = p.context_length ?? p.contextWindow ?? p.inputTokenLimit;
    const out = p.max_output_tokens ?? p.outputTokenLimit;

    setFormData({
      provider: entry.provider,
      modelPattern: entry.modelPattern,
      name: String(p.name || p.displayName || ""),
      description: String(p.description || ""),
      contextLength: ctx ? String(ctx) : "",
      maxOutputTokens: out ? String(out) : "",
      supportsVision: Boolean(isVision),
      supportsThinking: Boolean(isThinking),
      effortTiers,
      supportsTools: Boolean(isTools),
      supportedParameters: supportedParams,
      inputModalities: inputMods,
      outputModalities: outputMods,
    });
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleOpenDuplicate = (entry: PatchRuleEntry) => {
    setModalMode("duplicate");
    setOriginalEntry(null);

    const p = entry.patch;
    const caps = (p.capabilities || {}) as Record<string, unknown>;
    const isVision = caps.vision === true || p.supportsVision === true;
    const isThinking =
      caps.thinking === true || caps.reasoning === true || p.supportsThinking === true;
    const isTools = caps.tool_calling === true || p.supportsTools === true;
    const effortTiers = Array.isArray(caps.effort_tiers)
      ? (caps.effort_tiers as string[])
      : ["low", "medium", "high"];

    const supportedParams = Array.isArray(p.supported_parameters)
      ? (p.supported_parameters as string[])
      : [];

    const ctx = p.context_length ?? p.contextWindow ?? p.inputTokenLimit;
    const out = p.max_output_tokens ?? p.outputTokenLimit;

    setFormData({
      provider: entry.provider,
      modelPattern: `${entry.modelPattern}-copy`,
      name: p.name ? `${p.name} (Copy)` : "",
      description: String(p.description || ""),
      contextLength: ctx ? String(ctx) : "",
      maxOutputTokens: out ? String(out) : "",
      supportsVision: Boolean(isVision),
      supportsThinking: Boolean(isThinking),
      effortTiers,
      supportsTools: Boolean(isTools),
      supportedParameters: supportedParams,
      inputModalities: Array.isArray(p.input_modalities)
        ? (p.input_modalities as string[])
        : ["text"],
      outputModalities: Array.isArray(p.output_modalities)
        ? (p.output_modalities as string[])
        : ["text"],
    });
    setFormError(null);
    setIsModalOpen(true);
  };

  // Parameter chip helpers
  const handleToggleParam = (param: string) => {
    setFormData((prev) => {
      const exists = prev.supportedParameters.includes(param);
      return {
        ...prev,
        supportedParameters: exists
          ? prev.supportedParameters.filter((p) => p !== param)
          : [...prev.supportedParameters, param],
      };
    });
  };

  const handleAddCustomParam = () => {
    const trimmed = customParamInput.trim().toLowerCase();
    if (!trimmed) return;
    if (!formData.supportedParameters.includes(trimmed)) {
      setFormData((prev) => ({
        ...prev,
        supportedParameters: [...prev.supportedParameters, trimmed],
      }));
    }
    setCustomParamInput("");
  };

  const handleRemoveParam = (param: string) => {
    setFormData((prev) => ({
      ...prev,
      supportedParameters: prev.supportedParameters.filter((p) => p !== param),
    }));
  };

  const handleToggleEffortTier = (tier: string) => {
    setFormData((prev) => {
      const exists = prev.effortTiers.includes(tier);
      const next = exists
        ? prev.effortTiers.filter((t) => t !== tier)
        : [...prev.effortTiers, tier];
      return { ...prev, effortTiers: next };
    });
  };

  // Submit save
  const handleSaveRule = async () => {
    const provider = formData.provider.trim().toLowerCase();
    const modelPattern = formData.modelPattern.trim();

    if (!provider) {
      setFormError(isZh ? "请输入或选择提供商" : "Provider is required");
      return;
    }
    if (!modelPattern) {
      setFormError(isZh ? "请输入模型匹配模式或 ID" : "Model pattern or ID is required");
      return;
    }

    setSaving(true);
    setFormError(null);

    try {
      // Build clean ModelPatch object
      const patchObj: ModelPatch = {};

      if (formData.name.trim()) patchObj.name = formData.name.trim();
      if (formData.description.trim()) patchObj.description = formData.description.trim();

      const ctxNum = parseInt(formData.contextLength, 10);
      if (!Number.isNaN(ctxNum) && ctxNum > 0) {
        patchObj.context_length = ctxNum;
      }

      const outNum = parseInt(formData.maxOutputTokens, 10);
      if (!Number.isNaN(outNum) && outNum > 0) {
        patchObj.max_output_tokens = outNum;
      }

      // Capabilities
      const caps: Record<string, unknown> = {
        vision: formData.supportsVision,
        thinking: formData.supportsThinking,
        tool_calling: formData.supportsTools,
      };

      if (formData.supportsThinking && formData.effortTiers.length > 0) {
        caps.effort_tiers = formData.effortTiers;
      }

      patchObj.capabilities = caps;
      patchObj.supportsVision = formData.supportsVision;
      patchObj.supportsThinking = formData.supportsThinking;
      patchObj.supportsTools = formData.supportsTools;

      // Supported parameters
      if (formData.supportedParameters.length > 0) {
        patchObj.supported_parameters = formData.supportedParameters;
      }

      // Modalities
      const inputMods = [...formData.inputModalities];
      if (formData.supportsVision && !inputMods.includes("image")) {
        inputMods.push("image");
      }
      patchObj.input_modalities = inputMods;
      patchObj.output_modalities = formData.outputModalities;

      const payload = {
        provider,
        modelPattern,
        patch: patchObj,
        oldProvider: modalMode === "edit" ? originalEntry?.provider : undefined,
        oldModelPattern: modalMode === "edit" ? originalEntry?.modelPattern : undefined,
      };

      const res = await fetch("/api/models/patches/entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to save patch rule");
      }

      setIsModalOpen(false);
      showNotification(i18n.saveRuleSuccess, "success");
      await onRefresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Error saving rule");
    } finally {
      setSaving(false);
    }
  };

  // Submit delete
  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;

    setDeleting(true);
    try {
      const res = await fetch("/api/models/patches/entry", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: deleteTarget.provider,
          modelPattern: deleteTarget.modelPattern,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to delete patch rule");
      }

      setDeleteTarget(null);
      showNotification(i18n.deleteRuleSuccess, "success");
      await onRefresh();
    } catch (err) {
      showNotification(err instanceof Error ? err.message : "Delete failed", "error");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Toast Notification */}
      {notification && (
        <div
          className={`p-3.5 rounded-lg border text-xs flex items-center justify-between gap-3 shadow-sm transition-all ${
            notification.type === "success"
              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400"
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[18px]">
              {notification.type === "success" ? "check_circle" : "error"}
            </span>
            <span className="font-medium">{notification.message}</span>
          </div>
          <button type="button" onClick={() => setNotification(null)} className="hover:opacity-75">
            <span className="material-symbols-outlined text-[16px]">close</span>
          </button>
        </div>
      )}

      {/* Top Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <Card padding="none" className="p-3.5 border border-border">
          <div className="flex items-center gap-3">
            <div className="size-9 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[20px]">dataset</span>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] text-text-muted uppercase tracking-wider font-medium truncate">
                {i18n.statTotalRules}
              </p>
              <p className="text-xl font-bold text-text-main font-mono">{stats.total}</p>
            </div>
          </div>
        </Card>

        <Card padding="none" className="p-3.5 border border-border">
          <div className="flex items-center gap-3">
            <div className="size-9 rounded-lg bg-amber-500/10 text-amber-500 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[20px]">hub</span>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] text-text-muted uppercase tracking-wider font-medium truncate">
                {i18n.statProviders}
              </p>
              <p className="text-xl font-bold text-text-main font-mono">{stats.providers}</p>
            </div>
          </div>
        </Card>

        <Card padding="none" className="p-3.5 border border-border">
          <div className="flex items-center gap-3">
            <div className="size-9 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[20px]">visibility</span>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] text-text-muted uppercase tracking-wider font-medium truncate">
                {i18n.statVision}
              </p>
              <p className="text-xl font-bold text-text-main font-mono">{stats.vision}</p>
            </div>
          </div>
        </Card>

        <Card padding="none" className="p-3.5 border border-border">
          <div className="flex items-center gap-3">
            <div className="size-9 rounded-lg bg-indigo-500/10 text-indigo-500 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[20px]">psychology</span>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] text-text-muted uppercase tracking-wider font-medium truncate">
                {i18n.statThinking}
              </p>
              <p className="text-xl font-bold text-text-main font-mono">{stats.thinking}</p>
            </div>
          </div>
        </Card>

        <Card padding="none" className="p-3.5 border border-border col-span-2 sm:col-span-1">
          <div className="flex items-center gap-3">
            <div className="size-9 rounded-lg bg-purple-500/10 text-purple-500 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[20px]">construction</span>
            </div>
            <div className="min-w-0">
              <p className="text-[11px] text-text-muted uppercase tracking-wider font-medium truncate">
                {i18n.statTools}
              </p>
              <p className="text-xl font-bold text-text-main font-mono">{stats.tools}</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Main Filter & Action Card */}
      <Card padding="none" className="overflow-hidden border border-border">
        {/* Toolbar Header */}
        <div className="p-4 border-b border-border flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          {/* Search & Provider dropdown */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 flex-1">
            <div className="flex-1 max-w-md">
              <Input
                icon="search"
                placeholder={i18n.searchPlaceholder}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="text-xs"
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted whitespace-nowrap">
                {i18n.filterProvider}:
              </span>
              <select
                value={providerFilter}
                onChange={(e) => setProviderFilter(e.target.value)}
                className="h-9 rounded-md border border-border bg-card px-2.5 text-xs text-text-main font-medium focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="all">
                  {i18n.allProviders} ({entries.length})
                </option>
                {ruleProviders.map((p) => (
                  <option key={p} value={p}>
                    {p} ({entries.filter((e) => e.provider === p).length})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Capability Filter pills, View toggle, & Add button */}
          <div className="flex items-center gap-3 flex-wrap justify-between lg:justify-end">
            {/* Capability pills */}
            <div className="flex items-center p-1 rounded-lg bg-black/5 dark:bg-white/5 border border-border text-xs">
              <button
                type="button"
                onClick={() => setCapabilityFilter("all")}
                className={`px-2.5 py-1 rounded-md transition-all font-medium ${
                  capabilityFilter === "all"
                    ? "bg-card shadow-sm text-text-main font-semibold"
                    : "text-text-muted hover:text-text-main"
                }`}
              >
                {i18n.filterAll}
              </button>
              <button
                type="button"
                onClick={() => setCapabilityFilter("vision")}
                className={`px-2.5 py-1 rounded-md transition-all font-medium flex items-center gap-1 ${
                  capabilityFilter === "vision"
                    ? "bg-card shadow-sm text-emerald-600 dark:text-emerald-400 font-semibold"
                    : "text-text-muted hover:text-text-main"
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">visibility</span>
                {i18n.filterVision}
              </button>
              <button
                type="button"
                onClick={() => setCapabilityFilter("thinking")}
                className={`px-2.5 py-1 rounded-md transition-all font-medium flex items-center gap-1 ${
                  capabilityFilter === "thinking"
                    ? "bg-card shadow-sm text-indigo-600 dark:text-indigo-400 font-semibold"
                    : "text-text-muted hover:text-text-main"
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">psychology</span>
                {i18n.filterThinking}
              </button>
              <button
                type="button"
                onClick={() => setCapabilityFilter("tools")}
                className={`px-2.5 py-1 rounded-md transition-all font-medium flex items-center gap-1 ${
                  capabilityFilter === "tools"
                    ? "bg-card shadow-sm text-purple-600 dark:text-purple-400 font-semibold"
                    : "text-text-muted hover:text-text-main"
                }`}
              >
                <span className="material-symbols-outlined text-[14px]">construction</span>
                {i18n.filterTools}
              </button>
            </div>

            {/* View Mode Toggle */}
            <div className="flex items-center rounded-lg border border-border overflow-hidden bg-black/5 dark:bg-white/5">
              <button
                type="button"
                onClick={() => setViewMode("grid")}
                className={`p-1.5 transition-colors ${
                  viewMode === "grid"
                    ? "bg-card text-primary font-bold shadow-sm"
                    : "text-text-muted hover:text-text-main"
                }`}
                title="Grid / Cards View"
              >
                <span className="material-symbols-outlined text-[18px]">grid_view</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("table")}
                className={`p-1.5 transition-colors ${
                  viewMode === "table"
                    ? "bg-card text-primary font-bold shadow-sm"
                    : "text-text-muted hover:text-text-main"
                }`}
                title="Table View"
              >
                <span className="material-symbols-outlined text-[18px]">table_rows</span>
              </button>
            </div>

            {/* Add Rule Button */}
            <Button variant="primary" size="sm" icon="add" onClick={handleOpenCreate}>
              {i18n.btnAddRule}
            </Button>
          </div>
        </div>

        {/* Content: Empty State */}
        {filteredEntries.length === 0 && (
          <div className="p-12 text-center flex flex-col items-center justify-center gap-3">
            <span className="material-symbols-outlined text-4xl text-text-muted">
              manage_search
            </span>
            <p className="text-sm font-medium text-text-main">{i18n.noMatchingRules}</p>
            <p className="text-xs text-text-muted max-w-sm">
              {searchQuery || providerFilter !== "all" || capabilityFilter !== "all"
                ? isZh
                  ? "未找到符合当前搜索或筛选条件的规则，请调整条件或点击添加新规则。"
                  : "No rules match the current search or filters. Try adjusting them or create a new rule."
                : isZh
                  ? "当前尚未配置任何模型补丁规则，点击下方按钮开始创建第一条规则。"
                  : "No patch rules configured yet. Click below to add your first rule."}
            </p>
            <Button variant="secondary" size="sm" icon="add" onClick={handleOpenCreate}>
              {i18n.btnAddRule}
            </Button>
          </div>
        )}

        {/* Content: Grid / Cards View */}
        {filteredEntries.length > 0 && viewMode === "grid" && (
          <div className="p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredEntries.map((entry, idx) => {
              const caps = (entry.patch.capabilities || {}) as Record<string, unknown>;
              const isVision = caps.vision === true || entry.patch.supportsVision === true;
              const isThinking =
                caps.thinking === true ||
                caps.reasoning === true ||
                entry.patch.supportsThinking === true;
              const isTools = caps.tool_calling === true || entry.patch.supportsTools === true;
              const effortTiers = Array.isArray(caps.effort_tiers)
                ? (caps.effort_tiers as string[])
                : [];
              const context = entry.patch.context_length || entry.patch.contextWindow;
              const output = entry.patch.max_output_tokens || entry.patch.outputTokenLimit;
              const params = Array.isArray(entry.patch.supported_parameters)
                ? (entry.patch.supported_parameters as string[])
                : [];

              return (
                <div
                  key={`${entry.provider}-${entry.modelPattern}-${idx}`}
                  className="rounded-xl border border-border bg-card p-4 hover:border-primary/50 transition-all flex flex-col justify-between gap-3 shadow-xs group"
                >
                  <div className="flex flex-col gap-2.5">
                    {/* Card Top: Provider & Badges */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Badge
                          variant="outline"
                          size="sm"
                          className="font-semibold uppercase tracking-wider text-[10px]"
                        >
                          {entry.provider}
                        </Badge>
                        {entry.modelPattern === "*" && (
                          <Badge variant="warning" size="sm" dot>
                            {isZh ? "通用兜底" : "Default Fallback"}
                          </Badge>
                        )}
                      </div>

                      {/* Capabilities pill tags */}
                      <div className="flex items-center gap-1">
                        {isVision && (
                          <span
                            className="size-5 rounded flex items-center justify-center bg-emerald-500/10 text-emerald-500"
                            title={isZh ? "支持视觉" : "Supports Vision"}
                          >
                            <span className="material-symbols-outlined text-[14px]">
                              visibility
                            </span>
                          </span>
                        )}
                        {isThinking && (
                          <span
                            className="size-5 rounded flex items-center justify-center bg-indigo-500/10 text-indigo-500"
                            title={isZh ? "支持深度思考推理" : "Supports Thinking"}
                          >
                            <span className="material-symbols-outlined text-[14px]">
                              psychology
                            </span>
                          </span>
                        )}
                        {isTools && (
                          <span
                            className="size-5 rounded flex items-center justify-center bg-purple-500/10 text-purple-500"
                            title={isZh ? "支持工具与函数调用" : "Supports Tool Calling"}
                          >
                            <span className="material-symbols-outlined text-[14px]">
                              construction
                            </span>
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Pattern title & Display Name */}
                    <div>
                      <h4 className="text-sm font-mono font-bold text-text-main break-all">
                        {entry.modelPattern}
                      </h4>
                      {(entry.patch.name || entry.patch.displayName) && (
                        <p className="text-xs text-text-muted mt-0.5 truncate">
                          {String(entry.patch.name || entry.patch.displayName)}
                        </p>
                      )}
                      {entry.patch.description && (
                        <p className="text-[11px] text-text-muted mt-1 line-clamp-2 italic">
                          {String(entry.patch.description)}
                        </p>
                      )}
                    </div>

                    {/* Specs & Token Limits */}
                    <div className="flex items-center gap-2 pt-1 border-t border-border/50 text-[11px] font-mono text-text-muted">
                      <div className="flex items-center gap-1">
                        <span className="material-symbols-outlined text-[13px] text-primary">
                          data_array
                        </span>
                        <span>{context ? `${(context / 1024).toFixed(0)}K ctx` : "-"}</span>
                      </div>
                      <span>•</span>
                      <div className="flex items-center gap-1">
                        <span className="material-symbols-outlined text-[13px] text-accent">
                          output
                        </span>
                        <span>{output ? `${(output / 1024).toFixed(0)}K out` : "-"}</span>
                      </div>
                      {isThinking && effortTiers.length > 0 && (
                        <>
                          <span>•</span>
                          <span className="text-indigo-500 text-[10px]" title="Reasoning Tiers">
                            {effortTiers.join("/")}
                          </span>
                        </>
                      )}
                    </div>

                    {/* Supported Parameters */}
                    {params.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-1">
                        {params.slice(0, 5).map((param) => (
                          <span
                            key={param}
                            className="px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5 border border-border text-[10px] font-mono text-text-muted"
                          >
                            {param}
                          </span>
                        ))}
                        {params.length > 5 && (
                          <span className="text-[10px] text-text-muted self-center">
                            +{params.length - 5}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Card Actions Footer */}
                  <div className="pt-2 border-t border-border flex items-center justify-between gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="troubleshoot"
                      onClick={() =>
                        onInspect(
                          entry.modelPattern === "*"
                            ? `${entry.provider}/test-model`
                            : `${entry.provider}/${entry.modelPattern}`,
                          entry.provider
                        )
                      }
                      title={isZh ? "在仿真检查器中测试" : "Inspect Resolution"}
                    >
                      {isZh ? "测试" : "Inspect"}
                    </Button>

                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="content_copy"
                        onClick={() => handleOpenDuplicate(entry)}
                        title={i18n.btnDuplicate}
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="edit"
                        onClick={() => handleOpenEdit(entry)}
                        title={i18n.btnEditRule}
                      >
                        {isZh ? "编辑" : "Edit"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="delete"
                        onClick={() => setDeleteTarget(entry)}
                        title={i18n.btnDelete}
                        className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Content: Detailed Table View */}
        {filteredEntries.length > 0 && viewMode === "table" && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-black/[0.02] dark:bg-white/[0.02] text-text-muted border-b border-border font-semibold uppercase tracking-wider text-[11px]">
                <tr>
                  <th className="p-3">{isZh ? "提供商" : "Provider"}</th>
                  <th className="p-3">{isZh ? "模型匹配模式" : "Model Pattern"}</th>
                  <th className="p-3">{isZh ? "友好显示名" : "Display Name"}</th>
                  <th className="p-3">{isZh ? "能力特性" : "Capabilities"}</th>
                  <th className="p-3">{i18n.contextWindow}</th>
                  <th className="p-3">{i18n.maxOutput}</th>
                  <th className="p-3">{i18n.supportedParams}</th>
                  <th className="p-3 text-right">{isZh ? "操作" : "Actions"}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filteredEntries.map((entry, idx) => {
                  const caps = (entry.patch.capabilities || {}) as Record<string, unknown>;
                  const isVision = caps.vision === true || entry.patch.supportsVision === true;
                  const isThinking =
                    caps.thinking === true ||
                    caps.reasoning === true ||
                    entry.patch.supportsThinking === true;
                  const isTools = caps.tool_calling === true || entry.patch.supportsTools === true;
                  const context = entry.patch.context_length || entry.patch.contextWindow;
                  const output = entry.patch.max_output_tokens || entry.patch.outputTokenLimit;
                  const params = Array.isArray(entry.patch.supported_parameters)
                    ? (entry.patch.supported_parameters as string[])
                    : [];

                  return (
                    <tr
                      key={`tbl-${entry.provider}-${entry.modelPattern}-${idx}`}
                      className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
                    >
                      <td className="p-3 font-semibold text-text-main">
                        <Badge variant="outline" size="sm">
                          {entry.provider}
                        </Badge>
                      </td>
                      <td className="p-3 font-mono font-medium text-text-main">
                        {entry.modelPattern === "*" ? (
                          <span className="text-amber-500 font-bold">
                            {isZh ? "* (通用兜底)" : "* (Default Fallback)"}
                          </span>
                        ) : (
                          entry.modelPattern
                        )}
                      </td>
                      <td className="p-3 text-text-muted">
                        {entry.patch.name || entry.patch.displayName || "-"}
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {isVision && (
                            <Badge variant="success" size="sm">
                              {isZh ? "视觉" : "Vision"}
                            </Badge>
                          )}
                          {isThinking && (
                            <Badge variant="info" size="sm">
                              {isZh ? "思考" : "Thinking"}
                            </Badge>
                          )}
                          {isTools && (
                            <Badge variant="primary" size="sm">
                              {isZh ? "工具" : "Tools"}
                            </Badge>
                          )}
                          {!isVision && !isThinking && !isTools && (
                            <span className="text-text-muted">-</span>
                          )}
                        </div>
                      </td>
                      <td className="p-3 font-mono text-text-main">
                        {context ? `${context.toLocaleString()} tok` : "-"}
                      </td>
                      <td className="p-3 font-mono text-text-main">
                        {output ? `${output.toLocaleString()} tok` : "-"}
                      </td>
                      <td className="p-3 font-mono text-text-muted max-w-xs truncate">
                        {params.length > 0 ? params.join(", ") : "-"}
                      </td>
                      <td className="p-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="troubleshoot"
                            onClick={() =>
                              onInspect(
                                entry.modelPattern === "*"
                                  ? `${entry.provider}/test-model`
                                  : `${entry.provider}/${entry.modelPattern}`,
                                entry.provider
                              )
                            }
                            title={isZh ? "在检查器中测试" : "Inspect Resolution"}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="content_copy"
                            onClick={() => handleOpenDuplicate(entry)}
                            title={i18n.btnDuplicate}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="edit"
                            onClick={() => handleOpenEdit(entry)}
                            title={i18n.btnEditRule}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="delete"
                            onClick={() => setDeleteTarget(entry)}
                            title={i18n.btnDelete}
                            className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Create / Edit / Duplicate Modal */}
      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={
          modalMode === "create"
            ? i18n.modalCreateTitle
            : modalMode === "edit"
              ? i18n.modalEditTitle
              : i18n.modalDuplicateTitle
        }
        size="lg"
        footer={
          <div className="flex items-center justify-end gap-2 w-full">
            <Button variant="ghost" onClick={() => setIsModalOpen(false)}>
              {i18n.btnCancel}
            </Button>
            <Button variant="primary" loading={saving} onClick={handleSaveRule} icon="save">
              {saving ? i18n.btnSavingRule : i18n.btnSaveRule}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-5 py-1">
          {formError && (
            <div className="p-3 rounded-lg border border-red-500/20 bg-red-500/10 text-xs text-red-500 flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px]">error</span>
              <span>{formError}</span>
            </div>
          )}

          {/* Identity Section */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-text-main mb-1.5">
                {i18n.fieldProvider} <span className="text-red-500">*</span>
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={formData.provider}
                  onChange={(e) => setFormData((prev) => ({ ...prev, provider: e.target.value }))}
                  placeholder={i18n.fieldProviderPlaceholder}
                  className="flex-1 h-9 rounded-md border border-border bg-card px-3 text-xs text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) {
                      setFormData((prev) => ({ ...prev, provider: e.target.value }));
                    }
                  }}
                  className="h-9 rounded-md border border-border bg-card px-2 text-xs text-text-muted"
                  title="Select Common Provider"
                >
                  <option value="">{isZh ? "快速预设..." : "Presets..."}</option>
                  {availableProviders.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-text-main mb-1.5">
                {i18n.fieldModelPattern} <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={formData.modelPattern}
                onChange={(e) => setFormData((prev) => ({ ...prev, modelPattern: e.target.value }))}
                placeholder={i18n.fieldModelPatternPlaceholder}
                className="w-full h-9 rounded-md border border-border bg-card px-3 text-xs font-mono text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <p className="mt-1 text-[11px] text-text-muted">{i18n.fieldModelPatternHelp}</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-text-main mb-1.5">
                {i18n.fieldDisplayName}
              </label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                placeholder={i18n.fieldDisplayNamePlaceholder}
                className="w-full h-9 rounded-md border border-border bg-card px-3 text-xs text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-text-main mb-1.5">
                {i18n.fieldDescription}
              </label>
              <input
                type="text"
                value={formData.description}
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                placeholder={i18n.fieldDescriptionPlaceholder}
                className="w-full h-9 rounded-md border border-border bg-card px-3 text-xs text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          </div>

          {/* Token Limits */}
          <div className="p-4 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-border flex flex-col gap-4">
            <h5 className="text-xs font-bold text-text-main uppercase tracking-wider">
              {isZh ? "上下文与输出长度限制" : "Token Limits & Windows"}
            </h5>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-text-main mb-1">
                  {i18n.fieldContextLength}
                </label>
                <input
                  type="number"
                  value={formData.contextLength}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, contextLength: e.target.value }))
                  }
                  placeholder="131072"
                  className="w-full h-9 rounded-md border border-border bg-card px-3 text-xs font-mono text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {CONTEXT_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() =>
                        setFormData((prev) => ({ ...prev, contextLength: String(p.value) }))
                      }
                      className="px-2 py-0.5 rounded bg-card border border-border text-[10px] font-mono hover:border-primary text-text-muted hover:text-primary transition-colors"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-text-main mb-1">
                  {i18n.fieldMaxOutputTokens}
                </label>
                <input
                  type="number"
                  value={formData.maxOutputTokens}
                  onChange={(e) =>
                    setFormData((prev) => ({ ...prev, maxOutputTokens: e.target.value }))
                  }
                  placeholder="4096"
                  className="w-full h-9 rounded-md border border-border bg-card px-3 text-xs font-mono text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {OUTPUT_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() =>
                        setFormData((prev) => ({ ...prev, maxOutputTokens: String(p.value) }))
                      }
                      className="px-2 py-0.5 rounded bg-card border border-border text-[10px] font-mono hover:border-primary text-text-muted hover:text-primary transition-colors"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Capabilities Switches */}
          <div className="p-4 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-border flex flex-col gap-4">
            <h5 className="text-xs font-bold text-text-main uppercase tracking-wider">
              {i18n.secCapabilities}
            </h5>

            <div className="flex flex-col gap-3">
              {/* Vision Toggle */}
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-card border border-border">
                <div>
                  <p className="text-xs font-semibold text-text-main flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[16px] text-emerald-500">
                      visibility
                    </span>
                    {i18n.capVisionLabel}
                  </p>
                  <p className="text-[11px] text-text-muted mt-0.5">{i18n.capVisionDesc}</p>
                </div>
                <Toggle
                  checked={formData.supportsVision}
                  onChange={(checked) =>
                    setFormData((prev) => ({ ...prev, supportsVision: checked }))
                  }
                />
              </div>

              {/* Thinking / Reasoning Toggle */}
              <div className="flex flex-col gap-2.5 p-2.5 rounded-lg bg-card border border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-semibold text-text-main flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-[16px] text-indigo-500">
                        psychology
                      </span>
                      {i18n.capThinkingLabel}
                    </p>
                    <p className="text-[11px] text-text-muted mt-0.5">{i18n.capThinkingDesc}</p>
                  </div>
                  <Toggle
                    checked={formData.supportsThinking}
                    onChange={(checked) =>
                      setFormData((prev) => ({ ...prev, supportsThinking: checked }))
                    }
                  />
                </div>

                {formData.supportsThinking && (
                  <div className="pt-2 border-t border-border flex flex-col gap-2">
                    <span className="text-[11px] font-medium text-text-muted">
                      {i18n.reasoningEffortLabel}:
                    </span>
                    <div className="flex items-center gap-2 flex-wrap">
                      {["low", "medium", "high"].map((tier) => {
                        const checked = formData.effortTiers.includes(tier);
                        return (
                          <button
                            key={tier}
                            type="button"
                            onClick={() => handleToggleEffortTier(tier)}
                            className={`px-2.5 py-1 rounded border text-xs font-mono transition-all flex items-center gap-1.5 ${
                              checked
                                ? "border-indigo-500 bg-indigo-500/10 text-indigo-500 font-semibold"
                                : "border-border bg-card text-text-muted hover:border-primary"
                            }`}
                          >
                            <span className="material-symbols-outlined text-[14px]">
                              {checked ? "check_box" : "check_box_outline_blank"}
                            </span>
                            {tier}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Tools Toggle */}
              <div className="flex items-center justify-between p-2.5 rounded-lg bg-card border border-border">
                <div>
                  <p className="text-xs font-semibold text-text-main flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[16px] text-purple-500">
                      construction
                    </span>
                    {i18n.capToolsLabel}
                  </p>
                  <p className="text-[11px] text-text-muted mt-0.5">{i18n.capToolsDesc}</p>
                </div>
                <Toggle
                  checked={formData.supportsTools}
                  onChange={(checked) =>
                    setFormData((prev) => ({ ...prev, supportsTools: checked }))
                  }
                />
              </div>
            </div>
          </div>

          {/* Supported Request Parameters */}
          <div className="p-4 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-border flex flex-col gap-3">
            <h5 className="text-xs font-bold text-text-main uppercase tracking-wider">
              {i18n.secParameters}
            </h5>

            <div className="flex flex-wrap gap-1.5">
              {PRESET_PARAMETERS.map((param) => {
                const active = formData.supportedParameters.includes(param);
                return (
                  <button
                    key={param}
                    type="button"
                    onClick={() => handleToggleParam(param)}
                    className={`px-2 py-1 rounded text-xs font-mono transition-all border flex items-center gap-1 ${
                      active
                        ? "border-primary bg-primary/10 text-primary font-semibold"
                        : "border-border bg-card text-text-muted hover:border-border-hover hover:text-text-main"
                    }`}
                  >
                    <span>{param}</span>
                    <span className="material-symbols-outlined text-[12px]">
                      {active ? "close" : "add"}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Custom Param Adder */}
            <div className="flex items-center gap-2 mt-1">
              <input
                type="text"
                placeholder={i18n.tagParamPlaceholder}
                value={customParamInput}
                onChange={(e) => setCustomParamInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddCustomParam();
                  }
                }}
                className="flex-1 h-8 rounded-md border border-border bg-card px-2.5 text-xs font-mono text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <Button variant="secondary" size="sm" onClick={handleAddCustomParam}>
                {isZh ? "添加参数" : "Add Param"}
              </Button>
            </div>

            {/* Active custom tags */}
            {formData.supportedParameters.filter((p) => !PRESET_PARAMETERS.includes(p)).length >
              0 && (
              <div className="flex flex-wrap gap-1.5 pt-2 border-t border-border">
                {formData.supportedParameters
                  .filter((p) => !PRESET_PARAMETERS.includes(p))
                  .map((custom) => (
                    <span
                      key={custom}
                      className="px-2 py-0.5 rounded bg-primary/10 border border-primary/20 text-primary text-xs font-mono flex items-center gap-1"
                    >
                      <span>{custom}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveParam(custom)}
                        className="hover:opacity-75"
                      >
                        <span className="material-symbols-outlined text-[12px]">close</span>
                      </button>
                    </span>
                  ))}
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title={i18n.confirmDeleteTitle}
        size="sm"
        footer={
          <div className="flex items-center justify-end gap-2 w-full">
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {i18n.btnCancel}
            </Button>
            <Button variant="danger" loading={deleting} onClick={handleDeleteConfirm} icon="delete">
              {i18n.btnDelete}
            </Button>
          </div>
        }
      >
        <div className="py-2 text-xs text-text-muted leading-relaxed">
          {deleteTarget && i18n.confirmDeleteDesc(deleteTarget.provider, deleteTarget.modelPattern)}
        </div>
      </Modal>
    </div>
  );
}
