"use client";

import { useState } from "react";
import { Button, Card, Input, Badge } from "@/shared/components";
import { matchesSearch } from "@/shared/utils/turkishText";
import { useModelPatchesI18n, isChineseLocale } from "./i18n";

export interface PatchRuleEntry {
  provider: string;
  modelPattern: string;
  patch: Record<string, any>;
}

interface ModelPatchRulesListProps {
  entries: PatchRuleEntry[];
  onInspect: (modelId: string, provider: string) => void;
  onEdit: (pattern: string) => void;
}

interface UpstreamCoverageResult {
  totalUpstreamModels: number;
  coveredCount: number;
  coveragePercentage: number;
  coveredModels: Array<{ id: string; patchRule?: string }>;
  missingModels: string[];
}

export default function ModelPatchRulesList({ entries, onInspect }: ModelPatchRulesListProps) {
  const i18n = useModelPatchesI18n();
  const isZh = isChineseLocale();
  const [filterQuery, setFilterQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");

  // NIM Coverage Check State
  const [nimApiKey, setNimApiKey] = useState("");
  const [checkingNim, setCheckingNim] = useState(false);
  const [nimResult, setNimResult] = useState<UpstreamCoverageResult | null>(null);
  const [nimError, setNimError] = useState<string | null>(null);

  const providers = Array.from(new Set(entries.map((e) => e.provider))).sort();

  const filteredEntries = entries.filter((entry) => {
    if (providerFilter !== "all" && entry.provider !== providerFilter) return false;
    if (!filterQuery) return true;
    const name = String(entry.patch.name || entry.patch.displayName || "");
    return (
      matchesSearch(entry.modelPattern, filterQuery) ||
      matchesSearch(name, filterQuery) ||
      matchesSearch(entry.provider, filterQuery)
    );
  });

  const handleCheckNim = async () => {
    setCheckingNim(true);
    setNimError(null);

    try {
      const res = await fetch("/api/models/patches/check-upstream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: nimApiKey.trim() || undefined }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Failed to check NVIDIA NIM upstream models");
      }

      setNimResult(data as UpstreamCoverageResult);
    } catch (err) {
      setNimError(err instanceof Error ? err.message : "Error checking NIM");
    } finally {
      setCheckingNim(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* NIM Upstream Coverage Card */}
      <Card padding="none" className="p-5 border border-primary/20 bg-primary/[0.02]">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-text-main flex items-center gap-2">
                <span className="material-symbols-outlined text-primary text-[20px]">
                  network_check
                </span>
                {i18n.auditTitle}
              </h3>
              <p className="mt-1 text-xs text-text-muted">{i18n.auditDesc}</p>
            </div>
            <Button
              variant="primary"
              size="sm"
              icon="radar"
              loading={checkingNim}
              onClick={handleCheckNim}
            >
              {checkingNim ? i18n.btnAuditing : i18n.btnAudit}
            </Button>
          </div>

          <div className="flex items-center gap-3 max-w-md">
            <Input
              placeholder={i18n.nimApiKeyPlaceholder}
              type="password"
              value={nimApiKey}
              onChange={(e) => setNimApiKey(e.target.value)}
              className="text-xs"
            />
          </div>

          {nimError && (
            <div className="text-xs text-red-500 flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[16px]">error</span>
              <span>{nimError}</span>
            </div>
          )}

          {nimResult && (
            <div className="flex flex-col gap-3 p-4 rounded-lg bg-card border border-border">
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-text-main">
                    {i18n.coverageLabel}: {nimResult.coveragePercentage}%
                  </span>
                  <span className="text-text-muted">
                    (
                    {i18n.modelsCoveredUnit(
                      nimResult.coveredCount,
                      nimResult.totalUpstreamModels,
                      nimResult.coveragePercentage
                    )}
                    )
                  </span>
                </div>
                <Badge
                  variant={nimResult.coveragePercentage > 50 ? "success" : "warning"}
                  size="sm"
                >
                  {nimResult.coveredCount} {isZh ? "已覆盖" : "Covered"}
                </Badge>
              </div>

              {/* Progress bar */}
              <div className="w-full h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                  style={{ width: `${nimResult.coveragePercentage}%` }}
                />
              </div>

              {nimResult.missingModels.length > 0 ? (
                <div className="flex flex-col gap-2 pt-2 border-t border-border">
                  <span className="text-xs font-semibold text-text-muted">
                    {i18n.unpatchedModelsTitle} ({nimResult.missingModels.length}):
                  </span>
                  <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto p-1">
                    {nimResult.missingModels.slice(0, 30).map((modelId) => (
                      <button
                        key={modelId}
                        type="button"
                        onClick={() => onInspect(`nvidia/${modelId}`, "nvidia")}
                        className="px-2 py-0.5 rounded bg-black/5 dark:bg-white/5 border border-border hover:border-primary text-[11px] font-mono text-text-main flex items-center gap-1 group"
                        title={isZh ? "点击在检查器中测试该模型" : "Click to inspect this model"}
                      >
                        <span>{modelId}</span>
                        <span className="material-symbols-outlined text-[12px] opacity-0 group-hover:opacity-100 text-primary">
                          open_in_new
                        </span>
                      </button>
                    ))}
                    {nimResult.missingModels.length > 30 && (
                      <span className="text-xs text-text-muted self-center">
                        +{nimResult.missingModels.length - 30} {isZh ? "个更多" : "more"}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="pt-2 border-t border-border text-xs text-emerald-500 font-medium">
                  {i18n.allCovered}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* Rules Directory Table */}
      <Card padding="none" className="overflow-hidden">
        {/* Table Filter Bar */}
        <div className="p-4 border-b border-border flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="flex-1 max-w-sm">
            <Input
              icon="search"
              placeholder={i18n.searchPlaceholder}
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">{i18n.filterProvider}:</span>
            <select
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value)}
              className="h-9 rounded-md border border-border bg-card px-2.5 text-xs text-text-main"
            >
              <option value="all">
                {i18n.allProviders} ({entries.length})
              </option>
              {providers.map((p) => (
                <option key={p} value={p}>
                  {p} ({entries.filter((e) => e.provider === p).length})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Rules Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-black/[0.02] dark:bg-white/[0.02] text-text-muted border-b border-border font-semibold uppercase tracking-wider text-[11px]">
              <tr>
                <th className="p-3">{isZh ? "提供商" : "Provider"}</th>
                <th className="p-3">{isZh ? "模型匹配模式" : "Model Pattern"}</th>
                <th className="p-3">{isZh ? "显示名称" : "Display Name"}</th>
                <th className="p-3">{isZh ? "能力特性" : "Capabilities"}</th>
                <th className="p-3">{i18n.contextWindow}</th>
                <th className="p-3">{i18n.maxOutput}</th>
                <th className="p-3 text-right">{isZh ? "操作" : "Actions"}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredEntries.map((entry, idx) => {
                const caps = entry.patch.capabilities || {};
                const isVision = caps.vision === true || entry.patch.supportsVision === true;
                const isThinking =
                  caps.thinking === true ||
                  caps.reasoning === true ||
                  entry.patch.supportsThinking === true;
                const isTools = caps.tool_calling === true || entry.patch.supportsTools === true;
                const context = entry.patch.context_length || entry.patch.contextWindow;
                const output = entry.patch.max_output_tokens || entry.patch.outputTokenLimit;

                return (
                  <tr
                    key={`${entry.provider}-${entry.modelPattern}-${idx}`}
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
                          {isZh ? "* (提供商兜底)" : "* (Default Fallback)"}
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
                      {context ? `${context.toLocaleString()} tokens` : "-"}
                    </td>
                    <td className="p-3 font-mono text-text-main">
                      {output ? `${output.toLocaleString()} tokens` : "-"}
                    </td>
                    <td className="p-3 text-right">
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
                      >
                        {isZh ? "测试解析" : "Inspect"}
                      </Button>
                    </td>
                  </tr>
                );
              })}

              {filteredEntries.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-text-muted">
                    {i18n.noMatchingRules}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
