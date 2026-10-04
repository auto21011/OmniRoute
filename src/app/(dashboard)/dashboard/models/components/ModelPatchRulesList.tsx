"use client";

import { useState } from "react";
import { Button, Card, Input, Badge } from "@/shared/components";
import { matchesSearch } from "@/shared/utils/turkishText";
import { useModelPatchesI18n, isChineseLocale } from "./i18n";

export interface PatchRuleEntry {
  provider: string;
  modelPattern: string;
  patch: Record<string, unknown>;
}

interface ModelPatchRulesListProps {
  entries: PatchRuleEntry[];
  onInspect: (modelId: string, provider: string) => void;
  onEdit: (pattern: string) => void;
}

export default function ModelPatchRulesList({ entries, onInspect }: ModelPatchRulesListProps) {
  const i18n = useModelPatchesI18n();
  const isZh = isChineseLocale();
  const [filterQuery, setFilterQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");

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

  return (
    <div className="flex flex-col gap-6">
      {/* Rules Directory Table */}
      <Card padding="none" className="overflow-hidden border border-border">
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
                const caps = (entry.patch.capabilities || {}) as Record<string, unknown>;
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
                      <Badge variant="default" size="sm">
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
                      {String(entry.patch.name || entry.patch.displayName || "-")}
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
                      {typeof context === "number" ? `${context.toLocaleString()} tokens` : "-"}
                    </td>
                    <td className="p-3 font-mono text-text-main">
                      {typeof output === "number" ? `${output.toLocaleString()} tokens` : "-"}
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
